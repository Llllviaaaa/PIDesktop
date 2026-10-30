//! Persisted configuration: app settings and their defaults, the project list, where
//! files live under the config directory, and keeping MCP secrets out of the
//! public settings file.

use crate::*;

pub(crate) const MCP_SECRET_PLACEHOLDER: &str = "••••••••";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct AppSettings {
    pub(crate) provider: String,
    pub(crate) model: String,
    #[serde(alias = "thinking_level")]
    pub(crate) thinking_level: String,
    /// `provider/model` keys the user hid from the composer model picker.
    pub(crate) hidden_models: Vec<String>,
    /// Where Pi kept its sessions, if not `~/.pi/agent/sessions`; only read to
    /// import them into the Harness Host (P6b).
    #[serde(alias = "session_dir")]
    pub(crate) session_dir: String,
    /// Pi ran on the app's own config directory (`pi-agent`) instead of the
    /// terminal's. Pi is gone (P6c); this only says where its models.json and
    /// auth.json are for the Host's one-time import. The settings page no
    /// longer sends it, so `set_settings` keeps the stored value.
    pub(crate) separate_pi_config: bool,
    pub(crate) agent_mode: String,
    #[serde(alias = "permission_mode")]
    pub(crate) permission_mode: String,
    /// When true, shell/bash/exec always requires confirmation (unless full-access).
    pub(crate) always_confirm_shell: bool,
    /// When true, writes outside the workspace root are blocked without a confirm dialog.
    pub(crate) block_write_outside_workspace: bool,
    /// Newline- or comma-separated command prefixes that skip shell confirmation under ask/workspace-write.
    pub(crate) shell_allow_prefixes: String,
    pub(crate) tool_rules: Vec<ToolPermissionRule>,
    /// Default new-task environment: "local" or "worktree".
    pub(crate) default_task_environment: String,
    #[serde(alias = "show_thinking")]
    pub(crate) show_thinking: bool,
    #[serde(alias = "transcript_density", default = "default_transcript_density")]
    pub(crate) transcript_density: String,
    #[serde(alias = "auto_connect")]
    pub(crate) auto_connect: bool,
    pub(crate) follow_up_behavior: String,
    pub(crate) require_ctrl_enter: bool,
    pub(crate) prevent_sleep: bool,
    pub(crate) language: String,
    pub(crate) default_file_opener: String,
    pub(crate) terminal_shell: String,
    pub(crate) terminal_output: String,
    pub(crate) notifications_enabled: bool,
    pub(crate) notify_on_completion: bool,
    pub(crate) notify_on_approval: bool,
    pub(crate) notify_only_when_unfocused: bool,
    pub(crate) theme: String,
    pub(crate) pet_enabled: bool,
    pub(crate) pet_character: String,
    pub(crate) pet_size: u16,
    pub(crate) accent_color: String,
    pub(crate) background_color: String,
    pub(crate) foreground_color: String,
    pub(crate) ui_font: String,
    pub(crate) code_font: String,
    pub(crate) ui_scale: u16,
    /// Transcript body size in px (DSH's content font size); rows and line heights follow it.
    pub(crate) message_font_size: u16,
    pub(crate) personality: String,
    pub(crate) custom_instructions: String,
    pub(crate) suggested_prompts: bool,
    pub(crate) memory_enabled: bool,
    pub(crate) plan_tracking_enabled: bool,
    pub(crate) hooks_enabled: bool,
    pub(crate) hooks_inherit_environment: bool,
    pub(crate) hooks: Vec<DesktopHookConfig>,
    pub(crate) subagents_enabled: bool,
    pub(crate) subagent_max_concurrency: u8,
    pub(crate) browser_enabled: bool,
    pub(crate) browser_headless: bool,
    pub(crate) browser_profile_mode: String,
    pub(crate) browser_confirm_actions: bool,
    pub(crate) browser_executable: String,
    pub(crate) computer_enabled: bool,
    pub(crate) computer_confirm_actions: bool,
    pub(crate) mcp_enabled: bool,
    pub(crate) mcp_confirm_tools: bool,
    pub(crate) mcp_servers: Vec<McpServerConfig>,
    pub(crate) review_delivery: String,
    pub(crate) branch_prefix: String,
    pub(crate) allow_force_push: bool,
    pub(crate) commit_message_instructions: String,
    pub(crate) pull_request_instructions: String,
    pub(crate) log_level: String,
    pub(crate) shortcut_new_chat: String,
    pub(crate) shortcut_settings: String,
    pub(crate) shortcut_terminal: String,
    pub(crate) shortcut_changes: String,
    pub(crate) shortcut_toggle_sidebar: String,
    pub(crate) archived_sessions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct McpServerConfig {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) enabled: bool,
    pub(crate) transport: String,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: String,
    pub(crate) env: HashMap<String, String>,
    pub(crate) inherit_environment: bool,
    pub(crate) url: String,
    pub(crate) headers: HashMap<String, String>,
    pub(crate) trusted_read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct DesktopHookConfig {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) enabled: bool,
    pub(crate) event: String,
    pub(crate) command: String,
    pub(crate) timeout_seconds: u16,
    pub(crate) blocking: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ToolPermissionRule {
    pub(crate) id: String,
    pub(crate) enabled: bool,
    pub(crate) tool_pattern: String,
    pub(crate) action: String,
    pub(crate) command_prefix: String,
    pub(crate) path_prefix: String,
}

impl Default for ToolPermissionRule {
    fn default() -> Self {
        Self {
            id: String::new(),
            enabled: true,
            tool_pattern: "*".to_string(),
            action: "confirm".to_string(),
            command_prefix: String::new(),
            path_prefix: String::new(),
        }
    }
}

impl Default for DesktopHookConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            event: "agent_settled".to_string(),
            command: String::new(),
            timeout_seconds: 30,
            blocking: false,
        }
    }
}

