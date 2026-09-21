//! Pi RPC runtimes: launching `pi --mode rpc`, forwarding lines to it, and stopping it.

use crate::*;

pub(crate) static NEXT_RUNTIME_ID: AtomicU64 = AtomicU64::new(1);

pub(crate) struct PiRuntime {
    pub(crate) client: PiRpcClient,
    pub(crate) cwd: String,
    pub(crate) session_file: Option<String>,
    pub(crate) isolated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeInfo {
    pub(crate) runtime_id: String,
    pub(crate) cwd: String,
    pub(crate) session_file: Option<String>,
    pub(crate) is_streaming: bool,
    pub(crate) pending_extension: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PiStartResult {
    pub(crate) runtime_id: String,
    pub(crate) session_loaded: bool,
    pub(crate) session_forked: bool,
}

pub(crate) fn effective_pi_binary(settings: &AppSettings, state: &AppState) -> String {
    let configured =
        pi::runtime::resolve_pi_binary(&settings.pi_binary, state.bundled_pi_binary.as_deref());
    #[cfg(windows)]
    return resolve_windows_pi_binary(&configured);
    #[cfg(not(windows))]
    configured
}

pub(crate) struct PiLaunchConfig {
    pub(crate) extra_args: Vec<String>,
    pub(crate) environment: Vec<(String, String)>,
    pub(crate) sensitive_values: Vec<String>,
}

pub(crate) fn build_pi_launch_config(
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

#[tauri::command(async)]
pub(crate) fn pi_start(
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
    // Lets the desktop refresh this runtime's model snapshot after provider changes.
    // Optional: a chat must still start if the helper cannot be written.
    if let Ok(providers_extension) = ensure_providers_extension() {
        launch.extra_args.extend([
            "-e".to_string(),
            providers_extension.to_string_lossy().to_string(),
        ]);
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

pub(crate) fn resolve_session_for_launch(
    configured_root: &str,
    requested_session: &str,
    is_isolated: bool,
) -> Result<Option<PathBuf>, String> {
    if is_isolated && !Path::new(requested_session).is_file() {
        return Ok(None);
    }
    validate_session_path(configured_root, requested_session).map(Some)
}

#[cfg(windows)]
pub(crate) fn resolve_windows_pi_binary(value: &str) -> String {
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

#[tauri::command(async)]
pub(crate) fn pi_send(
    state: State<'_, AppState>,
    runtime_id: String,
    line: String,
) -> Result<(), String> {
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

#[tauri::command(async)]
pub(crate) fn pi_stop(state: State<'_, AppState>, runtime_id: String) -> Result<(), String> {
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
pub(crate) fn pi_is_running(
    state: State<'_, AppState>,
    runtime_id: String,
) -> Result<bool, String> {
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
pub(crate) fn pi_bind_session(
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
pub(crate) fn list_pi_runtimes(state: State<'_, AppState>) -> Result<Vec<RuntimeInfo>, String> {
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

pub(crate) fn paths_equal(left: &str, right: &str) -> bool {
    let normalize = |value: &str| value.trim_end_matches(['/', '\\']).to_lowercase();
    normalize(left) == normalize(right)
}

pub(crate) fn runtime_secret_values(settings: &AppSettings) -> Vec<String> {
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

pub(crate) fn redact_runtime_output(settings: &AppSettings, value: &str) -> String {
    pi::rpc::SecretRedactor::new(&runtime_secret_values(settings)).text(value)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
