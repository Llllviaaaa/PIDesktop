//! Git inspection and staging commands.
//!
//! Every command here shells out to `git`, so they all run off the main thread.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::AppError;
use crate::hidden_command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitFileChange {
    pub(crate) path: String,
    pub(crate) status: String,
    pub(crate) index_status: String,
    pub(crate) worktree_status: String,
    pub(crate) staged: bool,
    pub(crate) unstaged: bool,
    pub(crate) untracked: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitSnapshot {
    pub(crate) is_repository: bool,
    pub(crate) branch: Option<String>,
    pub(crate) files: Vec<GitFileChange>,
    pub(crate) diff: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBranchInfo {
    pub(crate) name: String,
    pub(crate) current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitInfo {
    pub(crate) sha: String,
    pub(crate) short_sha: String,
    pub(crate) subject: String,
    pub(crate) author: String,
    pub(crate) timestamp: i64,
}

pub(crate) fn parse_git_status(output: &str) -> Vec<GitFileChange> {
    output
        .lines()
        .filter_map(|line| {
            let bytes = line.as_bytes();
            if bytes.len() < 3 {
                return None;
            }
            let index = bytes[0] as char;
            let worktree = bytes[1] as char;
            let raw_path = line.get(3..)?.trim();
            let path = raw_path
                .rsplit_once(" -> ")
                .map(|(_, renamed)| renamed)
                .unwrap_or(raw_path)
                .trim_matches('"');
            if path.is_empty() {
                return None;
            }
            let untracked = index == '?' && worktree == '?';
            let staged = !untracked && index != ' ' && index != '?';
            let unstaged = untracked || (worktree != ' ' && worktree != '?');
            let status = if untracked {
                "?".to_string()
            } else {
                [index, worktree]
                    .into_iter()
                    .filter(|value| *value != ' ')
                    .collect()
            };
            Some(GitFileChange {
                path: path.to_string(),
                status,
                index_status: if index != ' ' {
                    index.to_string()
                } else {
                    String::new()
                },
                worktree_status: if worktree != ' ' {
                    worktree.to_string()
                } else {
                    String::new()
                },
                staged,
                unstaged,
                untracked,
            })
        })
        .collect()
}

#[tauri::command(async)]
pub(crate) fn git_list_branches(cwd: String) -> Result<Vec<GitBranchInfo>, AppError> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err(AppError::NotFound("workspace no longer exists".to_string()));
    }
    let output = run_git(
        &root,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(HEAD)",
            "refs/heads",
        ],
    )?;
    let mut branches: Vec<GitBranchInfo> = output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, '\t');
            let name = parts.next()?.trim();
            if name.is_empty() {
                return None;
            }
            let head = parts.next().unwrap_or("").trim();
            Some(GitBranchInfo {
                name: name.to_string(),
                current: head == "*",
            })
        })
        .collect();
    branches.sort_by(|a, b| match (a.current, b.current) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(branches)
}

#[tauri::command(async)]
pub(crate) fn git_checkout_branch(cwd: String, branch: String) -> Result<(), AppError> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err(AppError::NotFound("workspace no longer exists".to_string()));
    }
    let name = branch.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("branch name required".to_string()));
    }
    run_git(&root, &["checkout", name])?;
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn git_compare(cwd: String, base: String) -> Result<GitSnapshot, AppError> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err(AppError::NotFound("workspace no longer exists".to_string()));
    }
    let base = base.trim();
    if base.is_empty() {
        return Err(AppError::InvalidInput("base branch required".to_string()));
    }
    let branch = run_git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|value| value.trim().to_string());
    let range = format!("{base}...HEAD");
    let name_status = run_git(&root, &["diff", "--name-status", &range]).unwrap_or_default();
    let files = name_status
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 2 {
                return None;
            }
            let status = parts[0]
                .chars()
                .next()
                .map(|ch| ch.to_string())
                .unwrap_or_else(|| "?".to_string());
            let path = parts[parts.len() - 1].trim();
            if path.is_empty() {
                return None;
            }
            Some(GitFileChange {
                status,
                path: path.to_string(),
                index_status: String::new(),
                worktree_status: String::new(),
                staged: false,
                unstaged: false,
                untracked: false,
            })
        })
        .collect();
    let diff =
        run_git(&root, &["diff", "--no-ext-diff", "--unified=3", &range]).unwrap_or_default();
    Ok(GitSnapshot {
        is_repository: true,
        branch,
        files,
        diff,
    })
}

