#[cfg(windows)]
mod computer;
mod pi;
mod scheduler;
mod secret_store;
mod terminal;
mod workspace_files;

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};

use pi::process::{run_pi_print, PiPrintLimits};
use pi::rpc::PiRpcClient;
use pi::session_display::collapse_unchanged_session_forks;
use pi::sessions::{
    list_sessions, parse_session_file, session_history, session_message_timings, session_messages,
    trash_session, validate_session_path, SessionHistory, SessionInfo, SessionMessageTiming,
};
use scheduler::ScheduledRunRecord;
use workspace_files::WorkspaceDirEntry;

const GUARD_EXTENSION: &str = include_str!("../resources/pidesktop-guard.ts");
const RULES_MODULE: &str = include_str!("../resources/pidesktop-rules.ts");
const CHECKPOINTS_MODULE: &str = include_str!("../resources/pidesktop-checkpoints.ts");
const PLAN_CORE_MODULE: &str = include_str!("../resources/pidesktop-plan-core.ts");
const PLAN_EXTENSION: &str = include_str!("../resources/pidesktop-plan.ts");
const HOOKS_CORE_MODULE: &str = include_str!("../resources/pidesktop-hooks-core.ts");
const HOOKS_EXTENSION: &str = include_str!("../resources/pidesktop-hooks.ts");
const SUBAGENTS_CORE_MODULE: &str = include_str!("../resources/pidesktop-subagents-core.ts");
const SUBAGENTS_EXTENSION: &str = include_str!("../resources/pidesktop-subagents.ts");
const MEMORY_EXTENSION: &str = include_str!("../resources/pidesktop-memory.ts");
const MEMORY_CORE_MODULE: &str = include_str!("../resources/pidesktop-memory-core.ts");
const BROWSER_EXTENSION: &str = include_str!("../resources/pidesktop-browser.ts");
const COMPUTER_EXTENSION: &str = include_str!("../resources/pidesktop-computer.ts");
const MCP_EXTENSION: &str = include_str!("../resources/pidesktop-mcp.ts");
const MCP_SECRET_PLACEHOLDER: &str = "••••••••";

#[cfg(windows)]
static KEEP_AWAKE: AtomicBool = AtomicBool::new(false);
static NEXT_RUNTIME_ID: AtomicU64 = AtomicU64::new(1);
const MAX_CONCURRENT_SCHEDULED_RUNS: usize = 2;

