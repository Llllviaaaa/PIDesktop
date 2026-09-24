use crate::error::AppError;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
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

/// Ends every shell. Terminals now outlive the panel that shows them, so the
/// app calls this on shutdown to make sure no shell outlives the window.
pub fn close_all(sessions: &mut HashMap<String, TerminalSession>) {
    for (_, mut session) in sessions.drain() {
        let _ = session.child.kill();
    }
}

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

/// Decodes a byte stream as UTF-8 without splitting a character across reads.
///
/// The PTY is read in fixed-size chunks, so a multi-byte character (any CJK
/// text) regularly straddles two reads. Decoding each chunk on its own turns
/// both halves into U+FFFD; this keeps the incomplete tail for the next read.
#[derive(Default)]
pub(crate) struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    output.push_str(text);
                    self.pending.clear();
                    return output;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    output
                        .push_str(std::str::from_utf8(&self.pending[..valid]).unwrap_or_default());
                    match error.error_len() {
                        // The bytes after `valid` start a character the next read completes.
                        None => {
                            self.pending.drain(..valid);
                            return output;
                        }
                        // Genuinely invalid bytes: replace them and keep decoding.
                        Some(invalid) => {
                            output.push('\u{FFFD}');
                            self.pending.drain(..valid + invalid);
                        }
                    }
                }
            }
        }
    }

    /// Whatever is left when the stream ends can no longer be completed.
    pub(crate) fn finish(&mut self) -> String {
        let rest = String::from_utf8_lossy(&self.pending).to_string();
        self.pending.clear();
        rest
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellKind {
    WindowsPowerShell,
    PowerShell7,
    CommandPrompt,
    GitBash,
    Wsl,
}

impl ShellKind {
    fn label(self) -> &'static str {
        match self {
            ShellKind::WindowsPowerShell => "PowerShell",
            ShellKind::PowerShell7 => "PowerShell 7",
            ShellKind::CommandPrompt => "Command Prompt",
            ShellKind::GitBash => "Git Bash",
            ShellKind::Wsl => "WSL",
        }
    }
}

/// Maps the label the settings and the terminal tab menu use onto a shell.
fn shell_kind(label: &str) -> ShellKind {
    let normalized = label.trim().to_ascii_lowercase();
    if normalized.contains("cmd") || normalized.contains("command prompt") {
        ShellKind::CommandPrompt
    } else if normalized.contains("pwsh") || normalized.contains("powershell 7") {
        ShellKind::PowerShell7
    } else if normalized.contains("git bash") {
        ShellKind::GitBash
    } else if normalized == "wsl" || normalized.starts_with("wsl ") {
        ShellKind::Wsl
    } else {
        ShellKind::WindowsPowerShell
    }
}

/// Git Bash lives next to Git itself. A bare `bash.exe` would usually resolve
/// to System32's WSL launcher, which is not the shell the user picked.
#[cfg(windows)]
fn git_bash_executable() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(git) = crate::platform::resolve_windows_executable("git") {
        for ancestor in git.ancestors().skip(1).take(3) {
            candidates.push(ancestor.join("bin").join("bash.exe"));
        }
    }
    for variable in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(variable) {
            candidates.push(PathBuf::from(root).join("Git").join("bin").join("bash.exe"));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local)
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

#[cfg(not(windows))]
fn git_bash_executable() -> Option<PathBuf> {
    None
}

#[cfg(windows)]
fn shell_available(kind: ShellKind) -> bool {
    match kind {
        ShellKind::WindowsPowerShell | ShellKind::CommandPrompt => true,
        ShellKind::PowerShell7 => crate::platform::resolve_windows_executable("pwsh").is_some(),
        ShellKind::GitBash => git_bash_executable().is_some(),
        ShellKind::Wsl => std::env::var_os("SystemRoot")
            .map(|root| {
                PathBuf::from(root)
                    .join("System32")
                    .join("wsl.exe")
                    .is_file()
            })
            .unwrap_or(false),
    }
}

#[cfg(not(windows))]
fn shell_available(kind: ShellKind) -> bool {
    matches!(kind, ShellKind::WindowsPowerShell)
}

fn shell_command(shell: &str) -> CommandBuilder {
    let mut command = match shell_kind(shell) {
        ShellKind::CommandPrompt => CommandBuilder::new("cmd.exe"),
        ShellKind::PowerShell7 => {
            let mut command = CommandBuilder::new("pwsh.exe");
            command.arg("-NoLogo");
            command
        }
        ShellKind::GitBash => {
            let program = git_bash_executable()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_else(|| "bash.exe".to_string());
            let mut command = CommandBuilder::new(program);
            command.arg("--login");
            command.arg("-i");
            command
        }
        // wsl.exe starts in the Windows working directory, mapped under /mnt.
        ShellKind::Wsl => CommandBuilder::new("wsl.exe"),
        ShellKind::WindowsPowerShell => {
            #[cfg(windows)]
            {
                let mut command = CommandBuilder::new("powershell.exe");
                command.arg("-NoLogo");
                command
            }
            #[cfg(not(windows))]
            {
                CommandBuilder::new(
                    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string()),
                )
            }
        }
    };
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "PIDesktop");
    command
}

#[cfg(windows)]
unsafe extern "system" {
    fn SetConsoleCtrlHandler(
        handler: Option<unsafe extern "system" fn(u32) -> i32>,
        add: i32,
    ) -> i32;
}