#[tauri::command(async)]
pub(crate) fn git_review_snapshot(cwd: String, filter: String) -> Result<GitSnapshot, AppError> {
    if filter == "uncommitted" {
        return git_snapshot(cwd);
    }
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err(AppError::NotFound("workspace no longer exists".to_string()));
    }
    if filter != "staged" && filter != "unstaged" {
        return Err(AppError::InvalidInput(
            "unsupported review filter".to_string(),
        ));
    }
    let branch = run_git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|value| value.trim().to_string());
    let status = run_git(
        &root,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )
    .unwrap_or_default();
    let mut files = parse_git_status(&status);
    if filter == "staged" {
        files.retain(|file| file.staged);
    } else {
        files.retain(|file| file.unstaged);
    }
    let diff = if filter == "staged" {
        run_git(
            &root,
            &["diff", "--cached", "--no-ext-diff", "--unified=3", "--"],
        )
        .unwrap_or_default()
    } else {
        run_git(&root, &["diff", "--no-ext-diff", "--unified=3", "--"]).unwrap_or_default()
    };
    Ok(GitSnapshot {
        is_repository: true,
        branch,
        files,
        diff,
    })
}

#[tauri::command(async)]
pub(crate) fn git_list_commits(
    cwd: String,
    limit: Option<usize>,
) -> Result<Vec<GitCommitInfo>, AppError> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err(AppError::NotFound("workspace no longer exists".to_string()));
    }
    let count = limit.unwrap_or(50).clamp(1, 200);
    let count_arg = format!("--max-count={count}");
    let output = run_git(
        &root,
        &[
            "log",
            &count_arg,
            "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ct",
        ],
    )?;
    Ok(output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let sha = parts.next()?.trim();
            let short_sha = parts.next()?.trim();
            let subject = parts.next()?.trim();
            let author = parts.next()?.trim();
            let timestamp = parts.next()?.trim().parse::<i64>().ok()?;
            if sha.is_empty() || short_sha.is_empty() {
                return None;
            }
            Some(GitCommitInfo {
                sha: sha.to_string(),
                short_sha: short_sha.to_string(),
                subject: subject.to_string(),
                author: author.to_string(),
                timestamp,
            })
        })
        .collect())
}

#[tauri::command(async)]
pub(crate) fn git_commit_snapshot(cwd: String, commit: String) -> Result<GitSnapshot, AppError> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err(AppError::NotFound("workspace no longer exists".to_string()));
    }
    let commit = commit.trim();
    if !(7..=40).contains(&commit.len()) || !commit.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(AppError::InvalidInput("invalid commit id".to_string()));
    }
    let branch = run_git(&root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|value| value.trim().to_string());
    let name_status = run_git(
        &root,
        &[
            "show",
            "--format=",
            "--name-status",
            "--find-renames",
            commit,
            "--",
        ],
    )?;
    let files = name_status
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 2 {
                return None;
            }
            let status = parts[0]
                .chars()
                .next()
                .map(|ch| ch.to_string())
                .unwrap_or_else(|| "?".to_string());
            let path = parts[parts.len() - 1].trim();
            if path.is_empty() {
                return None;
            }
            Some(GitFileChange {
                path: path.to_string(),
                status,
                index_status: String::new(),
                worktree_status: String::new(),
                staged: false,
                unstaged: false,
                untracked: false,
            })
        })
        .collect();
    let diff = run_git(
        &root,
        &[
            "show",
            "--format=",
            "--no-ext-diff",
            "--unified=3",
            commit,
            "--",
        ],
    )?;
    Ok(GitSnapshot {
        is_repository: true,
        branch,
        files,
        diff,
    })
}