#[cfg(windows)]
unsafe extern "system" {
    fn SetThreadExecutionState(es_flags: u32) -> u32;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct AppSettings {
    #[serde(alias = "pi_binary")]
    pi_binary: String,
    provider: String,
    model: String,
    #[serde(alias = "thinking_level")]
    thinking_level: String,
    #[serde(alias = "session_dir")]
    session_dir: String,
    agent_mode: String,
    #[serde(alias = "permission_mode")]
    permission_mode: String,
    /// When true, shell/bash/exec always requires confirmation (unless full-access).
    always_confirm_shell: bool,
    /// When true, writes outside the workspace root are blocked without a confirm dialog.
    block_write_outside_workspace: bool,
    /// Newline- or comma-separated command prefixes that skip shell confirmation under ask/workspace-write.
    shell_allow_prefixes: String,
    tool_rules: Vec<ToolPermissionRule>,
    /// Default new-task environment: "local" or "worktree".
    default_task_environment: String,
    #[serde(alias = "show_thinking")]
    show_thinking: bool,
    #[serde(alias = "auto_connect")]
    auto_connect: bool,
    follow_up_behavior: String,
    require_ctrl_enter: bool,
    prevent_sleep: bool,
    language: String,
    default_file_opener: String,
    terminal_shell: String,
    terminal_output: String,
    notifications_enabled: bool,
    notify_on_completion: bool,
    notify_on_approval: bool,
    notify_only_when_unfocused: bool,
    theme: String,
    pet_enabled: bool,
    pet_character: String,
    pet_size: u16,
    accent_color: String,
    background_color: String,
    foreground_color: String,
    ui_font: String,
    code_font: String,
    ui_scale: u16,
    personality: String,
    custom_instructions: String,
    suggested_prompts: bool,
    memory_enabled: bool,
    plan_tracking_enabled: bool,
    hooks_enabled: bool,
    hooks_inherit_environment: bool,
    hooks: Vec<DesktopHookConfig>,
    subagents_enabled: bool,
    subagent_max_concurrency: u8,
    browser_enabled: bool,
    browser_headless: bool,
    browser_profile_mode: String,
    browser_confirm_actions: bool,
    browser_executable: String,
    computer_enabled: bool,
    computer_confirm_actions: bool,
    mcp_enabled: bool,
    mcp_confirm_tools: bool,
    mcp_servers: Vec<McpServerConfig>,
    review_delivery: String,
    branch_prefix: String,
    allow_force_push: bool,
    commit_message_instructions: String,
    pull_request_instructions: String,
    log_level: String,
    shortcut_new_chat: String,
    shortcut_settings: String,
    shortcut_terminal: String,
    shortcut_changes: String,
    shortcut_toggle_sidebar: String,
    archived_sessions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct McpServerConfig {
    id: String,
    name: String,
    enabled: bool,
    transport: String,
    command: String,
    args: Vec<String>,
    cwd: String,
    env: HashMap<String, String>,
    inherit_environment: bool,
    url: String,
    headers: HashMap<String, String>,
    trusted_read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct DesktopHookConfig {
    id: String,
    name: String,
    enabled: bool,
    event: String,
    command: String,
    timeout_seconds: u16,
    blocking: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ToolPermissionRule {
    id: String,
    enabled: bool,
    tool_pattern: String,
    action: String,
    command_prefix: String,
    path_prefix: String,
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

const CODEX_UI_FONT: &str = "-apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif";
const CODEX_CODE_FONT: &str =
    "ui-monospace, \"SFMono-Regular\", \"SF Mono\", Menlo, Consolas, \"Liberation Mono\", monospace";
const LEGACY_UI_FONT: &str = "Inter, Segoe UI, system-ui, sans-serif";
const LEGACY_CODE_FONT: &str = "JetBrains Mono, Consolas, monospace";

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

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            pi_binary: "pi".to_string(),
            provider: String::new(),
            model: String::new(),
            thinking_level: "medium".to_string(),
            session_dir: String::new(),
            agent_mode: "agent".to_string(),
            permission_mode: "ask".to_string(),
            always_confirm_shell: true,
            block_write_outside_workspace: true,
            shell_allow_prefixes: String::new(),
            tool_rules: Vec::new(),
            default_task_environment: "local".to_string(),
            show_thinking: true,
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

impl AppSettings {
    // Extension paths remain explicit because each module is provisioned independently.
    #[allow(clippy::too_many_arguments)]
    fn rpc_extra_args(
        &self,
        guard_extension: &Path,
        browser_extension: Option<&Path>,
        computer_extension: Option<&Path>,
        mcp_extension: Option<&Path>,
        plan_extension: Option<&Path>,
        hooks_extension: Option<&Path>,
        subagents_extension: Option<&Path>,
        memory_extension: Option<&Path>,
    ) -> Vec<String> {
        let mut args = vec![
            "-e".to_string(),
            guard_extension.to_string_lossy().to_string(),
        ];
        if let Some(browser_extension) = browser_extension {
            args.extend([
                "-e".to_string(),
                browser_extension.to_string_lossy().to_string(),
            ]);
        }
        if let Some(computer_extension) = computer_extension {
            args.extend([
                "-e".to_string(),
                computer_extension.to_string_lossy().to_string(),
            ]);
        }
        if let Some(mcp_extension) = mcp_extension {
            args.extend([
                "-e".to_string(),
                mcp_extension.to_string_lossy().to_string(),
            ]);
        }
        if let Some(plan_extension) = plan_extension {
            args.extend([
                "-e".to_string(),
                plan_extension.to_string_lossy().to_string(),
            ]);
        }
        if let Some(hooks_extension) = hooks_extension {
            args.extend([
                "-e".to_string(),
                hooks_extension.to_string_lossy().to_string(),
            ]);
        }
        if let Some(subagents_extension) = subagents_extension {
            args.extend([
                "-e".to_string(),
                subagents_extension.to_string_lossy().to_string(),
            ]);
        }
        if let Some(memory_extension) = memory_extension {
            args.extend([
                "-e".to_string(),
                memory_extension.to_string_lossy().to_string(),
            ]);
        }
        if !self.provider.is_empty() {
            args.extend(["--provider".to_string(), self.provider.clone()]);
        }
        if !self.model.is_empty() {
            args.extend(["--model".to_string(), self.model.clone()]);
        }
        if !self.thinking_level.is_empty() {
            args.extend(["--thinking".to_string(), self.thinking_level.clone()]);
        }
        if !self.session_dir.is_empty() {
            args.extend(["--session-dir".to_string(), self.session_dir.clone()]);
        }
        let personality = match self.personality.as_str() {
            "friendly" => "Communication style: be warm, collaborative, and clear while remaining technically precise.",
            "pragmatic" => "Communication style: be direct, implementation-focused, and concise. Lead with concrete outcomes.",
            _ => "",
        };
        let instructions = [personality, self.custom_instructions.trim()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        if !instructions.is_empty() {
            if let Ok(path) = ensure_personal_instructions(&instructions) {
                args.extend([
                    "--append-system-prompt".to_string(),
                    path.to_string_lossy().to_string(),
                ]);
            }
        }
        if !self.memory_enabled {
            args.push("--no-context-files".to_string());
        } else {
            let memory = local_memory_path();
            if memory.is_file() && fs::metadata(&memory).is_ok_and(|metadata| metadata.len() > 0) {
                args.extend([
                    "--append-system-prompt".to_string(),
                    memory.to_string_lossy().to_string(),
                ]);
            }
        }
        args
    }
}

struct PiRuntime {
    client: PiRpcClient,
    cwd: String,
    session_file: Option<String>,
    isolated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    runtime_id: String,
    cwd: String,
    session_file: Option<String>,
    is_streaming: bool,
    pending_extension: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
struct McpServerSecrets {
    env: HashMap<String, String>,
    headers: HashMap<String, String>,
}

type McpSecrets = HashMap<String, McpServerSecrets>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ModelProviderModel {
    id: String,
    name: String,
    reasoning: bool,
    input: Vec<String>,
    context_window: Option<u64>,
    max_tokens: Option<u64>,
}

impl Default for ModelProviderModel {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            reasoning: false,
            input: vec!["text".to_string()],
            context_window: None,
            max_tokens: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelProviderConfig {
    id: String,
    name: String,
    base_url: String,
    api: String,
    has_api_key: bool,
    api_key_source: String,
    auth_header: bool,
    models: Vec<ModelProviderModel>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ModelProviderInput {
    original_id: Option<String>,
    id: String,
    name: String,
    base_url: String,
    api: String,
    api_key: String,
    keep_existing_api_key: bool,
    auth_header: bool,
    models: Vec<ModelProviderModel>,
}

impl Default for ModelProviderInput {
    fn default() -> Self {
        Self {
            original_id: None,
            id: String::new(),
            name: String::new(),
            base_url: String::new(),
            api: "openai-completions".to_string(),
            api_key: String::new(),
            keep_existing_api_key: false,
            auth_header: false,
            models: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize)]
struct ModelProviderCheckResult {
    ok: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PiStartResult {
    runtime_id: String,
    session_loaded: bool,
    session_forked: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ProjectConfig {
    path: String,
    name: String,
    pinned: bool,
    hidden: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ScheduledTask {
    id: String,
    name: String,
    prompt: String,
    cwd: String,
    frequency: String,
    hour: u8,
    minute: u8,
    weekday: u8,
    #[serde(default = "default_scheduled_permission_mode")]
    permission_mode: String,
    timeout_minutes: Option<u16>,
    enabled: bool,
    last_run_at: Option<u64>,
    next_run_at: Option<u64>,
    last_status: String,
    last_message: String,
}

fn default_scheduled_permission_mode() -> String {
    "ask".to_string()
}

fn is_safe_scheduled_permission_mode(mode: &str) -> bool {
    matches!(mode, "read-only" | "ask" | "workspace-write")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledRunResult {
    success: bool,
    output: String,
    run: ScheduledRunRecord,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestInfo {
    number: u64,
    title: String,
    state: String,
    is_draft: bool,
    head_ref_name: String,
    base_ref_name: String,
    updated_at: String,
    url: String,
    author: String,
    review_decision: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestCollection {
    repository: String,
    remote_url: String,
    items: Vec<PullRequestInfo>,
}

struct AppState {
    runtimes: Mutex<HashMap<String, PiRuntime>>,
    settings: Mutex<AppSettings>,
    bundled_pi_binary: Option<PathBuf>,
    projects: Mutex<Vec<ProjectConfig>>,
    scheduled_tasks: Mutex<Vec<ScheduledTask>>,
    running_scheduled_tasks: Mutex<HashMap<String, Arc<AtomicBool>>>,
    workspace_searches: Mutex<HashMap<String, Arc<AtomicBool>>>,
    terminal_sessions: terminal::TerminalSessions,
}

impl Drop for AppState {
    fn drop(&mut self) {
        let session_dir = self
            .settings
            .get_mut()
            .map(|settings| settings.session_dir.clone())
            .unwrap_or_default();
        let Ok(runtimes) = self.runtimes.get_mut() else {
            return;
        };
        for (_, runtime) in runtimes.drain() {
            runtime.client.kill();
            if runtime.isolated {
                if let Some(file) = runtime.session_file {
                    let _ = trash_session(&session_dir, &file);
                }
            }
        }
    }
}

fn effective_pi_binary(settings: &AppSettings, state: &AppState) -> String {
    let configured =
        pi::runtime::resolve_pi_binary(&settings.pi_binary, state.bundled_pi_binary.as_deref());
    #[cfg(windows)]
    return resolve_windows_pi_binary(&configured);
    #[cfg(not(windows))]
    configured
}

fn app_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("pid-desktop")
}

fn settings_path() -> PathBuf {
    app_config_dir().join("settings.json")
}

fn mcp_secrets_path() -> PathBuf {
    app_config_dir().join("mcp-secrets.dat")
}

fn projects_path() -> PathBuf {
    app_config_dir().join("projects.json")
}

fn scheduled_tasks_path() -> PathBuf {
    app_config_dir().join("scheduled-tasks.json")
}

fn scheduled_runs_path() -> PathBuf {
    app_config_dir().join("scheduled-runs.sqlite3")
}

fn normalize_path_key(path: &str) -> String {
    path.trim()
        .trim_end_matches(['\\', '/'])
        .replace('\\', "/")
        .to_lowercase()
}

fn load_json_list<T: for<'de> Deserialize<'de>>(path: &Path) -> Vec<T> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_json_list<T: Serialize>(path: &Path, values: &[T]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create data directory: {err}"))?;
    }
    let raw = serde_json::to_string_pretty(values)
        .map_err(|err| format!("failed to serialize data: {err}"))?;
    fs::write(path, raw).map_err(|err| format!("failed to write data: {err}"))
}

#[tauri::command]
fn quick_chat_dir() -> Result<String, String> {
    let path = app_config_dir().join("quick-chat");
    fs::create_dir_all(&path)
        .map_err(|err| format!("failed to create quick chat directory: {err}"))?;
    Ok(path.to_string_lossy().to_string())
}

fn collect_mcp_secrets(settings: &AppSettings) -> McpSecrets {
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

fn without_mcp_secrets(settings: &AppSettings) -> AppSettings {
    let mut public = settings.clone();
    for server in &mut public.mcp_servers {
        server.env.clear();
        server.headers.clear();
    }
    public
}

fn apply_mcp_secrets(settings: &mut AppSettings, secrets: &McpSecrets) {
    for server in &mut settings.mcp_servers {
        if let Some(saved) = secrets.get(&server.id) {
            server.env.clone_from(&saved.env);
            server.headers.clone_from(&saved.headers);
        }
    }
}

fn merge_mcp_secret_sets(target: &mut McpSecrets, source: McpSecrets) {
    for (id, source) in source {
        let entry = target.entry(id).or_default();
        entry.env.extend(source.env);
        entry.headers.extend(source.headers);
    }
}

fn redact_mcp_secrets(settings: &AppSettings) -> AppSettings {
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

fn resolve_mcp_secret_placeholders(
    incoming: &mut AppSettings,
    current: &AppSettings,
) -> Result<(), String> {
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

fn load_mcp_secrets() -> Result<McpSecrets, String> {
    let path = mcp_secrets_path();
    if !path.exists() {
        return Ok(McpSecrets::new());
    }
    let protected = fs::read(&path)
        .map_err(|err| format!("failed to read encrypted MCP credentials: {err}"))?;
    let mut plaintext = secret_store::unprotect(&protected)?;
    let parsed = serde_json::from_slice(&plaintext)
        .map_err(|err| format!("encrypted MCP credentials are invalid: {err}"));
    plaintext.fill(0);
    parsed
}

fn save_mcp_secrets(secrets: &McpSecrets) -> Result<(), String> {
    let path = mcp_secrets_path();
    if secrets.is_empty() {
        if path.exists() {
            fs::remove_file(path)
                .map_err(|err| format!("failed to remove encrypted MCP credentials: {err}"))?;
        }
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create settings directory: {err}"))?;
    }
    let mut plaintext = serde_json::to_vec(secrets)
        .map_err(|err| format!("failed to serialize MCP credentials: {err}"))?;
    let protected = secret_store::protect(&plaintext);
    plaintext.fill(0);
    fs::write(&path, protected?)
        .map_err(|err| format!("failed to write encrypted MCP credentials: {err}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("failed to restrict MCP credential permissions: {err}"))?;
    }
    Ok(())
}

fn write_public_settings(settings: &AppSettings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create settings directory: {err}"))?;
    }
    let raw = serde_json::to_string_pretty(&without_mcp_secrets(settings))
        .map_err(|err| format!("failed to serialize settings: {err}"))?;
    fs::write(path, raw).map_err(|err| format!("failed to write settings: {err}"))
}

fn load_settings() -> AppSettings {
    let mut settings = fs::read_to_string(settings_path())
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

fn save_settings(settings: &AppSettings) -> Result<(), String> {
    save_mcp_secrets(&collect_mcp_secrets(settings))?;
    write_public_settings(settings)?;
    let _ = fs::remove_file(app_config_dir().join("mcp-servers.json"));
    Ok(())
}

#[tauri::command]
fn list_projects_cmd(state: State<'_, AppState>) -> Result<Vec<ProjectConfig>, String> {
    state
        .projects
        .lock()
        .map(|projects| projects.clone())
        .map_err(|_| "project state lock poisoned".to_string())
}

#[tauri::command]
fn register_project_cmd(state: State<'_, AppState>, path: String) -> Result<ProjectConfig, String> {
    if path.trim().is_empty() {
        return Err("project path is required".to_string());
    }
    if !Path::new(&path).is_dir() {
        return Err("project directory does not exist".to_string());
    }
    let key = normalize_path_key(&path);
    let mut projects = state
        .projects
        .lock()
        .map_err(|_| "project state lock poisoned".to_string())?;
    let project = if let Some(existing) = projects
        .iter_mut()
        .find(|project| normalize_path_key(&project.path) == key)
    {
        existing.path = path;
        existing.hidden = false;
        existing.clone()
    } else {
        let project = ProjectConfig {
            path,
            ..ProjectConfig::default()
        };
        projects.push(project.clone());
        project
    };
    save_json_list(&projects_path(), &projects)?;
    Ok(project)
}

#[tauri::command]
fn save_project_cmd(
    state: State<'_, AppState>,
    project: ProjectConfig,
) -> Result<ProjectConfig, String> {
    if project.path.trim().is_empty() {
        return Err("project path is required".to_string());
    }
    let key = normalize_path_key(&project.path);
    let mut projects = state
        .projects
        .lock()
        .map_err(|_| "project state lock poisoned".to_string())?;
    if let Some(existing) = projects
        .iter_mut()
        .find(|entry| normalize_path_key(&entry.path) == key)
    {
        *existing = project.clone();
    } else {
        projects.push(project.clone());
    }
    save_json_list(&projects_path(), &projects)?;
    Ok(project)
}

#[tauri::command]
fn remove_local_project_cmd(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let key = normalize_path_key(&path);
    let mut projects = state
        .projects
        .lock()
        .map_err(|_| "project state lock poisoned".to_string())?;
    if let Some(existing) = projects
        .iter_mut()
        .find(|project| normalize_path_key(&project.path) == key)
    {
        existing.hidden = true;
    } else {
        projects.push(ProjectConfig {
            path,
            hidden: true,
            ..ProjectConfig::default()
        });
    }
    save_json_list(&projects_path(), &projects)
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn truncate_scheduled_output(value: &str, limit: usize) -> String {
    let mut chars = value.chars();
    let mut result: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        result.push_str("\n... output truncated by PIDesktop");
    }
    result
}

struct ScheduledTaskRunGuard<'a> {
    running: &'a Mutex<HashMap<String, Arc<AtomicBool>>>,
    id: String,
    cancelled: Arc<AtomicBool>,
}

impl ScheduledTaskRunGuard<'_> {
    fn cancellation(&self) -> &AtomicBool {
        &self.cancelled
    }
}

impl Drop for ScheduledTaskRunGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut running) = self.running.lock() {
            running.remove(&self.id);
        }
    }
}

fn reserve_scheduled_task<'a>(
    state: &'a AppState,
    id: &str,
) -> Result<ScheduledTaskRunGuard<'a>, String> {
    let mut running = state
        .running_scheduled_tasks
        .lock()
        .map_err(|_| "scheduled runner state lock poisoned".to_string())?;
    if running.len() >= MAX_CONCURRENT_SCHEDULED_RUNS {
        return Err("scheduled runner is at its concurrency limit".to_string());
    }
    if running.contains_key(id) {
        return Err("scheduled task is already running".to_string());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    running.insert(id.to_string(), Arc::clone(&cancelled));
    Ok(ScheduledTaskRunGuard {
        running: &state.running_scheduled_tasks,
        id: id.to_string(),
        cancelled,
    })
}

fn emit_scheduled_task(app: &AppHandle, task: &ScheduledTask) {
    let _ = app.emit("scheduled-task-updated", task);
}

fn detect_scheduled_session(
    settings: &AppSettings,
    task: &ScheduledTask,
    before: &HashMap<String, Option<u64>>,
) -> Option<String> {
    list_sessions(&settings.session_dir)
        .into_iter()
        .filter(|session| normalize_path_key(&session.cwd) == normalize_path_key(&task.cwd))
        .filter(|session| {
            before
                .get(&session.file)
                .map(|previous| session.updated_at > *previous)
                .unwrap_or(true)
        })
        .max_by_key(|session| session.updated_at.unwrap_or_default())
        .map(|session| session.file)
}

fn execute_scheduled_task(
    app: &AppHandle,
    state: &AppState,
    id: &str,
    trigger: &str,
) -> Result<ScheduledRunResult, String> {
    let reservation = reserve_scheduled_task(state, id)?;
    let started_at = current_time_ms();
    let task = {
        let tasks = state
            .scheduled_tasks
            .lock()
            .map_err(|_| "scheduled task state lock poisoned".to_string())?;
        tasks
            .iter()
            .find(|task| task.id == id)
            .cloned()
            .ok_or_else(|| "scheduled task not found".to_string())?
    };
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .clone();
    let pi_binary = effective_pi_binary(&settings, state);
    let before_sessions: HashMap<String, Option<u64>> = list_sessions(&settings.session_dir)
        .into_iter()
        .filter(|session| normalize_path_key(&session.cwd) == normalize_path_key(&task.cwd))
        .map(|session| (session.file, session.updated_at))
        .collect();
    let mut run = scheduler::begin_run(&scheduled_runs_path(), &task, trigger, started_at)?;

    // Once begin_run succeeds, keep every later failure inside the run result so
    // history cannot be left permanently in the `running` state.
    let running_task_result = (|| -> Result<ScheduledTask, String> {
        let mut tasks = state
            .scheduled_tasks
            .lock()
            .map_err(|_| "scheduled task state lock poisoned".to_string())?;
        let entry = tasks
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "scheduled task not found".to_string())?;
        entry.last_run_at = Some(started_at);
        if trigger == "scheduled" {
            entry.next_run_at = entry
                .enabled
                .then(|| scheduler::next_scheduled_run(entry, started_at.saturating_add(1_000)));
        } else if entry.enabled && entry.next_run_at.is_none() {
            entry.next_run_at = Some(scheduler::next_scheduled_run(entry, started_at));
        }
        entry.last_status = "running".to_string();
        entry.last_message.clear();
        let snapshot = entry.clone();
        save_json_list(&scheduled_tasks_path(), &tasks)?;
        Ok(snapshot)
    })();
    if let Ok(running_task) = &running_task_result {
        emit_scheduled_task(app, running_task);
    }
    let _ = app.emit("scheduled-run-updated", &run);

    let permission_mode = if is_safe_scheduled_permission_mode(&task.permission_mode) {
        task.permission_mode.as_str()
    } else {
        "ask"
    };
    let execution = match running_task_result {
        Ok(_) => (|| {
            let launch = build_pi_launch_config(&settings, &task.cwd, permission_mode, false)?;
            run_pi_print(
                &pi_binary,
                &task.cwd,
                &launch.extra_args,
                &launch.environment,
                &task.prompt,
                reservation.cancellation(),
                PiPrintLimits {
                    timeout: Duration::from_secs(
                        u64::from(task.timeout_minutes.unwrap_or(30).clamp(1, 240)) * 60,
                    ),
                    output_bytes: 128 * 1024,
                },
            )
            .map_err(|err| format!("failed to run scheduled Pi task: {err}"))
        })(),
        Err(err) => Err(format!("failed to mark scheduled task as running: {err}")),
    };
    let (run_status, success, exit_code, message) = match execution {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let success = output
                .status
                .as_ref()
                .is_some_and(|status| status.success())
                && !output.cancelled
                && !output.timed_out;
            let mut message = if output.cancelled {
                "PIDesktop cancelled this scheduled task.".to_string()
            } else if output.timed_out {
                format!(
                    "Scheduled task exceeded its {} minute timeout.",
                    task.timeout_minutes.unwrap_or(30).clamp(1, 240)
                )
            } else if success {
                if stdout.is_empty() {
                    stderr
                } else {
                    stdout
                }
            } else if stderr.is_empty() {
                format!(
                    "Pi exited with {}",
                    output
                        .status
                        .as_ref()
                        .and_then(|status| status.code())
                        .unwrap_or(-1)
                )
            } else {
                stderr
            };
            if output.output_truncated {
                message.push_str("\n... output truncated by PIDesktop while the task was running");
            }
            (
                if output.cancelled {
                    "cancelled"
                } else if output.timed_out {
                    "timed-out"
                } else if success {
                    "success"
                } else {
                    "error"
                }
                .to_string(),
                success,
                output.status.as_ref().and_then(|status| status.code()),
                redact_runtime_output(&settings, &message),
            )
        }
        Err(err) => ("error".to_string(), false, None, err),
    };
    let finished_at = current_time_ms();
    run.status = run_status;
    run.finished_at = Some(finished_at);
    run.duration_ms = Some(finished_at.saturating_sub(started_at));
    run.exit_code = exit_code;
    run.output = truncate_scheduled_output(&message, 100_000);
    run.session_file = detect_scheduled_session(&settings, &task, &before_sessions);
    let history_result = scheduler::finish_run(&scheduled_runs_path(), &run);

    let task_result = (|| -> Result<Option<ScheduledTask>, String> {
        let mut tasks = state
            .scheduled_tasks
            .lock()
            .map_err(|_| "scheduled task state lock poisoned".to_string())?;
        let completed = tasks.iter_mut().find(|entry| entry.id == id).map(|entry| {
            entry.last_status = run.status.clone();
            entry.last_message = truncate_scheduled_output(&message, 2_000);
            entry.clone()
        });
        save_json_list(&scheduled_tasks_path(), &tasks)?;
        Ok(completed)
    })();
    if let Ok(Some(completed_task)) = &task_result {
        emit_scheduled_task(app, completed_task);
    }
    let _ = app.emit("scheduled-run-updated", &run);
    task_result?;
    history_result?;
    Ok(ScheduledRunResult {
        success,
        output: message,
        run,
    })
}

#[tauri::command]
fn list_scheduled_tasks_cmd(state: State<'_, AppState>) -> Result<Vec<ScheduledTask>, String> {
    state
        .scheduled_tasks
        .lock()
        .map(|tasks| tasks.clone())
        .map_err(|_| "scheduled task state lock poisoned".to_string())
}

#[tauri::command]
fn list_scheduled_runs_cmd(
    task_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ScheduledRunRecord>, String> {
    scheduler::list_runs(
        &scheduled_runs_path(),
        task_id.as_deref(),
        limit.unwrap_or(80),
    )
}

#[tauri::command]
fn save_scheduled_task_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
    mut task: ScheduledTask,
) -> Result<ScheduledTask, String> {
    if task.name.trim().is_empty() {
        return Err("task name is required".to_string());
    }
    if task.prompt.trim().is_empty() {
        return Err("task prompt is required".to_string());
    }
    if !Path::new(&task.cwd).is_dir() {
        return Err("task workspace does not exist".to_string());
    }
    if !matches!(
        task.frequency.as_str(),
        "hourly" | "daily" | "weekdays" | "weekly"
    ) {
        return Err("unsupported task frequency".to_string());
    }
    if !is_safe_scheduled_permission_mode(&task.permission_mode) {
        return Err(
            "scheduled task permission mode must be read-only, ask, or workspace-write".to_string(),
        );
    }
    if task
        .timeout_minutes
        .is_some_and(|minutes| !(1..=240).contains(&minutes))
    {
        return Err("scheduled task timeout must be between 1 and 240 minutes".to_string());
    }
    task.hour = task.hour.min(23);
    task.minute = task.minute.min(59);
    task.weekday = task.weekday.min(6);
    task.next_run_at = task
        .enabled
        .then(|| scheduler::next_scheduled_run(&task, current_time_ms()));
    if task.id.trim().is_empty() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        task.id = format!("schedule-{stamp}");
    }
    let mut tasks = state
        .scheduled_tasks
        .lock()
        .map_err(|_| "scheduled task state lock poisoned".to_string())?;
    if let Some(existing) = tasks.iter_mut().find(|entry| entry.id == task.id) {
        *existing = task.clone();
    } else {
        tasks.push(task.clone());
    }
    save_json_list(&scheduled_tasks_path(), &tasks)?;
    emit_scheduled_task(&app, &task);
    Ok(task)
}

#[tauri::command]
fn delete_scheduled_task_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let mut tasks = state
        .scheduled_tasks
        .lock()
        .map_err(|_| "scheduled task state lock poisoned".to_string())?;
    tasks.retain(|task| task.id != id);
    save_json_list(&scheduled_tasks_path(), &tasks)?;
    let _ = app.emit(
        "scheduled-task-updated",
        serde_json::json!({ "id": id, "deleted": true }),
    );
    Ok(())
}

#[tauri::command]
async fn run_scheduled_task_cmd(
    app: AppHandle,
    id: String,
    next_run_at: Option<u64>,
) -> Result<ScheduledRunResult, String> {
    let _ = next_run_at;
    let runner_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = runner_app.state::<AppState>();
        execute_scheduled_task(&runner_app, &state, &id, "manual")
    })
    .await
    .map_err(|err| format!("scheduled task worker failed: {err}"))?
}

#[tauri::command]
fn cancel_scheduled_task_cmd(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let cancellation = state
        .running_scheduled_tasks
        .lock()
        .map_err(|_| "scheduled runner state lock poisoned".to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "scheduled task is not running".to_string())?;
    cancellation.store(true, Ordering::Release);
    Ok(())
}

fn initialize_scheduled_runner(app: &AppHandle) -> Result<(), String> {
    let now = current_time_ms();
    scheduler::recover_interrupted_runs(&scheduled_runs_path(), now)?;
    let state = app.state::<AppState>();
    let mut tasks = state
        .scheduled_tasks
        .lock()
        .map_err(|_| "scheduled task state lock poisoned".to_string())?;
    for task in tasks.iter_mut() {
        if !is_safe_scheduled_permission_mode(&task.permission_mode) {
            task.permission_mode = default_scheduled_permission_mode();
        }
        if task.last_status == "running" {
            task.last_status = "interrupted".to_string();
            task.last_message = "PIDesktop exited before this run completed.".to_string();
        }
        if task.enabled {
            if task.next_run_at.is_none() {
                task.next_run_at = Some(scheduler::next_scheduled_run(task, now));
            }
        } else {
            task.next_run_at = None;
        }
    }
    save_json_list(&scheduled_tasks_path(), &tasks)
}

fn run_due_scheduled_tasks(app: &AppHandle) {
    let state = app.state::<AppState>();
    let available = state
        .running_scheduled_tasks
        .lock()
        .map(|running| MAX_CONCURRENT_SCHEDULED_RUNS.saturating_sub(running.len()))
        .unwrap_or(0);
    if available == 0 {
        return;
    }
    let now = current_time_ms();
    let due_ids: Vec<String> = state
        .scheduled_tasks
        .lock()
        .map(|tasks| {
            tasks
                .iter()
                .filter(|task| {
                    task.enabled && task.next_run_at.is_some_and(|next_run| next_run <= now)
                })
                .take(available)
                .map(|task| task.id.clone())
                .collect()
        })
        .unwrap_or_default();
    for id in due_ids {
        let runner_app = app.clone();
        std::thread::spawn(move || {
            let state = runner_app.state::<AppState>();
            if let Err(error) = execute_scheduled_task(&runner_app, &state, &id, "scheduled") {
                eprintln!("scheduled task {id} failed: {error}");
            }
        });
    }
}

fn ensure_guard_extension() -> Result<PathBuf, String> {
    // Helper modules are imported by the guard extension; keep all files in sync on disk.
    ensure_bundled_extension("pidesktop-rules.ts", RULES_MODULE, "rules")?;
    ensure_bundled_extension(
        "pidesktop-checkpoints.ts",
        CHECKPOINTS_MODULE,
        "checkpoints",
    )?;
    ensure_bundled_extension("pidesktop-guard.ts", GUARD_EXTENSION, "guard")
}

fn ensure_browser_extension() -> Result<PathBuf, String> {
    ensure_bundled_extension("pidesktop-browser.ts", BROWSER_EXTENSION, "browser")
}

fn ensure_computer_extension() -> Result<PathBuf, String> {
    ensure_bundled_extension("pidesktop-computer.ts", COMPUTER_EXTENSION, "computer")
}

fn ensure_mcp_extension() -> Result<PathBuf, String> {
    ensure_bundled_extension("pidesktop-mcp.ts", MCP_EXTENSION, "MCP")
}

fn ensure_plan_extension() -> Result<PathBuf, String> {
    ensure_bundled_extension("pidesktop-plan-core.ts", PLAN_CORE_MODULE, "plan core")?;
    ensure_bundled_extension("pidesktop-plan.ts", PLAN_EXTENSION, "plan")
}

fn ensure_hooks_extension() -> Result<PathBuf, String> {
    ensure_bundled_extension("pidesktop-hooks-core.ts", HOOKS_CORE_MODULE, "hooks core")?;
    ensure_bundled_extension("pidesktop-hooks.ts", HOOKS_EXTENSION, "hooks")
}

fn ensure_subagents_extension() -> Result<PathBuf, String> {
    ensure_bundled_extension(
        "pidesktop-subagents-core.ts",
        SUBAGENTS_CORE_MODULE,
        "subagents core",
    )?;
    ensure_bundled_extension("pidesktop-subagents.ts", SUBAGENTS_EXTENSION, "subagents")
}

fn ensure_memory_extension() -> Result<PathBuf, String> {
    ensure_bundled_extension(
        "pidesktop-memory-core.ts",
        MEMORY_CORE_MODULE,
        "memory core",
    )?;
    ensure_bundled_extension("pidesktop-memory.ts", MEMORY_EXTENSION, "memory")
}

fn ensure_bundled_extension(
    file_name: &str,
    contents: &str,
    label: &str,
) -> Result<PathBuf, String> {
    let path = app_config_dir().join("extensions").join(file_name);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create extension directory: {err}"))?;
    }
    let should_write = fs::read_to_string(&path)
        .map(|current| current != contents)
        .unwrap_or(true);
    if should_write {
        fs::write(&path, contents)
            .map_err(|err| format!("failed to install Pi Desktop {label} extension: {err}"))?;
    }
    Ok(path)
}

fn ensure_personal_instructions(contents: &str) -> Result<PathBuf, String> {
    let path = app_config_dir().join("personal-instructions.md");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create instructions directory: {err}"))?;
    }
    fs::write(&path, contents)
        .map_err(|err| format!("failed to write personal instructions: {err}"))?;
    Ok(path)
}

fn local_memory_path() -> PathBuf {
    app_config_dir().join("memory.md")
}

#[tauri::command]
fn get_local_memory() -> Result<String, String> {
    let path = local_memory_path();
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path).map_err(|err| format!("failed to read local memory: {err}"))
}

#[tauri::command]
fn set_local_memory(contents: String) -> Result<(), String> {
    const MAX_MEMORY_BYTES: usize = 256 * 1024;
    if contents.len() > MAX_MEMORY_BYTES {
        return Err("local memory cannot exceed 256 KB".to_string());
    }
    let path = local_memory_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create local memory directory: {err}"))?;
    }
    fs::write(&path, contents).map_err(|err| format!("failed to write local memory: {err}"))
}

#[tauri::command]
fn export_local_memory(destination: String) -> Result<String, String> {
    let destination = PathBuf::from(destination.trim());
    if destination.as_os_str().is_empty() {
        return Err("memory export path is required".to_string());
    }
    let source = local_memory_path();
    if !source.is_file() {
        return Err("local memory is empty".to_string());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create memory export directory: {err}"))?;
    }
    fs::copy(&source, &destination)
        .map_err(|err| format!("failed to export local memory: {err}"))?;
    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command]
fn delete_local_memory() -> Result<(), String> {
    let path = local_memory_path();
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(path).map_err(|err| format!("failed to delete local memory: {err}"))
}

struct PiLaunchConfig {
    extra_args: Vec<String>,
    environment: Vec<(String, String)>,
    sensitive_values: Vec<String>,
}

fn build_pi_launch_config(
    settings: &AppSettings,
    cwd: &str,
    permission_mode: &str,
    is_quick_chat: bool,
) -> Result<PiLaunchConfig, String> {
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
        let mut raw = serde_json::to_vec(&settings.mcp_servers)
            .map_err(|err| format!("failed to serialize MCP runtime config: {err}"))?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(&raw);
        raw.fill(0);
        encoded
    } else {
        String::new()
    };
    let hooks_config = if settings.hooks_enabled {
        base64::engine::general_purpose::STANDARD.encode(
            serde_json::to_vec(&settings.hooks)
                .map_err(|err| format!("failed to serialize hooks runtime config: {err}"))?,
        )
    } else {
        String::new()
    };
    let tool_rules_config = base64::engine::general_purpose::STANDARD.encode(
        serde_json::to_vec(&settings.tool_rules)
            .map_err(|err| format!("failed to serialize tool rules: {err}"))?,
    );
    let mut sensitive_values = runtime_secret_values(settings);
    if !mcp_config.is_empty() {
        sensitive_values.push(mcp_config.clone());
    }
    if !hooks_config.is_empty() {
        sensitive_values.push(hooks_config.clone());
    }
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
                .map_err(|err| format!("failed to locate Pi Desktop executable: {err}"))?
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
            settings.subagent_max_concurrency.clamp(1, 4).to_string(),
        ),
        (
            "PIDESKTOP_SUBAGENT_PROVIDER".to_string(),
            settings.provider.clone(),
        ),
        (
            "PIDESKTOP_SUBAGENT_MODEL".to_string(),
            settings.model.clone(),
        ),
        (
            "PIDESKTOP_SUBAGENT_THINKING".to_string(),
            settings.thinking_level.clone(),
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

#[tauri::command]
fn pi_start(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    session_file: Option<String>,
    isolated: Option<bool>,
) -> Result<PiStartResult, String> {
    let cwd_path = PathBuf::from(&cwd);
    if !cwd_path.is_dir() {
        return Err(format!("workspace does not exist: {cwd}"));
    }

    let is_isolated = isolated.unwrap_or(false);
    if !is_isolated {
        let mut runtimes = state
            .runtimes
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        runtimes.retain(|_, runtime| runtime.client.is_running());
        if let Some(ref requested_session) = session_file {
            if let Some((runtime_id, _)) = runtimes.iter().find(|(_, runtime)| {
                runtime.session_file.as_ref() == Some(requested_session)
                    && paths_equal(&runtime.cwd, &cwd)
            }) {
                return Ok(PiStartResult {
                    runtime_id: runtime_id.clone(),
                    session_loaded: true,
                    session_forked: false,
                });
            }
            if let Some((runtime_id, _)) = runtimes.iter().find(|(_, runtime)| {
                paths_equal(&runtime.cwd, &cwd)
                    && runtime.session_file.is_none()
                    && !runtime.client.is_streaming()
                    && runtime.client.pending_extension().is_none()
            }) {
                return Ok(PiStartResult {
                    runtime_id: runtime_id.clone(),
                    session_loaded: false,
                    session_forked: false,
                });
            }
            if let Some((runtime_id, _)) = runtimes.iter().find(|(_, runtime)| {
                paths_equal(&runtime.cwd, &cwd)
                    && !runtime.client.is_streaming()
                    && runtime.client.pending_extension().is_none()
            }) {
                return Ok(PiStartResult {
                    runtime_id: runtime_id.clone(),
                    session_loaded: false,
                    session_forked: false,
                });
            }
        } else if let Some((runtime_id, _)) = runtimes.iter().find(|(_, runtime)| {
            paths_equal(&runtime.cwd, &cwd)
                && runtime.session_file.is_none()
                && !runtime.client.is_streaming()
                && runtime.client.pending_extension().is_none()
        }) {
            return Ok(PiStartResult {
                runtime_id: runtime_id.clone(),
                session_loaded: false,
                session_forked: false,
            });
        }
    }

    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .clone();
    let pi_binary = effective_pi_binary(&settings, &state);
    #[cfg(windows)]
    KEEP_AWAKE.store(settings.prevent_sleep, Ordering::Relaxed);
    let quick_root = app_config_dir().join("quick-chat");
    let is_quick_chat = cwd_path
        .canonicalize()
        .ok()
        .zip(quick_root.canonicalize().ok())
        .is_some_and(|(active, quick)| active == quick);
    let mut launch =
        build_pi_launch_config(&settings, &cwd, &settings.permission_mode, is_quick_chat)?;
    let mut initial_session_file = None;
    let mut session_loaded = false;
    let mut session_forked = false;
    if let Some(requested_session) = session_file.as_deref() {
        if let Some(validated) =
            resolve_session_for_launch(&settings.session_dir, requested_session, is_isolated)?
        {
            let validated = validated.to_string_lossy().to_string();
            if is_isolated {
                launch.extra_args.extend(["--fork".to_string(), validated]);
                session_forked = true;
            } else {
                launch
                    .extra_args
                    .extend(["--session".to_string(), validated.clone()]);
                initial_session_file = Some(validated);
                session_loaded = true;
            }
        }
    }
    let runtime_id = format!(
        "runtime-{}-{}",
        std::process::id(),
        NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed)
    );
    let client = PiRpcClient::spawn(
        app,
        &runtime_id,
        &pi_binary,
        &cwd,
        &launch.extra_args,
        &launch.environment,
        &launch.sensitive_values,
    )?;

    state
        .runtimes
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .insert(
            runtime_id.clone(),
            PiRuntime {
                client,
                cwd,
                session_file: initial_session_file,
                isolated: is_isolated,
            },
        );
    Ok(PiStartResult {
        runtime_id,
        session_loaded,
        session_forked,
    })
}

fn resolve_session_for_launch(
    configured_root: &str,
    requested_session: &str,
    is_isolated: bool,
) -> Result<Option<PathBuf>, String> {
    if is_isolated && !Path::new(requested_session).is_file() {
        return Ok(None);
    }
    validate_session_path(configured_root, requested_session).map(Some)
}

fn pi_agent_dir() -> PathBuf {
    std::env::var_os("PI_CODING_AGENT_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".pi").join("agent")))
        .unwrap_or_else(|| PathBuf::from(".pi").join("agent"))
}

fn models_config_path() -> PathBuf {
    pi_agent_dir().join("models.json")
}

#[cfg(windows)]
fn resolve_windows_pi_binary(value: &str) -> String {
    let normalized = value.trim().trim_matches('"');
    if !normalized.eq_ignore_ascii_case("pi") {
        return value.to_string();
    }
    let mut npm_roots = Vec::new();
    if let Some(app_data) = std::env::var_os("APPDATA") {
        npm_roots.push(PathBuf::from(app_data).join("npm"));
    }
    if let Some(data_dir) = dirs::data_dir() {
        npm_roots.push(data_dir.join("npm"));
    }
    if let Some(home) = dirs::home_dir() {
        npm_roots.push(home.join("AppData").join("Roaming").join("npm"));
    }
    for root in npm_roots {
        for file_name in ["pi.cmd", "pi.exe", "pi.bat"] {
            let candidate = root.join(file_name);
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }
    value.to_string()
}

#[cfg(windows)]
fn windows_registry_path_entries() -> Vec<PathBuf> {
    let locations = [
        ("HKCU\\Environment", "Path"),
        (
            "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
            "Path",
        ),
    ];
    let mut entries = Vec::new();
    for (key, name) in locations {
        let Ok(output) = hidden_command("reg.exe")
            .args(["query", key, "/v", name])
            .output()
        else {
            continue;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let value = ["REG_EXPAND_SZ", "REG_SZ"]
                .iter()
                .find_map(|marker| line.find(marker).map(|index| &line[index + marker.len()..]));
            if let Some(value) = value {
                entries.extend(
                    value
                        .trim()
                        .split(';')
                        .map(str::trim)
                        .filter(|entry| !entry.is_empty())
                        .map(PathBuf::from),
                );
            }
        }
    }
    entries
}

#[cfg(windows)]
fn resolve_windows_pi_node_command(pi_binary: &str) -> Option<(PathBuf, PathBuf)> {
    let shim = PathBuf::from(pi_binary);
    let npm_root = shim.parent()?;
    let cli = [
        npm_root
            .join("node_modules")
            .join("@earendil-works")
            .join("pi-coding-agent")
            .join("dist")
            .join("cli.js"),
        npm_root
            .join("node_modules")
            .join("@mariozechner")
            .join("pi-coding-agent")
            .join("dist")
            .join("cli.js"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())?;

    let mut node_candidates = vec![npm_root.join("node.exe")];
    if let Some(path) = std::env::var_os("PATH") {
        node_candidates.extend(std::env::split_paths(&path).map(|entry| entry.join("node.exe")));
    }
    node_candidates.extend(
        windows_registry_path_entries()
            .into_iter()
            .map(|path| path.join("node.exe")),
    );
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        node_candidates.push(PathBuf::from(program_files).join("nodejs").join("node.exe"));
    }
    let node = node_candidates
        .into_iter()
        .find(|candidate| candidate.is_file())?;
    Some((node, cli))
}

#[cfg(windows)]
fn find_windows_executable_in_dirs(program: &str, directories: &[PathBuf]) -> Option<PathBuf> {
    let path = PathBuf::from(program);
    if path.is_file() {
        return Some(path);
    }
    let names = if path.extension().is_some() {
        vec![program.to_string()]
    } else {
        vec![
            format!("{program}.exe"),
            format!("{program}.cmd"),
            format!("{program}.bat"),
            program.to_string(),
        ]
    };
    directories
        .iter()
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|candidate| candidate.is_file())
}

#[cfg(windows)]
fn resolve_windows_executable(program: &str) -> Option<PathBuf> {
    let mut directories = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    directories.extend(windows_registry_path_entries());
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        directories.push(PathBuf::from(program_files).join("GitHub CLI"));
    }
    find_windows_executable_in_dirs(program, &directories)
}

fn github_cli_command() -> Command {
    #[cfg(windows)]
    {
        hidden_command(resolve_windows_executable("gh").unwrap_or_else(|| PathBuf::from("gh")))
    }
    #[cfg(not(windows))]
    {
        hidden_command("gh")
    }
}

fn load_models_config() -> Result<serde_json::Value, String> {
    let path = models_config_path();
    if !path.exists() {
        return Ok(serde_json::json!({ "providers": {} }));
    }
    let raw =
        fs::read_to_string(&path).map_err(|err| format!("无法读取 {}: {err}", path.display()))?;
    let value: serde_json::Value = json5::from_str(&raw)
        .map_err(|err| format!("{} 不是有效的 JSON/JSONC: {err}", path.display()))?;
    if !value.is_object() {
        return Err(format!("{} 的根节点必须是对象", path.display()));
    }
    Ok(value)
}

fn save_models_config(value: &serde_json::Value) -> Result<(), String> {
    let path = models_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("无法创建 Pi 配置目录: {err}"))?;
    }
    if path.exists() {
        let backup = path.with_extension("json.pidesktop.bak");
        fs::copy(&path, &backup).map_err(|err| format!("无法备份 models.json: {err}"))?;
    }
    let raw = serde_json::to_string_pretty(value)
        .map_err(|err| format!("无法序列化 models.json: {err}"))?;
    fs::write(&path, format!("{raw}\n"))
        .map_err(|err| format!("无法写入 {}: {err}", path.display()))
}

