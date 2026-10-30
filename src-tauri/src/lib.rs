#[macro_use]
mod desktop_log;

mod commands;
#[cfg(windows)]
mod computer;
mod config;
mod error;
mod extensions;
mod harness_host;
mod platform;
mod secret_store;
mod terminal;
mod workspace_files;

// The crate root doubles as a prelude: config.rs, platform.rs and every module
// under commands/ start with `use crate::*;`, so the std, serde and tauri
// imports below and the glob re-imports of each module are shared by all of
// them. Removing an import that looks unused here can break a sibling module.
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State,
};

use commands::commit::*;
use commands::desktop::*;
use commands::git::*;
use commands::memory::*;
use commands::packages::*;
use commands::project::*;
use commands::pull_request::*;
use commands::settings::*;
use commands::workspace::*;
use config::*;
use error::AppError;
use extensions::ensure_personal_instructions;
use platform::*;

#[cfg(windows)]
static KEEP_AWAKE: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
unsafe extern "system" {
    fn SetThreadExecutionState(es_flags: u32) -> u32;
}

struct AppState {
    settings: Mutex<AppSettings>,
    projects: Mutex<Vec<ProjectConfig>>,
    workspace_searches: Mutex<HashMap<String, Arc<AtomicBool>>>,
    terminal_sessions: terminal::TerminalSessions,
}

impl Drop for AppState {
    fn drop(&mut self) {
        if let Ok(terminals) = self.terminal_sessions.get_mut() {
            terminal::close_all(terminals);
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
        // Native webviews float above the page, so a hidden browser tab must hide them.
        "hide" => webview
            .hide()
            .map_err(|err| AppError::Other(err.to_string())),
        "show" => webview
            .show()
            .map_err(|err| AppError::Other(err.to_string())),
        "devtools" => {
            // Only the embedded browser gets an inspector, never the app's own UI.
            if !label.starts_with("workspace-browser-") {
                return Err(AppError::InvalidInput(
                    "developer tools are only available for the embedded browser".to_string(),
                ));
            }
            webview.open_devtools();
            Ok(())
        }
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

    let settings = load_settings();
    // Pi is gone (P6c); its old config directory is only read by the one-time imports.
    remember_pi_config(settings.separate_pi_config);
    migrate_pi_resources();
    #[cfg(windows)]
    KEEP_AWAKE.store(settings.prevent_sleep, Ordering::Relaxed);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            settings: Mutex::new(settings),
            projects: Mutex::new(load_json_list(&projects_path())),
            workspace_searches: Mutex::new(HashMap::new()),
            terminal_sessions: Mutex::new(HashMap::new()),
        })
        .manage(harness_host::HarnessHost::default())
        .setup(|app| {
            initialize_tray(app)?;
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
            quick_chat_dir,
            list_projects_cmd,
            register_project_cmd,
            save_project_cmd,
            remove_local_project_cmd,
            get_settings,
            set_settings,
            get_local_memory,
            set_local_memory,
            export_local_memory,
            delete_local_memory,
            read_attachment,
            git_snapshot,
            git_repository_root,
            git_restore_files,
            git_stage_files,
            git_unstage_files,
            git_apply_patch,
            git_last_turn_snapshot,
            git_list_branches,
            git_checkout_branch,
            git_compare,
            git_review_snapshot,
            git_list_commits,
            git_commit_snapshot,
            git_default_branch,
            git_commit,
            git_push,
            git_commit_message_prompt,
            list_resources,
            legacy_project_resources,
            migrate_project_resources,
            open_appearance_directory,
            install_appearance_extension,
            list_workspace_dir,
            search_workspace_files,
            cancel_workspace_search,
            read_workspace_file,
            open_workspace_in_file_manager,
            list_workspace_editors,
            open_workspace_in_editor,
            open_file_in_editor,
            reveal_path_in_file_manager,
            list_terminal_apps,
            open_workspace_in_terminal_app,
            browser_webview_action,
            terminal::terminal_shells,
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            harness_host::harness_endpoint,
            harness_host::restart_harness_host,
            harness_host::sidebar_host_base,
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
