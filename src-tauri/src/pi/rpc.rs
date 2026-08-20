use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use regex::Regex;
use tauri::{AppHandle, Emitter};

const REDACTED: &str = "[REDACTED]";

fn known_credential_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(concat!(
            r"(?i)(?:sk-(?:proj-|svcacct-|ant-|or-v1-)?[a-z0-9_-]{16,}",
            r"|gsk_[a-z0-9]{16,}",
            r"|github_pat_[a-z0-9_]{30,}",
            r"|gh[pousr]_[a-z0-9]{20,}",
            r"|aiza[0-9a-z_-]{30,}",
            r"|(?:akia|asia)[a-z0-9]{16}",
            r"|xox[baprs]-[a-z0-9-]{10,}",
            r"|hf_[a-z0-9]{20,}",
            r"|npm_[a-z0-9]{20,}",
            r"|pypi-[a-z0-9_-]{20,}",
            r"|sg\.[a-z0-9_-]{10,}\.[a-z0-9_-]{20,})"
        ))
        .expect("credential pattern must compile")
    })
}

fn bearer_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)\b(bearer\s+)[a-z0-9._~+/=-]{8,}").expect("bearer pattern must compile")
    })
}

fn quoted_secret_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r#"(?i)([\"'](?:api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|credential|cookie|password|private[-_]?key|secret|token)[\"']\s*:\s*[\"'])[^\"']*([\"'])"#)
            .expect("quoted secret pattern must compile")
    })
}

fn assigned_secret_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)\b(api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|credential|cookie|password|private[-_]?key|secret|token)\b(\s*[:=]\s*)([^\s,;]+)")
            .expect("assigned secret pattern must compile")
    })
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "apikey"
            | "accesstoken"
            | "authtoken"
            | "authorization"
            | "clientsecret"
            | "credential"
            | "credentials"
            | "cookie"
            | "password"
            | "passwd"
            | "privatekey"
            | "secret"
            | "setcookie"
            | "token"
    )
}

#[derive(Clone)]
pub(crate) struct SecretRedactor {
    exact_values: Arc<Vec<String>>,
}

impl SecretRedactor {
    pub(crate) fn new(values: &[String]) -> Self {
        let mut exact_values = values
            .iter()
            .filter(|value| value.len() >= 4)
            .cloned()
            .collect::<Vec<_>>();
        exact_values.sort_by_key(|value| std::cmp::Reverse(value.len()));
        exact_values.dedup();
        Self {
            exact_values: Arc::new(exact_values),
        }
    }

    pub(crate) fn text(&self, input: &str) -> String {
        let mut output = input.to_string();
        for secret in self.exact_values.iter() {
            output = output.replace(secret, REDACTED);
        }
        output = known_credential_pattern()
            .replace_all(&output, REDACTED)
            .into_owned();
        output = bearer_pattern()
            .replace_all(&output, "$1[REDACTED]")
            .into_owned();
        output = quoted_secret_pattern()
            .replace_all(&output, "$1[REDACTED]$2")
            .into_owned();
        assigned_secret_pattern()
            .replace_all(&output, "$1$2[REDACTED]")
            .into_owned()
    }

    fn json(&self, value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(object) => {
                for (key, value) in object {
                    if is_sensitive_key(key) {
                        *value = serde_json::Value::String(REDACTED.to_string());
                    } else {
                        self.json(value);
                    }
                }
            }
            serde_json::Value::Array(values) => {
                values.iter_mut().for_each(|value| self.json(value));
            }
            serde_json::Value::String(text) => *text = self.text(text),
            _ => {}
        }
    }
}

/// A live `pi --mode rpc` subprocess.
///
/// This is a transparent JSONL bridge: everything pi writes to stdout is
/// re-emitted to the frontend as `pi-event` (when it parses as JSON) or
/// `pi-log` (plain lines), and commands coming from the frontend are written
/// verbatim to pi's stdin. The frontend owns all protocol logic.
pub struct PiRpcClient {
    child: Arc<Mutex<Child>>,
    stdin: Mutex<ChildStdin>,
    is_streaming: Arc<AtomicBool>,
    pending_extension: Arc<Mutex<Option<serde_json::Value>>>,
}