fn api_key_source(value: Option<&str>) -> String {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => "none",
        Some(value) if value.starts_with('!') => "command",
        Some(value) if value.starts_with('$') => "environment",
        Some(_) => "stored",
    }
    .to_string()
}

fn runtime_secret_values(settings: &AppSettings) -> Vec<String> {
    let mut values = Vec::new();
    for value in settings
        .mcp_servers
        .iter()
        .flat_map(|server| server.env.values().chain(server.headers.values()))
        .filter(|value| value.len() >= 4)
    {
        values.push(value.clone());
        if let Some((scheme, token)) = value.split_once(' ') {
            if scheme.eq_ignore_ascii_case("bearer") && token.len() >= 4 {
                values.push(token.to_string());
            }
        }
    }

    if let Ok(config) = load_models_config() {
        let provider_keys = config
            .get("providers")
            .and_then(|value| value.as_object())
            .into_iter()
            .flat_map(|providers| providers.values())
            .filter_map(|provider| provider.get("apiKey").and_then(|value| value.as_str()));
        for configured in provider_keys {
            let resolved = configured
                .strip_prefix('$')
                .and_then(|name| std::env::var(name).ok())
                .or_else(|| (!configured.starts_with('!')).then(|| configured.to_string()));
            if let Some(value) = resolved.filter(|value| value.len() >= 4) {
                values.push(value);
            }
        }
    }
    values.sort_by_key(|value| std::cmp::Reverse(value.len()));
    values.dedup();
    values
}

fn redact_runtime_output(settings: &AppSettings, value: &str) -> String {
    pi::rpc::SecretRedactor::new(&runtime_secret_values(settings)).text(value)
}

