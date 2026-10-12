//! Scratch storage for side-chat sessions.
//!
//! A side chat forks the current conversation into a throwaway Pi session.
//! Those forks used to land in the Pi session root and were only filtered out
//! of the sidebar while their runtime lived; when the app was killed (an
//! installer upgrade, Task Manager, a crash) the fork stayed behind and showed
//! up as an extra conversation. They now live under a directory the sidebar
//! never lists: `side-chats/<app pid>/<runtime id>/`. A runtime's directory is
//! removed when it stops, and directories of app processes that are no longer
//! running are removed at startup.

use std::fs;
use std::path::{Path, PathBuf};

fn side_chat_root() -> Option<PathBuf> {
    dirs::data_local_dir()
        .or_else(dirs::config_dir)
        .map(|root| root.join("pid-desktop").join("side-chats"))
}

/// The session directory for one side-chat runtime of this app process.
pub fn runtime_session_dir(runtime_id: &str) -> Option<PathBuf> {
    side_chat_root().map(|root| root.join(std::process::id().to_string()).join(runtime_id))
}

pub fn remove_runtime_session_dir(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

/// Remove what side chats of earlier app processes left behind. Another app
/// instance may still be running, so only directories of exited processes go.
pub fn clear_stale_side_chats() {
    let Some(root) = side_chat_root() else {
        return;
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let owner = name.to_str().and_then(|value| value.parse::<u32>().ok());
        if owner.is_some_and(process_is_running) {
            continue;
        }
        let _ = fs::remove_dir_all(entry.path());
    }
}

#[cfg(windows)]
fn process_is_running(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if pid == std::process::id() {
        return true;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }
    let mut exit_code = 0u32;
    let queried = unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0;
    unsafe { CloseHandle(handle) };
    queried && exit_code == STILL_ACTIVE as u32
}

#[cfg(not(windows))]
fn process_is_running(pid: u32) -> bool {
    pid == std::process::id() || unsafe { libc::kill(pid as i32, 0) } == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_dirs_are_scoped_to_this_process() {
        let dir = runtime_session_dir("runtime-1").expect("a local data directory");
        let owner = dir
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str());
        assert_eq!(owner, Some(std::process::id().to_string().as_str()));
        assert!(dir.ends_with("runtime-1"));
    }

    #[test]
    fn this_process_is_running_and_an_impossible_pid_is_not() {
        assert!(process_is_running(std::process::id()));
        // PIDs are multiples of four on Windows, so this one can never exist.
        #[cfg(windows)]
        assert!(!process_is_running(u32::MAX - 2));
    }
}