#[tauri::command(async)]
pub(crate) fn git_restore_files(cwd: String, paths: Vec<String>) -> Result<(), AppError> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err(AppError::NotFound("workspace no longer exists".to_string()));
    }
    if paths.is_empty() {
        return Err(AppError::InvalidInput("no paths to restore".to_string()));
    }
    let mut restore_args = vec!["restore".to_string(), "--".to_string()];
    restore_args.extend(paths.iter().cloned());
    let output = hidden_command("git")
        .args(&restore_args)
        .current_dir(&root)
        .output()
        .map_err(|err| AppError::Process(format!("failed to run git restore: {err}")))?;
    if output.status.success() {
        return Ok(());
    }
    // Older Git: fall back to checkout --
    let mut checkout_args = vec!["checkout".to_string(), "--".to_string()];
    checkout_args.extend(paths);
    let retry = hidden_command("git")
        .args(&checkout_args)
        .current_dir(&root)
        .output()
        .map_err(|err| AppError::Process(format!("failed to run git checkout: {err}")))?;
    if retry.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let err2 = String::from_utf8_lossy(&retry.stderr).trim().to_string();
    Err(AppError::Git(if !err.is_empty() {
        err
    } else if !err2.is_empty() {
        err2
    } else {
        "git restore failed".to_string()
    }))
}

pub(crate) fn run_git_path_command(
    root: &Path,
    args: &[&str],
    paths: &[String],
) -> Result<(), AppError> {
    let output = hidden_command("git")
        .args(args)
        .arg("--")
        .args(paths)
        .current_dir(root)
        .output()
        .map_err(|err| AppError::Process(format!("failed to run git: {err}")))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(AppError::Git(if stderr.is_empty() {
        format!("git {} failed", args.join(" "))
    } else {
        stderr
    }))
}

pub(crate) fn validate_git_paths(cwd: &str, paths: &[String]) -> Result<PathBuf, AppError> {
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Err(AppError::NotFound("workspace no longer exists".to_string()));
    }
    if paths.is_empty() {
        return Err(AppError::InvalidInput("no paths selected".to_string()));
    }
    if paths.iter().any(|path| path.trim().is_empty()) {
        return Err(AppError::InvalidInput(
            "empty Git path is not allowed".to_string(),
        ));
    }
    Ok(root)
}

#[tauri::command(async)]
pub(crate) fn git_stage_files(cwd: String, paths: Vec<String>) -> Result<(), AppError> {
    let root = validate_git_paths(&cwd, &paths)?;
    run_git_path_command(&root, &["add"], &paths)
}

#[tauri::command(async)]
pub(crate) fn git_unstage_files(cwd: String, paths: Vec<String>) -> Result<(), AppError> {
    let root = validate_git_paths(&cwd, &paths)?;
    match run_git_path_command(&root, &["restore", "--staged"], &paths) {
        Ok(()) => Ok(()),
        Err(first_error) => run_git_path_command(&root, &["reset", "HEAD"], &paths)
            .map_err(|second_error| AppError::Git(format!("{first_error}\n{second_error}"))),
    }
}

#[tauri::command(async)]
pub(crate) fn git_snapshot(cwd: String) -> Result<GitSnapshot, AppError> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() {
        return Err(AppError::NotFound("workspace no longer exists".to_string()));
    }

    let branch_output = run_git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let Ok(branch) = branch_output else {
        return Ok(GitSnapshot {
            is_repository: false,
            branch: None,
            files: Vec::new(),
            diff: String::new(),
        });
    };

    let (status, working, staged) = std::thread::scope(|scope| {
        let status = scope.spawn(|| {
            run_git(
                &root,
                &["status", "--porcelain=v1", "--untracked-files=all"],
            )
            .unwrap_or_default()
        });
        let working = scope.spawn(|| {
            run_git(&root, &["diff", "--no-ext-diff", "--unified=3", "--"]).unwrap_or_default()
        });
        let staged = scope.spawn(|| {
            run_git(
                &root,
                &["diff", "--cached", "--no-ext-diff", "--unified=3", "--"],
            )
            .unwrap_or_default()
        });
        (
            status.join().unwrap_or_default(),
            working.join().unwrap_or_default(),
            staged.join().unwrap_or_default(),
        )
    });
    let files = parse_git_status(&status);
    let diff = match (staged.is_empty(), working.is_empty()) {
        (true, _) => working,
        (_, true) => staged,
        (false, false) => format!("# Staged changes\n{staged}\n# Working tree changes\n{working}"),
    };

    Ok(GitSnapshot {
        is_repository: true,
        branch: Some(branch.trim().to_string()),
        files,
        diff,
    })
}

