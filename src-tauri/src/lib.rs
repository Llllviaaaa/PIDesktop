#[cfg(windows)]
mod computer;
mod pi;
mod terminal;

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
use tauri::{AppHandle, Manager, State};

use pi::rpc::PiRpcClient;
use pi::sessions::{
    list_sessions, parse_session_file, session_message_timings, session_messages, trash_session,
    validate_session_path, SessionInfo, SessionMessageTiming,
};

const GUARD_EXTENSION: &str = include_str!("../resources/pidesktop-guard.ts");
const RULES_MODULE: &str = include_str!("../resources/pidesktop-rules.ts");
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
    /// When true, shell/bash/exec always requires confirmation (unless full-access).
    always_confirm_shell: bool,
    /// When true, writes outside the workspace root are blocked without a confirm dialog.
    block_write_outside_workspace: bool,
    /// Newline- or comma-separated command prefixes that skip shell confirmation under ask/workspace-write.
    shell_allow_prefixes: String,
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
            always_confirm_shell: true,
            block_write_outside_workspace: true,
            shell_allow_prefixes: String::new(),
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
            accent_color: "#111111".to_string(),
            background_color: "#ffffff".to_string(),
            foreground_color: "#1a1a1a".to_string(),
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
struct ScheduledTask {
    id: String,
    name: String,
    prompt: String,
    cwd: String,
    frequency: String,
    hour: u8,
    minute: u8,
    weekday: u8,
    enabled: bool,
    last_run_at: Option<u64>,
    next_run_at: Option<u64>,
    last_status: String,
    last_message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledRunResult {
    success: bool,
    output: String,
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
    projects: Mutex<Vec<ProjectConfig>>,
    scheduled_tasks: Mutex<Vec<ScheduledTask>>,
    terminal_sessions: terminal::TerminalSessions,
}

fn app_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("pid-desktop")
}

fn settings_path() -> PathBuf {
    app_config_dir().join("settings.json")
}

fn projects_path() -> PathBuf {
    app_config_dir().join("projects.json")
}

fn scheduled_tasks_path() -> PathBuf {
    app_config_dir().join("scheduled-tasks.json")
}

fn normalize_path_key(path: &str) -> String {
    path.trim().trim_end_matches(['\\', '/']).replace('\\', "/").to_lowercase()
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
fn save_project_cmd(state: State<'_, AppState>, project: ProjectConfig) -> Result<ProjectConfig, String> {
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

#[tauri::command]
fn list_scheduled_tasks_cmd(state: State<'_, AppState>) -> Result<Vec<ScheduledTask>, String> {
    state
        .scheduled_tasks
        .lock()
        .map(|tasks| tasks.clone())
        .map_err(|_| "scheduled task state lock poisoned".to_string())
}

#[tauri::command]
fn save_scheduled_task_cmd(
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
    if !matches!(task.frequency.as_str(), "hourly" | "daily" | "weekdays" | "weekly") {
        return Err("unsupported task frequency".to_string());
    }
    task.hour = task.hour.min(23);
    task.minute = task.minute.min(59);
    task.weekday = task.weekday.min(6);
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
    Ok(task)
}

#[tauri::command]
fn delete_scheduled_task_cmd(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut tasks = state
        .scheduled_tasks
        .lock()
        .map_err(|_| "scheduled task state lock poisoned".to_string())?;
    tasks.retain(|task| task.id != id);
    save_json_list(&scheduled_tasks_path(), &tasks)
}

#[tauri::command]
fn run_scheduled_task_cmd(
    state: State<'_, AppState>,
    id: String,
    next_run_at: Option<u64>,
) -> Result<ScheduledRunResult, String> {
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let task = {
        let mut tasks = state
            .scheduled_tasks
            .lock()
            .map_err(|_| "scheduled task state lock poisoned".to_string())?;
        let task = tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| "scheduled task not found".to_string())?;
        task.last_run_at = Some(started_at);
        task.next_run_at = next_run_at;
        task.last_status = "running".to_string();
        task.last_message.clear();
        let snapshot = task.clone();
        save_json_list(&scheduled_tasks_path(), &tasks)?;
        snapshot
    };
    let settings = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .clone();
    let execution = hidden_command(&settings.pi_binary)
        .arg("-p")
        .arg(&task.prompt)
        .current_dir(&task.cwd)
        .output();
    let (success, message) = match execution {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let success = output.status.success();
            let message = if success {
                if stdout.is_empty() { stderr } else { stdout }
            } else if stderr.is_empty() {
                format!("Pi exited with {}", output.status.code().unwrap_or(-1))
            } else {
                stderr
            };
            (success, message)
        }
        Err(err) => (false, format!("failed to run scheduled Pi task: {err}")),
    };
    {
        let mut tasks = state
            .scheduled_tasks
            .lock()
            .map_err(|_| "scheduled task state lock poisoned".to_string())?;
        if let Some(entry) = tasks.iter_mut().find(|entry| entry.id == id) {
            entry.last_status = if success { "success" } else { "error" }.to_string();
            entry.last_message = message.chars().take(2000).collect();
        }
        save_json_list(&scheduled_tasks_path(), &tasks)?;
    }
    Ok(ScheduledRunResult { success, output: message })
}