fn model_from_value(value: &serde_json::Value) -> Option<ModelProviderModel> {
    let object = value.as_object()?;
    let id = object.get("id")?.as_str()?.trim().to_string();
    if id.is_empty() {
        return None;
    }
    Some(ModelProviderModel {
        name: object
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or(&id)
            .to_string(),
        reasoning: object
            .get("reasoning")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        input: object
            .get("input")
            .and_then(|value| value.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .filter(|values: &Vec<String>| !values.is_empty())
            .unwrap_or_else(|| vec!["text".to_string()]),
        context_window: object.get("contextWindow").and_then(|value| value.as_u64()),
        max_tokens: object.get("maxTokens").and_then(|value| value.as_u64()),
        id,
    })
}

fn validate_model_provider(provider: &ModelProviderInput) -> Result<(), String> {
    let id = provider.id.trim();
    if id.is_empty()
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("提供商 ID 只能包含字母、数字、点、短横线和下划线".to_string());
    }
    if provider.original_id.is_none() && provider.models.is_empty() {
        return Err("新提供商至少需要配置一个模型".to_string());
    }
    if provider.original_id.is_none() && provider.base_url.trim().is_empty() {
        return Err("新提供商需要 API 地址".to_string());
    }
    if !(provider.base_url.trim().is_empty()
        || provider.base_url.starts_with("http://")
        || provider.base_url.starts_with("https://"))
    {
        return Err("API 地址必须以 http:// 或 https:// 开头".to_string());
    }
    let supported_apis = [
        "anthropic-messages",
        "openai-completions",
        "openai-responses",
        "azure-openai-responses",
        "openai-codex-responses",
        "mistral-conversations",
        "google-generative-ai",
        "google-vertex",
        "bedrock-converse-stream",
    ];
    if !provider.api.trim().is_empty() && !supported_apis.contains(&provider.api.as_str()) {
        return Err("不支持的 Pi API 协议".to_string());
    }
    let mut model_ids = std::collections::HashSet::new();
    for model in &provider.models {
        let model_id = model.id.trim();
        if model_id.is_empty() || !model_ids.insert(model_id.to_string()) {
            return Err("模型 ID 必须非空且不能重复".to_string());
        }
        if model.context_window == Some(0) || model.max_tokens == Some(0) {
            return Err(format!("模型 {model_id} 的 token 数必须大于 0"));
        }
    }
    Ok(())
}

#[tauri::command]
fn list_model_providers() -> Result<Vec<ModelProviderConfig>, String> {
    let config = load_models_config()?;
    let mut items = config
        .get("providers")
        .and_then(|value| value.as_object())
        .into_iter()
        .flat_map(|providers| providers.iter())
        .filter_map(|(id, value)| {
            let object = value.as_object()?;
            let key = object.get("apiKey").and_then(|value| value.as_str());
            Some(ModelProviderConfig {
                id: id.clone(),
                name: object
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or(id)
                    .to_string(),
                base_url: object
                    .get("baseUrl")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                api: object
                    .get("api")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .to_string(),
                has_api_key: key.is_some_and(|value| !value.trim().is_empty()),
                api_key_source: api_key_source(key),
                auth_header: object
                    .get("authHeader")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false),
                models: object
                    .get("models")
                    .and_then(|value| value.as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(model_from_value)
                    .collect(),
            })
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(items)
}

#[tauri::command]
fn save_model_provider(provider: ModelProviderInput) -> Result<(), String> {
    validate_model_provider(&provider)?;
    let id = provider.id.trim().to_string();
    if let Some(original_id) = provider.original_id.as_deref() {
        if original_id != id {
            return Err("编辑现有提供商时不能修改 ID".to_string());
        }
    }

    let mut config = load_models_config()?;
    let root = config
        .as_object_mut()
        .ok_or_else(|| "models.json 的根节点必须是对象".to_string())?;
    let providers = root
        .entry("providers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "models.json 的 providers 必须是对象".to_string())?;
    if provider.original_id.is_none() && providers.contains_key(&id) {
        return Err(format!("提供商 {id} 已存在"));
    }

    let mut provider_object = providers
        .get(&id)
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let existing_models = provider_object
        .get("models")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    if provider.name.trim().is_empty() || provider.name.trim() == id {
        provider_object.remove("name");
    } else {
        provider_object.insert("name".to_string(), serde_json::json!(provider.name.trim()));
    }
    if provider.base_url.trim().is_empty() {
        provider_object.remove("baseUrl");
    } else {
        provider_object.insert(
            "baseUrl".to_string(),
            serde_json::json!(provider.base_url.trim()),
        );
    }
    if provider.api.trim().is_empty() {
        provider_object.remove("api");
    } else {
        provider_object.insert("api".to_string(), serde_json::json!(provider.api.trim()));
    }
    if !provider.api_key.is_empty() {
        provider_object.insert("apiKey".to_string(), serde_json::json!(provider.api_key));
    } else if !provider.keep_existing_api_key {
        provider_object.remove("apiKey");
    }
    if provider.auth_header {
        provider_object.insert("authHeader".to_string(), serde_json::json!(true));
    } else {
        provider_object.remove("authHeader");
    }

    let models = provider
        .models
        .iter()
        .map(|model| {
            let mut object = existing_models
                .iter()
                .find(|value| {
                    value.get("id").and_then(|value| value.as_str()) == Some(model.id.trim())
                })
                .and_then(|value| value.as_object())
                .cloned()
                .unwrap_or_default();
            let model_id = model.id.trim();
            object.insert("id".to_string(), serde_json::json!(model_id));
            if model.name.trim().is_empty() || model.name.trim() == model_id {
                object.remove("name");
            } else {
                object.insert("name".to_string(), serde_json::json!(model.name.trim()));
            }
            if model.reasoning {
                object.insert("reasoning".to_string(), serde_json::json!(true));
            } else {
                object.remove("reasoning");
            }
            let supports_image = model.input.iter().any(|value| value == "image");
            if supports_image {
                object.insert("input".to_string(), serde_json::json!(["text", "image"]));
            } else {
                object.remove("input");
            }
            match model.context_window {
                Some(value) => {
                    object.insert("contextWindow".to_string(), serde_json::json!(value));
                }
                None => {
                    object.remove("contextWindow");
                }
            }
            match model.max_tokens {
                Some(value) => {
                    object.insert("maxTokens".to_string(), serde_json::json!(value));
                }
                None => {
                    object.remove("maxTokens");
                }
            }
            serde_json::Value::Object(object)
        })
        .collect::<Vec<_>>();
    provider_object.insert("models".to_string(), serde_json::Value::Array(models));
    providers.insert(id, serde_json::Value::Object(provider_object));
    save_models_config(&config)
}

#[tauri::command]
fn delete_model_provider(id: String) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("提供商 ID 不能为空".to_string());
    }
    let mut config = load_models_config()?;
    let providers = config
        .get_mut("providers")
        .and_then(|value| value.as_object_mut())
        .ok_or_else(|| "models.json 的 providers 必须是对象".to_string())?;
    if providers.remove(id).is_none() {
        return Err(format!("未找到提供商 {id}"));
    }
    save_models_config(&config)
}

#[tauri::command]
fn check_model_provider(
    state: State<'_, AppState>,
    id: String,
) -> Result<ModelProviderCheckResult, String> {
    let providers = list_model_providers()?;
    let provider = providers
        .iter()
        .find(|provider| provider.id == id)
        .ok_or_else(|| format!("未找到提供商 {id}"))?;
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .clone();
    let pi_binary = effective_pi_binary(&settings, &state);

    #[cfg(windows)]
    let mut command = {
        let mut command = if let Some((node, cli)) = resolve_windows_pi_node_command(&pi_binary) {
            let mut command = Command::new(node);
            command.arg(cli).args(["--offline", "--list-models", &id]);
            command
        } else {
            let command_line = format!(
                "call \"{}\" --offline --list-models \"{}\"",
                pi_binary.replace('"', "\"\""),
                id
            );
            let mut command = Command::new("cmd.exe");
            command.args(["/D", "/S", "/C", &command_line]);
            command
        };
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(&pi_binary);
        command.args(["--offline", "--list-models", &id]);
        command
    };
    let output = command
        .output()
        .map_err(|err| format!("无法运行 Pi 配置检查: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8(output.stderr)
            .map(|value| value.trim().to_string())
            .unwrap_or_else(|_| "Pi 配置检查命令执行失败，请确认 Pi 可执行文件设置".to_string());
        let stderr = redact_runtime_output(&settings, &stderr);
        return Ok(ModelProviderCheckResult {
            ok: false,
            message: if stderr.is_empty() {
                "Pi 未能加载该提供商配置".to_string()
            } else {
                stderr
            },
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let recognized = !stdout.trim().is_empty() && stdout.contains(&provider.id);
    Ok(ModelProviderCheckResult {
        ok: recognized,
        message: if recognized {
            format!("Pi 已识别 {} 个配置模型", provider.models.len())
        } else if !provider.has_api_key {
            "配置格式有效，但 Pi 暂未把模型标为可用；请配置 API 密钥或 auth.json 凭据".to_string()
        } else {
            "配置格式有效，但 Pi 的可用模型列表中尚未出现该提供商".to_string()
        },
    })
}

#[tauri::command]
fn pi_send(state: State<'_, AppState>, runtime_id: String, line: String) -> Result<(), String> {
    let guard = state
        .runtimes
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    guard
        .get(&runtime_id)
        .ok_or_else(|| format!("Pi runtime is not running: {runtime_id}"))?
        .client
        .send_line(&line)
}

#[tauri::command]
fn pi_stop(state: State<'_, AppState>, runtime_id: String) -> Result<(), String> {
    let runtime = {
        let mut runtimes = state
            .runtimes
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        let runtime = runtimes.remove(&runtime_id);
        #[cfg(windows)]
        if runtimes.is_empty() {
            KEEP_AWAKE.store(false, Ordering::Relaxed);
        }
        runtime
    };
    if let Some(runtime) = runtime {
        let ephemeral_session = runtime
            .isolated
            .then(|| runtime.session_file.clone())
            .flatten();
        runtime.client.kill();
        if let Some(file) = ephemeral_session {
            let session_dir = state
                .settings
                .lock()
                .map_err(|_| "state lock poisoned".to_string())?
                .session_dir
                .clone();
            let _ = trash_session(&session_dir, &file);
        }
    }
    Ok(())
}

#[tauri::command]
fn pi_is_running(state: State<'_, AppState>, runtime_id: String) -> Result<bool, String> {
    let mut runtimes = state
        .runtimes
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    let is_running = runtimes
        .get(&runtime_id)
        .is_some_and(|runtime| runtime.client.is_running());
    if !is_running {
        runtimes.remove(&runtime_id);
    }
    Ok(is_running)
}

#[tauri::command]
fn pi_bind_session(
    state: State<'_, AppState>,
    runtime_id: String,
    session_file: String,
) -> Result<(), String> {
    let mut runtimes = state
        .runtimes
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    let runtime = runtimes
        .get_mut(&runtime_id)
        .ok_or_else(|| format!("Pi runtime is not running: {runtime_id}"))?;
    runtime.session_file = Some(session_file);
    Ok(())
}

#[tauri::command]
fn list_pi_runtimes(state: State<'_, AppState>) -> Result<Vec<RuntimeInfo>, String> {
    let mut runtimes = state
        .runtimes
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    runtimes.retain(|_, runtime| runtime.client.is_running());
    Ok(runtimes
        .iter()
        .map(|(runtime_id, runtime)| RuntimeInfo {
            runtime_id: runtime_id.clone(),
            cwd: runtime.cwd.clone(),
            session_file: runtime.session_file.clone(),
            is_streaming: runtime.client.is_streaming(),
            pending_extension: runtime.client.pending_extension(),
        })
        .collect())
}

fn paths_equal(left: &str, right: &str) -> bool {
    let normalize = |value: &str| value.trim_end_matches(['/', '\\']).to_lowercase();
    normalize(left) == normalize(right)
}

#[tauri::command]
fn list_sessions_cmd(state: State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .clone();
    let (ephemeral_sessions, active_primary_sessions) = {
        let runtimes = state
            .runtimes
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        let ephemeral = runtimes
            .values()
            .filter(|runtime| runtime.isolated)
            .filter_map(|runtime| runtime.session_file.clone())
            .collect::<Vec<_>>();
        let primary = runtimes
            .values()
            .filter(|runtime| !runtime.isolated)
            .filter_map(|runtime| runtime.session_file.clone())
            .collect::<Vec<_>>();
        (ephemeral, primary)
    };
    let archived = &settings.archived_sessions;
    let sessions = list_sessions(&settings.session_dir)
        .into_iter()
        .filter(|session| !archived.iter().any(|file| file == &session.file))
        .filter(|session| {
            !ephemeral_sessions
                .iter()
                .any(|file| paths_equal(file, &session.file))
        })
        .collect();
    Ok(collapse_unchanged_session_forks(
        &settings.session_dir,
        sessions,
        &active_primary_sessions,
    ))
}

#[tauri::command]
fn session_message_timings_cmd(
    state: State<'_, AppState>,
    file: String,
) -> Result<Vec<SessionMessageTiming>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    session_message_timings(&settings.session_dir, &file)
}

#[tauri::command]
fn session_messages_cmd(
    state: State<'_, AppState>,
    file: String,
) -> Result<Vec<serde_json::Value>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    session_messages(&settings.session_dir, &file)
}

#[tauri::command]
fn session_history_cmd(state: State<'_, AppState>, file: String) -> Result<SessionHistory, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    session_history(&settings.session_dir, &file)
}

fn session_message_markdown(message: &serde_json::Value) -> Option<(String, String)> {
    let role = message.get("role")?.as_str()?;
    let heading = match role {
        "user" => "User",
        "assistant" => "Assistant",
        _ => return None,
    };
    let content = message.get("content")?;
    let text = match content {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(serde_json::Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(serde_json::Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    (!text.trim().is_empty()).then(|| (heading.to_string(), text.trim().to_string()))
}

fn session_history_markdown(history: &SessionHistory) -> String {
    let mut output = String::from("# PIDesktop conversation\n\n");
    for message in &history.messages {
        let Some((heading, text)) = session_message_markdown(message) else {
            continue;
        };
        output.push_str(&format!("## {heading}\n\n{text}\n\n"));
    }
    output
}

#[tauri::command]
fn export_session_markdown(
    state: State<'_, AppState>,
    file: String,
    destination: String,
) -> Result<String, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .clone();
    let history = session_history(&settings.session_dir, &file)?;
    let destination = PathBuf::from(destination.trim());
    if destination.as_os_str().is_empty() {
        return Err("conversation export path is required".to_string());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create conversation export directory: {err}"))?;
    }
    fs::write(&destination, session_history_markdown(&history))
        .map_err(|err| format!("failed to export conversation: {err}"))?;
    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command]
fn list_archived_sessions_cmd(state: State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    Ok(settings
        .archived_sessions
        .iter()
        .filter_map(|file| parse_session_file(Path::new(file)))
        .collect())
}

#[tauri::command]
fn archive_session_cmd(state: State<'_, AppState>, file: String) -> Result<(), String> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    validate_session_path(&settings.session_dir, &file)?;
    let normalized = file;
    if !settings.archived_sessions.contains(&normalized) {
        settings.archived_sessions.push(normalized);
        save_settings(&settings)?;
    }
    Ok(())
}

#[tauri::command]
fn restore_session_cmd(state: State<'_, AppState>, file: String) -> Result<(), String> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    settings.archived_sessions.retain(|entry| entry != &file);
    save_settings(&settings)
}

#[tauri::command]
fn delete_session_cmd(state: State<'_, AppState>, file: String) -> Result<(), String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    trash_session(&settings.session_dir, &file)
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())
        .map(|guard| redact_mcp_secrets(&guard))
}

#[tauri::command]
fn set_settings(state: State<'_, AppState>, mut settings: AppSettings) -> Result<(), String> {
    let current = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .clone();
    resolve_mcp_secret_placeholders(&mut settings, &current)?;
    if !matches!(
        settings.permission_mode.as_str(),
        "read-only" | "ask" | "workspace-write" | "full-access"
    ) {
        return Err("invalid permission mode".to_string());
    }
    if !matches!(settings.agent_mode.as_str(), "agent" | "plan" | "ask") {
        return Err("invalid agent mode".to_string());
    }
    if !matches!(
        settings.default_task_environment.as_str(),
        "local" | "worktree"
    ) {
        return Err("invalid default task environment".to_string());
    }
    if !(75..=150).contains(&settings.ui_scale) {
        return Err("UI scale must be between 75 and 150".to_string());
    }
    if !(80..=224).contains(&settings.pet_size) {
        return Err("pet size must be between 80 and 224".to_string());
    }
    if !(1..=4).contains(&settings.subagent_max_concurrency) {
        return Err("subagent concurrency must be between 1 and 4".to_string());
    }
    let mut mcp_ids = std::collections::HashSet::new();
    for server in &settings.mcp_servers {
        if server.id.trim().is_empty() || !mcp_ids.insert(server.id.trim().to_lowercase()) {
            return Err("MCP server IDs must be non-empty and unique".to_string());
        }
        if !matches!(server.transport.as_str(), "stdio" | "http") {
            return Err(format!("invalid MCP transport for {}", server.name));
        }
        if server.enabled && server.transport == "stdio" && server.command.trim().is_empty() {
            return Err(format!("MCP server {} requires a command", server.name));
        }
        if server.enabled
            && server.transport == "http"
            && !(server.url.starts_with("http://") || server.url.starts_with("https://"))
        {
            return Err(format!(
                "MCP server {} requires an HTTP(S) URL",
                server.name
            ));
        }
    }
    if settings.hooks.len() > 32 {
        return Err("at most 32 hooks may be configured".to_string());
    }
    if settings.tool_rules.len() > 64 {
        return Err("at most 64 tool rules may be configured".to_string());
    }
    let mut rule_ids = std::collections::HashSet::new();
    for rule in &settings.tool_rules {
        if rule.id.trim().is_empty() || !rule_ids.insert(rule.id.trim().to_lowercase()) {
            return Err("tool rule IDs must be non-empty and unique".to_string());
        }
        if rule.tool_pattern.trim().is_empty() {
            return Err(format!("tool rule {} requires a tool pattern", rule.id));
        }
        if !matches!(rule.action.as_str(), "allow" | "confirm" | "block") {
            return Err(format!("invalid action for tool rule {}", rule.id));
        }
    }
    let mut hook_ids = std::collections::HashSet::new();
    for hook in &settings.hooks {
        if hook.id.trim().is_empty() || !hook_ids.insert(hook.id.trim().to_lowercase()) {
            return Err("hook IDs must be non-empty and unique".to_string());
        }
        if !matches!(
            hook.event.as_str(),
            "session_start"
                | "before_agent_start"
                | "agent_end"
                | "agent_settled"
                | "tool_call"
                | "tool_result"
        ) {
            return Err(format!("invalid event for hook {}", hook.name));
        }
        if hook.command.trim().is_empty() {
            return Err(format!("hook {} requires a command", hook.name));
        }
        if hook.command.len() > 8192 {
            return Err(format!("hook {} command is too long", hook.name));
        }
        if !(1..=300).contains(&hook.timeout_seconds) {
            return Err(format!(
                "hook {} timeout must be between 1 and 300 seconds",
                hook.name
            ));
        }
        if hook.blocking && hook.event != "tool_call" {
            return Err(format!("only tool_call hooks may block: {}", hook.name));
        }
    }
    if !settings.custom_instructions.trim().is_empty() {
        ensure_personal_instructions(&settings.custom_instructions)?;
    }
    save_settings(&settings)?;
    *state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())? = settings;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceItem {
    kind: String,
    name: String,
    path: String,
    scope: String,
    version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageCatalogItem {
    name: String,
    version: String,
    description: String,
    author: String,
    published_at: String,
    downloads: u64,
    score: f64,
    keywords: Vec<String>,
    npm_url: String,
    repository_url: Option<String>,
    homepage_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageCatalogPage {
    items: Vec<PackageCatalogItem>,
    total: u64,
    page: u32,
    page_size: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PackageCatalogDetail {
    name: String,
    version: String,
    description: String,
    author: String,
    license: String,
    keywords: Vec<String>,
    npm_url: String,
    repository_url: Option<String>,
    homepage_url: Option<String>,
    image_url: Option<String>,
    video_url: Option<String>,
    extensions: Vec<String>,
    skills: Vec<String>,
    prompts: Vec<String>,
    themes: Vec<String>,
    dependency_count: u64,
    peer_dependency_count: u64,
    unpacked_size: u64,
    integrity: String,
}

fn package_sources_from_settings(value: &serde_json::Value) -> Vec<String> {
    value
        .get("packages")
        .and_then(|entry| entry.as_array())
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            entry
                .as_str()
                .or_else(|| entry.get("source").and_then(|source| source.as_str()))
        })
        .map(str::trim)
        .filter(|source| !source.is_empty())
        .map(str::to_string)
        .collect()
}

fn npm_package_name(source: &str) -> Option<String> {
    let value = source.trim().strip_prefix("npm:").unwrap_or(source.trim());
    if value.is_empty() || value.contains("://") || value.starts_with("git:") {
        return None;
    }
    if value.starts_with('@') {
        let slash = value.find('/')?;
        let version = value[slash + 1..].rfind('@').map(|index| slash + 1 + index);
        return Some(value[..version.unwrap_or(value.len())].to_string());
    }
    Some(value.split('@').next().unwrap_or(value).to_string())
}

fn installed_package_version(scope_root: &Path, source: &str) -> Option<String> {
    let name = npm_package_name(source)?;
    let manifest = scope_root
        .join("npm")
        .join("node_modules")
        .join(name)
        .join("package.json");
    let value =
        serde_json::from_str::<serde_json::Value>(&fs::read_to_string(manifest).ok()?).ok()?;
    value
        .get("version")
        .and_then(|entry| entry.as_str())
        .map(str::to_string)
}

fn collect_package_settings(
    settings_path: &Path,
    scope_root: &Path,
    scope: &str,
    items: &mut Vec<ResourceItem>,
) {
    let Ok(raw) = fs::read_to_string(settings_path) else {
        return;
    };
    let Ok(value) = json5::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    for source in package_sources_from_settings(&value) {
        items.push(ResourceItem {
            kind: "package".to_string(),
            name: npm_package_name(&source).unwrap_or_else(|| source.clone()),
            version: installed_package_version(scope_root, &source),
            path: source,
            scope: scope.to_string(),
        });
    }
}

#[tauri::command]
fn list_resources(cwd: String) -> Result<Vec<ResourceItem>, String> {
    let mut items = Vec::new();
    if let Some(home) = dirs::home_dir() {
        let agent = home.join(".pi").join("agent");
        collect_resources(&agent.join("extensions"), "extension", "user", &mut items);
        collect_resources(&agent.join("skills"), "skill", "user", &mut items);
        collect_resources(&agent.join("prompts"), "prompt", "user", &mut items);
        collect_resources(&agent.join("themes"), "theme", "user", &mut items);
        collect_resources(&agent.join("pets"), "pet", "user", &mut items);
        collect_package_settings(&agent.join("settings.json"), &agent, "user", &mut items);
    }
    let project = PathBuf::from(cwd).join(".pi");
    collect_resources(
        &project.join("extensions"),
        "extension",
        "project",
        &mut items,
    );
    collect_resources(&project.join("skills"), "skill", "project", &mut items);
    collect_resources(&project.join("prompts"), "prompt", "project", &mut items);
    collect_resources(&project.join("themes"), "theme", "project", &mut items);
    collect_resources(&project.join("pets"), "pet", "project", &mut items);
    collect_package_settings(
        &project.join("settings.json"),
        &project,
        "project",
        &mut items,
    );
    items.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)));
    Ok(items)
}

fn appearance_directory(cwd: &str, kind: &str, scope: &str) -> Result<PathBuf, String> {
    let folder = match kind {
        "theme" => "themes",
        "pet" => "pets",
        _ => return Err(format!("unsupported appearance extension kind: {kind}")),
    };
    match scope {
        "user" => dirs::home_dir()
            .map(|home| home.join(".pi").join("agent").join(folder))
            .ok_or_else(|| "cannot resolve the user home directory".to_string()),
        "project" => Ok(validate_workspace_directory(cwd)?.join(".pi").join(folder)),
        _ => Err(format!("unsupported appearance extension scope: {scope}")),
    }
}

fn validate_json_object(path: &Path, label: &str) -> Result<(), String> {
    let raw = fs::read_to_string(path).map_err(|err| format!("failed to read {label}: {err}"))?;
    let value = serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|err| format!("{label} is not valid JSON: {err}"))?;
    if !value.is_object() {
        return Err(format!("{label} must contain a JSON object"));
    }
    Ok(())
}

fn copy_appearance_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir(destination).map_err(|err| format!("failed to create pet directory: {err}"))?;
    for entry in
        fs::read_dir(source).map_err(|err| format!("failed to read pet directory: {err}"))?
    {
        let entry = entry.map_err(|err| format!("failed to read pet directory entry: {err}"))?;
        let file_type = entry
            .file_type()
            .map_err(|err| format!("failed to inspect pet directory entry: {err}"))?;
        if file_type.is_symlink() {
            return Err("pet directories cannot contain symbolic links".to_string());
        }
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_appearance_directory(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)
                .map_err(|err| format!("failed to copy pet asset: {err}"))?;
        }
    }
    Ok(())
}

