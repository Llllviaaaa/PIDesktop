use std::process::{Command, Output};

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

/// Run a one-shot Pi prompt with the same executable and environment semantics as RPC mode.
pub(crate) fn run_pi_print(
    pi_binary: &str,
    cwd: &str,
    extra_args: &[String],
    environment: &[(String, String)],
    prompt: &str,
) -> Result<Output, String> {
    let mut command = if cfg!(windows) {
        build_windows_command(pi_binary, cwd, std::iter::empty(), extra_args, Some(prompt))
    } else {
        let mut command = Command::new(pi_binary);
        command.args(extra_args).arg("-p").arg(prompt);
        command.current_dir(cwd);
        command
    };
    command.envs(environment.iter().map(|(key, value)| (key, value)));
    command
        .output()
        .map_err(|err| format!("failed to run Pi process: {err}"))
}

#[cfg(windows)]
fn build_windows_command<'a>(
    pi_binary: &str,
    cwd: &str,
    leading_args: impl IntoIterator<Item = &'a str>,
    extra_args: &[String],
    prompt: Option<&str>,
) -> Command {
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

    #[test]
    fn quotes_windows_shell_metacharacters() {
        assert_eq!(quote_cmd_arg("pi.cmd"), "pi.cmd");
        assert_eq!(quote_cmd_arg("hello world"), "\"hello world\"");
        assert_eq!(quote_cmd_arg("a&b"), "\"a&b\"");
        assert_eq!(quote_cmd_arg("a\"b"), "\"a\"\"b\"");
    }
}
