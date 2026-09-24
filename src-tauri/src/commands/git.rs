//! Git inspection and staging commands.
//!
//! Every command here shells out to `git`, so they all run off the main thread.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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
    /// Where the branch stands against its remote; only the working-tree snapshot has it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) sync: Option<GitSyncStatus>,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitSyncStatus {
    /// `origin/main`; none before the branch is published or after its remote branch was deleted.
    pub(crate) upstream: Option<String>,
    pub(crate) ahead: u32,
    pub(crate) behind: u32,
    pub(crate) has_remote: bool,
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

/// Reads the first line of `git status --branch`:
/// `## main...origin/main [ahead 1, behind 2]`, `## main` or `## HEAD (no branch)`.
pub(crate) fn parse_branch_header(line: &str) -> GitSyncStatus {
    let mut status = GitSyncStatus::default();
    let Some(rest) = line.strip_prefix("## ") else {
        return status;
    };
    let (refs, counts) = match rest.split_once(" [") {
        Some((refs, counts)) => (refs, counts.trim_end_matches(']')),
        None => (rest, ""),
    };
    status.upstream = refs
        .split_once("...")
        .map(|(_, upstream)| upstream.to_string());
    for part in counts.split(", ") {
        if let Some(count) = part.strip_prefix("ahead ") {
            status.ahead = count.parse().unwrap_or(0);
        } else if let Some(count) = part.strip_prefix("behind ") {
            status.behind = count.parse().unwrap_or(0);
        } else if part == "gone" {
            // The remote branch was deleted: pushing publishes it again.
            status.upstream = None;
        }
    }
    status
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
        sync: None,
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
        sync: None,
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
        sync: None,
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
            sync: None,
        });
    };

    let (status, working, staged, remotes) = std::thread::scope(|scope| {
        let status = scope.spawn(|| {
            run_git(
                &root,
                &[
                    "status",
                    "--porcelain=v1",
                    "--branch",
                    "--untracked-files=all",
                ],
            )
            .unwrap_or_default()
        });
        let remotes = scope.spawn(|| run_git(&root, &["remote"]).unwrap_or_default());
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
            remotes.join().unwrap_or_default(),
        )
    });
    let (header, entries) = match status.split_once('\n') {
        Some((first, rest)) if first.starts_with("## ") => (first, rest),
        _ if status.starts_with("## ") => (status.as_str(), ""),
        _ => ("", status.as_str()),
    };
    let mut sync = parse_branch_header(header);
    sync.has_remote = remotes.lines().any(|line| !line.trim().is_empty());
    let files = parse_git_status(entries);
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
        sync: Some(sync),
    })
}

/// The repository's top-level folder; patches and tree writes run from here
/// because Git reports every path relative to it.
fn repository_toplevel(cwd: &Path) -> Result<PathBuf, AppError> {
    if !cwd.is_dir() {
        return Err(AppError::NotFound("workspace no longer exists".to_string()));
    }
    let root = run_git(cwd, &["rev-parse", "--show-toplevel"])?;
    let root = root.trim();
    if root.is_empty() {
        return Err(AppError::Git("not a Git repository".to_string()));
    }
    Ok(PathBuf::from(root))
}

/// Applies a patch the review pane built from one hunk (or one file).
///
/// `cached` targets the index (stage or unstage a hunk); without it the patch
/// lands in the working tree (discard a hunk). `reverse` undoes the patch.
#[tauri::command(async)]
pub(crate) fn git_apply_patch(
    cwd: String,
    patch: String,
    cached: bool,
    reverse: bool,
) -> Result<(), AppError> {
    use std::io::Write;
    use std::process::Stdio;

    if patch.trim().is_empty() {
        return Err(AppError::InvalidInput("patch is empty".to_string()));
    }
    let root = repository_toplevel(Path::new(&cwd))?;
    let mut command = hidden_command("git");
    command.arg("apply").arg("--whitespace=nowarn");
    if cached {
        command.arg("--cached");
    }
    if reverse {
        command.arg("--reverse");
    }
    let mut child = command
        .arg("-")
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| AppError::Process(format!("failed to run git apply: {err}")))?;
    let mut body = patch;
    if !body.ends_with('\n') {
        body.push('\n');
    }
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(body.as_bytes())
            .map_err(|err| AppError::Io(format!("failed to send patch to git: {err}")))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|err| AppError::Process(format!("failed to run git apply: {err}")))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(AppError::Git(if stderr.is_empty() {
        "git apply failed".to_string()
    } else {
        stderr
    }))
}