pub(crate) const CODEX_UI_FONT: &str =
    "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif";

pub(crate) const CODEX_CODE_FONT: &str =
    "ui-monospace, \"SFMono-Regular\", \"SF Mono\", Menlo, Consolas, \"Liberation Mono\", monospace";

pub(crate) const LEGACY_UI_FONT: &str = "Inter, Segoe UI, system-ui, sans-serif";

pub(crate) const LEGACY_CODE_FONT: &str = "JetBrains Mono, Consolas, monospace";

impl Default for McpServerConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            transport: "stdio".to_string(),
            command: String::new(),
            args: Vec::new(),
            cwd: String::new(),
            env: HashMap::new(),
            inherit_environment: false,
            url: String::new(),
            headers: HashMap::new(),
            trusted_read_only: false,
        }
    }
}

pub(crate) fn default_transcript_density() -> String {
    "normal".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            provider: String::new(),
            model: String::new(),
            thinking_level: "medium".to_string(),
            hidden_models: Vec::new(),
            session_dir: String::new(),
            separate_pi_config: false,
            agent_mode: "agent".to_string(),
            permission_mode: "ask".to_string(),
            always_confirm_shell: true,
            block_write_outside_workspace: true,
            shell_allow_prefixes: String::new(),
            tool_rules: Vec::new(),
            default_task_environment: "local".to_string(),
            show_thinking: true,
            transcript_density: "normal".to_string(),
            auto_connect: false,
            follow_up_behavior: "steer".to_string(),
            require_ctrl_enter: false,
            prevent_sleep: true,
            language: "zh-CN".to_string(),
            default_file_opener: "system".to_string(),
            terminal_shell: "PowerShell".to_string(),
            terminal_output: "summary".to_string(),
            notifications_enabled: true,
            notify_on_completion: true,
            notify_on_approval: true,
            notify_only_when_unfocused: true,
            theme: "light".to_string(),
            pet_enabled: false,
            pet_character: "cat".to_string(),
            pet_size: 96,
            accent_color: "#111111".to_string(),
            background_color: "#ffffff".to_string(),
            foreground_color: "#1a1a1a".to_string(),
            ui_font: CODEX_UI_FONT.to_string(),
            code_font: CODEX_CODE_FONT.to_string(),
            ui_scale: 100,
            message_font_size: 15,
            personality: "pragmatic".to_string(),
            custom_instructions: String::new(),
            suggested_prompts: true,
            memory_enabled: true,
            plan_tracking_enabled: true,
            hooks_enabled: false,
            hooks_inherit_environment: false,
            hooks: Vec::new(),
            subagents_enabled: true,
            subagent_max_concurrency: 3,
            browser_enabled: true,
            browser_headless: true,
            browser_profile_mode: "temporary".to_string(),
            browser_confirm_actions: true,
            browser_executable: String::new(),
            computer_enabled: true,
            computer_confirm_actions: true,
            mcp_enabled: true,
            mcp_confirm_tools: true,
            mcp_servers: Vec::new(),
            review_delivery: "inline".to_string(),
            branch_prefix: "pi/".to_string(),
            allow_force_push: false,
            commit_message_instructions: String::new(),
            pull_request_instructions: String::new(),
            log_level: "info".to_string(),
            shortcut_new_chat: "Ctrl+Shift+N".to_string(),
            shortcut_settings: "Ctrl+,".to_string(),
            shortcut_terminal: "Ctrl+Shift+T".to_string(),
            shortcut_changes: "Ctrl+Shift+G".to_string(),
            shortcut_toggle_sidebar: "Ctrl+B".to_string(),
            archived_sessions: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct McpServerSecrets {
    pub(crate) env: HashMap<String, String>,
    pub(crate) headers: HashMap<String, String>,
}

pub(crate) type McpSecrets = HashMap<String, McpServerSecrets>;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ProjectConfig {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) pinned: bool,
    pub(crate) hidden: bool,
}