#[tauri::command]
fn open_appearance_directory(cwd: String, kind: String, scope: String) -> Result<String, String> {
    let directory = appearance_directory(&cwd, &kind, &scope)?;
    fs::create_dir_all(&directory)
        .map_err(|err| format!("failed to create appearance extension directory: {err}"))?;
    let path = directory.to_string_lossy().to_string();
    open_workspace_in_file_manager(path.clone())?;
    Ok(path)
}

#[tauri::command]
fn install_appearance_extension(
    source: String,
    cwd: String,
    kind: String,
    scope: String,
) -> Result<String, String> {
    let source = fs::canonicalize(&source)
        .map_err(|err| format!("failed to resolve the selected extension: {err}"))?;
    let target_root = appearance_directory(&cwd, &kind, &scope)?;
    fs::create_dir_all(&target_root)
        .map_err(|err| format!("failed to create appearance extension directory: {err}"))?;
    let canonical_target_root = fs::canonicalize(&target_root)
        .map_err(|err| format!("failed to resolve appearance extension directory: {err}"))?;

    let destination = if kind == "theme" {
        if !source.is_file()
            || source
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                != Some("json".to_string())
        {
            return Err("a theme extension must be a JSON file".to_string());
        }
        validate_json_object(&source, "theme file")?;
        let name = source
            .file_name()
            .ok_or_else(|| "the selected theme has no file name".to_string())?;
        let destination = target_root.join(name);
        if destination.exists() {
            if fs::canonicalize(&destination).ok().as_ref() == Some(&source) {
                return Ok(destination.to_string_lossy().to_string());
            }
            return Err(format!(
                "a theme named {} already exists",
                name.to_string_lossy()
            ));
        }
        fs::copy(&source, &destination)
            .map_err(|err| format!("failed to import the theme: {err}"))?;
        destination
    } else {
        let source_directory = if source.is_dir() {
            source
        } else if source.file_name().and_then(|value| value.to_str()) == Some("pet.json") {
            source
                .parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| "cannot resolve the selected pet directory".to_string())?
        } else {
            return Err("a pet extension must be a directory containing pet.json".to_string());
        };
        let manifest = source_directory.join("pet.json");
        if !manifest.is_file() {
            return Err("the selected pet directory does not contain pet.json".to_string());
        }
        validate_json_object(&manifest, "pet.json")?;
        if canonical_target_root.starts_with(&source_directory) {
            return Err(
                "the selected pet directory cannot contain the extension destination".to_string(),
            );
        }
        let name = source_directory
            .file_name()
            .ok_or_else(|| "the selected pet directory has no name".to_string())?;
        let destination = target_root.join(name);
        if destination.exists() {
            if fs::canonicalize(&destination).ok().as_ref() == Some(&source_directory) {
                return Ok(destination.to_string_lossy().to_string());
            }
            return Err(format!(
                "a pet named {} already exists",
                name.to_string_lossy()
            ));
        }
        copy_appearance_directory(&source_directory, &destination)?;
        destination
    };
    Ok(destination.to_string_lossy().to_string())
}

fn collect_resources(root: &Path, kind: &str, scope: &str, items: &mut Vec<ResourceItem>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_stem()
            .or_else(|| path.file_name())
            .and_then(|value| value.to_str())
            .unwrap_or("resource")
            .to_string();
        items.push(ResourceItem {
            kind: kind.to_string(),
            name,
            path: path.to_string_lossy().to_string(),
            scope: scope.to_string(),
            version: None,
        });
    }
}

fn json_string(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(|entry| entry.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn json_string_list(value: Option<&serde_json::Value>) -> Vec<String> {
    match value {
        Some(serde_json::Value::Array(entries)) => entries
            .iter()
            .filter_map(|entry| entry.as_str())
            .map(str::to_string)
            .collect(),
        Some(serde_json::Value::String(entry)) => vec![entry.clone()],
        _ => Vec::new(),
    }
}

fn package_author(value: &serde_json::Value) -> String {
    value
        .get("author")
        .and_then(|entry| {
            entry
                .as_str()
                .or_else(|| entry.get("name").and_then(|name| name.as_str()))
        })
        .or_else(|| {
            value
                .pointer("/publisher/username")
                .and_then(|entry| entry.as_str())
        })
        .unwrap_or_default()
        .to_string()
}

fn package_link(value: &serde_json::Value, field: &str) -> Option<String> {
    value
        .pointer(&format!("/links/{field}"))
        .and_then(|entry| entry.as_str())
        .or_else(|| {
            value.get(field).and_then(|entry| {
                entry
                    .as_str()
                    .or_else(|| entry.get("url").and_then(|url| url.as_str()))
            })
        })
        .and_then(safe_external_url)
}

fn safe_external_url(entry: &str) -> Option<String> {
    let entry = entry.trim().trim_start_matches("git+");
    if entry.starts_with("https://") || entry.starts_with("http://") {
        return Some(entry.to_string());
    }
    entry
        .strip_prefix("git://github.com/")
        .map(|path| format!("https://github.com/{}", path.trim_end_matches(".git")))
}

fn npm_registry_json(url: &str) -> Result<serde_json::Value, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(18))
        .user_agent("PiDesktop/0.2 package-marketplace")
        .build();
    let response = agent
        .get(url)
        .call()
        .map_err(|err| format!("无法连接 npm Registry: {err}"))?;
    response
        .into_json::<serde_json::Value>()
        .map_err(|err| format!("npm Registry 返回了无效数据: {err}"))
}

async fn run_marketplace_request<T, F>(request: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(request)
        .await
        .map_err(|err| format!("插件市场后台任务失败: {err}"))?
}

fn search_pi_packages_blocking(
    query: String,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<PackageCatalogPage, String> {
    let query = query.trim();
    if query.chars().count() > 120 {
        return Err("搜索词不能超过 120 个字符".to_string());
    }
    let page = page.unwrap_or(0);
    let page_size = page_size.unwrap_or(30).clamp(1, 50);
    let text = if query.is_empty() {
        "keywords:pi-package".to_string()
    } else {
        format!("keywords:pi-package {query}")
    };
    let url = format!(
        "https://registry.npmjs.org/-/v1/search?text={}&size={page_size}&from={}",
        urlencoding::encode(&text),
        page.saturating_mul(page_size)
    );
    let value = npm_registry_json(&url)?;
    let total = value
        .get("total")
        .and_then(|entry| entry.as_u64())
        .unwrap_or(0);
    let items = value
        .get("objects")
        .and_then(|entry| entry.as_array())
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let package = entry.get("package")?;
            let keywords = json_string_list(package.get("keywords"));
            if !keywords.iter().any(|keyword| keyword == "pi-package") {
                return None;
            }
            let name = json_string(package.get("name"));
            if name.is_empty() {
                return None;
            }
            Some(PackageCatalogItem {
                npm_url: package_link(package, "npm")
                    .unwrap_or_else(|| format!("https://www.npmjs.com/package/{name}")),
                repository_url: package_link(package, "repository"),
                homepage_url: package_link(package, "homepage"),
                name,
                version: json_string(package.get("version")),
                description: json_string(package.get("description")),
                author: package_author(package),
                published_at: json_string(package.get("date")),
                downloads: entry
                    .pointer("/downloads/monthly")
                    .and_then(|item| item.as_u64())
                    .unwrap_or(0),
                score: entry
                    .pointer("/score/final")
                    .and_then(|item| item.as_f64())
                    .unwrap_or(0.0),
                keywords,
            })
        })
        .collect();
    Ok(PackageCatalogPage {
        items,
        total,
        page,
        page_size,
    })
}

#[tauri::command]
async fn search_pi_packages(
    query: String,
    page: Option<u32>,
    page_size: Option<u32>,
) -> Result<PackageCatalogPage, String> {
    run_marketplace_request(move || search_pi_packages_blocking(query, page, page_size)).await
}

fn pi_package_detail_blocking(name: String) -> Result<PackageCatalogDetail, String> {
    let name = npm_package_name(&name).ok_or_else(|| "无效的 npm 软件包名称".to_string())?;
    if name.chars().count() > 214 {
        return Err("npm 软件包名称过长".to_string());
    }
    let url = format!(
        "https://registry.npmjs.org/{}/latest",
        urlencoding::encode(&name)
    );
    let value = npm_registry_json(&url)?;
    let keywords = json_string_list(value.get("keywords"));
    if !keywords.iter().any(|keyword| keyword == "pi-package") {
        return Err("该软件包没有 pi-package 标记，未进入 Pi 官方目录".to_string());
    }
    let manifest = value.get("pi").cloned().unwrap_or(serde_json::Value::Null);
    let license = value
        .get("license")
        .and_then(|entry| {
            entry
                .as_str()
                .or_else(|| entry.get("type").and_then(|item| item.as_str()))
        })
        .unwrap_or("未声明")
        .to_string();
    Ok(PackageCatalogDetail {
        npm_url: format!("https://www.npmjs.com/package/{name}"),
        repository_url: package_link(&value, "repository"),
        homepage_url: package_link(&value, "homepage"),
        name,
        version: json_string(value.get("version")),
        description: json_string(value.get("description")),
        author: package_author(&value),
        license,
        keywords,
        image_url: manifest
            .get("image")
            .and_then(|entry| entry.as_str())
            .and_then(safe_external_url),
        video_url: manifest
            .get("video")
            .and_then(|entry| entry.as_str())
            .and_then(safe_external_url),
        extensions: json_string_list(manifest.get("extensions")),
        skills: json_string_list(manifest.get("skills")),
        prompts: json_string_list(manifest.get("prompts")),
        themes: json_string_list(manifest.get("themes")),
        dependency_count: value
            .get("dependencies")
            .and_then(|entry| entry.as_object())
            .map(|entry| entry.len() as u64)
            .unwrap_or(0),
        peer_dependency_count: value
            .get("peerDependencies")
            .and_then(|entry| entry.as_object())
            .map(|entry| entry.len() as u64)
            .unwrap_or(0),
        unpacked_size: value
            .pointer("/dist/unpackedSize")
            .and_then(|entry| entry.as_u64())
            .unwrap_or(0),
        integrity: json_string(value.pointer("/dist/integrity")),
    })
}

