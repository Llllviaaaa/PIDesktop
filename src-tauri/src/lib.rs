#[cfg(windows)]
mod computer;
mod pi;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(windows)]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use pi::rpc::PiRpcClient;
use pi::sessions::{
    list_sessions, parse_session_file, trash_session, validate_session_path, SessionInfo,
};

const GUARD_EXTENSION: &str = include_str!("../resources/pidesktop-guard.ts");
const BROWSER_EXTENSION: &str = include_str!("../resources/pidesktop-browser.ts");
const COMPUTER_EXTENSION: &str = include_str!("../resources/pidesktop-computer.ts");
const MCP_EXTENSION: &str = include_str!("../resources/pidesktop-mcp.ts");

#[cfg(windows)]
static KEEP_AWAKE: AtomicBool = AtomicBool::new(false);
static NEXT_RUNTIME_ID: AtomicU64 = AtomicU64::new(1);

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
    #[serde(alias = "permission_mode")]
    permission_mode: String,
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
    browser_enabled: bool,
    browser_headless: bool,
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
            permission_mode: "ask".to_string(),
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
            theme: "dark".to_string(),
            accent_color: "#ffffff".to_string(),
            background_color: "#0f0f10".to_string(),
            foreground_color: "#f5f5f5".to_string(),
            ui_font: "Inter, Segoe UI, system-ui, sans-serif".to_string(),
            code_font: "JetBrains Mono, Consolas, monospace".to_string(),
            ui_scale: 100,
            personality: "pragmatic".to_string(),
            custom_instructions: String::new(),
            suggested_prompts: true,
            memory_enabled: true,
            browser_enabled: true,
            browser_headless: true,
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
    fn rpc_extra_args(
        &self,
        guard_extension: &Path,
        browser_extension: Option<&Path>,
        computer_extension: Option<&Path>,
        mcp_extension: Option<&Path>,
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
        }
        args
    }
}

struct PiRuntime {
    client: PiRpcClient,
    cwd: String,
    session_file: Option<String>,
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

struct AppState {
    runtimes: Mutex<HashMap<String, PiRuntime>>,
    settings: Mutex<AppSettings>,
}

fn app_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("pid-desktop")
}

fn settings_path() -> PathBuf {
    app_config_dir().join("settings.json")
}

#[tauri::command]
fn quick_chat_dir() -> Result<String, String> {
    let path = app_config_dir().join("quick-chat");
    fs::create_dir_all(&path)
        .map_err(|err| format!("failed to create quick chat directory: {err}"))?;
    Ok(path.to_string_lossy().to_string())
}

fn load_settings() -> AppSettings {
    fs::read_to_string(settings_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create settings directory: {err}"))?;
    }
    let raw = serde_json::to_string_pretty(settings)
        .map_err(|err| format!("failed to serialize settings: {err}"))?;
    fs::write(path, raw).map_err(|err| format!("failed to write settings: {err}"))
}