pub(crate) fn app_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("pid-desktop")
}

pub(crate) fn settings_path() -> PathBuf {
    app_config_dir().join("settings.json")
}

pub(crate) fn mcp_secrets_path() -> PathBuf {
    app_config_dir().join("mcp-secrets.dat")
}

pub(crate) fn projects_path() -> PathBuf {
    app_config_dir().join("projects.json")
}

pub(crate) fn normalize_path_key(path: &str) -> String {
    path.trim()
        .trim_end_matches(['\\', '/'])
        .replace('\\', "/")
        .to_lowercase()
}

pub(crate) fn load_json_list<T: for<'de> Deserialize<'de>>(path: &Path) -> Vec<T> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn save_json_list<T: Serialize>(path: &Path, values: &[T]) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| AppError::Io(format!("failed to create data directory: {err}")))?;
    }
    let raw = serde_json::to_string_pretty(values)
        .map_err(|err| AppError::Other(format!("failed to serialize data: {err}")))?;
    fs::write(path, raw).map_err(|err| AppError::Io(format!("failed to write data: {err}")))
}

pub(crate) fn collect_mcp_secrets(settings: &AppSettings) -> McpSecrets {
    settings
        .mcp_servers
        .iter()
        .filter(|server| !server.env.is_empty() || !server.headers.is_empty())
        .map(|server| {
            (
                server.id.clone(),
                McpServerSecrets {
                    env: server.env.clone(),
                    headers: server.headers.clone(),
                },
            )
        })
        .collect()
}

pub(crate) fn without_mcp_secrets(settings: &AppSettings) -> AppSettings {
    let mut public = settings.clone();
    for server in &mut public.mcp_servers {
        server.env.clear();
        server.headers.clear();
    }
    public
}

pub(crate) fn apply_mcp_secrets(settings: &mut AppSettings, secrets: &McpSecrets) {
    for server in &mut settings.mcp_servers {
        if let Some(saved) = secrets.get(&server.id) {
            server.env.clone_from(&saved.env);
            server.headers.clone_from(&saved.headers);
        }
    }
}

pub(crate) fn merge_mcp_secret_sets(target: &mut McpSecrets, source: McpSecrets) {
    for (id, source) in source {
        let entry = target.entry(id).or_default();
        entry.env.extend(source.env);
        entry.headers.extend(source.headers);
    }
}

pub(crate) fn redact_mcp_secrets(settings: &AppSettings) -> AppSettings {
    let mut redacted = settings.clone();
    for server in &mut redacted.mcp_servers {
        server
            .env
            .values_mut()
            .for_each(|value| *value = MCP_SECRET_PLACEHOLDER.to_string());
        server
            .headers
            .values_mut()
            .for_each(|value| *value = MCP_SECRET_PLACEHOLDER.to_string());
    }
    redacted
}

