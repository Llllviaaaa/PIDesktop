use std::io::Read;
#[cfg(windows)]
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub(crate) struct PiPrintOutput {
    pub status: Option<ExitStatus>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub output_truncated: bool,
}

pub(crate) struct PiPrintLimits {
    pub timeout: Duration,
    pub output_bytes: usize,
}

/// Build the OS-level command that launches Pi in RPC mode.
pub(crate) fn build_pi_rpc_command(pi_binary: &str, cwd: &str, extra_args: &[String]) -> Command {
    if cfg!(windows) {
        build_windows_command(pi_binary, cwd, ["--mode", "rpc"], extra_args, None)
    } else {
        let mut command = Command::new(pi_binary);
        command.arg("--mode").arg("rpc").args(extra_args);
        command.current_dir(cwd);
        command
    }
}

/// Run a bounded, cancellable one-shot Pi prompt with the same executable and
/// environment semantics as RPC mode.
pub(crate) fn run_pi_print(
    pi_binary: &str,
    cwd: &str,
    extra_args: &[String],
    environment: &[(String, String)],
    prompt: &str,
    cancelled: &AtomicBool,
    limits: PiPrintLimits,
) -> Result<PiPrintOutput, String> {
    let mut command = if cfg!(windows) {
        build_windows_command(pi_binary, cwd, std::iter::empty(), extra_args, Some(prompt))
    } else {
        let mut command = Command::new(pi_binary);
        command.args(extra_args).arg("-p").arg(prompt);
        command.current_dir(cwd);
        command
    };
    command.envs(environment.iter().map(|(key, value)| (key, value)));
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to run Pi process: {err}"))?;
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture scheduled Pi stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture scheduled Pi stderr".to_string())?;
    let stdout_reader = std::thread::spawn(move || read_limited(stdout, limits.output_bytes));
    let stderr_reader = std::thread::spawn(move || read_limited(stderr, limits.output_bytes));

    let started = Instant::now();
    let mut timed_out = false;
    let mut was_cancelled = false;
    let status = loop {
        if cancelled.load(Ordering::Acquire) {
            was_cancelled = true;
            let _ = kill_process_tree(pid);
            let _ = child.kill();
            break child.wait().ok();
        }
        if started.elapsed() >= limits.timeout {
            timed_out = true;
            let _ = kill_process_tree(pid);
            let _ = child.kill();
            break child.wait().ok();
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(err) => {
                let _ = kill_process_tree(pid);
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("failed to inspect scheduled Pi process: {err}"));
            }
        }
    };

    let (stdout, stdout_truncated) = stdout_reader
        .join()
        .map_err(|_| "scheduled Pi stdout reader panicked".to_string())?;
    let (stderr, stderr_truncated) = stderr_reader
        .join()
        .map_err(|_| "scheduled Pi stderr reader panicked".to_string())?;
    Ok(PiPrintOutput {
        status,
        stdout,
        stderr,
        timed_out,
        cancelled: was_cancelled,
        output_truncated: stdout_truncated || stderr_truncated,
    })
}

fn read_limited(mut reader: impl Read, limit: usize) -> (Vec<u8>, bool) {
    let mut output = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 8 * 1024];
    let mut truncated = false;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        let remaining = limit.saturating_sub(output.len());
        if remaining > 0 {
            output.extend_from_slice(&buffer[..read.min(remaining)]);
        }
        if read > remaining {
            truncated = true;
        }
    }
    (output, truncated)
}

/// Kill a process and all of its descendants. On Windows `taskkill /T` tears
/// down the whole cmd -> node -> shell tree; elsewhere we signal the direct child.
pub(crate) fn kill_process_tree(pid: u32) -> Result<(), String> {
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
        let result = unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }
}

#[cfg(windows)]
fn build_windows_command<'a>(
    pi_binary: &str,
    cwd: &str,
    leading_args: impl IntoIterator<Item = &'a str>,
    extra_args: &[String],
    prompt: Option<&str>,
) -> Command {
    let leading_args = leading_args.into_iter().collect::<Vec<_>>();
    if Path::new(pi_binary)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        let mut command = Command::new(pi_binary);
        command.args(&leading_args).args(extra_args);
        if let Some(prompt) = prompt {
            command.arg("-p").arg(prompt);
        }
        command.current_dir(cwd);
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
        return command;
    }

    // `.cmd`/`.bat` npm shims require cmd.exe. Keep every interpolated value quoted here.
    let mut command_line = quote_cmd_arg(pi_binary);
    for arg in leading_args {
        command_line.push(' ');
        command_line.push_str(&quote_cmd_arg(arg));
    }
    for arg in extra_args {
        command_line.push(' ');
        command_line.push_str(&quote_cmd_arg(arg));
    }
    if let Some(prompt) = prompt {
        command_line.push_str(" -p ");
        command_line.push_str(&quote_cmd_arg(prompt));
    }
    let mut command = Command::new("cmd.exe");
    command.args(["/D", "/S", "/C", &command_line]);
    command.current_dir(cwd);
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// Quote a CLI argument for safe inclusion in a `cmd /C` string.
#[cfg(windows)]
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn bounded_reader_drains_but_caps_retained_output() {
        let (output, truncated) = read_limited(Cursor::new(b"0123456789"), 4);
        assert_eq!(output, b"0123");
        assert!(truncated);

        let (output, truncated) = read_limited(Cursor::new(b"ok"), 4);
        assert_eq!(output, b"ok");
        assert!(!truncated);
    }

    #[test]
    fn quotes_windows_shell_metacharacters() {
        assert_eq!(quote_cmd_arg("pi.cmd"), "pi.cmd");
        assert_eq!(quote_cmd_arg("hello world"), "\"hello world\"");
        assert_eq!(quote_cmd_arg("a&b"), "\"a&b\"");
        assert_eq!(quote_cmd_arg("a\"b"), "\"a\"\"b\"");
    }

    #[test]
    fn launches_executables_directly_even_when_the_path_contains_spaces() {
        let command = build_pi_rpc_command(
            r"C:\Program Files\Pi Desktop\pi-runtime\pi.exe",
            r"D:\workspace",
            &["--thinking".to_string(), "medium".to_string()],
        );
        assert_eq!(
            command.get_program(),
            r"C:\Program Files\Pi Desktop\pi-runtime\pi.exe"
        );
        assert_eq!(
            command
                .get_args()
                .map(|argument| argument.to_string_lossy().to_string())
                .collect::<Vec<_>>(),
            ["--mode", "rpc", "--thinking", "medium"]
        );
    }
}
