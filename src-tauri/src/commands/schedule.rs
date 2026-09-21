//! Local scheduled Pi tasks: definitions, run history, and the runner that fires them.

use crate::*;

pub(crate) const MAX_CONCURRENT_SCHEDULED_RUNS: usize = 2;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ScheduledTask {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) prompt: String,
    pub(crate) cwd: String,
    pub(crate) frequency: String,
    pub(crate) hour: u8,
    pub(crate) minute: u8,
    pub(crate) weekday: u8,
    #[serde(default = "default_scheduled_permission_mode")]
    pub(crate) permission_mode: String,
    pub(crate) timeout_minutes: Option<u16>,
    pub(crate) enabled: bool,
    pub(crate) last_run_at: Option<u64>,
    pub(crate) next_run_at: Option<u64>,
    pub(crate) last_status: String,
    pub(crate) last_message: String,
}

pub(crate) fn default_scheduled_permission_mode() -> String {
    "ask".to_string()
}

pub(crate) fn is_safe_scheduled_permission_mode(mode: &str) -> bool {
    matches!(mode, "read-only" | "ask" | "workspace-write")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduledRunResult {
    pub(crate) success: bool,
    pub(crate) output: String,
    pub(crate) run: ScheduledRunRecord,
}

pub(crate) fn scheduled_tasks_path() -> PathBuf {
    app_config_dir().join("scheduled-tasks.json")
}

pub(crate) fn scheduled_runs_path() -> PathBuf {
    app_config_dir().join("scheduled-runs.sqlite3")
}

pub(crate) fn truncate_scheduled_output(value: &str, limit: usize) -> String {
    let mut chars = value.chars();
    let mut result: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() {
        result.push_str("\n... output truncated by PIDesktop");
    }
    result
}

pub(crate) struct ScheduledTaskRunGuard<'a> {
    pub(crate) running: &'a Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub(crate) id: String,
    pub(crate) cancelled: Arc<AtomicBool>,
}

impl ScheduledTaskRunGuard<'_> {
    pub(crate) fn cancellation(&self) -> &AtomicBool {
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

pub(crate) fn reserve_scheduled_task<'a>(
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

pub(crate) fn emit_scheduled_task(app: &AppHandle, task: &ScheduledTask) {
    let _ = app.emit("scheduled-task-updated", task);
}

pub(crate) fn detect_scheduled_session(
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

pub(crate) fn execute_scheduled_task(
    app: &AppHandle,
    state: &AppState,
    id: &str,
    trigger: &str,
) -> Result<ScheduledRunResult, AppError> {
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
    let running_task_result = (|| -> Result<ScheduledTask, AppError> {
        let mut tasks = state
            .scheduled_tasks
            .lock()
            .map_err(|_| AppError::locked("scheduled task"))?;
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
        Ok::<_, AppError>(snapshot)
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

    let task_result = (|| -> Result<Option<ScheduledTask>, AppError> {
        let mut tasks = state
            .scheduled_tasks
            .lock()
            .map_err(|_| AppError::locked("scheduled task"))?;
        let completed = tasks.iter_mut().find(|entry| entry.id == id).map(|entry| {
            entry.last_status = run.status.clone();
            entry.last_message = truncate_scheduled_output(&message, 2_000);
            entry.clone()
        });
        save_json_list(&scheduled_tasks_path(), &tasks)?;
        Ok::<_, AppError>(completed)
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
pub(crate) fn list_scheduled_tasks_cmd(
    state: State<'_, AppState>,
) -> Result<Vec<ScheduledTask>, String> {
    state
        .scheduled_tasks
        .lock()
        .map(|tasks| tasks.clone())
        .map_err(|_| "scheduled task state lock poisoned".to_string())
}

#[tauri::command(async)]
pub(crate) fn list_scheduled_runs_cmd(
    task_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ScheduledRunRecord>, String> {
    scheduler::list_runs(
        &scheduled_runs_path(),
        task_id.as_deref(),
        limit.unwrap_or(80),
    )
}

#[tauri::command(async)]
pub(crate) fn save_scheduled_task_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
    mut task: ScheduledTask,
) -> Result<ScheduledTask, AppError> {
    if task.name.trim().is_empty() {
        return Err(AppError::InvalidInput("task name is required".to_string()));
    }
    if task.prompt.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "task prompt is required".to_string(),
        ));
    }
    if !Path::new(&task.cwd).is_dir() {
        return Err(AppError::InvalidInput(
            "task workspace does not exist".to_string(),
        ));
    }
    if !matches!(
        task.frequency.as_str(),
        "hourly" | "daily" | "weekdays" | "weekly"
    ) {
        return Err(AppError::InvalidInput(
            "unsupported task frequency".to_string(),
        ));
    }
    if !is_safe_scheduled_permission_mode(&task.permission_mode) {
        return Err(AppError::InvalidInput(
            "scheduled task permission mode must be read-only, ask, or workspace-write".to_string(),
        ));
    }
    if task
        .timeout_minutes
        .is_some_and(|minutes| !(1..=240).contains(&minutes))
    {
        return Err(AppError::InvalidInput(
            "scheduled task timeout must be between 1 and 240 minutes".to_string(),
        ));
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

#[tauri::command(async)]
pub(crate) fn delete_scheduled_task_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
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
pub(crate) async fn run_scheduled_task_cmd(
    app: AppHandle,
    id: String,
    next_run_at: Option<u64>,
) -> Result<ScheduledRunResult, AppError> {
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
pub(crate) fn cancel_scheduled_task_cmd(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
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

pub(crate) fn initialize_scheduled_runner(app: &AppHandle) -> Result<(), AppError> {
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

pub(crate) fn run_due_scheduled_tasks(app: &AppHandle) {
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