#[tauri::command]
async fn pi_package_detail(name: String) -> Result<PackageCatalogDetail, String> {
    run_marketplace_request(move || pi_package_detail_blocking(name)).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileContent {
    path: String,
    file_name: String,
    text: Option<String>,
    mime_type: Option<String>,
    data: Option<String>,
    truncated: bool,
    is_binary: bool,
    size: u64,
}

fn strip_windows_prefix(path: PathBuf) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

fn confined_workspace_path(cwd: &str, relative: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = strip_windows_prefix(
        fs::canonicalize(cwd).map_err(|err| format!("workspace not found: {err}"))?,
    );
    let requested = strip_windows_prefix(PathBuf::from(relative));
    if requested
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("path is outside the workspace".to_string());
    }
    let joined = if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    };
    let canon = if joined.exists() {
        strip_windows_prefix(
            fs::canonicalize(&joined).map_err(|err| format!("path not found: {err}"))?,
        )
    } else {
        joined
    };
    if !canon.starts_with(&root) {
        return Err("path is outside the workspace".to_string());
    }
    Ok((root, canon))
}

#[tauri::command]
fn list_workspace_dir(cwd: String, path: Option<String>) -> Result<Vec<WorkspaceDirEntry>, String> {
    let rel = path.unwrap_or_default().replace('\\', "/");
    let (_root, dir) = confined_workspace_path(&cwd, &rel)?;
    if !dir.is_dir() {
        return Err("not a directory".to_string());
    }
    let mut entries = Vec::new();
    let reader = fs::read_dir(&dir).map_err(|err| format!("failed to list directory: {err}"))?;
    for entry in reader.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "." || name == ".." {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let child = if rel.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", rel.trim_end_matches('/'), name)
        };
        entries.push(WorkspaceDirEntry {
            name,
            path: child,
            is_dir,
        });
        if entries.len() >= 400 {
            break;
        }
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
async fn search_workspace_files(
    state: State<'_, AppState>,
    cwd: String,
    query: String,
    request_id: String,
) -> Result<Vec<WorkspaceDirEntry>, String> {
    let (root, _) = confined_workspace_path(&cwd, "")?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut searches = state
            .workspace_searches
            .lock()
            .map_err(|_| "workspace search state lock poisoned".to_string())?;
        if let Some(previous) = searches.insert(request_id.clone(), Arc::clone(&cancelled)) {
            previous.store(true, Ordering::Release);
        }
    }
    let worker_cancelled = Arc::clone(&cancelled);
    let worker = tauri::async_runtime::spawn_blocking(move || {
        workspace_files::search(&root, &query, &worker_cancelled)
    })
    .await;
    if let Ok(mut searches) = state.workspace_searches.lock() {
        if searches
            .get(&request_id)
            .is_some_and(|active| Arc::ptr_eq(active, &cancelled))
        {
            searches.remove(&request_id);
        }
    }
    worker.map_err(|err| format!("workspace search worker failed: {err}"))?
}

#[tauri::command]
fn cancel_workspace_search(state: State<'_, AppState>, request_id: String) -> Result<(), String> {
    if let Some(cancelled) = state
        .workspace_searches
        .lock()
        .map_err(|_| "workspace search state lock poisoned".to_string())?
        .get(&request_id)
        .cloned()
    {
        cancelled.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
fn read_workspace_file(cwd: String, path: String) -> Result<WorkspaceFileContent, String> {
    const MAX_BYTES: u64 = 512 * 1024;
    const MAX_BINARY_PREVIEW_BYTES: u64 = 10 * 1024 * 1024;
    let (_root, file) = confined_workspace_path(&cwd, &path)?;
    if !file.is_file() {
        return Err("not a file".to_string());
    }
    let metadata = fs::metadata(&file).map_err(|err| format!("failed to inspect file: {err}"))?;
    let file_name = file
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file")
        .to_string();
    let extension = file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime_type = match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "pdf" => Some("application/pdf"),
        _ => None,
    };
    let binary_preview = mime_type.is_some() && metadata.len() <= MAX_BINARY_PREVIEW_BYTES;
    let bytes = if metadata.len() > MAX_BYTES && !binary_preview {
        let mut data = fs::read(&file).map_err(|err| format!("failed to read file: {err}"))?;
        data.truncate(MAX_BYTES as usize);
        data
    } else {
        fs::read(&file).map_err(|err| format!("failed to read file: {err}"))?
    };
    let text = if mime_type.is_some() {
        None
    } else {
        String::from_utf8(bytes.clone()).ok()
    };
    let is_binary = text.is_none();
    let data = binary_preview.then(|| base64::engine::general_purpose::STANDARD.encode(&bytes));
    Ok(WorkspaceFileContent {
        path,
        file_name,
        text,
        mime_type: mime_type.map(str::to_string),
        data,
        truncated: metadata.len()
            > if binary_preview {
                MAX_BINARY_PREVIEW_BYTES
            } else {
                MAX_BYTES
            },
        is_binary,
        size: metadata.len(),
    })
}

#[tauri::command]
fn pi_package_action(
    state: State<'_, AppState>,
    action: String,
    source: Option<String>,
    cwd: Option<String>,
    scope: Option<String>,
) -> Result<String, String> {
    if !matches!(action.as_str(), "install" | "remove" | "update") {
        return Err("unsupported Pi package action".to_string());
    }
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .clone();
    let pi_binary = effective_pi_binary(&settings, &state);
    let working_directory = cwd
        .filter(|value| Path::new(value).is_dir())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    let scope = scope.unwrap_or_else(|| "user".to_string());
    if !matches!(scope.as_str(), "user" | "project") {
        return Err("unsupported Pi package scope".to_string());
    }
    let source = source
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut arguments = match action.as_str() {
        "install" | "remove" => {
            let value = source
                .clone()
                .ok_or_else(|| "Pi package source is required".to_string())?;
            vec![action.clone(), value]
        }
        "update" => source
            .clone()
            .map(|value| vec!["update".to_string(), "--extension".to_string(), value])
            .unwrap_or_else(|| vec!["update".to_string(), "--extensions".to_string()]),
        _ => unreachable!(),
    };
    if scope == "project" && matches!(action.as_str(), "install" | "remove") {
        arguments.extend(["-l".to_string(), "--approve".to_string()]);
    }

    #[cfg(windows)]
    let mut command = {
        let mut command = if let Some((node, cli)) = resolve_windows_pi_node_command(&pi_binary) {
            let mut command = Command::new(node);
            command.arg(cli).args(&arguments);
            command
        } else if Path::new(&pi_binary)
            .extension()
            .and_then(|entry| entry.to_str())
            .is_some_and(|entry| entry.eq_ignore_ascii_case("exe"))
        {
            let mut command = Command::new(&pi_binary);
            command.args(&arguments);
            command
        } else {
            let command_line = std::iter::once(pi_binary.as_str())
                .chain(arguments.iter().map(String::as_str))
                .map(|value| format!("\"{}\"", value.replace('%', "%%").replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(" ");
            let mut command = Command::new("cmd.exe");
            command.args(["/D", "/S", "/C", &command_line]);
            command
        };
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(&pi_binary);
        command.args(&arguments);
        command
    };
    let output = command
        .current_dir(working_directory)
        .output()
        .map_err(|err| format!("failed to run Pi package command: {err}"))?;
    let stdout = redact_runtime_output(&settings, String::from_utf8_lossy(&output.stdout).trim());
    let stderr = redact_runtime_output(&settings, String::from_utf8_lossy(&output.stderr).trim());
    if output.status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.is_empty() {
            format!(
                "Pi package command exited with {}",
                output.status.code().unwrap_or(-1)
            )
        } else {
            stderr
        })
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageSummary {
    sessions: u64,
    messages: u64,
    input_tokens: u64,
    output_tokens: u64,
    reasoning_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    total_tokens: u64,
    total_cost: f64,
}

#[tauri::command]
fn list_pull_requests(cwd: String) -> Result<PullRequestCollection, String> {
    let cwd_path = PathBuf::from(&cwd);
    let repository_root = run_git(&cwd_path, &["rev-parse", "--show-toplevel"])?;
    let repository_root = PathBuf::from(repository_root.trim());
    let repository = repository_root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("repository")
        .to_string();
    let remote_url = run_git(&repository_root, &["remote", "get-url", "origin"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let output = github_cli_command()
        .args([
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "50",
            "--json",
            "number,title,state,isDraft,headRefName,baseRefName,updatedAt,url,author,reviewDecision",
        ])
        .current_dir(&repository_root)
        .output()
        .map_err(|err| format!("无法启动 GitHub CLI（gh）：{err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "GitHub CLI 未登录或当前仓库没有可访问的远程仓库".to_string()
        } else {
            stderr
        });
    }
    let raw: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|err| format!("failed to parse GitHub pull requests: {err}"))?;
    let items = raw
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| PullRequestInfo {
            number: item
                .get("number")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
            title: item
                .get("title")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            state: item
                .get("state")
                .and_then(|value| value.as_str())
                .unwrap_or("OPEN")
                .to_string(),
            is_draft: item
                .get("isDraft")
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
            head_ref_name: item
                .get("headRefName")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            base_ref_name: item
                .get("baseRefName")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            updated_at: item
                .get("updatedAt")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            url: item
                .get("url")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            author: item
                .pointer("/author/login")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            review_decision: item
                .get("reviewDecision")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect();
    Ok(PullRequestCollection {
        repository,
        remote_url,
        items,
    })
}

#[tauri::command]
fn checkout_pull_request(cwd: String, number: u64) -> Result<(), String> {
    let cwd_path = PathBuf::from(cwd);
    let output = github_cli_command()
        .args(["pr", "checkout", &number.to_string()])
        .current_dir(cwd_path)
        .output()
        .map_err(|err| format!("无法启动 GitHub CLI（gh）：{err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            "检出拉取请求失败".to_string()
        } else {
            stderr
        })
    }
}

#[tauri::command]
fn usage_summary(state: State<'_, AppState>) -> Result<UsageSummary, String> {
    use std::io::BufRead;

    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    let sessions = list_sessions(&settings.session_dir);
    let mut summary = UsageSummary {
        sessions: sessions.len() as u64,
        ..UsageSummary::default()
    };
    for session in sessions {
        let Ok(file) = fs::File::open(session.file) else {
            continue;
        };
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if entry.get("type").and_then(|value| value.as_str()) != Some("message") {
                continue;
            }
            summary.messages += 1;
            if entry
                .pointer("/message/role")
                .and_then(|value| value.as_str())
                != Some("assistant")
            {
                continue;
            }
            let usage = entry.pointer("/message/usage");
            let tokens = |name: &str| {
                usage
                    .and_then(|value| value.get(name))
                    .and_then(|value| value.as_u64())
                    .unwrap_or(0)
            };
            summary.input_tokens += tokens("input");
            summary.output_tokens += tokens("output");
            summary.reasoning_tokens += tokens("reasoning");
            summary.cache_read_tokens += tokens("cacheRead");
            summary.cache_write_tokens += tokens("cacheWrite");
            summary.total_tokens += tokens("totalTokens");
            summary.total_cost += usage
                .and_then(|value| value.pointer("/cost/total"))
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0);
        }
    }
    Ok(summary)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeInfo {
    path: String,
    head: Option<String>,
    branch: Option<String>,
    is_main: bool,
}

#[tauri::command]
fn list_worktrees(cwd: String) -> Result<Vec<WorktreeInfo>, String> {
    let root = PathBuf::from(cwd);
    let output = run_git(&root, &["worktree", "list", "--porcelain"])?;
    Ok(parse_worktrees(&output))
}

#[tauri::command]
fn create_worktree(
    state: State<'_, AppState>,
    cwd: String,
    base: Option<String>,
) -> Result<WorktreeInfo, String> {
    let cwd = PathBuf::from(cwd);
    let repo = run_git(&cwd, &["rev-parse", "--show-toplevel"])?;
    let repo = PathBuf::from(repo.trim());
    let repo_name = repo
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workspace");
    let safe_name: String = repo_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let root = app_config_dir().join("worktrees");
    fs::create_dir_all(&root)
        .map_err(|err| format!("failed to create worktree directory: {err}"))?;
    let target = root.join(format!("{safe_name}-{stamp}"));
    let base = base
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "HEAD".to_string());
    let branch_prefix = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .branch_prefix
        .trim()
        .to_string();
    let branch_prefix = if branch_prefix.is_empty() {
        "pi/".to_string()
    } else if branch_prefix.ends_with('/') {
        branch_prefix
    } else {
        format!("{branch_prefix}/")
    };
    let branch = format!("{branch_prefix}worktree-{stamp}");
    let output = hidden_command("git")
        .args(["worktree", "add", "-b", &branch])
        .arg(&target)
        .arg(&base)
        .current_dir(&repo)
        .output()
        .map_err(|err| format!("failed to create worktree: {err}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(WorktreeInfo {
        path: target.to_string_lossy().to_string(),
        head: run_git(&target, &["rev-parse", "HEAD"])
            .ok()
            .map(|value| value.trim().to_string()),
        branch: Some(branch),
        is_main: false,
    })
}

fn parse_worktrees(output: &str) -> Vec<WorktreeInfo> {
    let mut result = Vec::new();
    let mut path: Option<String> = None;
    let mut head: Option<String> = None;
    let mut branch: Option<String> = None;
    for line in output.lines().chain(std::iter::once("")) {
        if let Some(value) = line.strip_prefix("worktree ") {
            if let Some(previous) = path.take() {
                result.push(WorktreeInfo {
                    path: previous,
                    head: head.take(),
                    branch: branch.take(),
                    is_main: result.is_empty(),
                });
            }
            path = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("HEAD ") {
            head = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("branch ") {
            branch = Some(value.trim_start_matches("refs/heads/").to_string());
        } else if line.is_empty() {
            if let Some(previous) = path.take() {
                result.push(WorktreeInfo {
                    path: previous,
                    head: head.take(),
                    branch: branch.take(),
                    is_main: result.is_empty(),
                });
            }
        }
    }
    result
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentPayload {
    path: String,
    file_name: String,
    mime_type: String,
    size: u64,
    kind: String,
    data: Option<String>,
    text: Option<String>,
}

#[tauri::command]
fn read_attachment(file: String) -> Result<AttachmentPayload, String> {
    let path =
        fs::canonicalize(&file).map_err(|err| format!("failed to open attachment: {err}"))?;
    let metadata =
        fs::metadata(&path).map_err(|err| format!("failed to inspect attachment: {err}"))?;
    if !metadata.is_file() {
        return Err("attachment must be a file".to_string());
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime_type = mime_for_extension(&extension).to_string();
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment")
        .to_string();

    if mime_type.starts_with("image/") {
        if metadata.len() > 12 * 1024 * 1024 {
            return Err("images are limited to 12 MB".to_string());
        }
        let bytes = fs::read(&path).map_err(|err| format!("failed to read image: {err}"))?;
        return Ok(AttachmentPayload {
            path: path.to_string_lossy().to_string(),
            file_name,
            mime_type,
            size: metadata.len(),
            kind: "image".to_string(),
            data: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            text: None,
        });
    }

    if metadata.len() > 2 * 1024 * 1024 {
        return Ok(AttachmentPayload {
            path: path.to_string_lossy().to_string(),
            file_name,
            mime_type,
            size: metadata.len(),
            kind: "file".to_string(),
            data: None,
            text: None,
        });
    }

    let bytes = fs::read(&path).map_err(|err| format!("failed to read attachment: {err}"))?;
    let text = String::from_utf8(bytes).ok();
    Ok(AttachmentPayload {
        path: path.to_string_lossy().to_string(),
        file_name,
        mime_type,
        size: metadata.len(),
        kind: if text.is_some() { "text" } else { "file" }.to_string(),
        data: None,
        text,
    })
}

fn mime_for_extension(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "md" | "txt" | "log" => "text/plain",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "rs" => "text/rust",
        "py" => "text/python",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitFileChange {
    path: String,
    status: String,
    index_status: String,
    worktree_status: String,
    staged: bool,
    unstaged: bool,
    untracked: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitSnapshot {
    is_repository: bool,
    branch: Option<String>,
    files: Vec<GitFileChange>,
    diff: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBranchInfo {
    name: String,
    current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitInfo {
    sha: String,
    short_sha: String,
    subject: String,
    author: String,
    timestamp: i64,
}

fn parse_git_status(output: &str) -> Vec<GitFileChange> {
    output
        .lines()
        .filter_map(|line| {
            let bytes = line.as_bytes();
            if bytes.len() < 3 {
                return None;
            }
            let index = bytes[0] as char;
            let worktree = bytes[1] as char;
            let raw_path = line.get(3..)?.trim();
            let path = raw_path
                .rsplit_once(" -> ")
                .map(|(_, renamed)| renamed)
                .unwrap_or(raw_path)
                .trim_matches('"');
            if path.is_empty() {
                return None;
            }
            let untracked = index == '?' && worktree == '?';
            let staged = !untracked && index != ' ' && index != '?';
            let unstaged = untracked || (worktree != ' ' && worktree != '?');
            let status = if untracked {
                "?".to_string()
            } else {
                [index, worktree]
                    .into_iter()
                    .filter(|value| *value != ' ')
                    .collect()
            };
            Some(GitFileChange {
                path: path.to_string(),
                status,
                index_status: if index != ' ' {
                    index.to_string()
                } else {
                    String::new()
                },
                worktree_status: if worktree != ' ' {
                    worktree.to_string()
                } else {
                    String::new()
                },
                staged,
                unstaged,
                untracked,
            })
        })
        .collect()
}

#[tauri::command]
fn git_list_branches(cwd: String) -> Result<Vec<GitBranchInfo>, String> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err("workspace no longer exists".to_string());
    }
    let output = run_git(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(HEAD)",
            "refs/heads",
        ],
    )?;
    let mut branches: Vec<GitBranchInfo> = output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, '\t');
            let name = parts.next()?.trim();
            if name.is_empty() {
                return None;
            }
            let head = parts.next().unwrap_or("").trim();
            Some(GitBranchInfo {
                name: name.to_string(),
                current: head == "*",
            })
        })
        .collect();
    branches.sort_by(|a, b| match (a.current, b.current) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(branches)
}

#[tauri::command]
fn git_checkout_branch(cwd: String, branch: String) -> Result<(), String> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err("workspace no longer exists".to_string());
    }
    let name = branch.trim();
    if name.is_empty() {
        return Err("branch name required".to_string());
    }
    run_git(&root, &["checkout", name])?;
    Ok(())
}

#[tauri::command]
fn git_compare(cwd: String, base: String) -> Result<GitSnapshot, String> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err("workspace no longer exists".to_string());
    }
    let base = base.trim();
    if base.is_empty() {
        return Err("base branch required".to_string());
    }
    let branch = run_git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|value| value.trim().to_string());
    let range = format!("{base}...HEAD");
    let name_status = run_git(&root, &["diff", "--name-status", &range]).unwrap_or_default();
    let files = name_status
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 2 {
                return None;
            }
            let status = parts[0]
                .chars()
                .next()
                .map(|ch| ch.to_string())
                .unwrap_or_else(|| "?".to_string());
            let path = parts[parts.len() - 1].trim();
            if path.is_empty() {
                return None;
            }
            Some(GitFileChange {
                status,
                path: path.to_string(),
                index_status: String::new(),
                worktree_status: String::new(),
                staged: false,
                unstaged: false,
                untracked: false,
            })
        })
        .collect();
    let diff =
        run_git(&root, &["diff", "--no-ext-diff", "--unified=3", &range]).unwrap_or_default();
    Ok(GitSnapshot {
        is_repository: true,
        branch,
        files,
        diff,
    })
}