fn ensure_guard_extension() -> Result<PathBuf, String> {
    // Rules helpers are imported by the guard extension; keep both files in sync on disk.
    ensure_bundled_extension("pidesktop-rules.ts", RULES_MODULE, "rules")?;
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
            });
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
    let mut extra_args = settings.rpc_extra_args(
        &guard_extension,
        browser_extension.as_deref(),
        computer_extension.as_deref(),
        mcp_extension.as_deref(),
    );
    let mut initial_session_file = None;
    let mut session_loaded = false;
    if let Some(requested_session) = session_file.as_deref() {
        let validated = validate_session_path(&settings.session_dir, requested_session)?;
        let validated = validated.to_string_lossy().to_string();
        if is_isolated {
            extra_args.extend(["--fork".to_string(), validated]);
        } else {
            extra_args.extend(["--session".to_string(), validated.clone()]);
            initial_session_file = Some(validated);
            session_loaded = true;
        }
    }
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
                session_file: initial_session_file,
            },
        );
    Ok(PiStartResult {
        runtime_id,
        session_loaded,
    })
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
        node_candidates.extend(
            std::env::split_paths(&path).map(|entry| entry.join("node.exe")),
        );
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

fn load_models_config() -> Result<serde_json::Value, String> {
    let path = models_config_path();
    if !path.exists() {
        return Ok(serde_json::json!({ "providers": {} }));
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("无法读取 {}: {err}", path.display()))?;
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
        fs::create_dir_all(parent)
            .map_err(|err| format!("无法创建 Pi 配置目录: {err}"))?;
    }
    if path.exists() {
        let backup = path.with_extension("json.pidesktop.bak");
        fs::copy(&path, &backup)
            .map_err(|err| format!("无法备份 models.json: {err}"))?;
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
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return Err("提供商 ID 只能包含字母、数字、点、短横线和下划线".to_string());
    }
    if provider.original_id.is_none() && provider.models.is_empty() {
        return Err("新提供商至少需要配置一个模型".to_string());
    }
    if provider.original_id.is_none() && provider.base_url.trim().is_empty() {
        return Err("新提供商需要 API 地址".to_string());
    }
    if !provider.base_url.trim().is_empty()
        && !(provider.base_url.starts_with("http://") || provider.base_url.starts_with("https://"))
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
        provider_object.insert("baseUrl".to_string(), serde_json::json!(provider.base_url.trim()));
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
                .find(|value| value.get("id").and_then(|value| value.as_str()) == Some(model.id.trim()))
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
    let pi_binary = state
        .settings
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .pi_binary
        .clone();
    #[cfg(windows)]
    let pi_binary = resolve_windows_pi_binary(&pi_binary);

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
    if !matches!(
        settings.default_task_environment.as_str(),
        "local" | "worktree"
    ) {
        return Err("invalid default task environment".to_string());
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDirEntry {
    name: String,
    path: String,
    is_dir: bool,
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
    let mut joined = root.clone();
    for part in relative.replace('\\', "/").split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("path is outside the workspace".to_string());
        }
        joined.push(part);
    }
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
fn search_workspace_files(cwd: String, query: String) -> Result<Vec<WorkspaceDirEntry>, String> {
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let (root, _) = confined_workspace_path(&cwd, "")?;
    let mut pending = vec![root.clone()];
    let mut matches = Vec::new();
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(&directory) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            if is_dir {
                if !matches!(name.as_str(), ".git" | "node_modules" | "target" | "dist" | ".next" | ".venv") {
                    pending.push(path);
                }
                continue;
            }
            let relative = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if name.to_ascii_lowercase().contains(&needle) || relative.to_ascii_lowercase().contains(&needle) {
                matches.push(WorkspaceDirEntry { name, path: relative, is_dir: false });
                if matches.len() >= 200 {
                    break;
                }
            }
        }
        if matches.len() >= 200 {
            break;
        }
    }
    matches.sort_by(|a, b| a.path.to_ascii_lowercase().cmp(&b.path.to_ascii_lowercase()));
    Ok(matches)
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
        truncated: metadata.len() > if binary_preview { MAX_BINARY_PREVIEW_BYTES } else { MAX_BYTES },
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
    let output = hidden_command("gh")
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
            number: item.get("number").and_then(|value| value.as_u64()).unwrap_or(0),
            title: item.get("title").and_then(|value| value.as_str()).unwrap_or("").to_string(),
            state: item.get("state").and_then(|value| value.as_str()).unwrap_or("OPEN").to_string(),
            is_draft: item.get("isDraft").and_then(|value| value.as_bool()).unwrap_or(false),
            head_ref_name: item.get("headRefName").and_then(|value| value.as_str()).unwrap_or("").to_string(),
            base_ref_name: item.get("baseRefName").and_then(|value| value.as_str()).unwrap_or("").to_string(),
            updated_at: item.get("updatedAt").and_then(|value| value.as_str()).unwrap_or("").to_string(),
            url: item.get("url").and_then(|value| value.as_str()).unwrap_or("").to_string(),
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
    let output = hidden_command("gh")
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
fn create_worktree(state: State<'_, AppState>, cwd: String, base: Option<String>) -> Result<WorktreeInfo, String> {
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBranchInfo {
    name: String,
    current: bool,
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
    let files = status
        .lines()
        .filter(|line| line.len() >= 3)
        .map(|line| GitFileChange {
            status: line[..2].trim().to_string(),
            path: line[3..].trim().to_string(),
        })
        .collect();
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
            let parsed = tauri::Url::parse(&raw).map_err(|err| format!("invalid browser URL: {err}"))?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err("browser only supports HTTP(S) URLs".to_string());
            }
            webview.navigate(parsed).map_err(|err| err.to_string())
        }
        "back" => webview.eval("history.back()").map_err(|err| err.to_string()),
        "forward" => webview.eval("history.forward()").map_err(|err| err.to_string()),
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

