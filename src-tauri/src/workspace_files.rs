use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;

use crate::pi::process::kill_process_tree;

const MAX_MATCHES: usize = 200;
const MAX_SCANNED_FILES: usize = 50_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceDirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

pub(crate) fn search(
    root: &Path,
    query: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<WorkspaceDirEntry>, String> {
    let needle = query.trim().to_ascii_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    if let Some(matches) = search_git_files(root, &needle, cancelled)? {
        return Ok(sort_matches(matches, &needle));
    }
    search_filesystem(root, &needle, cancelled).map(|matches| sort_matches(matches, &needle))
}

/// Git supplies the repository's canonical ignored-file behavior, including
/// nested .gitignore files, global excludes, and worktree metadata.
fn search_git_files(
    root: &Path,
    needle: &str,
    cancelled: &AtomicBool,
) -> Result<Option<Vec<WorkspaceDirEntry>>, String> {
    let mut command = Command::new("git");
    command
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(mut child) = command.spawn() else {
        return Ok(None);
    };
    let pid = child.id();
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Ok(None);
    };
    let (sender, receiver) = mpsc::sync_channel::<String>(256);
    let reader = std::thread::spawn(move || {
        let mut stdout = BufReader::new(stdout);
        let mut bytes = Vec::new();
        loop {
            bytes.clear();
            match stdout.read_until(0, &mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if bytes.last() == Some(&0) {
                        bytes.pop();
                    }
                    if sender
                        .send(String::from_utf8_lossy(&bytes).replace('\\', "/"))
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });

    let mut scanned = 0;
    let mut matches = Vec::new();
    let mut stopped_early = false;
    let status = loop {
        if cancelled.load(Ordering::Acquire) {
            let _ = kill_process_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
            drop(receiver);
            let _ = reader.join();
            return Err("workspace search cancelled".to_string());
        }
        while let Ok(relative) = receiver.try_recv() {
            scanned += 1;
            collect_match(&relative, needle, &mut matches);
            if scanned >= MAX_SCANNED_FILES || matches.len() >= MAX_MATCHES {
                stopped_early = true;
                let _ = kill_process_tree(pid);
                let _ = child.kill();
                break;
            }
        }
        if scanned >= MAX_SCANNED_FILES || matches.len() >= MAX_MATCHES {
            break child.wait().ok();
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => break None,
        }
    };
    for relative in receiver.try_iter() {
        if scanned >= MAX_SCANNED_FILES || matches.len() >= MAX_MATCHES {
            break;
        }
        scanned += 1;
        collect_match(&relative, needle, &mut matches);
    }
    drop(receiver);
    let _ = reader.join();
    Ok(if stopped_early {
        Some(matches)
    } else {
        status.filter(|status| status.success()).map(|_| matches)
    })
}

fn search_filesystem(
    root: &Path,
    needle: &str,
    cancelled: &AtomicBool,
) -> Result<Vec<WorkspaceDirEntry>, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut scanned = 0;
    let mut matches = Vec::new();
    while let Some(directory) = pending.pop() {
        if cancelled.load(Ordering::Acquire) {
            return Err("workspace search cancelled".to_string());
        }
        let Ok(entries) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            if cancelled.load(Ordering::Acquire) {
                return Err("workspace search cancelled".to_string());
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
            if is_dir {
                if !is_ignored_fallback_directory(&name) {
                    pending.push(path);
                }
                continue;
            }
            scanned += 1;
            let relative = relative_path(root, &path);
            collect_match(&relative, needle, &mut matches);
            if scanned >= MAX_SCANNED_FILES || matches.len() >= MAX_MATCHES {
                return Ok(matches);
            }
        }
    }
    Ok(matches)
}

fn collect_match(relative: &str, needle: &str, matches: &mut Vec<WorkspaceDirEntry>) {
    let name = Path::new(relative)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| relative.to_string());
    if name.to_ascii_lowercase().contains(needle) || relative.to_ascii_lowercase().contains(needle)
    {
        matches.push(WorkspaceDirEntry {
            name,
            path: relative.to_string(),
            is_dir: false,
        });
    }
}

fn sort_matches(mut matches: Vec<WorkspaceDirEntry>, needle: &str) -> Vec<WorkspaceDirEntry> {
    matches.sort_by(|left, right| {
        match_rank(left, needle)
            .cmp(&match_rank(right, needle))
            .then_with(|| {
                left.path
                    .to_ascii_lowercase()
                    .cmp(&right.path.to_ascii_lowercase())
            })
    });
    matches
}

fn match_rank(entry: &WorkspaceDirEntry, needle: &str) -> u8 {
    let name = entry.name.to_ascii_lowercase();
    if name.starts_with(needle) {
        0
    } else if name.contains(needle) {
        1
    } else {
        2
    }
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn is_ignored_fallback_directory(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules" | "target" | "dist" | "build" | "out" | "coverage" | "__pycache__"
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn ranks_file_name_matches_before_path_matches() {
        let matches = vec![
            WorkspaceDirEntry {
                name: "mod.rs".into(),
                path: "search/mod.rs".into(),
                is_dir: false,
            },
            WorkspaceDirEntry {
                name: "search.rs".into(),
                path: "src/search.rs".into(),
                is_dir: false,
            },
        ];
        let sorted = sort_matches(matches, "search");
        assert_eq!(sorted[0].name, "search.rs");
    }

    #[test]
    fn fallback_skips_hidden_and_generated_directories() {
        assert!(is_ignored_fallback_directory(".git"));
        assert!(is_ignored_fallback_directory("node_modules"));
        assert!(!is_ignored_fallback_directory("src"));
    }

    #[test]
    fn git_search_respects_ignore_rules() {
        let directory = std::env::temp_dir().join(format!(
            "pid-desktop-workspace-search-{}-{}",
            std::process::id(),
            NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let initialized = Command::new("git")
            .args(["init", "-q"])
            .current_dir(&directory)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !initialized {
            let _ = std::fs::remove_dir_all(directory);
            return;
        }
        std::fs::write(directory.join(".gitignore"), "ignored.log\n").unwrap();
        std::fs::write(directory.join("ignored.log"), "ignored").unwrap();
        std::fs::write(directory.join("visible.txt"), "visible").unwrap();

        let cancelled = AtomicBool::new(false);
        assert!(search(&directory, "ignored", &cancelled)
            .unwrap()
            .is_empty());
        let visible = search(&directory, "visible", &cancelled).unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].path, "visible.txt");

        std::fs::remove_dir_all(directory).unwrap();
    }
}
