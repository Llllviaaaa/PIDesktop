use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

pub struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

pub type TerminalSessions = Mutex<HashMap<String, TerminalSession>>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    id: String,
}

fn shell_command(shell: &str) -> CommandBuilder {
    let normalized = shell.trim().to_ascii_lowercase();
    let mut command = if normalized.contains("cmd") || normalized.contains("command prompt") {
        CommandBuilder::new("cmd.exe")
    } else if normalized.contains("pwsh") {
        let mut command = CommandBuilder::new("pwsh.exe");
        command.arg("-NoLogo");
        command
    } else if normalized.contains("git bash") {
        let mut command = CommandBuilder::new("bash.exe");
        command.arg("--login");
        command.arg("-i");
        command
    } else {
        let mut command = CommandBuilder::new("powershell.exe");
        command.arg("-NoLogo");
        command
    };
    command.env("TERM", "xterm-256color");
    command
}

#[tauri::command]
pub fn terminal_create(
    state: State<'_, crate::AppState>,
    app: AppHandle,
    id: String,
    cwd: String,
    shell: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("terminal id is required".to_string());
    }
    if !std::path::Path::new(&cwd).is_dir() {
        return Err("terminal workspace does not exist".to_string());
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to open terminal: {error}"))?;

    let mut command = shell_command(&shell);
    command.cwd(&cwd);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("failed to start terminal shell: {error}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("failed to read terminal output: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("failed to open terminal input: {error}"))?;

    {
        let mut sessions = state
            .terminal_sessions
            .lock()
            .map_err(|_| "terminal state lock poisoned".to_string())?;
        if sessions.contains_key(&id) {
            return Err("terminal already exists".to_string());
        }
        sessions.insert(
            id.clone(),
            TerminalSession {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let data = String::from_utf8_lossy(&buffer[..read]).to_string();
                    let _ = app.emit(
                        "terminal-output",
                        TerminalOutput {
                            id: id.clone(),
                            data,
                        },
                    );
                }
            }
        }
        let _ = app.emit("terminal-exit", TerminalExit { id });
    });

    Ok(())
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, crate::AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state
        .terminal_sessions
        .lock()
        .map_err(|_| "terminal state lock poisoned".to_string())?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "terminal is not available".to_string())?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|error| format!("failed to write to terminal: {error}"))
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, crate::AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .terminal_sessions
        .lock()
        .map_err(|_| "terminal state lock poisoned".to_string())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| "terminal is not available".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("failed to resize terminal: {error}"))
}

#[tauri::command]
pub fn terminal_close(state: State<'_, crate::AppState>, id: String) -> Result<(), String> {
    let mut sessions = state
        .terminal_sessions
        .lock()
        .map_err(|_| "terminal state lock poisoned".to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        session
            .child
            .kill()
            .map_err(|error| format!("failed to close terminal: {error}"))?;
    }
    Ok(())
}