fn ensure_guard_extension() -> Result<PathBuf, String> {
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

fn ensure_mcp_config(servers: &[McpServerConfig]) -> Result<PathBuf, String> {
    let path = app_config_dir().join("mcp-servers.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("failed to create MCP config directory: {err}"))?;
    }
    let raw = serde_json::to_string_pretty(servers)
        .map_err(|err| format!("failed to serialize MCP servers: {err}"))?;
    fs::write(&path, raw).map_err(|err| format!("failed to write MCP config: {err}"))?;
    Ok(path)
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

#[tauri::command]
fn pi_start(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    session_file: Option<String>,
) -> Result<String, String> {
    let cwd_path = PathBuf::from(&cwd);
    if !cwd_path.is_dir() {
        return Err(format!("workspace does not exist: {cwd}"));
    }

    if let Some(ref requested_session) = session_file {
        let mut runtimes = state
            .runtimes
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        runtimes.retain(|_, runtime| runtime.client.is_running());
        if let Some((runtime_id, _)) = runtimes.iter().find(|(_, runtime)| {
            runtime.session_file.as_ref() == Some(requested_session)
                && paths_equal(&runtime.cwd, &cwd)
        }) {
            return Ok(runtime_id.clone());
        }
    }

    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .clone();
    #[cfg(windows)]
    KEEP_AWAKE.store(settings.prevent_sleep, Ordering::Relaxed);
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
    let mcp_config = settings
        .mcp_enabled
        .then(|| ensure_mcp_config(&settings.mcp_servers))
        .transpose()?;
    let extra_args = settings.rpc_extra_args(
        &guard_extension,
        browser_extension.as_deref(),
        computer_extension.as_deref(),
        mcp_extension.as_deref(),
    );
    let quick_root = app_config_dir().join("quick-chat");
    let is_quick_chat = cwd_path
        .canonicalize()
        .ok()
        .zip(quick_root.canonicalize().ok())
        .is_some_and(|(active, quick)| active == quick);
    let environment = vec![
        (
            "PIDESKTOP_PERMISSION_MODE".to_string(),
            settings.permission_mode.clone(),
        ),
        ("PIDESKTOP_WORKSPACE_ROOT".to_string(), cwd.clone()),
        (
            "PIDESKTOP_QUICK_CHAT".to_string(),
            if is_quick_chat { "1" } else { "0" }.to_string(),
        ),
        (
            "PIDESKTOP_BROWSER_HEADLESS".to_string(),
            if settings.browser_headless { "1" } else { "0" }.to_string(),
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
        (
            "PIDESKTOP_MCP_CONFIG".to_string(),
            mcp_config
                .as_deref()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default(),
        ),
        (
            "PIDESKTOP_MCP_CONFIRM".to_string(),
            if settings.mcp_confirm_tools { "1" } else { "0" }.to_string(),
        ),
    ];
    let runtime_id = format!(
        "runtime-{}-{}",
        std::process::id(),
        NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed)
    );
    let client = PiRpcClient::spawn(
        app,
        &runtime_id,
        &settings.pi_binary,
        &cwd,
        &extra_args,
        &environment,
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
                session_file,
            },
        );
    Ok(runtime_id)
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
    let mut runtimes = state
        .runtimes
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    if let Some(runtime) = runtimes.remove(&runtime_id) {
        runtime.client.kill();
    }
    #[cfg(windows)]
    if runtimes.is_empty() {
        KEEP_AWAKE.store(false, Ordering::Relaxed);
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
        .map_err(|_| "state lock poisoned".to_string())?;
    let archived = &settings.archived_sessions;
    Ok(list_sessions(&settings.session_dir)
        .into_iter()
        .filter(|session| !archived.iter().any(|file| file == &session.file))
        .collect())
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
        .map(|guard| guard.clone())
}

#[tauri::command]
fn set_settings(state: State<'_, AppState>, settings: AppSettings) -> Result<(), String> {
    if !matches!(
        settings.permission_mode.as_str(),
        "read-only" | "ask" | "workspace-write" | "full-access"
    ) {
        return Err("invalid permission mode".to_string());
    }
    if !(75..=150).contains(&settings.ui_scale) {
        return Err("UI scale must be between 75 and 150".to_string());
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
}

#[tauri::command]
fn list_resources(cwd: String) -> Result<Vec<ResourceItem>, String> {
    let mut items = Vec::new();
    if let Some(home) = dirs::home_dir() {
        let agent = home.join(".pi").join("agent");
        collect_resources(&agent.join("extensions"), "extension", "user", &mut items);
        collect_resources(&agent.join("skills"), "skill", "user", &mut items);
        collect_resources(&agent.join("prompts"), "prompt", "user", &mut items);
        let settings_path = agent.join("settings.json");
        if let Ok(raw) = fs::read_to_string(settings_path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(packages) = value.get("packages").and_then(|entry| entry.as_array()) {
                    for package in packages.iter().filter_map(|entry| entry.as_str()) {
                        items.push(ResourceItem {
                            kind: "package".to_string(),
                            name: package.to_string(),
                            path: package.to_string(),
                            scope: "user".to_string(),
                        });
                    }
                }
            }
        }
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
    items.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.name.cmp(&b.name)));
    Ok(items)
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
        });
    }
}

#[tauri::command]
fn pi_package_action(
    state: State<'_, AppState>,
    action: String,
    source: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    if !matches!(action.as_str(), "install" | "remove" | "update") {
        return Err("unsupported Pi package action".to_string());
    }
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .clone();
    let working_directory = cwd
        .filter(|value| Path::new(value).is_dir())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));

    #[cfg(windows)]
    let mut command = {
        let mut command_line =
            format!("\"{}\" {}", settings.pi_binary.replace('"', "\"\""), action);
        if let Some(value) = source.as_ref().filter(|value| !value.trim().is_empty()) {
            command_line.push(' ');
            command_line.push('"');
            command_line.push_str(&value.replace('"', "\"\""));
            command_line.push('"');
        }
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C", &command_line]);
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(&settings.pi_binary);
        command.arg(&action);
        if let Some(value) = source.as_ref().filter(|value| !value.trim().is_empty()) {
            command.arg(value);
        }
        command
    };
    let output = command
        .current_dir(working_directory)
        .output()
        .map_err(|err| format!("failed to run Pi package command: {err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
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
fn create_worktree(cwd: String, base: Option<String>) -> Result<WorktreeInfo, String> {
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
    let output = Command::new("git")
        .args(["worktree", "add", "--detach"])
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
        branch: None,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitFileChange {
    path: String,
    status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitSnapshot {
    is_repository: bool,
    branch: Option<String>,
    files: Vec<GitFileChange>,
    diff: String,
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

    let status = run_git(
        &root,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )
    .unwrap_or_default();
    let files = status
        .lines()
        .filter(|line| line.len() >= 3)
        .map(|line| GitFileChange {
            status: line[..2].trim().to_string(),
            path: line[3..].trim().to_string(),
        })
        .collect();
    let working =
        run_git(&root, &["diff", "--no-ext-diff", "--unified=3", "--"]).unwrap_or_default();
    let staged = run_git(
        &root,
        &["diff", "--cached", "--no-ext-diff", "--unified=3", "--"],
    )
    .unwrap_or_default();
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

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|err| format!("failed to run git: {err}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            runtimes: Mutex::new(HashMap::new()),
            settings: Mutex::new(load_settings()),
        })
        .invoke_handler(tauri::generate_handler![
            pi_start,
            pi_send,
            pi_stop,
            pi_is_running,
            pi_bind_session,
            list_pi_runtimes,
            quick_chat_dir,
            list_sessions_cmd,
            list_archived_sessions_cmd,
            archive_session_cmd,
            restore_session_cmd,
            delete_session_cmd,
            get_settings,
            set_settings,
            read_attachment,
            git_snapshot,
            list_resources,
            pi_package_action,
            usage_summary,
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
}
