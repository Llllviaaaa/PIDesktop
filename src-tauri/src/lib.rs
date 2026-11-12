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
mod webview_guard;
mod workspace_files;

pub use desktop_log::install_panic_hook;

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
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

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
static STREAMING_GUARD_ACTIVE: AtomicBool = AtomicBool::new(false);
static QUIT_CONFIRM_OPEN: AtomicBool = AtomicBool::new(false);
static EXPLICIT_EXIT: AtomicBool = AtomicBool::new(false);

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

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        webview_guard::spawn_recreate_main_window(app);
    }
}

fn exit_app_cleanly(app: &AppHandle) {
    log_line!("[desktop] exiting application on explicit request");
    EXPLICIT_EXIT.store(true, Ordering::SeqCst);
    desktop_log::mark_session_clean_exit("explicit_request");
    app.exit(0);
}

fn request_app_exit(app: AppHandle, already_confirmed: bool) {
    if already_confirmed || !STREAMING_GUARD_ACTIVE.load(Ordering::Acquire) {
        exit_app_cleanly(&app);
        return;
    }
    if QUIT_CONFIRM_OPEN.swap(true, Ordering::AcqRel) {
        return;
    }

    show_main_window(&app);
    let app_for_cb = app.clone();
    let mut dialog = app
        .dialog()
        .message(
            "当前有会话正在执行任务，退出将中断正在运行的流式回复或工具调用。确定仍要退出千机吗？",
        )
        .title("退出千机")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "仍要退出".to_string(),
            "继续运行".to_string(),
        ));
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.parent(&window);
    }
    dialog.show(move |confirmed| {
        QUIT_CONFIRM_OPEN.store(false, Ordering::Release);
        if confirmed {
            exit_app_cleanly(&app_for_cb);
        }
    });
}

fn initialize_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "tray_show", "打开 千机", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray_quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("千机")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_show" => show_main_window(app),
            "tray_quit" => request_app_exit(app.clone(), false),
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

/// Release builds explicitly disable WebView2 DevTools on application windows
/// (F12 and the default context-menu inspector) while keeping them enabled in debug builds.
#[cfg(all(windows, not(debug_assertions)))]
pub(crate) fn disable_window_devtools(label: &str, window: &tauri::WebviewWindow) {
    let owned_label = label.to_string();
    let result = window.with_webview(move |webview| {
        let disabled = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.Settings())
                .and_then(|settings| settings.SetAreDevToolsEnabled(false))
        };
        if let Err(err) = disabled {
            log_line!("[desktop] could not turn off DevTools for {owned_label}: {err}");
        }
    });
    if let Err(err) = result {
        log_line!(
            "[desktop] could not reach the {} webview: {err}",
            window.label()
        );
    }
}

#[cfg(all(windows, not(debug_assertions)))]
fn disable_app_devtools(app: &tauri::App) {
    for (label, window) in app.webview_windows() {
        disable_window_devtools(&label, &window);
    }
}

#[tauri::command]
fn set_streaming_guard(active: bool) {
    STREAMING_GUARD_ACTIVE.store(active, Ordering::Release);
}

#[tauri::command]
fn quit_app(app: AppHandle, confirmed: Option<bool>) {
    request_app_exit(app, confirmed.unwrap_or(false));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    desktop_log::install_panic_hook();

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
    #[cfg(windows)]
    KEEP_AWAKE.store(settings.prevent_sleep, Ordering::Relaxed);

    let app = tauri::Builder::default()
        // Must be registered first: a second launch hands off here and exits before
        // it can start its own window, tray icon or Harness Host.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
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
            // Recorded inside `.setup` (after `tauri_plugin_single_instance`) so a second
            // launch that hands off focus and exits never overwrites `desktop-lifecycle.json`.
            desktop_log::mark_session_start(env!("CARGO_PKG_VERSION"));
            initialize_tray(app)?;
            #[cfg(all(windows, not(debug_assertions)))]
            disable_app_devtools(app);
            #[cfg(windows)]
            webview_guard::install_for_all_windows(app);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                let _ = window.hide();
            }
            tauri::WindowEvent::Destroyed => {
                webview_guard::mark_detached(window.label());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            quit_app,
            set_streaming_guard,
            desktop_log::log_frontend_error,
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
            open_appearance_directory,
            install_appearance_extension,
            list_workspace_dir,
            search_workspace_files,
            cancel_workspace_search,
            read_workspace_file,
            write_workspace_file,
            open_workspace_in_file_manager,
            list_workspace_editors,
            open_workspace_in_editor,
            open_file_in_editor,
            reveal_path_in_file_manager,
            list_terminal_apps,
            open_workspace_in_terminal_app,
            terminal::terminal_shells,
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            harness_host::harness_endpoint,
            harness_host::restart_harness_host,
            list_pull_requests,
            checkout_pull_request,
            pull_request_draft_prompt,
            create_pull_request,
            get_pull_request_detail,
            list_worktrees,
            create_worktree
        ])
        .build(tauri::generate_context!())
        .expect("error while building Qianji");

    app.run(|_app_handle, event| match event {
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            if code.is_none() && !EXPLICIT_EXIT.load(Ordering::SeqCst) {
                api.prevent_exit();
                log_line!(
                    "[desktop] prevented implicit event-loop exit while tray or WebView recovery is active"
                );
            }
        }
        tauri::RunEvent::Exit => {
            if EXPLICIT_EXIT.load(Ordering::SeqCst) {
                desktop_log::mark_session_clean_exit("event_loop_exit");
            }
        }
        _ => {}
    });
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
