//! GitHub pull requests through `gh`, and managed git worktrees.

use crate::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequestInfo {
    pub(crate) number: u64,
    pub(crate) title: String,
    pub(crate) state: String,
    pub(crate) is_draft: bool,
    pub(crate) head_ref_name: String,
    pub(crate) base_ref_name: String,
    pub(crate) updated_at: String,
    pub(crate) url: String,
    pub(crate) author: String,
    pub(crate) review_decision: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequestCollection {
    pub(crate) repository: String,
    pub(crate) remote_url: String,
    pub(crate) items: Vec<PullRequestInfo>,
}

pub(crate) fn github_cli_command() -> Command {
    #[cfg(windows)]
    {
        hidden_command(resolve_windows_executable("gh").unwrap_or_else(|| PathBuf::from("gh")))
    }
    #[cfg(not(windows))]
    {
        hidden_command("gh")
    }
}

#[tauri::command(async)]
pub(crate) fn list_pull_requests(cwd: String) -> Result<PullRequestCollection, AppError> {
    let cwd_path = PathBuf::from(&cwd);
    let repository_root = run_git(&cwd_path, &["rev-parse", "--show-toplevel"])?;
    let repository_root = PathBuf::from(repository_root.trim());
    let repository = repository_root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("repository")
        .to_string();
    let remote_url = run_git(&repository_root, &["remote", "get-url", "origin"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let output = github_cli_command()
        .args([
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "50",
            "--json",
            "number,title,state,isDraft,headRefName,baseRefName,updatedAt,url,author,reviewDecision",
        ])
        .current_dir(&repository_root)
        .output()
        .map_err(|err| AppError::Git(format!("无法启动 GitHub CLI（gh）：{err}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Git(if stderr.is_empty() {
            "GitHub CLI 未登录或当前仓库没有可访问的远程仓库".to_string()
        } else {
            stderr
        }));
    }
    let raw: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|err| AppError::Git(format!("failed to parse GitHub pull requests: {err}")))?;
    let items = raw
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| PullRequestInfo {
            number: item
                .get("number")
                .and_then(|value| value.as_u64())
                .unwrap_or(0),
            title: item
                .get("title")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            state: item
                .get("state")
                .and_then(|value| value.as_str())
                .unwrap_or("OPEN")
                .to_string(),
            is_draft: item
                .get("isDraft")
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
            head_ref_name: item
                .get("headRefName")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            base_ref_name: item
                .get("baseRefName")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            updated_at: item
                .get("updatedAt")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            url: item
                .get("url")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            author: item
                .pointer("/author/login")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            review_decision: item
                .get("reviewDecision")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect();
    Ok(PullRequestCollection {
        repository,
        remote_url,
        items,
    })
}

#[tauri::command(async)]
pub(crate) fn checkout_pull_request(cwd: String, number: u64) -> Result<(), AppError> {
    let cwd_path = PathBuf::from(cwd);
    let output = github_cli_command()
        .args(["pr", "checkout", &number.to_string()])
        .current_dir(cwd_path)
        .output()
        .map_err(|err| AppError::Git(format!("无法启动 GitHub CLI（gh）：{err}")))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            AppError::Git("检出拉取请求失败".to_string())
        } else {
            AppError::Git(stderr)
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeInfo {
    pub(crate) path: String,
    pub(crate) head: Option<String>,
    pub(crate) branch: Option<String>,
    pub(crate) is_main: bool,
}

#[tauri::command(async)]
pub(crate) fn list_worktrees(cwd: String) -> Result<Vec<WorktreeInfo>, AppError> {
    let root = PathBuf::from(cwd);
    let output = run_git(&root, &["worktree", "list", "--porcelain"])?;
    Ok(parse_worktrees(&output))
}

#[tauri::command(async)]
pub(crate) fn create_worktree(
    state: State<'_, AppState>,
    cwd: String,
    base: Option<String>,
) -> Result<WorktreeInfo, AppError> {
    let cwd = PathBuf::from(cwd);
    let repo = run_git(&cwd, &["rev-parse", "--show-toplevel"])?;
    let repo = PathBuf::from(repo.trim());
    let repo_name = repo
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workspace");
    let safe_name: String = repo_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let root = app_config_dir().join("worktrees");
    fs::create_dir_all(&root)
        .map_err(|err| AppError::Io(format!("failed to create worktree directory: {err}")))?;
    let target = root.join(format!("{safe_name}-{stamp}"));
    let base = base
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "HEAD".to_string());
    let branch_prefix = state
        .settings
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?
        .branch_prefix
        .trim()
        .to_string();
    let branch_prefix = if branch_prefix.is_empty() {
        "pi/".to_string()
    } else if branch_prefix.ends_with('/') {
        branch_prefix
    } else {
        format!("{branch_prefix}/")
    };
    let branch = format!("{branch_prefix}worktree-{stamp}");
    let output = hidden_command("git")
        .args(["worktree", "add", "-b", &branch])
        .arg(&target)
        .arg(&base)
        .current_dir(&repo)
        .output()
        .map_err(|err| AppError::Process(format!("failed to create worktree: {err}")))?;
    if !output.status.success() {
        return Err(AppError::Git(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    Ok(WorktreeInfo {
        path: target.to_string_lossy().to_string(),
        head: run_git(&target, &["rev-parse", "HEAD"])
            .ok()
            .map(|value| value.trim().to_string()),
        branch: Some(branch),
        is_main: false,
    })
}

pub(crate) fn parse_worktrees(output: &str) -> Vec<WorktreeInfo> {
    let mut result = Vec::new();
    let mut path: Option<String> = None;
    let mut head: Option<String> = None;
    let mut branch: Option<String> = None;
    for line in output.lines().chain(std::iter::once("")) {
        if let Some(value) = line.strip_prefix("worktree ") {
            if let Some(previous) = path.take() {
                result.push(WorktreeInfo {
                    path: previous,
                    head: head.take(),
                    branch: branch.take(),
                    is_main: result.is_empty(),
                });
            }
            path = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("HEAD ") {
            head = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("branch ") {
            branch = Some(value.trim_start_matches("refs/heads/").to_string());
        } else if line.is_empty() {
            if let Some(previous) = path.take() {
                result.push(WorktreeInfo {
                    path: previous,
                    head: head.take(),
                    branch: branch.take(),
                    is_main: result.is_empty(),
                });
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_git_worktree_porcelain_output() {
        let worktrees = parse_worktrees(
            "worktree D:/repo\nHEAD abcdef123456\nbranch refs/heads/main\n\nworktree D:/worktrees/task\nHEAD 123456abcdef\ndetached\n",
        );
        assert_eq!(worktrees.len(), 2);
        assert!(worktrees[0].is_main);
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
        assert!(!worktrees[1].is_main);
        assert_eq!(worktrees[1].path, "D:/worktrees/task");
    }
}
