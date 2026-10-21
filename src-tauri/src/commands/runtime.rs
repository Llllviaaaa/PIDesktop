//! Pi RPC runtimes: launching `pi --mode rpc`, forwarding lines to it, and stopping it.

use crate::*;

pub(crate) static NEXT_RUNTIME_ID: AtomicU64 = AtomicU64::new(1);

pub(crate) struct PiRuntime {
    pub(crate) client: PiRpcClient,
    pub(crate) cwd: String,
    pub(crate) session_file: Option<String>,
    /// Set for a side chat: its forked session lives here, outside the Pi session root.
    pub(crate) side_chat_dir: Option<PathBuf>,
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

#[tauri::command(async)]
pub(crate) fn pi_start(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    session_file: Option<String>,
    isolated: Option<bool>,
) -> Result<PiStartResult, AppError> {
    let cwd_path = PathBuf::from(&cwd);
    if !cwd_path.is_dir() {
        return Err(AppError::NotFound(format!(
            "workspace does not exist: {cwd}"
        )));
    }

    let is_isolated = isolated.unwrap_or(false);
    // Side chats fork their own session and must not take over a primary runtime.
    if !is_isolated {
        let mut runtimes = state
            .runtimes
            .lock()
            .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?;
        runtimes.retain(|_, runtime| runtime.client.is_running());
        let snapshots = runtimes
            .iter()
            .map(|(runtime_id, runtime)| pi::claim::RuntimeSnapshot {
                runtime_id: runtime_id.clone(),
                cwd: runtime.cwd.clone(),
                session_file: runtime.session_file.clone(),
                is_streaming: runtime.client.is_streaming(),
                has_pending_extension: runtime.client.pending_extension().is_some(),
            })
            .collect::<Vec<_>>();
        if let Some(claimed) = pi::claim::claim_primary(&snapshots, &cwd, session_file.as_deref()) {
            return Ok(PiStartResult {
                runtime_id: claimed.runtime_id,
                session_loaded: claimed.session_loaded,
                session_forked: false,
            });
        }
    }

    let settings = state
        .settings
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?
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
    let runtime_id = format!(
        "runtime-{}-{}",
        std::process::id(),
        NEXT_RUNTIME_ID.fetch_add(1, Ordering::Relaxed)
    );
    let side_chat_dir = if is_isolated {
        Some(runtime_session_dir(&runtime_id).ok_or_else(|| {
            AppError::Other("could not resolve the side chat session directory".to_string())
        })?)
    } else {
        None
    };
    let mut launch = match &side_chat_dir {
        Some(dir) => {
            let launch_settings = AppSettings {
                session_dir: dir.to_string_lossy().to_string(),
                ..settings.clone()
            };
            pi::launch::interactive(
                &launch_settings,
                &cwd,
                &settings.permission_mode,
                is_quick_chat,
            )?
        }
        None => pi::launch::interactive(&settings, &cwd, &settings.permission_mode, is_quick_chat)?,
    };
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
    let client = PiRpcClient::spawn(
        app,
        &runtime_id,
        &pi_binary,
        &cwd,
        &launch.extra_args,
        &launch.environment,
        &launch.sensitive_values,
    )
    .inspect_err(|_| {
        if let Some(dir) = &side_chat_dir {
            remove_runtime_session_dir(dir);
        }
    })?;

    state
        .runtimes
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?
        .insert(
            runtime_id.clone(),
            PiRuntime {
                client,
                cwd,
                session_file: initial_session_file,
                side_chat_dir,
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
) -> Result<Option<PathBuf>, AppError> {
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
) -> Result<(), AppError> {
    let guard = state
        .runtimes
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?;
    guard
        .get(&runtime_id)
        .ok_or_else(|| AppError::NotFound(format!("Pi runtime is not running: {runtime_id}")))?
        .client
        .send_line(&line)
}

#[tauri::command(async)]
pub(crate) fn pi_stop(state: State<'_, AppState>, runtime_id: String) -> Result<(), AppError> {
    let runtime = {
        let mut runtimes = state
            .runtimes
            .lock()
            .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?;
        let runtime = runtimes.remove(&runtime_id);
        #[cfg(windows)]
        if runtimes.is_empty() {
            KEEP_AWAKE.store(false, Ordering::Relaxed);
        }
        runtime
    };
    if let Some(runtime) = runtime {
        runtime.client.kill();
        if let Some(dir) = &runtime.side_chat_dir {
            remove_runtime_session_dir(dir);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn pi_is_running(
    state: State<'_, AppState>,
    runtime_id: String,
) -> Result<bool, AppError> {
    let mut runtimes = state
        .runtimes
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?;
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
) -> Result<(), AppError> {
    let mut runtimes = state
        .runtimes
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?;
    let runtime = runtimes
        .get_mut(&runtime_id)
        .ok_or_else(|| AppError::NotFound(format!("Pi runtime is not running: {runtime_id}")))?;
    runtime.session_file = Some(session_file);
    Ok(())
}

#[tauri::command]
pub(crate) fn list_pi_runtimes(state: State<'_, AppState>) -> Result<Vec<RuntimeInfo>, AppError> {
    let mut runtimes = state
        .runtimes
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?;
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
