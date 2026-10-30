//! One constructor for every Pi launch. Callers pick a use; they do not assemble args.
//!
//! `interactive` is a live RPC. `unattended` is a scheduled `-p` run and never
//! keeps `full-access`. `subagent_spec` only publishes the values the extension
//! already reads before it spawns.

use base64::Engine;

use crate::error::AppError;
use crate::extensions::{
    ensure_browser_extension, ensure_computer_extension, ensure_guard_extension,
    ensure_hooks_extension, ensure_mcp_extension, ensure_memory_extension, ensure_plan_extension,
    ensure_subagents_extension,
};
use crate::{app_config_dir, local_memory_path, runtime_secret_values, AppSettings};

pub(crate) struct PiLaunchConfig {
    pub(crate) extra_args: Vec<String>,
    pub(crate) environment: Vec<(String, String)>,
    pub(crate) sensitive_values: Vec<String>,
}

pub(crate) fn interactive(
    settings: &AppSettings,
    cwd: &str,
    permission_mode: &str,
    is_quick_chat: bool,
) -> Result<PiLaunchConfig, AppError> {
    build(settings, cwd, permission_mode, is_quick_chat)
}

/// Scheduled runs cannot escalate to full-access. Unsafe stored modes become `ask`.
pub(crate) fn unattended(
    settings: &AppSettings,
    cwd: &str,
    requested_permission: &str,
) -> Result<PiLaunchConfig, AppError> {
    let permission_mode = if is_safe_unattended_permission(requested_permission) {
        requested_permission
    } else {
        "ask"
    };
    build(settings, cwd, permission_mode, false)
}

pub(crate) fn is_safe_unattended_permission(mode: &str) -> bool {
    matches!(mode, "read-only" | "ask" | "workspace-write")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SubagentSpec {
    pub(crate) concurrency: u8,
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) thinking: String,
}

pub(crate) fn subagent_spec(settings: &AppSettings) -> SubagentSpec {
    SubagentSpec {
        concurrency: settings.subagent_max_concurrency.clamp(1, 4),
        provider: settings.provider.clone(),
        model: settings.model.clone(),
        thinking: settings.thinking_level.clone(),
    }
}