fn run_git_with_index(root: &Path, index: &Path, args: &[&str]) -> Result<String, AppError> {
    let output = hidden_command("git")
        .args(["-c", "core.quotePath=false"])
        .args(args)
        .env("GIT_INDEX_FILE", index)
        .current_dir(root)
        .output()
        .map_err(|err| AppError::Process(format!("failed to run git: {err}")))?;
    if !output.status.success() {
        return Err(AppError::Git(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Records the whole working tree (tracked and untracked, minus ignored files)
/// as a tree object, without touching the real index or making a commit.
///
/// This mirrors how the Pi guard extension (pidesktop-checkpoints.ts) records
/// a turn's starting point, so the two trees compare like for like. A scratch
/// copy of the real index is merged with HEAD via `read-tree -m`, which keeps
/// Git's stat cache: only files that changed are hashed again.
fn write_worktree_tree(root: &Path) -> Result<String, AppError> {
    let index = run_git(root, &["rev-parse", "--git-path", "index"])?;
    let index = root.join(index.trim());
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let scratch = std::env::temp_dir().join(format!(
        "pid-desktop-worktree-{}-{stamp}.index",
        std::process::id()
    ));
    let head_tree = run_git(root, &["rev-parse", "--verify", "--quiet", "HEAD^{tree}"])
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let tree = (|| {
        match &head_tree {
            Some(head) => {
                let merged = index.is_file()
                    && fs::copy(&index, &scratch).is_ok()
                    && run_git_with_index(root, &scratch, &["read-tree", "-m", head]).is_ok();
                if !merged {
                    // No index yet, or one with conflicts: start from HEAD without a stat cache.
                    let _ = fs::remove_file(&scratch);
                    run_git_with_index(root, &scratch, &["read-tree", head])?;
                }
            }
            None => {
                run_git_with_index(root, &scratch, &["read-tree", "--empty"])?;
            }
        }
        run_git_with_index(root, &scratch, &["add", "-A", "--", "."])?;
        run_git_with_index(root, &scratch, &["write-tree"])
    })();
    let _ = fs::remove_file(&scratch);
    let tree = tree?.trim().to_string();
    if tree.is_empty() {
        return Err(AppError::Git("git write-tree returned nothing".to_string()));
    }
    Ok(tree)
}

/// A snapshot of what the most recent agent turn changed in this repository.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LastTurnSnapshot {
    #[serde(flatten)]
    pub(crate) snapshot: GitSnapshot,
    /// Unix seconds when the turn started (when its checkpoint was recorded).
    pub(crate) started_at: i64,
}

/// The newest turn checkpoint the Pi guard extension recorded for this repository.
fn latest_turn_checkpoint(root: &Path) -> Result<Option<(String, i64)>, AppError> {
    let output = run_git(
        root,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            "--count=1",
            "--format=%(objectname) %(creatordate:unix)",
            "refs/pidesktop/checkpoints",
        ],
    )?;
    let Some((commit, stamp)) = output.trim().split_once(' ') else {
        return Ok(None);
    };
    let tree = run_git(
        root,
        &["rev-parse", "--verify", &format!("{commit}^{{tree}}")],
    )?;
    Ok(Some((
        tree.trim().to_string(),
        stamp.trim().parse().unwrap_or_default(),
    )))
}

fn snapshot_between_trees(root: &Path, from: &str, to: &str) -> Result<GitSnapshot, AppError> {
    let branch = run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok()
        .map(|value| value.trim().to_string());
    let name_status = run_git(root, &["diff", "--no-renames", "--name-status", from, to])?;
    let files = name_status
        .lines()
        .filter_map(|line| {
            let (status, path) = line.split_once('\t')?;
            let path = path.trim();
            if path.is_empty() {
                return None;
            }
            Some(GitFileChange {
                status: status
                    .chars()
                    .next()
                    .map(|ch| ch.to_string())
                    .unwrap_or_default(),
                path: path.to_string(),
                index_status: String::new(),
                worktree_status: String::new(),
                staged: false,
                unstaged: true,
                untracked: false,
            })
        })
        .collect();
    let diff = run_git(
        root,
        &[
            "diff",
            "--no-ext-diff",
            "--no-renames",
            "--unified=3",
            from,
            to,
        ],
    )?;
    Ok(GitSnapshot {
        is_repository: true,
        branch,
        files,
        diff,
        sync: None,
    })
}

/// Everything the working tree gained since the latest agent turn started.
/// `None` when no turn has run in this repository with checkpoints enabled.
#[tauri::command(async)]
pub(crate) fn git_last_turn_snapshot(cwd: String) -> Result<Option<LastTurnSnapshot>, AppError> {
    let root = repository_toplevel(Path::new(&cwd))?;
    let Some((checkpoint, started_at)) = latest_turn_checkpoint(&root)? else {
        return Ok(None);
    };
    let current = write_worktree_tree(&root)?;
    Ok(Some(LastTurnSnapshot {
        snapshot: snapshot_between_trees(&root, &checkpoint, &current)?,
        started_at,
    }))
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

/// Every read goes through here. `core.quotePath=false` makes Git print
/// non-ASCII paths (every CJK file name) as UTF-8 instead of octal escapes,
/// so status lines and diff headers name files the way the UI shows them.
pub(crate) fn run_git(cwd: &Path, args: &[&str]) -> Result<String, AppError> {
    let output = hidden_command("git")
        .args(["-c", "core.quotePath=false"])
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
    fn reads_upstream_and_counts_from_the_branch_header() {
        let tracked = parse_branch_header("## main...origin/main [ahead 2, behind 1]");
        assert_eq!(tracked.upstream.as_deref(), Some("origin/main"));
        assert_eq!((tracked.ahead, tracked.behind), (2, 1));
        let even = parse_branch_header("## feat/x...origin/feat/x");
        assert_eq!(even.upstream.as_deref(), Some("origin/feat/x"));
        assert_eq!((even.ahead, even.behind), (0, 0));
        assert_eq!(
            parse_branch_header("## feat/local"),
            GitSyncStatus::default()
        );
        assert_eq!(
            parse_branch_header("## feat/x...origin/feat/x [gone]").upstream,
            None
        );
        assert_eq!(
            parse_branch_header("## No commits yet on main").upstream,
            None
        );
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

    fn fixture_repository(name: &str, contents: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "pid-desktop-git-{name}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("temporary repository should be created");
        run_git(&directory, &["init"]).expect("git repository should initialize");
        run_git(&directory, &["config", "core.autocrlf", "false"]).expect("autocrlf should be set");
        fs::write(directory.join("notes.txt"), contents).expect("fixture file should be written");
        run_git(&directory, &["add", "notes.txt"]).expect("file should stage");
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
        directory
    }

    /// The first hunk of a single-file diff, as the review pane builds it.
    fn first_hunk_patch(diff: &str) -> String {
        let mut header = Vec::new();
        let mut hunk = Vec::new();
        for line in diff.lines() {
            if line.starts_with("@@") {
                if !hunk.is_empty() {
                    break;
                }
                hunk.push(line);
            } else if hunk.is_empty() {
                header.push(line);
            } else {
                hunk.push(line);
            }
        }
        format!("{}\n{}\n", header.join("\n"), hunk.join("\n"))
    }

    #[test]
    fn stages_and_discards_a_single_hunk() {
        let original: String = (1..=30).map(|n| format!("line {n}\n")).collect();
        let directory = fixture_repository("hunk", &original);
        let edited = original
            .replace("line 2\n", "line two\n")
            .replace("line 28\n", "line twenty-eight\n");
        fs::write(directory.join("notes.txt"), &edited).expect("file should be edited");
        let cwd = directory.to_string_lossy().to_string();

        let diff = run_git(&directory, &["diff", "--no-ext-diff", "--unified=3", "--"])
            .expect("diff should load");
        assert_eq!(
            diff.lines().filter(|line| line.starts_with("@@")).count(),
            2
        );
        let patch = first_hunk_patch(&diff);

        git_apply_patch(cwd.clone(), patch.clone(), true, false).expect("hunk should stage");
        let staged =
            run_git(&directory, &["diff", "--cached", "--"]).expect("staged diff should load");
        assert!(staged.contains("+line two"));
        assert!(!staged.contains("twenty-eight"));

        git_apply_patch(cwd.clone(), patch.clone(), true, true).expect("hunk should unstage");
        let staged =
            run_git(&directory, &["diff", "--cached", "--"]).expect("staged diff should load");
        assert!(staged.trim().is_empty());

        git_apply_patch(cwd, patch, false, true).expect("hunk should be discarded");
        let contents = fs::read_to_string(directory.join("notes.txt")).expect("file should read");
        assert!(contents.contains("line 2\n"));
        assert!(contents.contains("line twenty-eight\n"));

        fs::remove_dir_all(directory).expect("temporary repository should be removed");
    }

    #[test]
    fn reports_non_ascii_paths_as_utf8() {
        let directory = fixture_repository(
            "unicode", "alpha
",
        );
        fs::write(
            directory.join("书签.txt"),
            "新内容
",
        )
        .expect("CJK file should be written");
        run_git(&directory, &["add", "书签.txt"]).expect("CJK file should stage");
        let snapshot =
            git_snapshot(directory.to_string_lossy().to_string()).expect("snapshot should load");
        assert!(
            snapshot.files.iter().any(|file| file.path == "书签.txt"),
            "{:?}",
            snapshot.files
        );
        assert!(snapshot.diff.contains("b/书签.txt"));

        fs::remove_dir_all(directory).expect("temporary repository should be removed");
    }

    /// Records a turn checkpoint the way the Pi guard extension does.
    fn record_turn_checkpoint(directory: &Path, name: &str) {
        let tree = write_worktree_tree(directory).expect("worktree tree should be written");
        let commit = run_git(
            directory,
            &[
                "-c",
                "user.email=checkpoint@example.invalid",
                "-c",
                "user.name=PIDesktop",
                "commit-tree",
                &tree,
                "-m",
                "checkpoint",
            ],
        )
        .expect("checkpoint commit should be created");
        run_git(
            directory,
            &[
                "update-ref",
                &format!("refs/pidesktop/checkpoints/{name}"),
                commit.trim(),
            ],
        )
        .expect("checkpoint ref should be written");
    }

    #[test]
    fn shows_only_what_the_last_turn_changed() {
        let directory = fixture_repository("last-turn", "alpha\n");
        let cwd = directory.to_string_lossy().to_string();
        assert!(git_last_turn_snapshot(cwd.clone())
            .expect("lookup should work")
            .is_none());

        // Work that predates the turn must not show up as the turn's change.
        fs::write(directory.join("notes.txt"), "alpha\nbefore turn\n")
            .expect("file should be edited");
        run_git(&directory, &["add", "notes.txt"]).expect("pre-turn edit should stage");
        let index_before =
            run_git(&directory, &["diff", "--cached", "--name-only"]).expect("index should read");
        record_turn_checkpoint(&directory, "turn-1");

        fs::write(
            directory.join("notes.txt"),
            "alpha\nbefore turn\nduring turn\n",
        )
        .expect("file should be edited");
        fs::write(directory.join("created.txt"), "new file\n").expect("file should be created");

        let last_turn = git_last_turn_snapshot(cwd.clone())
            .expect("last turn should load")
            .expect("a checkpoint should exist");
        assert!(last_turn.started_at > 0);
        let snapshot = last_turn.snapshot;
        let mut paths: Vec<_> = snapshot
            .files
            .iter()
            .map(|file| (file.status.as_str(), file.path.as_str()))
            .collect();
        paths.sort();
        assert_eq!(paths, [("A", "created.txt"), ("M", "notes.txt")]);
        assert!(snapshot.diff.contains("+during turn"));
        assert!(!snapshot.diff.contains("+before turn"));
        // Reading the last turn never changes the real index.
        let index_after =
            run_git(&directory, &["diff", "--cached", "--name-only"]).expect("index should read");
        assert_eq!(index_before, index_after);

        // Reverse-applying the turn's diff restores the pre-turn working tree.
        git_apply_patch(cwd, snapshot.diff, false, true).expect("turn should be undone");
        assert_eq!(
            fs::read_to_string(directory.join("notes.txt")).expect("file should read"),
            "alpha\nbefore turn\n"
        );
        assert!(!directory.join("created.txt").exists());

        fs::remove_dir_all(directory).expect("temporary repository should be removed");
    }
}