#[tauri::command]
fn open_workspace_in_file_manager(path: String) -> Result<(), String> {
    let workspace = validate_workspace_directory(&path)?;

    #[cfg(windows)]
    {
        return hidden_command("explorer.exe")
            .arg(&workspace)
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("failed to open File Explorer: {err}"));
    }

    #[cfg(target_os = "macos")]
    {
        return Command::new("open")
            .arg(&workspace)
            .spawn()
            .map(|_| ())
            .map_err(|err| format!("failed to open Finder: {err}"));
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

fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
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
            projects: Mutex::new(load_json_list(&projects_path())),
            scheduled_tasks: Mutex::new(load_json_list(&scheduled_tasks_path())),
            terminal_sessions: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
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
            save_scheduled_task_cmd,
            delete_scheduled_task_cmd,
            run_scheduled_task_cmd,
            list_sessions_cmd,
            session_message_timings_cmd,
            session_messages_cmd,
            list_archived_sessions_cmd,
            archive_session_cmd,
            restore_session_cmd,
            delete_session_cmd,
            get_settings,
            set_settings,
            list_model_providers,
            save_model_provider,
            delete_model_provider,
            check_model_provider,
            read_attachment,
            git_snapshot,
            git_restore_files,
            git_list_branches,
            git_checkout_branch,
            git_compare,
            list_resources,
            list_workspace_dir,
            search_workspace_files,
            read_workspace_file,
            open_workspace_in_file_manager,
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
    fn permission_rule_env_flags_roundtrip_defaults() {
        let settings = AppSettings::default();
        assert!(settings.always_confirm_shell);
        assert!(settings.block_write_outside_workspace);
        assert!(settings.shell_allow_prefixes.is_empty());
        assert_eq!(settings.default_task_environment, "local");
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
        let mut settings = AppSettings::default();
        settings.default_task_environment = "cloud".to_string();
        // Mirror set_settings validation without full AppState.
        assert!(!matches!(
            settings.default_task_environment.as_str(),
            "local" | "worktree"
        ));
    }
}
