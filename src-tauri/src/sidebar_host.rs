//! better-sidebar's host half, run as a sidecar.
//!
//! The right and bottom panels come from better-sidebar (src/better-sidebar),
//! whose client half talks to its own host routes (`/sidebar/api/*`, the file
//! and HTML routes, the watch sockets). DSH serves those from its host process;
//! PIDesktop runs the same host code as `better-sidebar-host.exe`
//! (scripts/prepare-sidebar-host.mjs), started on the first request for its
//! address. The sidecar holds our end of its stdin and exits when that pipe
//! closes, so it never outlives the app however the app ends.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::error::AppError;

/// The page origins the sidecar answers for: Tauri's on Windows (http, or
/// https when configured), its custom scheme elsewhere, and the dev server.
const PAGE_ORIGINS: &[&str] = &[
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];
#[cfg(debug_assertions)]
const DEV_PAGE_ORIGIN: &str = "http://localhost:1420";

const START_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Default)]
pub(crate) struct SidebarHost(Mutex<Option<Running>>);

struct Running {
    child: Child,
    base: String,
}

fn locate_sidebar_host() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join("sidebar-host").join("better-sidebar-host.exe"));
        }
    }
    #[cfg(debug_assertions)]
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("sidebar-host")
            .join("better-sidebar-host.exe"),
    );
    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn start(app: &AppHandle) -> Result<Running, AppError> {
    let executable = locate_sidebar_host()
        .ok_or_else(|| AppError::NotFound("the sidebar host is not installed".to_string()))?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Io(format!("no app data directory: {error}")))?
        .join("better-sidebar");

    let mut command = Command::new(&executable);
    command
        .arg("--data-dir")
        .arg(&data_dir)
        .args(["--port", "0", "--exit-with-stdin"]);
    for origin in PAGE_ORIGINS {
        command.args(["--page-origin", origin]);
    }
    #[cfg(debug_assertions)]
    command.args(["--page-origin", DEV_PAGE_ORIGIN]);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| AppError::Process(format!("failed to start the sidebar host: {error}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Process("failed to read the sidebar host".to_string()))?;
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("{line}");
            }
        });
    }

    // Its first stdout line is `{"port": n}`; nothing else is written there.
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = sender.send(result);
    });
    let line = match receiver.recv_timeout(START_TIMEOUT) {
        Ok(Ok(line)) => line,
        Ok(Err(error)) => {
            let _ = child.kill();
            return Err(AppError::Process(format!("the sidebar host did not start: {error}")));
        }
        Err(_) => {
            let _ = child.kill();
            return Err(AppError::Process("the sidebar host did not start in time".to_string()));
        }
    };
    let port = serde_json::from_str::<serde_json::Value>(line.trim())
        .ok()
        .and_then(|value| value.get("port")?.as_u64())
        .filter(|port| (1..=u64::from(u16::MAX)).contains(port));
    let Some(port) = port else {
        let _ = child.kill();
        return Err(AppError::Process(format!(
            "the sidebar host reported no port: {}",
            line.trim()
        )));
    };
    Ok(Running {
        child,
        base: format!("http://127.0.0.1:{port}/"),
    })
}

/// The sidebar host's base URL, starting it (again) when it is not running.
#[tauri::command(async)]
pub(crate) fn sidebar_host_base(
    app: AppHandle,
    state: State<'_, SidebarHost>,
) -> Result<String, AppError> {
    let mut running = state
        .0
        .lock()
        .map_err(|_| AppError::locked("sidebar host"))?;
    if let Some(current) = running.as_mut() {
        if matches!(current.child.try_wait(), Ok(None)) {
            return Ok(current.base.clone());
        }
    }
    let started = start(&app)?;
    let base = started.base.clone();
    *running = Some(started);
    Ok(base)
}