fn build(
    settings: &AppSettings,
    cwd: &str,
    permission_mode: &str,
    is_quick_chat: bool,
) -> Result<PiLaunchConfig, AppError> {
    let guard_extension = ensure_guard_extension()?;
    let browser_extension = settings
        .browser_enabled
        .then(ensure_browser_extension)
        .transpose()?;
    let computer_extension = settings
        .computer_enabled
        .then(ensure_computer_extension)
        .transpose()?;
    let mcp_extension = settings
        .mcp_enabled
        .then(ensure_mcp_extension)
        .transpose()?;
    let plan_extension = settings
        .plan_tracking_enabled
        .then(ensure_plan_extension)
        .transpose()?;
    let hooks_extension = settings
        .hooks_enabled
        .then(ensure_hooks_extension)
        .transpose()?;
    let subagents_extension = settings
        .subagents_enabled
        .then(ensure_subagents_extension)
        .transpose()?;
    let memory_extension = settings
        .memory_enabled
        .then(ensure_memory_extension)
        .transpose()?;
    let mcp_config = if settings.mcp_enabled {
        let mut raw = serde_json::to_vec(&settings.mcp_servers).map_err(|err| {
            AppError::Other(format!("failed to serialize MCP runtime config: {err}"))
        })?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&raw);
        raw.fill(0);
        encoded
    } else {
        String::new()
    };
    let hooks_config = if settings.hooks_enabled {
        base64::engine::general_purpose::STANDARD.encode(
            serde_json::to_vec(&settings.hooks).map_err(|err| {
                AppError::Other(format!("failed to serialize hooks runtime config: {err}"))
            })?,
        )
    } else {
        String::new()
    };
    let tool_rules_config =
        base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_vec(&settings.tool_rules).map_err(|err| {
                AppError::Other(format!("failed to serialize tool rules: {err}"))
            })?);
    let mut sensitive_values = runtime_secret_values(settings);
    if !mcp_config.is_empty() {
        sensitive_values.push(mcp_config.clone());
    }
    if !hooks_config.is_empty() {
        sensitive_values.push(hooks_config.clone());
    }
    let spec = subagent_spec(settings);
    let extra_args = settings.rpc_extra_args(
        &guard_extension,
        browser_extension.as_deref(),
        computer_extension.as_deref(),
        mcp_extension.as_deref(),
        plan_extension.as_deref(),
        hooks_extension.as_deref(),
        subagents_extension.as_deref(),
        memory_extension.as_deref(),
    );
    let environment = vec![
        (
            "PIDESKTOP_PERMISSION_MODE".to_string(),
            permission_mode.to_string(),
        ),
        (
            "PIDESKTOP_AGENT_MODE".to_string(),
            settings.agent_mode.clone(),
        ),
        ("PIDESKTOP_WORKSPACE_ROOT".to_string(), cwd.to_string()),
        (
            "PIDESKTOP_RULE_ALWAYS_CONFIRM_SHELL".to_string(),
            if settings.always_confirm_shell {
                "1"
            } else {
                "0"
            }
            .to_string(),
        ),
        (
            "PIDESKTOP_RULE_BLOCK_OUTSIDE_WRITE".to_string(),
            if settings.block_write_outside_workspace {
                "1"
            } else {
                "0"
            }
            .to_string(),
        ),
        (
            "PIDESKTOP_RULE_SHELL_ALLOWLIST".to_string(),
            settings.shell_allow_prefixes.clone(),
        ),
        ("PIDESKTOP_TOOL_RULES_B64".to_string(), tool_rules_config),
        (
            "PIDESKTOP_QUICK_CHAT".to_string(),
            if is_quick_chat { "1" } else { "0" }.to_string(),
        ),
        (
            "PIDESKTOP_BROWSER_HEADLESS".to_string(),
            if settings.browser_headless { "1" } else { "0" }.to_string(),
        ),
        (
            "PIDESKTOP_BROWSER_PROFILE_DIR".to_string(),
            if settings.browser_profile_mode == "persistent" {
                app_config_dir()
                    .join("browser-profile")
                    .to_string_lossy()
                    .to_string()
            } else {
                String::new()
            },
        ),
        (
            "PIDESKTOP_BROWSER_CONFIRM".to_string(),
            if settings.browser_confirm_actions {
                "1"
            } else {
                "0"
            }
            .to_string(),
        ),
        (
            "PIDESKTOP_BROWSER_EXECUTABLE".to_string(),
            settings.browser_executable.clone(),
        ),
        (
            "PIDESKTOP_COMPUTER_CONFIRM".to_string(),
            if settings.computer_confirm_actions {
                "1"
            } else {
                "0"
            }
            .to_string(),
        ),
        (
            "PIDESKTOP_COMPUTER_HELPER".to_string(),
            std::env::current_exe()
                .map_err(|err| {
                    AppError::Other(format!("failed to locate Pi Desktop executable: {err}"))
                })?
                .to_string_lossy()
                .to_string(),
        ),
        ("PIDESKTOP_MCP_CONFIG_B64".to_string(), mcp_config),
        ("PIDESKTOP_HOOKS_CONFIG_B64".to_string(), hooks_config),
        (
            "PIDESKTOP_HOOKS_INHERIT_ENV".to_string(),
            if settings.hooks_inherit_environment {
                "1"
            } else {
                "0"
            }
            .to_string(),
        ),
        (
            "PIDESKTOP_GUARD_EXTENSION".to_string(),
            guard_extension.to_string_lossy().to_string(),
        ),
        (
            "PIDESKTOP_SUBAGENT_CONCURRENCY".to_string(),
            spec.concurrency.to_string(),
        ),
        (
            "PIDESKTOP_SUBAGENT_PROVIDER".to_string(),
            spec.provider.clone(),
        ),
        ("PIDESKTOP_SUBAGENT_MODEL".to_string(), spec.model.clone()),
        (
            "PIDESKTOP_SUBAGENT_THINKING".to_string(),
            spec.thinking.clone(),
        ),
        (
            "PIDESKTOP_MEMORY_FILE".to_string(),
            local_memory_path().to_string_lossy().to_string(),
        ),
        (
            "PIDESKTOP_MCP_CONFIRM".to_string(),
            if settings.mcp_confirm_tools { "1" } else { "0" }.to_string(),
        ),
    ];
    Ok(PiLaunchConfig {
        extra_args,
        environment,
        sensitive_values,
    })
}