/// Makes Ctrl+C work in the shells this process starts.
///
/// Windows passes "ignore Ctrl+C" from parent to child. An app launched by
/// something that set it (a background task, some launchers and process
/// managers) would hand it to every terminal shell, and Ctrl+C would never
/// stop a dev server. Clearing it here restores normal processing for the
/// shells; this GUI process has no console of its own to receive the event.
#[cfg(windows)]
fn allow_ctrl_c_in_children() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        SetConsoleCtrlHandler(None, 0);
    });
}

#[cfg(not(windows))]
fn allow_ctrl_c_in_children() {}

/// The shells this machine can start, in the order the tab menu lists them.
#[tauri::command(async)]
pub fn terminal_shells() -> Vec<String> {
    [
        ShellKind::WindowsPowerShell,
        ShellKind::PowerShell7,
        ShellKind::CommandPrompt,
        ShellKind::GitBash,
        ShellKind::Wsl,
    ]
    .into_iter()
    .filter(|kind| shell_available(*kind))
    .map(|kind| kind.label().to_string())
    .collect()
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
) -> Result<(), AppError> {
    if id.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "terminal id is required".to_string(),
        ));
    }
    if !std::path::Path::new(&cwd).is_dir() {
        return Err(AppError::NotFound(
            "terminal workspace does not exist".to_string(),
        ));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| AppError::Io(format!("failed to open terminal: {error}")))?;

    allow_ctrl_c_in_children();
    let mut command = shell_command(&shell);
    command.cwd(&cwd);
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| AppError::Process(format!("failed to start terminal shell: {error}")))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| AppError::Io(format!("failed to read terminal output: {error}")))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| AppError::Io(format!("failed to open terminal input: {error}")))?;

    {
        let mut sessions = state
            .terminal_sessions
            .lock()
            .map_err(|_| AppError::locked("terminal"))?;
        if sessions.contains_key(&id) {
            return Err(AppError::InvalidInput(
                "terminal already exists".to_string(),
            ));
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
        let mut decoder = Utf8Stream::default();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let data = decoder.push(&buffer[..read]);
                    if data.is_empty() {
                        continue;
                    }
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
        let rest = decoder.finish();
        if !rest.is_empty() {
            let _ = app.emit(
                "terminal-output",
                TerminalOutput {
                    id: id.clone(),
                    data: rest,
                },
            );
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
) -> Result<(), AppError> {
    let mut sessions = state
        .terminal_sessions
        .lock()
        .map_err(|_| AppError::locked("terminal"))?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| AppError::NotFound("terminal is not available".to_string()))?;
    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|error| AppError::Io(format!("failed to write to terminal: {error}")))
}

#[tauri::command]
pub fn terminal_resize(
    state: State<'_, crate::AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    let sessions = state
        .terminal_sessions
        .lock()
        .map_err(|_| AppError::locked("terminal"))?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| AppError::NotFound("terminal is not available".to_string()))?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| AppError::Process(format!("failed to resize terminal: {error}")))
}

#[tauri::command]
pub fn terminal_close(state: State<'_, crate::AppState>, id: String) -> Result<(), AppError> {
    let mut sessions = state
        .terminal_sessions
        .lock()
        .map_err(|_| AppError::locked("terminal"))?;
    if let Some(mut session) = sessions.remove(&id) {
        // A shell that already exited cannot be killed again; that is not a failure.
        if let Err(error) = session.child.kill() {
            if session.child.try_wait().ok().flatten().is_none() {
                return Err(AppError::Process(format!(
                    "failed to close terminal: {error}"
                )));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_character_split_across_reads_intact() {
        let text = "构建成功 ✓";
        let bytes = text.as_bytes();
        let mut decoder = Utf8Stream::default();
        let mut output = String::new();
        // Split in the middle of the second character (each CJK char is 3 bytes).
        output.push_str(&decoder.push(&bytes[..4]));
        output.push_str(&decoder.push(&bytes[4..]));
        output.push_str(&decoder.finish());
        assert_eq!(output, text);
    }

    #[test]
    fn decodes_byte_by_byte_without_replacement_characters() {
        let text = "日志：错误 at src/main.rs";
        let mut decoder = Utf8Stream::default();
        let output: String = text
            .as_bytes()
            .iter()
            .map(|byte| decoder.push(std::slice::from_ref(byte)))
            .collect();
        assert_eq!(output, text);
    }

    #[test]
    fn replaces_invalid_bytes_and_keeps_going() {
        let mut decoder = Utf8Stream::default();
        assert_eq!(decoder.push(b"ok \xff done"), "ok \u{FFFD} done");
        // A truncated character at the very end surfaces once the stream ends.
        assert_eq!(decoder.push(&"界".as_bytes()[..2]), "");
        assert_eq!(decoder.finish(), "\u{FFFD}");
    }

    #[test]
    fn maps_shell_labels() {
        assert_eq!(shell_kind("PowerShell"), ShellKind::WindowsPowerShell);
        assert_eq!(shell_kind("PowerShell 7"), ShellKind::PowerShell7);
        assert_eq!(shell_kind("pwsh"), ShellKind::PowerShell7);
        assert_eq!(shell_kind("Command Prompt"), ShellKind::CommandPrompt);
        assert_eq!(shell_kind("Git Bash"), ShellKind::GitBash);
        assert_eq!(shell_kind("WSL"), ShellKind::Wsl);
        assert_eq!(shell_kind(""), ShellKind::WindowsPowerShell);
    }
}