#[tauri::command(async)]
pub(crate) fn git_repository_root(cwd: String) -> Result<Option<String>, AppError> {
    let workspace = PathBuf::from(cwd.trim());
    if !workspace.is_dir() {
        return Ok(None);
    }
    match run_git(&workspace, &["rev-parse", "--show-toplevel"]) {
        Ok(root) => {
            let root = root.trim();
            Ok((!root.is_empty()).then(|| root.to_string()))
        }
        Err(_) => Ok(None),
    }
}

pub(crate) fn run_git(cwd: &Path, args: &[&str]) -> Result<String, AppError> {
    let output = hidden_command("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|err| AppError::Process(format!("failed to run git: {err}")))?;
    if !output.status.success() {
        return Err(AppError::Git(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::*;

    #[test]
    fn parses_git_index_and_worktree_status_separately() {
        let changes = parse_git_status(
            " M src/working.ts\nM  src/staged.ts\nMM src/both.ts\n?? src/new.ts\nR  old.ts -> renamed.ts\n",
        );
        assert_eq!(changes.len(), 5);
        assert!(!changes[0].staged);
        assert!(changes[0].unstaged);
        assert_eq!(changes[0].worktree_status, "M");
        assert!(changes[1].staged);
        assert!(!changes[1].unstaged);
        assert_eq!(changes[1].index_status, "M");
        assert!(changes[2].staged && changes[2].unstaged);
        assert!(changes[3].untracked && changes[3].unstaged);
        assert_eq!(changes[4].path, "renamed.ts");
    }

    #[test]
    fn stages_and_unstages_selected_files() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "pid-desktop-git-index-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("temporary repository should be created");
        run_git(&directory, &["init"]).expect("git repository should initialize");
        fs::write(directory.join("tracked.txt"), "first\n")
            .expect("tracked file should be written");
        run_git(&directory, &["add", "tracked.txt"]).expect("file should stage");
        run_git(
            &directory,
            &[
                "-c",
                "user.email=pid-desktop@example.invalid",
                "-c",
                "user.name=PIDesktop Tests",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "initial",
            ],
        )
        .expect("fixture commit should be created");
        fs::write(directory.join("tracked.txt"), "second\n")
            .expect("tracked file should be modified");

        let cwd = directory.to_string_lossy().to_string();
        let paths = vec!["tracked.txt".to_string()];
        let working = git_snapshot(cwd.clone()).expect("working snapshot should load");
        assert!(working.files[0].unstaged);
        let unstaged_review = git_review_snapshot(cwd.clone(), "unstaged".to_string())
            .expect("unstaged review should load");
        assert_eq!(unstaged_review.files.len(), 1);
        assert!(unstaged_review.diff.contains("-first"));
        git_stage_files(cwd.clone(), paths.clone()).expect("file should stage");
        let staged = git_snapshot(cwd.clone()).expect("staged snapshot should load");
        assert!(staged.files[0].staged);
        assert!(!staged.files[0].unstaged);
        let staged_review = git_review_snapshot(cwd.clone(), "staged".to_string())
            .expect("staged review should load");
        assert_eq!(staged_review.files.len(), 1);
        assert!(staged_review.diff.contains("+second"));
        let commits = git_list_commits(cwd.clone(), Some(5)).expect("commits should load");
        assert_eq!(commits.len(), 1);
        let commit_review = git_commit_snapshot(cwd.clone(), commits[0].sha.clone())
            .expect("commit review should load");
        assert_eq!(commit_review.files.len(), 1);
        assert!(commit_review.diff.contains("+first"));
        git_unstage_files(cwd.clone(), paths).expect("file should unstage");
        let unstaged = git_snapshot(cwd).expect("unstaged snapshot should load");
        assert!(!unstaged.files[0].staged);
        assert!(unstaged.files[0].unstaged);

        fs::remove_dir_all(directory).expect("temporary repository should be removed");
    }
}