pub(crate) fn resolve_mcp_secret_placeholders(
    incoming: &mut AppSettings,
    current: &AppSettings,
) -> Result<(), AppError> {
    for server in &mut incoming.mcp_servers {
        let existing = current.mcp_servers.iter().find(|item| item.id == server.id);
        for (key, value) in &mut server.env {
            if value == MCP_SECRET_PLACEHOLDER {
                *value = existing
                    .and_then(|item| item.env.get(key))
                    .cloned()
                    .ok_or_else(|| {
                        format!(
                            "MCP server {} credential {key} must be re-entered",
                            server.id
                        )
                    })?;
            }
        }
        for (key, value) in &mut server.headers {
            if value == MCP_SECRET_PLACEHOLDER {
                *value = existing
                    .and_then(|item| item.headers.get(key))
                    .cloned()
                    .ok_or_else(|| {
                        format!("MCP server {} header {key} must be re-entered", server.id)
                    })?;
            }
        }
    }
    Ok(())
}

pub(crate) fn load_mcp_secrets() -> Result<McpSecrets, AppError> {
    let path = mcp_secrets_path();
    if !path.exists() {
        return Ok(McpSecrets::new());
    }
    let protected = fs::read(&path)
        .map_err(|err| AppError::Io(format!("failed to read encrypted MCP credentials: {err}")))?;
    let mut plaintext = secret_store::unprotect(&protected)?;
    let parsed = serde_json::from_slice(&plaintext)
        .map_err(|err| AppError::Other(format!("encrypted MCP credentials are invalid: {err}")));
    plaintext.fill(0);
    parsed
}

pub(crate) fn save_mcp_secrets(secrets: &McpSecrets) -> Result<(), AppError> {
    let path = mcp_secrets_path();
    if secrets.is_empty() {
        if path.exists() {
            fs::remove_file(path).map_err(|err| {
                AppError::Io(format!("failed to remove encrypted MCP credentials: {err}"))
            })?;
        }
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| AppError::Io(format!("failed to create settings directory: {err}")))?;
    }
    let mut plaintext = serde_json::to_vec(secrets)
        .map_err(|err| AppError::Other(format!("failed to serialize MCP credentials: {err}")))?;
    let protected = secret_store::protect(&plaintext);
    plaintext.fill(0);
    fs::write(&path, protected?)
        .map_err(|err| AppError::Io(format!("failed to write encrypted MCP credentials: {err}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|err| {
            AppError::Io(format!(
                "failed to restrict MCP credential permissions: {err}"
            ))
        })?;
    }
    Ok(())
}

pub(crate) fn write_public_settings(settings: &AppSettings) -> Result<(), AppError> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| AppError::Io(format!("failed to create settings directory: {err}")))?;
    }
    let raw = serde_json::to_string_pretty(&without_mcp_secrets(settings))
        .map_err(|err| AppError::Other(format!("failed to serialize settings: {err}")))?;
    fs::write(path, raw).map_err(|err| AppError::Io(format!("failed to write settings: {err}")))
}

pub(crate) fn load_settings() -> AppSettings {
    let mut settings: AppSettings = fs::read_to_string(settings_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let legacy_secrets = collect_mcp_secrets(&settings);
    let mut secrets = match load_mcp_secrets() {
        Ok(secrets) => secrets,
        Err(err) => {
            eprintln!("PIDesktop could not load protected MCP credentials: {err}");
            McpSecrets::new()
        }
    };
    merge_mcp_secret_sets(&mut secrets, legacy_secrets.clone());
    settings = without_mcp_secrets(&settings);
    apply_mcp_secrets(&mut settings, &secrets);

    let mut typography_migrated = false;
    if settings.ui_font.trim() == LEGACY_UI_FONT {
        settings.ui_font = CODEX_UI_FONT.to_string();
        typography_migrated = true;
    }
    if settings.code_font.trim() == LEGACY_CODE_FONT {
        settings.code_font = CODEX_CODE_FONT.to_string();
        typography_migrated = true;
    }

    if !legacy_secrets.is_empty() {
        match save_mcp_secrets(&secrets) {
            Ok(()) => {
                if let Err(err) = write_public_settings(&settings) {
                    eprintln!(
                        "PIDesktop could not remove migrated MCP credentials from settings: {err}"
                    );
                }
            }
            Err(err) => eprintln!("PIDesktop could not migrate MCP credentials: {err}"),
        }
    }
    if typography_migrated {
        if let Err(err) = write_public_settings(&settings) {
            eprintln!("PIDesktop could not migrate Codex typography defaults: {err}");
        }
    }
    let _ = fs::remove_file(app_config_dir().join("mcp-servers.json"));
    settings
}

pub(crate) fn save_settings(settings: &AppSettings) -> Result<(), AppError> {
    save_mcp_secrets(&collect_mcp_secrets(settings))?;
    write_public_settings(settings)?;
    let _ = fs::remove_file(app_config_dir().join("mcp-servers.json"));
    Ok(())
}

/// Mirrors `AppSettings::separate_pi_config` for code that has no settings at hand.
static SEPARATE_PI_CONFIG: AtomicBool = AtomicBool::new(false);

/// The config directory the terminal `pi` used.
pub(crate) fn shared_pi_agent_dir() -> PathBuf {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".pi").join("agent")))
        .unwrap_or_else(|| PathBuf::from(".pi").join("agent"))
}

