use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};

/// A live `pi --mode rpc` subprocess.
///
/// This is a transparent JSONL bridge: everything pi writes to stdout is
/// re-emitted to the frontend as `pi-event` (when it parses as JSON) or
/// `pi-log` (plain lines), and commands coming from the frontend are written
/// verbatim to pi's stdin. The frontend owns all protocol logic.
pub struct PiRpcClient {
    child: Arc<Mutex<Child>>,
    stdin: Mutex<ChildStdin>,
}

impl PiRpcClient {
    /// Spawn `pi --mode rpc` rooted at `cwd`, forwarding output to the app.
    pub fn spawn(
        app: AppHandle,
        pi_binary: &str,
        cwd: &str,
        extra_args: &[String],
        environment: &[(String, String)],
    ) -> Result<Self, String> {
        let mut command = build_pi_command(pi_binary, cwd, extra_args);
        command.envs(environment.iter().map(|(key, value)| (key, value)));
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|err| format!("failed to spawn `{}`: {err}", pi_binary))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to open pi stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to open pi stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "failed to open pi stderr".to_string())?;

        let child = Arc::new(Mutex::new(child));

        // stdout reader: strict LF framing per the RPC protocol. When stdout
        // closes we wait on the child to report the real exit code.
        {
            let child = Arc::clone(&child);
            let app = app.clone();
            let status_cwd = cwd.to_string();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut line = Vec::new();
                loop {
                    line.clear();
                    match reader.read_until(b'\n', &mut line) {
                        Ok(0) => break,
                        Ok(_) => {
                            while matches!(line.last(), Some(b'\n' | b'\r')) {
                                line.pop();
                            }
                            let text = String::from_utf8_lossy(&line);
                            if text.trim().is_empty() {
                                continue;
                            }
                            match serde_json::from_str::<serde_json::Value>(&text) {
                                Ok(value) => {
                                    let _ = app.emit("pi-event", value);
                                }
                                Err(_) => {
                                    let _ = app.emit("pi-log", text.to_string());
                                }
                            }
                        }
                        Err(err) => {
                            let _ = app.emit("pi-log", format!("error reading pi stdout: {err}"));
                            break;
                        }
                    }
                }

                let exit_code = child
                    .lock()
                    .ok()
                    .and_then(|mut guarded| guarded.wait().ok())
                    .and_then(|status| status.code());
                let _ = app.emit(
                    "pi-status",
                    serde_json::json!({ "status": "exited", "code": exit_code, "cwd": status_cwd }),
                );
            });
        }

        // stderr reader: forward everything as log lines for diagnostics.
        {
            let app = app.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) => break,
                        Ok(_) => {
                            let trimmed = line.trim_end();
                            if !trimmed.is_empty() {
                                let _ = app.emit("pi-log", trimmed.to_string());
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        let _ = app.emit(
            "pi-status",
            serde_json::json!({ "status": "running", "cwd": cwd }),
        );

        Ok(PiRpcClient {
            child,
            stdin: Mutex::new(stdin),
        })
    }

    /// Write one JSON command line to pi's stdin.
    pub fn send_line(&self, line: &str) -> Result<(), String> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "stdin lock poisoned".to_string())?;
        let payload = if line.ends_with('\n') {
            line.to_string()
        } else {
            format!("{line}\n")
        };
        stdin
            .write_all(payload.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|err| format!("failed to write to pi stdin: {err}"))
    }

    /// Terminate the pi process tree (cmd wrapper + node + any child shells).
    pub fn kill(&self) {
        if let Ok(mut guarded) = self.child.lock() {
            let pid = guarded.id();
            let _ = kill_process_tree(pid);
            let _ = guarded.kill();
            let _ = guarded.wait();
        }
    }
}

/// Build the OS-level command that launches pi in RPC mode.
fn build_pi_command(pi_binary: &str, cwd: &str, extra_args: &[String]) -> Command {
    if cfg!(windows) {
        // `.cmd`/`.bat` shims cannot be launched with CreateProcess directly,
        // so route through cmd.exe. `cmd /S /C` handles quoting for us.
        // CREATE_NO_WINDOW suppresses the console popup.
        let mut command_line = format!("{} --mode rpc", quote_cmd_arg(pi_binary));
        for arg in extra_args {
            command_line.push(' ');
            command_line.push_str(&quote_cmd_arg(arg));
        }
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C", &command_line]);
        command.current_dir(cwd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command
    } else {
        let mut command = Command::new(pi_binary);
        command.arg("--mode").arg("rpc").args(extra_args);
        command.current_dir(cwd);
        command
    }
}

/// Quote a CLI argument for safe inclusion in a `cmd /C` string.
fn quote_cmd_arg(arg: &str) -> String {
    if arg.is_empty()
        || arg.contains(' ')
        || arg.contains('\t')
        || arg.contains('"')
        || arg.contains('&')
        || arg.contains('|')
        || arg.contains('<')
        || arg.contains('>')
        || arg.contains('^')
    {
        format!("\"{}\"", arg.replace('"', "\"\""))
    } else {
        arg.to_string()
    }
}

impl Drop for PiRpcClient {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Kill a process and all of its descendants. On Windows `taskkill /T` tears
/// down the whole cmd → node → shell tree; elsewhere we signal the direct child.
fn kill_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let output = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .map_err(|err| format!("taskkill failed: {err}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "taskkill exited with {}: {}",
                output.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&output.stderr)
            ))
        }
    }
    #[cfg(not(windows))]
    {
        let _ = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        Ok(())
    }
}