impl PiRpcClient {
    /// Spawn `pi --mode rpc` rooted at `cwd`, forwarding output to the app.
    pub fn spawn(
        app: AppHandle,
        runtime_id: &str,
        pi_binary: &str,
        cwd: &str,
        extra_args: &[String],
        environment: &[(String, String)],
        sensitive_values: &[String],
    ) -> Result<Self, String> {
        let redactor = SecretRedactor::new(sensitive_values);
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
        let is_streaming = Arc::new(AtomicBool::new(false));
        let pending_extension = Arc::new(Mutex::new(None));

        // stdout reader: strict LF framing per the RPC protocol. When stdout
        // closes we wait on the child to report the real exit code.
        {
            let child = Arc::clone(&child);
            let app = app.clone();
            let status_cwd = cwd.to_string();
            let runtime_id = runtime_id.to_string();
            let runtime_streaming = Arc::clone(&is_streaming);
            let runtime_extension = Arc::clone(&pending_extension);
            let redactor = redactor.clone();
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
                                Ok(mut value) => {
                                    redactor.json(&mut value);
                                    update_runtime_snapshot(
                                        &value,
                                        &runtime_streaming,
                                        &runtime_extension,
                                    );
                                    let _ = app.emit(
                                        "pi-event",
                                        serde_json::json!({ "runtimeId": runtime_id, "event": value }),
                                    );
                                }
                                Err(_) => {
                                    let text = redactor.text(&text);
                                    let _ = app.emit(
                                        "pi-log",
                                        serde_json::json!({ "runtimeId": runtime_id, "line": text.to_string() }),
                                    );
                                }
                            }
                        }
                        Err(err) => {
                            let _ = app.emit(
                                "pi-log",
                                serde_json::json!({ "runtimeId": runtime_id, "line": format!("error reading pi stdout: {err}") }),
                            );
                            break;
                        }
                    }
                }

                let exit_code = child
                    .lock()
                    .ok()
                    .and_then(|mut guarded| guarded.wait().ok())
                    .and_then(|status| status.code());
                runtime_streaming.store(false, Ordering::Relaxed);
                if let Ok(mut pending) = runtime_extension.lock() {
                    pending.take();
                }
                let _ = app.emit(
                    "pi-status",
                    serde_json::json!({ "runtimeId": runtime_id, "status": "exited", "code": exit_code, "cwd": status_cwd }),
                );
            });
        }

        // stderr reader: forward everything as log lines for diagnostics.
        {
            let app = app.clone();
            let runtime_id = runtime_id.to_string();
            let redactor = redactor.clone();
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
                                let trimmed = redactor.text(trimmed);
                                let _ = app.emit(
                                    "pi-log",
                                    serde_json::json!({ "runtimeId": runtime_id, "line": trimmed }),
                                );
                            }
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        let _ = app.emit(
            "pi-status",
            serde_json::json!({ "runtimeId": runtime_id, "status": "running", "cwd": cwd }),
        );

        Ok(PiRpcClient {
            child,
            stdin: Mutex::new(stdin),
            is_streaming,
            pending_extension,
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
        let result = stdin
            .write_all(payload.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|err| format!("failed to write to pi stdin: {err}"));
        if result.is_ok()
            && serde_json::from_str::<serde_json::Value>(line)
                .ok()
                .and_then(|value| {
                    value
                        .get("type")
                        .and_then(|kind| kind.as_str())
                        .map(str::to_owned)
                })
                .as_deref()
                == Some("extension_ui_response")
        {
            if let Ok(mut pending) = self.pending_extension.lock() {
                pending.take();
            }
        }
        result
    }

    pub fn is_running(&self) -> bool {
        self.child
            .lock()
            .ok()
            .and_then(|mut child| child.try_wait().ok())
            .is_some_and(|status| status.is_none())
    }

    pub fn is_streaming(&self) -> bool {
        self.is_streaming.load(Ordering::Relaxed)
    }

    pub fn pending_extension(&self) -> Option<serde_json::Value> {
        self.pending_extension
            .lock()
            .ok()
            .and_then(|pending| pending.clone())
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

fn update_runtime_snapshot(
    event: &serde_json::Value,
    is_streaming: &AtomicBool,
    pending_extension: &Mutex<Option<serde_json::Value>>,
) {
    match event.get("type").and_then(|value| value.as_str()) {
        Some("agent_start") => is_streaming.store(true, Ordering::Relaxed),
        Some("agent_end")
            if event.get("willRetry").and_then(|value| value.as_bool()) != Some(true) =>
        {
            is_streaming.store(false, Ordering::Relaxed);
            if let Ok(mut pending) = pending_extension.lock() {
                pending.take();
            }
        }
        Some("agent_settled") => {
            is_streaming.store(false, Ordering::Relaxed);
            if let Ok(mut pending) = pending_extension.lock() {
                pending.take();
            }
        }
        Some("extension_ui_request") if is_actionable_extension(event) => {
            if let Ok(mut pending) = pending_extension.lock() {
                pending.replace(event.clone());
            }
        }
        _ => {}
    }
}

fn is_actionable_extension(event: &serde_json::Value) -> bool {
    !matches!(
        event.get("method").and_then(|value| value.as_str()),
        Some("notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text")
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_configured_and_structured_credentials() {
        let redactor = SecretRedactor::new(&["custom-private-value".to_string()]);
        let provider_key = format!("{}{}", "sk-proj-", "abcdefghijklmnopqrstuvwxyz");
        let text = redactor.text(&format!(
            "Authorization: Bearer abcdefghijklmnop api_key={provider_key} custom-private-value"
        ));
        assert!(!text.contains("abcdefghijklmnop"));
        assert!(!text.contains("sk-proj-"));
        assert!(!text.contains("custom-private-value"));
        assert!(text.contains(REDACTED));

        let mut value = serde_json::json!({
            "apiKey": "plain-value",
            "maxTokens": 4096,
            "nested": { "authorization": "Bearer another-secret" }
        });
        redactor.json(&mut value);
        assert_eq!(value["apiKey"], REDACTED);
        assert_eq!(value["nested"]["authorization"], REDACTED);
        assert_eq!(value["maxTokens"], 4096);
    }

    #[test]
    fn runtime_snapshot_tracks_streaming_and_actionable_approval() {
        let streaming = AtomicBool::new(false);
        let pending = Mutex::new(None);

        update_runtime_snapshot(
            &serde_json::json!({ "type": "agent_start" }),
            &streaming,
            &pending,
        );
        assert!(streaming.load(Ordering::Relaxed));

        update_runtime_snapshot(
            &serde_json::json!({
                "type": "extension_ui_request",
                "id": "approval-1",
                "method": "confirm",
                "title": "Allow command?",
                "message": "Run tests"
            }),
            &streaming,
            &pending,
        );
        assert_eq!(
            pending
                .lock()
                .expect("pending extension lock")
                .as_ref()
                .and_then(|value| value.get("id"))
                .and_then(|value| value.as_str()),
            Some("approval-1")
        );

        update_runtime_snapshot(
            &serde_json::json!({ "type": "agent_end", "willRetry": false }),
            &streaming,
            &pending,
        );
        assert!(!streaming.load(Ordering::Relaxed));
        assert!(pending.lock().expect("pending extension lock").is_none());
    }

    #[test]
    fn runtime_snapshot_ignores_non_actionable_extension_updates() {
        let streaming = AtomicBool::new(false);
        let pending = Mutex::new(None);

        update_runtime_snapshot(
            &serde_json::json!({
                "type": "extension_ui_request",
                "id": "status-1",
                "method": "setStatus",
                "statusKey": "build",
                "statusText": "Running"
            }),
            &streaming,
            &pending,
        );

        assert!(pending.lock().expect("pending extension lock").is_none());
    }
}

/// Kill a process and all of its descendants. On Windows `taskkill /T` tears
/// down the whole cmd → node → shell tree; elsewhere we signal the direct child.
fn kill_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
        let output = command
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