/// The app's own Pi config directory, used when the settings kept the app apart from the terminal.
pub(crate) fn app_pi_agent_dir() -> PathBuf {
    app_config_dir().join("pi-agent")
}

/// Where Pi's models.json, auth.json, skills, themes and pets were: what the
/// one-time imports into the Harness Host read (P5a, P6a).
pub(crate) fn pi_agent_dir() -> PathBuf {
    if SEPARATE_PI_CONFIG.load(Ordering::Relaxed) {
        app_pi_agent_dir()
    } else {
        shared_pi_agent_dir()
    }
}

/// Remember which Pi config directory the settings named.
pub(crate) fn remember_pi_config(separate: bool) {
    SEPARATE_PI_CONFIG.store(separate, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_rule_env_flags_roundtrip_defaults() {
        let settings = AppSettings::default();
        assert!(settings.always_confirm_shell);
        assert!(settings.block_write_outside_workspace);
        assert!(settings.shell_allow_prefixes.is_empty());
        assert_eq!(settings.default_task_environment, "local");
        assert_eq!(settings.browser_profile_mode, "temporary");
    }

    #[test]
    fn mcp_credentials_are_separated_redacted_and_restored() {
        let mut settings = AppSettings::default();
        settings.mcp_servers.push(McpServerConfig {
            id: "private-server".to_string(),
            env: HashMap::from([("API_TOKEN".to_string(), "env-secret".to_string())]),
            headers: HashMap::from([(
                "Authorization".to_string(),
                "Bearer header-secret".to_string(),
            )]),
            ..Default::default()
        });

        let secrets = collect_mcp_secrets(&settings);
        let public = without_mcp_secrets(&settings);
        assert!(public.mcp_servers[0].env.is_empty());
        assert!(public.mcp_servers[0].headers.is_empty());

        let redacted = redact_mcp_secrets(&settings);
        assert_eq!(
            redacted.mcp_servers[0].env["API_TOKEN"],
            MCP_SECRET_PLACEHOLDER
        );
        assert_eq!(
            redacted.mcp_servers[0].headers["Authorization"],
            MCP_SECRET_PLACEHOLDER
        );

        let mut restored = public;
        apply_mcp_secrets(&mut restored, &secrets);
        assert_eq!(restored.mcp_servers[0].env["API_TOKEN"], "env-secret");
        assert_eq!(
            restored.mcp_servers[0].headers["Authorization"],
            "Bearer header-secret"
        );
    }

    #[test]
    fn mcp_secret_placeholders_keep_existing_values() {
        let mut current = AppSettings::default();
        current.mcp_servers.push(McpServerConfig {
            id: "server".to_string(),
            env: HashMap::from([("TOKEN".to_string(), "existing-secret".to_string())]),
            ..Default::default()
        });
        let mut incoming = redact_mcp_secrets(&current);
        resolve_mcp_secret_placeholders(&mut incoming, &current)
            .expect("placeholder should resolve from current settings");
        assert_eq!(incoming.mcp_servers[0].env["TOKEN"], "existing-secret");
    }

    #[test]
    fn pi_imports_read_the_terminal_config_unless_the_app_had_its_own() {
        // The process-wide switch is left alone here: other tests read the config directory too.
        assert!(!SEPARATE_PI_CONFIG.load(Ordering::Relaxed));
        assert_eq!(pi_agent_dir(), shared_pi_agent_dir());
        assert_eq!(app_pi_agent_dir(), app_config_dir().join("pi-agent"));
    }
}
