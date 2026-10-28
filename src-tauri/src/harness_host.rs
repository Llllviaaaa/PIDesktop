//! The Harness Host (packages/host, docs/adr/0001-harness-host-process.md).
//!
//! One `pid-harness.exe` (scripts/prepare-harness-host.mjs) serves the RPC
//! gateway the V2 frontend talks to and better-sidebar's host routes
//! (`/sidebar/api/*`, the file and HTML routes, the watch sockets), which used
//! to run as a sidecar of their own. It starts on the first request for its
//! address. This process generates the RPC token and hands it over in the
//! environment, never on the command line. The host holds our end of its
//! stdin and exits when that pipe closes, so it never outlives the app however
//! the app ends. After a crash the next request restarts it with a growing
//! delay, and five crashes within a minute stop the restarts.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::AppError;

/// The page origins the host answers for: Tauri's on Windows (http, or
/// https when configured), its custom scheme elsewhere, and the dev server.
const PAGE_ORIGINS: &[&str] = &[
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];
#[cfg(debug_assertions)]
const DEV_PAGE_ORIGIN: &str = "http://localhost:1420";

const START_TIMEOUT: Duration = Duration::from_secs(20);
const TOKEN_ENV: &str = "PID_HARNESS_TOKEN";
const TOKEN_BYTES: usize = 32;
/// The delay before a restart, by how many crashes the window holds; a fifth
/// crash within the window stops the restarts.
const RESTART_DELAYS_MS: [u64; 4] = [500, 1_000, 2_000, 4_000];
const CRASH_WINDOW: Duration = Duration::from_secs(60);
const KEEPS_CRASHING: &str = "the Harness Host keeps crashing; restart Pi Desktop to try again";

#[derive(Default)]
pub(crate) struct HarnessHost(Mutex<HostState>);

#[derive(Default)]
struct HostState {
    running: Option<Running>,
    crashes: VecDeque<Instant>,
}

struct Running {
    child: Child,
    base: String,
    token: String,
}

/// Where the frontend reaches the host, and the token its RPC gateway expects.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessEndpoint {
    base_url: String,
    token: String,
}

fn locate_harness_host() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join("harness").join("pid-harness.exe"));
        }
    }
    #[cfg(debug_assertions)]
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("harness")
            .join("pid-harness.exe"),
    );
    candidates.into_iter().find(|candidate| candidate.is_file())
}

#[cfg(windows)]
fn fill_random(buffer: &mut [u8]) -> Result<(), AppError> {
    use windows_sys::Win32::Security::Cryptography::{
        BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
    };

    let length: u32 = buffer
        .len()
        .try_into()
        .map_err(|_| AppError::Other("random buffer is too large".to_string()))?;
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            buffer.as_mut_ptr(),
            length,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(AppError::Other(format!(
            "Windows could not generate random bytes ({status:#x})"
        )));
    }
    Ok(())
}

#[cfg(not(windows))]
fn fill_random(buffer: &mut [u8]) -> Result<(), AppError> {
    use std::io::Read;

    std::fs::File::open("/dev/urandom")?.read_exact(buffer)?;
    Ok(())
}

/// A fresh RPC token: 32 random bytes as unpadded base64url.
fn new_token() -> Result<String, AppError> {
    let mut bytes = [0u8; TOKEN_BYTES];
    fill_random(&mut bytes)?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

/// How long to wait before restarting after `crashes` recent crashes, or
/// `None` once the window holds too many of them.
fn restart_delay(crashes: usize) -> Option<Duration> {
    if crashes == 0 {
        return Some(Duration::ZERO);
    }
    let millis = RESTART_DELAYS_MS.get(crashes - 1)?;
    Some(Duration::from_millis(*millis))
}

fn start(app: &AppHandle) -> Result<Running, AppError> {
    let executable = locate_harness_host()
        .ok_or_else(|| AppError::NotFound("the Harness Host is not installed".to_string()))?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Io(format!("no app data directory: {error}")))?;
    let token = new_token()?;

    let mut command = Command::new(&executable);
    command
        .arg("--data-dir")
        .arg(&data_dir)
        .args(["--port", "0", "--exit-with-stdin"])
        .env(TOKEN_ENV, &token);
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
        .map_err(|error| AppError::Process(format!("failed to start the Harness Host: {error}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Process("failed to read the Harness Host".to_string()))?;
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
            return Err(AppError::Process(format!(
                "the Harness Host did not start: {error}"
            )));
        }
        Err(_) => {
            let _ = child.kill();
            return Err(AppError::Process(
                "the Harness Host did not start in time".to_string(),
            ));
        }
    };
    let port = serde_json::from_str::<serde_json::Value>(line.trim())
        .ok()
        .and_then(|value| value.get("port")?.as_u64())
        .filter(|port| (1..=u64::from(u16::MAX)).contains(port));
    let Some(port) = port else {
        let _ = child.kill();
        return Err(AppError::Process(format!(
            "the Harness Host reported no port: {}",
            line.trim()
        )));
    };
    Ok(Running {
        child,
        base: format!("http://127.0.0.1:{port}/"),
        token,
    })
}

/// The running host's endpoint, starting it (again) when it is not running.
fn ensure_running(app: &AppHandle, host: &HarnessHost) -> Result<HarnessEndpoint, AppError> {
    let mut state = host
        .0
        .lock()
        .map_err(|_| AppError::locked("harness host"))?;
    let now = Instant::now();
    if let Some(current) = state.running.as_mut() {
        if matches!(current.child.try_wait(), Ok(None)) {
            return Ok(HarnessEndpoint {
                base_url: current.base.clone(),
                token: current.token.clone(),
            });
        }
        state.running = None;
        state.crashes.push_back(now);
    }
    let crashes = &mut state.crashes;
    crashes.retain(|crash| now.duration_since(*crash) <= CRASH_WINDOW);
    let Some(delay) = restart_delay(crashes.len()) else {
        return Err(AppError::Process(KEEPS_CRASHING.to_string()));
    };
    std::thread::sleep(delay);
    let started = start(app)?;
    let endpoint = HarnessEndpoint {
        base_url: started.base.clone(),
        token: started.token.clone(),
    };
    state.running = Some(started);
    Ok(endpoint)
}

/// The host's base URL and RPC token.
#[tauri::command(async)]
pub(crate) fn harness_endpoint(
    app: AppHandle,
    state: State<'_, HarnessHost>,
) -> Result<HarnessEndpoint, AppError> {
    ensure_running(&app, &state)
}

/// The host's base URL, for better-sidebar's client half
/// (src/dsh-host/better-sidebar.ts), which reaches its routes there.
#[tauri::command(async)]
pub(crate) fn sidebar_host_base(
    app: AppHandle,
    state: State<'_, HarnessHost>,
) -> Result<String, AppError> {
    let endpoint = ensure_running(&app, &state)?;
    Ok(endpoint.base_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_fresh_base64url() {
        let first = new_token().expect("token");
        let second = new_token().expect("token");
        let base64url = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
        assert_eq!(first.len(), 43);
        assert!(first.chars().all(base64url));
        assert_ne!(first, second);
    }

    #[test]
    fn restarts_back_off_and_then_stop() {
        assert_eq!(restart_delay(0), Some(Duration::ZERO));
        assert_eq!(restart_delay(1), Some(Duration::from_millis(500)));
        assert_eq!(restart_delay(4), Some(Duration::from_millis(4_000)));
        assert_eq!(restart_delay(5), None);
        assert_eq!(restart_delay(9), None);
    }
}