#[tauri::command]
fn git_review_snapshot(cwd: String, filter: String) -> Result<GitSnapshot, String> {
    if filter == "uncommitted" {
        return git_snapshot(cwd);
    }
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err("workspace no longer exists".to_string());
    }
    if filter != "staged" && filter != "unstaged" {
        return Err("unsupported review filter".to_string());
    }
    let branch = run_git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|value| value.trim().to_string());
    let status = run_git(
        &root,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )
    .unwrap_or_default();
    let mut files = parse_git_status(&status);
    if filter == "staged" {
        files.retain(|file| file.staged);
    } else {
        files.retain(|file| file.unstaged);
    }
    let diff = if filter == "staged" {
        run_git(
            &root,
            &["diff", "--cached", "--no-ext-diff", "--unified=3", "--"],
        )
        .unwrap_or_default()
    } else {
        run_git(&root, &["diff", "--no-ext-diff", "--unified=3", "--"]).unwrap_or_default()
    };
    Ok(GitSnapshot {
        is_repository: true,
        branch,
        files,
        diff,
    })
}

#[tauri::command]
fn git_list_commits(cwd: String, limit: Option<usize>) -> Result<Vec<GitCommitInfo>, String> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err("workspace no longer exists".to_string());
    }
    let count = limit.unwrap_or(50).clamp(1, 200);
    let count_arg = format!("--max-count={count}");
    let output = run_git(
        &root,
        &[
            "log",
            &count_arg,
            "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ct",
        ],
    )?;
    Ok(output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let sha = parts.next()?.trim();
            let short_sha = parts.next()?.trim();
            let subject = parts.next()?.trim();
            let author = parts.next()?.trim();
            let timestamp = parts.next()?.trim().parse::<i64>().ok()?;
            if sha.is_empty() || short_sha.is_empty() {
                return None;
            }
            Some(GitCommitInfo {
                sha: sha.to_string(),
                short_sha: short_sha.to_string(),
                subject: subject.to_string(),
                author: author.to_string(),
                timestamp,
            })
        })
        .collect())
}

#[tauri::command]
fn git_commit_snapshot(cwd: String, commit: String) -> Result<GitSnapshot, String> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err("workspace no longer exists".to_string());
    }
    let commit = commit.trim();
    if !(7..=40).contains(&commit.len()) || !commit.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("invalid commit id".to_string());
    }
    let branch = run_git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|value| value.trim().to_string());
    let name_status = run_git(
        &root,
        &[
            "show",
            "--format=",
            "--name-status",
            "--find-renames",
            commit,
            "--",
        ],
    )?;
    let files = name_status
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 2 {
                return None;
            }
            let status = parts[0]
                .chars()
                .next()
                .map(|ch| ch.to_string())
                .unwrap_or_else(|| "?".to_string());
            let path = parts[parts.len() - 1].trim();
            if path.is_empty() {
                return None;
            }
            Some(GitFileChange {
                path: path.to_string(),
                status,
                index_status: String::new(),
                worktree_status: String::new(),
                staged: false,
                unstaged: false,
                untracked: false,
            })
        })
        .collect();
    let diff = run_git(
        &root,
        &[
            "show",
            "--format=",
            "--no-ext-diff",
            "--unified=3",
            commit,
            "--",
        ],
    )?;
    Ok(GitSnapshot {
        is_repository: true,
        branch,
        files,
        diff,
    })
}

#[tauri::command]
fn git_restore_files(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err("workspace no longer exists".to_string());
    }
    if paths.is_empty() {
        return Err("no paths to restore".to_string());
    }
    let mut restore_args = vec!["restore".to_string(), "--".to_string()];
    restore_args.extend(paths.iter().cloned());
    let output = hidden_command("git")
        .args(&restore_args)
        .current_dir(&root)
        .output()
        .map_err(|err| format!("failed to run git restore: {err}"))?;
    if output.status.success() {
        return Ok(());
    }
    // Older Git: fall back to checkout --
    let mut checkout_args = vec!["checkout".to_string(), "--".to_string()];
    checkout_args.extend(paths);
    let retry = hidden_command("git")
        .args(&checkout_args)
        .current_dir(&root)
        .output()
        .map_err(|err| format!("failed to run git checkout: {err}"))?;
    if retry.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let err2 = String::from_utf8_lossy(&retry.stderr).trim().to_string();
    Err(if !err.is_empty() {
        err
    } else if !err2.is_empty() {
        err2
    } else {
        "git restore failed".to_string()
    })
}

fn run_git_path_command(root: &Path, args: &[&str], paths: &[String]) -> Result<(), String> {
    let output = hidden_command("git")
        .args(args)
        .arg("--")
        .args(paths)
        .current_dir(root)
        .output()
        .map_err(|err| format!("failed to run git: {err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("git {} failed", args.join(" "))
    } else {
        stderr
    })
}

fn validate_git_paths(cwd: &str, paths: &[String]) -> Result<PathBuf, String> {
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Err("workspace no longer exists".to_string());
    }
    if paths.is_empty() {
        return Err("no paths selected".to_string());
    }
    if paths.iter().any(|path| path.trim().is_empty()) {
        return Err("empty Git path is not allowed".to_string());
    }
    Ok(root)
}

#[tauri::command]
fn git_stage_files(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let root = validate_git_paths(&cwd, &paths)?;
    run_git_path_command(&root, &["add"], &paths)
}

#[tauri::command]
fn git_unstage_files(cwd: String, paths: Vec<String>) -> Result<(), String> {
    let root = validate_git_paths(&cwd, &paths)?;
    match run_git_path_command(&root, &["restore", "--staged"], &paths) {
        Ok(()) => Ok(()),
        Err(first_error) => run_git_path_command(&root, &["reset", "HEAD"], &paths)
            .map_err(|second_error| format!("{first_error}\n{second_error}")),
    }
}

#[tauri::command]
fn git_snapshot(cwd: String) -> Result<GitSnapshot, String> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err("workspace no longer exists".to_string());
    }

    let branch_output = run_git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let Ok(branch) = branch_output else {
        return Ok(GitSnapshot {
            is_repository: false,
            branch: None,
            files: Vec::new(),
            diff: String::new(),
        });
    };

    let (status, working, staged) = std::thread::scope(|scope| {
        let status = scope.spawn(|| {
            run_git(
                &root,
                &["status", "--porcelain=v1", "--untracked-files=all"],
            )
            .unwrap_or_default()
        });
        let working = scope.spawn(|| {
            run_git(&root, &["diff", "--no-ext-diff", "--unified=3", "--"]).unwrap_or_default()
        });
        let staged = scope.spawn(|| {
            run_git(
                &root,
                &["diff", "--cached", "--no-ext-diff", "--unified=3", "--"],
            )
            .unwrap_or_default()
        });
        (
            status.join().unwrap_or_default(),
            working.join().unwrap_or_default(),
            staged.join().unwrap_or_default(),
        )
    });
    let files = parse_git_status(&status);
    let diff = match (staged.is_empty(), working.is_empty()) {
        (true, _) => working,
        (_, true) => staged,
        (false, false) => format!("# Staged changes\n{staged}\n# Working tree changes\n{working}"),
    };

    Ok(GitSnapshot {
        is_repository: true,
        branch: Some(branch.trim().to_string()),
        files,
        diff,
    })
}

#[tauri::command]
fn git_repository_root(cwd: String) -> Result<Option<String>, String> {
    let workspace = PathBuf::from(cwd.trim());
    if !workspace.is_dir() {
        return Ok(None);
    }
    match run_git(&workspace, &["rev-parse", "--show-toplevel"]) {
        Ok(root) => {
            let root = root.trim();
            Ok((!root.is_empty()).then(|| root.to_string()))
        }
        Err(_) => Ok(None),
    }
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = hidden_command("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|err| format!("failed to run git: {err}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn browser_webview_action(
    app: AppHandle,
    label: String,
    action: String,
    url: Option<String>,
) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser webview is not available".to_string())?;
    match action.as_str() {
        "navigate" => {
            let raw = url.ok_or_else(|| "browser URL is required".to_string())?;
            let parsed =
                tauri::Url::parse(&raw).map_err(|err| format!("invalid browser URL: {err}"))?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err("browser only supports HTTP(S) URLs".to_string());
            }
            webview.navigate(parsed).map_err(|err| err.to_string())
        }
        "back" => webview
            .eval("history.back()")
            .map_err(|err| err.to_string()),
        "forward" => webview
            .eval("history.forward()")
            .map_err(|err| err.to_string()),
        "reload" => webview.reload().map_err(|err| err.to_string()),
        _ => Err("unsupported browser action".to_string()),
    }
}

fn validate_workspace_directory(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("workspace path is empty".to_string());
    }
    let workspace = PathBuf::from(trimmed);
    if !workspace.is_absolute() {
        return Err("workspace path must be absolute".to_string());
    }
    let metadata = fs::metadata(&workspace)
        .map_err(|err| format!("workspace path is not available: {err}"))?;
    if !metadata.is_dir() {
        return Err("workspace path is not a directory".to_string());
    }
    Ok(workspace)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEditorInfo {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Copy)]
struct WorkspaceEditorSpec {
    id: &'static str,
    name: &'static str,
    commands: &'static [&'static str],
    executable_names: &'static [&'static str],
}

const WORKSPACE_EDITOR_SPECS: &[WorkspaceEditorSpec] = &[
    WorkspaceEditorSpec {
        id: "cursor",
        name: "Cursor",
        commands: &["cursor"],
        executable_names: &["Cursor.exe"],
    },
    WorkspaceEditorSpec {
        id: "vscode",
        name: "Visual Studio Code",
        commands: &["code", "code-insiders"],
        executable_names: &["Code.exe", "Code - Insiders.exe"],
    },
    WorkspaceEditorSpec {
        id: "windsurf",
        name: "Windsurf",
        commands: &["windsurf"],
        executable_names: &["Windsurf.exe"],
    },
    WorkspaceEditorSpec {
        id: "antigravity",
        name: "Antigravity",
        commands: &["antigravity"],
        executable_names: &["Antigravity.exe"],
    },
];

fn workspace_editor_spec(editor_id: &str) -> Option<&'static WorkspaceEditorSpec> {
    WORKSPACE_EDITOR_SPECS
        .iter()
        .find(|editor| editor.id.eq_ignore_ascii_case(editor_id.trim()))
}

#[cfg(windows)]
fn prefer_native_editor_executable(path: PathBuf, spec: &WorkspaceEditorSpec) -> PathBuf {
    if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return path;
    }
    for ancestor in path.ancestors().take(6) {
        for executable_name in spec.executable_names {
            let candidate = ancestor.join(executable_name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    path
}

#[cfg(windows)]
fn windows_editor_install_candidates(spec: &WorkspaceEditorSpec) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local_app_data).join("Programs"));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        roots.push(PathBuf::from(program_files));
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        roots.push(PathBuf::from(program_files_x86));
    }

    let install_directories: &[&str] = match spec.id {
        "cursor" => &["Cursor", "cursor"],
        "vscode" => &["Microsoft VS Code", "Microsoft VS Code Insiders"],
        "windsurf" => &["Windsurf"],
        "antigravity" => &["Antigravity", "antigravity"],
        _ => &[],
    };
    let mut candidates = roots
        .iter()
        .flat_map(|root| {
            install_directories.iter().flat_map(move |directory| {
                spec.executable_names
                    .iter()
                    .map(move |name| root.join(directory).join(name))
            })
        })
        .collect::<Vec<_>>();

    if let Some(user_profile) = std::env::var_os("USERPROFILE") {
        let scoop_name = match spec.id {
            "cursor" => "cursor",
            "vscode" => "vscode",
            "windsurf" => "windsurf",
            "antigravity" => "antigravity",
            _ => "",
        };
        if !scoop_name.is_empty() {
            let root = PathBuf::from(user_profile)
                .join("scoop")
                .join("apps")
                .join(scoop_name)
                .join("current");
            candidates.extend(spec.executable_names.iter().map(|name| root.join(name)));
        }
    }
    candidates
}

#[cfg(windows)]
fn resolve_workspace_editor(spec: &WorkspaceEditorSpec) -> Option<PathBuf> {
    if let Some(candidate) = windows_editor_install_candidates(spec)
        .into_iter()
        .find(|candidate| candidate.is_file())
    {
        return Some(candidate);
    }

    spec.commands.iter().find_map(|program| {
        let candidate = resolve_windows_executable(program)?;
        let normalized = candidate.to_string_lossy().to_ascii_lowercase();
        if spec.id == "vscode"
            && (normalized.contains("cursor")
                || normalized.contains("windsurf")
                || normalized.contains("antigravity"))
        {
            return None;
        }
        Some(prefer_native_editor_executable(candidate, spec))
    })
}

#[cfg(not(windows))]
fn resolve_workspace_editor(spec: &WorkspaceEditorSpec) -> Option<PathBuf> {
    let path_entries = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    spec.commands
        .iter()
        .flat_map(|program| path_entries.iter().map(move |entry| entry.join(program)))
        .find(|candidate| candidate.is_file())
}

#[tauri::command]
fn list_workspace_editors() -> Vec<WorkspaceEditorInfo> {
    WORKSPACE_EDITOR_SPECS
        .iter()
        .filter(|editor| resolve_workspace_editor(editor).is_some())
        .map(|editor| WorkspaceEditorInfo {
            id: editor.id.to_string(),
            name: editor.name.to_string(),
        })
        .collect()
}

#[tauri::command]
fn open_workspace_in_editor(path: String, editor_id: String) -> Result<(), String> {
    let workspace = validate_workspace_directory(&path)?;
    let editor = workspace_editor_spec(&editor_id)
        .ok_or_else(|| format!("unsupported workspace editor: {editor_id}"))?;
    let executable = resolve_workspace_editor(editor)
        .ok_or_else(|| format!("{} is not installed or cannot be found", editor.name))?;

    hidden_command(&executable)
        .arg(&workspace)
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("failed to open workspace in {}: {err}", editor.name))
}

#[tauri::command]
fn open_workspace_in_file_manager(path: String) -> Result<(), String> {
    let workspace = validate_workspace_directory(&path)?;

    #[cfg(windows)]
    {
        hidden_command("explorer.exe")
            .arg(&workspace)
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("failed to open File Explorer: {err}"))
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&workspace)
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("failed to open Finder: {err}"))
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&workspace)
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("failed to open file manager: {err}"))
    }
}

fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn initialize_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray_show", "打开 Pi Desktop", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray_quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("Pi Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_show" => show_main_window(app),
            "tray_quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    std::thread::spawn(|| loop {
        const ES_CONTINUOUS: u32 = 0x8000_0000;
        const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
        const ES_AWAYMODE_REQUIRED: u32 = 0x0000_0040;
        let flags = if KEEP_AWAKE.load(Ordering::Relaxed) {
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
        } else {
            ES_CONTINUOUS
        };
        unsafe {
            SetThreadExecutionState(flags);
        }
        std::thread::sleep(std::time::Duration::from_secs(30));
    });

    let bundled_pi_binary = pi::runtime::locate_bundled_pi_binary();
    if let Some(path) = &bundled_pi_binary {
        eprintln!(
            "Pi Desktop is using bundled Pi runtime at {}",
            path.display()
        );
    } else {
        eprintln!(
            "Pi Desktop bundled Pi runtime was not found; falling back to configured Pi command"
        );
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            runtimes: Mutex::new(HashMap::new()),
            settings: Mutex::new(load_settings()),
            bundled_pi_binary,
            projects: Mutex::new(load_json_list(&projects_path())),
            scheduled_tasks: Mutex::new(load_json_list(&scheduled_tasks_path())),
            running_scheduled_tasks: Mutex::new(HashMap::new()),
            workspace_searches: Mutex::new(HashMap::new()),
            terminal_sessions: Mutex::new(HashMap::new()),
        })
        .setup(|app| {
            initialize_tray(app)?;
            if let Err(error) = initialize_scheduled_runner(app.handle()) {
                eprintln!("failed to initialize scheduled runner: {error}");
            }
            let runner_app = app.handle().clone();
            std::thread::spawn(move || loop {
                run_due_scheduled_tasks(&runner_app);
                std::thread::sleep(std::time::Duration::from_secs(15));
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            quit_app,
            pi_start,
            pi_send,
            pi_stop,
            pi_is_running,
            pi_bind_session,
            list_pi_runtimes,
            quick_chat_dir,
            list_projects_cmd,
            register_project_cmd,
            save_project_cmd,
            remove_local_project_cmd,
            list_scheduled_tasks_cmd,
            list_scheduled_runs_cmd,
            save_scheduled_task_cmd,
            delete_scheduled_task_cmd,
            run_scheduled_task_cmd,
            cancel_scheduled_task_cmd,
            list_sessions_cmd,
            session_history_cmd,
            export_session_markdown,
            session_message_timings_cmd,
            session_messages_cmd,
            list_archived_sessions_cmd,
            archive_session_cmd,
            restore_session_cmd,
            delete_session_cmd,
            get_settings,
            set_settings,
            get_local_memory,
            set_local_memory,
            export_local_memory,
            delete_local_memory,
            list_model_providers,
            save_model_provider,
            delete_model_provider,
            check_model_provider,
            read_attachment,
            git_snapshot,
            git_repository_root,
            git_restore_files,
            git_stage_files,
            git_unstage_files,
            git_list_branches,
            git_checkout_branch,
            git_compare,
            git_review_snapshot,
            git_list_commits,
            git_commit_snapshot,
            list_resources,
            open_appearance_directory,
            install_appearance_extension,
            search_pi_packages,
            pi_package_detail,
            list_workspace_dir,
            search_workspace_files,
            cancel_workspace_search,
            read_workspace_file,
            open_workspace_in_file_manager,
            list_workspace_editors,
            open_workspace_in_editor,
            browser_webview_action,
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            pi_package_action,
            usage_summary,
            list_pull_requests,
            checkout_pull_request,
            list_worktrees,
            create_worktree
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pi Desktop");
}

pub fn run_computer_helper() -> i32 {
    #[cfg(windows)]
    {
        computer::run()
    }
    #[cfg(not(windows))]
    {
        println!(r#"{{"ok":false,"error":"Computer Use currently supports Windows only"}}"#);
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn isolated_side_chat_falls_back_when_parent_session_is_missing() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "pid-desktop-side-chat-session-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("temporary session directory should be created");
        let missing = root.join("missing.jsonl");

        assert!(resolve_session_for_launch(
            &root.to_string_lossy(),
            &missing.to_string_lossy(),
            true,
        )
        .expect("isolated launch should accept a missing parent")
        .is_none());
        assert!(resolve_session_for_launch(
            &root.to_string_lossy(),
            &missing.to_string_lossy(),
            false,
        )
        .is_err());

        let existing = root.join("existing.jsonl");
        fs::write(&existing, "{}\n").expect("temporary session should be written");
        let resolved =
            resolve_session_for_launch(&root.to_string_lossy(), &existing.to_string_lossy(), true)
                .expect("existing isolated parent should be validated")
                .expect("existing isolated parent should be used");
        assert_eq!(resolved, fs::canonicalize(&existing).unwrap());

        fs::remove_dir_all(root).expect("temporary session directory should be removed");
    }

    #[test]
    fn confines_relative_and_absolute_files_to_the_workspace() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "pid-desktop-workspace-path-{}-{stamp}",
            std::process::id()
        ));
        let workspace = directory.join("workspace");
        let outside = directory.join("outside.html");
        let inside = workspace.join("inside.html");
        fs::create_dir_all(&workspace).expect("temporary workspace should be created");
        fs::write(&inside, "<h1>inside</h1>").expect("workspace file should be written");
        fs::write(&outside, "<h1>outside</h1>").expect("outside file should be written");

        let cwd = workspace.to_string_lossy();
        assert_eq!(
            confined_workspace_path(&cwd, "inside.html")
                .expect("relative workspace path should be accepted")
                .1,
            strip_windows_prefix(fs::canonicalize(&inside).expect("inside file should resolve")),
        );
        assert_eq!(
            confined_workspace_path(&cwd, &inside.to_string_lossy())
                .expect("absolute workspace path should be accepted")
                .1,
            strip_windows_prefix(fs::canonicalize(&inside).expect("inside file should resolve")),
        );
        let forward_slash_inside = inside.to_string_lossy().replace('\\', "/");
        let content = read_workspace_file(cwd.to_string(), forward_slash_inside)
            .expect("forward-slash absolute HTML path should be readable");
        assert_eq!(content.text.as_deref(), Some("<h1>inside</h1>"));
        assert!(confined_workspace_path(&cwd, &outside.to_string_lossy()).is_err());
        assert!(confined_workspace_path(&cwd, "../outside.html").is_err());

        fs::remove_dir_all(directory).expect("temporary path fixture should be removed");
    }

    #[test]
    fn exports_conversation_as_readable_markdown() {
        let history = SessionHistory {
            messages: vec![
                serde_json::json!({ "role": "user", "content": "Explain this" }),
                serde_json::json!({
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": "private" },
                        { "type": "text", "text": "Here is the answer.\n\n```ts\nconst ok = true;\n```" }
                    ]
                }),
                serde_json::json!({ "role": "toolResult", "content": [{ "type": "text", "text": "hidden tool output" }] }),
            ],
            timings: Vec::new(),
        };
        let markdown = session_history_markdown(&history);
        assert!(markdown.contains("## User\n\nExplain this"));
        assert!(markdown.contains("## Assistant\n\nHere is the answer."));
        assert!(markdown.contains("```ts\nconst ok = true;\n```"));
        assert!(!markdown.contains("private"));
        assert!(!markdown.contains("hidden tool output"));
    }

    #[test]
    fn parses_git_index_and_worktree_status_separately() {
        let changes = parse_git_status(
            " M src/working.ts\nM  src/staged.ts\nMM src/both.ts\n?? src/new.ts\nR  old.ts -> renamed.ts\n",
        );
        assert_eq!(changes.len(), 5);
        assert!(!changes[0].staged);
        assert!(changes[0].unstaged);
        assert_eq!(changes[0].worktree_status, "M");
        assert!(changes[1].staged);
        assert!(!changes[1].unstaged);
        assert_eq!(changes[1].index_status, "M");
        assert!(changes[2].staged && changes[2].unstaged);
        assert!(changes[3].untracked && changes[3].unstaged);
        assert_eq!(changes[4].path, "renamed.ts");
    }

    #[test]
    fn stages_and_unstages_selected_files() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "pid-desktop-git-index-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("temporary repository should be created");
        run_git(&directory, &["init"]).expect("git repository should initialize");
        fs::write(directory.join("tracked.txt"), "first\n")
            .expect("tracked file should be written");
        run_git(&directory, &["add", "tracked.txt"]).expect("file should stage");
        run_git(
            &directory,
            &[
                "-c",
                "user.email=pid-desktop@example.invalid",
                "-c",
                "user.name=PIDesktop Tests",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "initial",
            ],
        )
        .expect("fixture commit should be created");
        fs::write(directory.join("tracked.txt"), "second\n")
            .expect("tracked file should be modified");

        let cwd = directory.to_string_lossy().to_string();
        let paths = vec!["tracked.txt".to_string()];
        let working = git_snapshot(cwd.clone()).expect("working snapshot should load");
        assert!(working.files[0].unstaged);
        let unstaged_review = git_review_snapshot(cwd.clone(), "unstaged".to_string())
            .expect("unstaged review should load");
        assert_eq!(unstaged_review.files.len(), 1);
        assert!(unstaged_review.diff.contains("-first"));
        git_stage_files(cwd.clone(), paths.clone()).expect("file should stage");
        let staged = git_snapshot(cwd.clone()).expect("staged snapshot should load");
        assert!(staged.files[0].staged);
        assert!(!staged.files[0].unstaged);
        let staged_review = git_review_snapshot(cwd.clone(), "staged".to_string())
            .expect("staged review should load");
        assert_eq!(staged_review.files.len(), 1);
        assert!(staged_review.diff.contains("+second"));
        let commits = git_list_commits(cwd.clone(), Some(5)).expect("commits should load");
        assert_eq!(commits.len(), 1);
        let commit_review = git_commit_snapshot(cwd.clone(), commits[0].sha.clone())
            .expect("commit review should load");
        assert_eq!(commit_review.files.len(), 1);
        assert!(commit_review.diff.contains("+first"));
        git_unstage_files(cwd.clone(), paths).expect("file should unstage");
        let unstaged = git_snapshot(cwd).expect("unstaged snapshot should load");
        assert!(!unstaged.files[0].staged);
        assert!(unstaged.files[0].unstaged);

        fs::remove_dir_all(directory).expect("temporary repository should be removed");
    }

    #[test]
    fn parses_git_worktree_porcelain_output() {
        let worktrees = parse_worktrees(
            "worktree D:/repo\nHEAD abcdef123456\nbranch refs/heads/main\n\nworktree D:/worktrees/task\nHEAD 123456abcdef\ndetached\n",
        );
        assert_eq!(worktrees.len(), 2);
        assert!(worktrees[0].is_main);
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
        assert!(!worktrees[1].is_main);
        assert_eq!(worktrees[1].path, "D:/worktrees/task");
    }

    #[test]
    fn validates_workspace_directory_before_opening_file_manager() {
        assert!(validate_workspace_directory("").is_err());
        assert!(validate_workspace_directory("relative/path").is_err());

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "pid-desktop-file-manager-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("temporary workspace should be created");
        let file = directory.join("not-a-workspace.txt");
        fs::write(&file, b"test").expect("temporary file should be created");

        assert_eq!(
            validate_workspace_directory(&directory.to_string_lossy())
                .expect("existing absolute directory should be accepted"),
            directory
        );
        assert!(validate_workspace_directory(&file.to_string_lossy()).is_err());

        fs::remove_dir_all(directory).expect("temporary workspace should be removed");
    }

    #[test]
    fn imports_theme_and_pet_extensions_into_project_scope() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "pid-desktop-appearance-import-{}-{stamp}",
            std::process::id()
        ));
        let workspace = root.join("workspace");
        let sources = root.join("sources");
        fs::create_dir_all(&workspace).expect("temporary workspace should be created");
        fs::create_dir_all(&sources).expect("temporary source directory should be created");

        let theme = sources.join("ocean.json");
        fs::write(&theme, r#"{ "name": "ocean" }"#).expect("theme fixture should be written");
        let installed_theme = install_appearance_extension(
            theme.to_string_lossy().to_string(),
            workspace.to_string_lossy().to_string(),
            "theme".to_string(),
            "project".to_string(),
        )
        .expect("theme should import");
        assert_eq!(
            PathBuf::from(installed_theme),
            workspace.join(".pi/themes/ocean.json")
        );

        let pet = sources.join("comet");
        fs::create_dir_all(pet.join("sprites")).expect("pet fixture should be created");
        fs::write(
            pet.join("pet.json"),
            r#"{ "id": "comet", "asset": "sprites/comet.png" }"#,
        )
        .expect("pet manifest should be written");
        fs::write(pet.join("sprites/comet.png"), b"png").expect("pet asset should be written");
        let installed_pet = install_appearance_extension(
            pet.to_string_lossy().to_string(),
            workspace.to_string_lossy().to_string(),
            "pet".to_string(),
            "project".to_string(),
        )
        .expect("pet should import");
        assert_eq!(
            PathBuf::from(installed_pet),
            workspace.join(".pi/pets/comet")
        );
        assert!(workspace.join(".pi/pets/comet/sprites/comet.png").is_file());

        assert!(install_appearance_extension(
            theme.to_string_lossy().to_string(),
            workspace.to_string_lossy().to_string(),
            "theme".to_string(),
            "project".to_string(),
        )
        .is_err());
        assert!(
            appearance_directory(&workspace.to_string_lossy(), "unsupported", "project").is_err()
        );

        fs::remove_dir_all(root).expect("temporary appearance fixture should be removed");
    }

    #[test]
    fn workspace_editor_catalog_has_stable_unique_ids() {
        let ids = WORKSPACE_EDITOR_SPECS
            .iter()
            .map(|editor| editor.id)
            .collect::<HashSet<_>>();
        assert_eq!(ids.len(), WORKSPACE_EDITOR_SPECS.len());
        assert_eq!(
            workspace_editor_spec("cursor").map(|item| item.name),
            Some("Cursor")
        );
        assert_eq!(
            workspace_editor_spec("VSCODE").map(|item| item.name),
            Some("Visual Studio Code")
        );
        assert_eq!(
            workspace_editor_spec("antigravity").map(|item| item.name),
            Some("Antigravity")
        );
        assert!(workspace_editor_spec("unknown").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn promotes_editor_command_script_to_native_executable() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "pid-desktop-editor-launcher-{}-{stamp}",
            std::process::id()
        ));
        let bin = root.join("resources").join("app").join("bin");
        fs::create_dir_all(&bin).expect("temporary editor bin should exist");
        let script = bin.join("cursor.cmd");
        let executable = root.join("Cursor.exe");
        fs::write(&script, b"").expect("temporary command script should be written");
        fs::write(&executable, b"").expect("temporary editor executable should be written");

        let spec = workspace_editor_spec("cursor").expect("Cursor spec should exist");
        assert_eq!(prefer_native_editor_executable(script, spec), executable);

        fs::remove_dir_all(root).expect("temporary editor directory should be removed");
    }

    #[cfg(windows)]
    #[test]
    fn resolves_windows_executable_from_explicit_search_directories() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "pid-desktop-command-path-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("temporary executable directory should exist");
        let executable = directory.join("gh.exe");
        fs::write(&executable, b"").expect("temporary executable should be written");

        assert_eq!(
            find_windows_executable_in_dirs("gh", std::slice::from_ref(&directory)),
            Some(executable)
        );

        fs::remove_dir_all(directory).expect("temporary executable directory should be removed");
    }

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
    fn validates_native_model_provider_input() {
        let provider = ModelProviderInput {
            id: "local-ollama".to_string(),
            base_url: "http://localhost:11434/v1".to_string(),
            api_key: "ollama".to_string(),
            models: vec![ModelProviderModel {
                id: "qwen2.5-coder:7b".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(validate_model_provider(&provider).is_ok());
    }

    #[test]
    fn rejects_duplicate_provider_model_ids() {
        let provider = ModelProviderInput {
            id: "custom".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            models: vec![
                ModelProviderModel {
                    id: "same-model".to_string(),
                    ..Default::default()
                },
                ModelProviderModel {
                    id: "same-model".to_string(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        assert!(validate_model_provider(&provider).is_err());
    }

    #[test]
    fn settings_reject_invalid_task_environment() {
        let settings = AppSettings {
            default_task_environment: "cloud".to_string(),
            ..Default::default()
        };
        // Mirror set_settings validation without full AppState.
        assert!(!matches!(
            settings.default_task_environment.as_str(),
            "local" | "worktree"
        ));
    }

    #[test]
    fn reads_string_and_filtered_package_settings() {
        let value = serde_json::json!({
            "packages": [
                "npm:plain-package",
                { "source": "npm:@scope/filtered@2.0.0", "skills": [] },
                { "skills": ["missing-source"] },
                42
            ]
        });
        assert_eq!(
            package_sources_from_settings(&value),
            vec!["npm:plain-package", "npm:@scope/filtered@2.0.0"]
        );
        assert_eq!(
            npm_package_name("npm:plain-package@1.2.0").as_deref(),
            Some("plain-package")
        );
        assert_eq!(
            npm_package_name("npm:@scope/filtered@2.0.0").as_deref(),
            Some("@scope/filtered")
        );
        assert!(npm_package_name("git:github.com/example/package").is_none());
    }

    #[test]
    fn filters_marketplace_external_urls() {
        assert_eq!(
            safe_external_url("git+https://github.com/example/package.git").as_deref(),
            Some("https://github.com/example/package.git")
        );
        assert_eq!(
            safe_external_url("git://github.com/example/package.git").as_deref(),
            Some("https://github.com/example/package")
        );
        assert!(safe_external_url("javascript:alert(1)").is_none());
        assert!(safe_external_url("file:///C:/private.txt").is_none());
    }

    #[test]
    fn marketplace_requests_run_off_the_command_thread() {
        let command_thread = std::thread::current().id();
        let worker_thread = tauri::async_runtime::block_on(run_marketplace_request(|| {
            Ok::<_, String>(std::thread::current().id())
        }))
        .expect("marketplace worker should complete");
        assert_ne!(command_thread, worker_thread);
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
}
