mod commands;
#[cfg(windows)]
mod computer;
mod config;
mod error;
mod extensions;
mod pi;
mod platform;
mod scheduler;
mod secret_store;
mod terminal;
mod workspace_files;

// The crate root doubles as a prelude: config.rs, platform.rs and every module
// under commands/ start with `use crate::*;`, so the std, serde and tauri
// imports below and the glob re-imports of each module are shared by all of
// them. Removing an import that looks unused here can break a sibling module.
use std::collections::HashMap;
use std::fs;
use std::io::Read;
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

use commands::desktop::*;
use commands::git::*;
use commands::memory::*;
use commands::packages::*;
use commands::project::*;
use commands::provider::*;
use commands::pull_request::*;
use commands::runtime::*;
use commands::schedule::*;
use commands::session::*;
use commands::settings::*;
use commands::usage::*;
use commands::workspace::*;
use config::*;
use error::AppError;
use extensions::{
    ensure_browser_extension, ensure_computer_extension, ensure_guard_extension,
    ensure_hooks_extension, ensure_mcp_extension, ensure_memory_extension,
    ensure_personal_instructions, ensure_plan_extension, ensure_providers_extension,
    ensure_subagents_extension,
};
use pi::process::{run_pi_print, PiPrintLimits};
use pi::rpc::PiRpcClient;
use pi::sessions::{list_sessions, trash_session, validate_session_path};
use platform::*;
use scheduler::ScheduledRunRecord;

#[cfg(windows)]
static KEEP_AWAKE: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
unsafe extern "system" {
    fn SetThreadExecutionState(es_flags: u32) -> u32;
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
    /// Session-less Pi process that lists providers and runs login/logout for Settings.
    provider_service: Mutex<Option<PiRpcClient>>,
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

#[tauri::command]
fn browser_webview_action(
    app: AppHandle,
    label: String,
    action: String,
    url: Option<String>,
) -> Result<(), AppError> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| AppError::NotFound("browser webview is not available".to_string()))?;
    match action.as_str() {
        "navigate" => {
            let raw =
                url.ok_or_else(|| AppError::InvalidInput("browser URL is required".to_string()))?;
            let parsed = tauri::Url::parse(&raw)
                .map_err(|err| AppError::InvalidInput(format!("invalid browser URL: {err}")))?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(AppError::InvalidInput(
                    "browser only supports HTTP(S) URLs".to_string(),
                ));
            }
            webview
                .navigate(parsed)
                .map_err(|err| AppError::Other(err.to_string()))
        }
        "back" => webview
            .eval("history.back()")
            .map_err(|err| AppError::Other(err.to_string())),
        "forward" => webview
            .eval("history.forward()")
            .map_err(|err| AppError::Other(err.to_string())),
        "reload" => webview
            .reload()
            .map_err(|err| AppError::Other(err.to_string())),
        _ => Err(AppError::InvalidInput(
            "unsupported browser action".to_string(),
        )),
    }
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
            provider_service: Mutex::new(None),
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
            provider_service_start,
            provider_service_send,
            provider_service_stop,
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
            discover_model_provider_models,
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
