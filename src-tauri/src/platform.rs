//! Windows process plumbing: finding executables the way the shell would, and
//! launching child processes without flashing a console window.

use crate::*;

#[cfg(windows)]
pub(crate) fn windows_registry_path_entries() -> Vec<PathBuf> {
    let locations = [
        ("HKCU\\Environment", "Path"),
        (
            "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
            "Path",
        ),
    ];
    let mut entries = Vec::new();
    for (key, name) in locations {
        let Ok(output) = hidden_command("reg.exe")
            .args(["query", key, "/v", name])
            .output()
        else {
            continue;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let value = ["REG_EXPAND_SZ", "REG_SZ"]
                .iter()
                .find_map(|marker| line.find(marker).map(|index| &line[index + marker.len()..]));
            if let Some(value) = value {
                entries.extend(
                    value
                        .trim()
                        .split(';')
                        .map(str::trim)
                        .filter(|entry| !entry.is_empty())
                        .map(PathBuf::from),
                );
            }
        }
    }
    entries
}

#[cfg(windows)]
pub(crate) fn resolve_windows_pi_node_command(pi_binary: &str) -> Option<(PathBuf, PathBuf)> {
    let shim = PathBuf::from(pi_binary);
    let npm_root = shim.parent()?;
    let cli = [
        npm_root
            .join("node_modules")
            .join("@earendil-works")
            .join("pi-coding-agent")
            .join("dist")
            .join("cli.js"),
        npm_root
            .join("node_modules")
            .join("@mariozechner")
            .join("pi-coding-agent")
            .join("dist")
            .join("cli.js"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())?;

    let mut node_candidates = vec![npm_root.join("node.exe")];
    if let Some(path) = std::env::var_os("PATH") {
        node_candidates.extend(std::env::split_paths(&path).map(|entry| entry.join("node.exe")));
    }
    node_candidates.extend(
        windows_registry_path_entries()
            .into_iter()
            .map(|path| path.join("node.exe")),
    );
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        node_candidates.push(PathBuf::from(program_files).join("nodejs").join("node.exe"));
    }
    let node = node_candidates
        .into_iter()
        .find(|candidate| candidate.is_file())?;
    Some((node, cli))
}

#[cfg(windows)]
pub(crate) fn find_windows_executable_in_dirs(
    program: &str,
    directories: &[PathBuf],
) -> Option<PathBuf> {
    let path = PathBuf::from(program);
    if path.is_file() {
        return Some(path);
    }
    let names = if path.extension().is_some() {
        vec![program.to_string()]
    } else {
        vec![
            format!("{program}.exe"),
            format!("{program}.cmd"),
            format!("{program}.bat"),
            program.to_string(),
        ]
    };
    directories
        .iter()
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|candidate| candidate.is_file())
}

#[cfg(windows)]
pub(crate) fn resolve_windows_executable(program: &str) -> Option<PathBuf> {
    let mut directories = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    directories.extend(windows_registry_path_entries());
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        directories.push(PathBuf::from(program_files).join("GitHub CLI"));
    }
    find_windows_executable_in_dirs(program, &directories)
}

pub(crate) fn strip_windows_prefix(path: PathBuf) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path
    }
}

pub(crate) fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn resolves_windows_executable_from_explicit_search_directories() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "pid-desktop-command-path-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("temporary executable directory should exist");
        let executable = directory.join("gh.exe");
        fs::write(&executable, b"").expect("temporary executable should be written");

        assert_eq!(
            find_windows_executable_in_dirs("gh", std::slice::from_ref(&directory)),
            Some(executable)
        );

        fs::remove_dir_all(directory).expect("temporary executable directory should be removed");
    }
}
