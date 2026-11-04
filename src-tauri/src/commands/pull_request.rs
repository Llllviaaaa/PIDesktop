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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequestDraftContext {
    pub(crate) head_branch: String,
    pub(crate) base_branch: String,
    pub(crate) commit_count: usize,
    pub(crate) prompt: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequestCreated {
    pub(crate) url: String,
    pub(crate) number: Option<u64>,
    pub(crate) head_ref_name: String,
    pub(crate) base_ref_name: String,
    pub(crate) is_draft: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequestComment {
    pub(crate) id: String,
    pub(crate) author: String,
    pub(crate) body: String,
    pub(crate) created_at: String,
    pub(crate) kind: String,
    pub(crate) review_state: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequestCheck {
    pub(crate) name: String,
    pub(crate) status: String,
    pub(crate) conclusion: String,
    pub(crate) details_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullRequestDetail {
    pub(crate) number: u64,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) url: String,
    pub(crate) state: String,
    pub(crate) is_draft: bool,
    pub(crate) base_ref_name: String,
    pub(crate) head_ref_name: String,
    pub(crate) author: String,
    pub(crate) review_decision: String,
    pub(crate) comments: Vec<PullRequestComment>,
    pub(crate) checks: Vec<PullRequestCheck>,
}

const PR_DIFF_LIMIT: usize = 48 * 1024;

fn truncate_pr_prompt(mut text: String, limit: usize) -> String {
    if text.len() <= limit {
        return text;
    }
    let mut cut = limit;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    text.push_str("\n…（后面的差异过长，已省略）\n");
    text
}

pub(crate) fn build_pull_request_prompt(
    head_branch: &str,
    base_branch: &str,
    commits_log: &str,
    diff_text: &str,
    instructions: &str,
) -> String {
    let commits_section = if commits_log.trim().is_empty() {
        "（当前分支尚无相对基线分支的独立提交，以下为工作区/最近改动）".to_string()
    } else {
        commits_log.trim().to_string()
    };
    let instructions_trimmed = instructions.trim();
    let extra = if instructions_trimmed.is_empty() {
        String::new()
    } else {
        format!("\n## 用户的额外要求\n\n{instructions_trimmed}\n")
    };
    format!(
        "请根据下面的分支提交与代码差异，起草一份 GitHub Pull Request 的标题与正文描述。\n\
         - 源分支：`{head_branch}` → 目标分支：`{base_branch}`\n\
         - 请严格只输出一个 JSON 对象，格式为 `{{\"title\": \"...\", \"body\": \"...\"}}`，不要加代码块包裹或额外解释。\n\
         - `title` 控制在 72 个字符以内，清晰概括本次改动。\n\
         - `body` 使用 Markdown（包含「改动摘要」与「验证方式」小节）。\n\
         {extra}\n\
         ## 提交记录\n\n{commits_section}\n\n\
         ## 差异摘要与内容\n\n{diff_text}\n"
    )
}

pub(crate) fn parse_created_pr_url(stdout: &str) -> (String, Option<u64>) {
    let url = stdout
        .lines()
        .map(str::trim)
        .rfind(|line| line.starts_with("https://") || line.starts_with("http://"))
        .unwrap_or_else(|| stdout.trim())
        .to_string();
    let number = url
        .trim_end_matches('/')
        .rsplit_once("/pull/")
        .and_then(|(_, num)| num.parse::<u64>().ok());
    (url, number)
}

pub(crate) fn parse_pull_request_detail_json(
    raw_bytes: &[u8],
) -> Result<PullRequestDetail, AppError> {
    let raw: serde_json::Value = serde_json::from_slice(raw_bytes)
        .map_err(|err| AppError::Git(format!("failed to parse pull request detail: {err}")))?;
    let mut comments = Vec::new();
    if let Some(items) = raw.get("comments").and_then(|v| v.as_array()) {
        for (idx, item) in items.iter().enumerate() {
            let body = item
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if body.is_empty() {
                continue;
            }
            comments.push(PullRequestComment {
                id: item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("comment-{idx}")),
                author: item
                    .pointer("/author/login")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                body,
                created_at: item
                    .get("createdAt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                kind: "comment".to_string(),
                review_state: None,
            });
        }
    }
    if let Some(reviews) = raw.get("reviews").and_then(|v| v.as_array()) {
        for (idx, item) in reviews.iter().enumerate() {
            let body = item
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let state = item
                .get("state")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if body.is_empty() && (state.is_empty() || state == "COMMENTED") {
                continue;
            }
            comments.push(PullRequestComment {
                id: item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("review-{idx}")),
                author: item
                    .pointer("/author/login")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                body,
                created_at: item
                    .get("submittedAt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                kind: "review".to_string(),
                review_state: if state.is_empty() { None } else { Some(state) },
            });
        }
    }

    let mut checks = Vec::new();
    if let Some(rollup) = raw.get("statusCheckRollup").and_then(|v| v.as_array()) {
        for item in rollup {
            let name = item
                .get("name")
                .and_then(|v| v.as_str())
                .or_else(|| item.get("context").and_then(|v| v.as_str()))
                .unwrap_or("check")
                .to_string();
            let status = item
                .get("status")
                .and_then(|v| v.as_str())
                .or_else(|| item.get("state").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            let conclusion = item
                .get("conclusion")
                .and_then(|v| v.as_str())
                .or_else(|| item.get("state").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            let details_url = item
                .get("detailsUrl")
                .and_then(|v| v.as_str())
                .or_else(|| item.get("targetUrl").and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            checks.push(PullRequestCheck {
                name,
                status,
                conclusion,
                details_url,
            });
        }
    }

    Ok(PullRequestDetail {
        number: raw.get("number").and_then(|v| v.as_u64()).unwrap_or(0),
        title: raw
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        body: raw
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        url: raw
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        state: raw
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("OPEN")
            .to_string(),
        is_draft: raw
            .get("isDraft")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        base_ref_name: raw
            .get("baseRefName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        head_ref_name: raw
            .get("headRefName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        author: raw
            .pointer("/author/login")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        review_decision: raw
            .get("reviewDecision")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        comments,
        checks,
    })
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

#[tauri::command(async)]
pub(crate) fn pull_request_draft_prompt(
    state: State<'_, AppState>,
    cwd: String,
    base: Option<String>,
) -> Result<PullRequestDraftContext, AppError> {
    let cwd_path = PathBuf::from(&cwd);
    let repository_root =
        PathBuf::from(run_git(&cwd_path, &["rev-parse", "--show-toplevel"])?.trim());
    let head_branch = run_git(&repository_root, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    if head_branch == "HEAD" {
        return Err(AppError::InvalidInput(
            "当前不在任何分支上（分离的 HEAD）。先切换到一个分支再起草拉取请求。".to_string(),
        ));
    }
    let repo_cwd = repository_root.to_string_lossy().to_string();
    let base_branch = base
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| git_default_branch(repo_cwd).ok().flatten())
        .unwrap_or_else(|| "main".to_string());

    let origin_ref = format!("origin/{base_branch}");
    let compare_ref = if run_git(
        &repository_root,
        &["rev-parse", "--verify", "--quiet", &origin_ref],
    )
    .is_ok()
    {
        Some(origin_ref)
    } else if run_git(
        &repository_root,
        &["rev-parse", "--verify", "--quiet", &base_branch],
    )
    .is_ok()
    {
        Some(base_branch.clone())
    } else {
        None
    };

    let (commits_log, commit_count, raw_diff) = if let Some(target_ref) = compare_ref {
        let range = format!("{target_ref}..HEAD");
        let log_out = run_git(
            &repository_root,
            &["log", "--reverse", "--format=- %s (%h)", &range],
        )
        .unwrap_or_default();
        let count = log_out
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count();
        let stat = run_git(
            &repository_root,
            &[
                "diff",
                "--no-ext-diff",
                "--stat",
                &format!("{target_ref}...HEAD"),
            ],
        )
        .unwrap_or_default();
        let patch = run_git(
            &repository_root,
            &[
                "diff",
                "--no-ext-diff",
                "--unified=2",
                &format!("{target_ref}...HEAD"),
            ],
        )
        .unwrap_or_default();
        let combined = if patch.trim().is_empty() {
            // Fall back to working tree / HEAD~1 when on same commit as base
            let wt_stat = run_git(
                &repository_root,
                &["diff", "--no-ext-diff", "--stat", "HEAD"],
            )
            .unwrap_or_default();
            let wt_patch = run_git(
                &repository_root,
                &["diff", "--no-ext-diff", "--unified=2", "HEAD"],
            )
            .unwrap_or_default();
            format!("{wt_stat}\n{wt_patch}")
        } else {
            format!("{stat}\n{patch}")
        };
        (log_out, count, combined)
    } else {
        let log_out = run_git(
            &repository_root,
            &["log", "-5", "--reverse", "--format=- %s (%h)"],
        )
        .unwrap_or_default();
        let count = log_out
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count();
        let patch = run_git(&repository_root, &["show", "--stat", "--unified=2", "HEAD"])
            .unwrap_or_default();
        (log_out, count, patch)
    };

    let diff_text = truncate_pr_prompt(raw_diff, PR_DIFF_LIMIT);
    let instructions = state
        .settings
        .lock()
        .map_err(|_| AppError::Locked("state lock poisoned".to_string()))?
        .pull_request_instructions
        .clone();

    let prompt = build_pull_request_prompt(
        &head_branch,
        &base_branch,
        &commits_log,
        &diff_text,
        &instructions,
    );
    Ok(PullRequestDraftContext {
        head_branch,
        base_branch,
        commit_count,
        prompt,
    })
}

#[tauri::command(async)]
pub(crate) fn create_pull_request(
    cwd: String,
    title: String,
    body: String,
    base: Option<String>,
    draft: bool,
) -> Result<PullRequestCreated, AppError> {
    let trimmed_title = title.trim();
    if trimmed_title.is_empty() {
        return Err(AppError::InvalidInput("拉取请求标题不能为空".to_string()));
    }
    let cwd_path = PathBuf::from(&cwd);
    let repository_root =
        PathBuf::from(run_git(&cwd_path, &["rev-parse", "--show-toplevel"])?.trim());
    let head_ref_name = run_git(&repository_root, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();
    if head_ref_name == "HEAD" {
        return Err(AppError::InvalidInput(
            "当前不在任何分支上（分离的 HEAD）。先切换到一个分支再创建拉取请求。".to_string(),
        ));
    }
    let repo_cwd = repository_root.to_string_lossy().to_string();
    let base_ref_name = base
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| git_default_branch(repo_cwd).ok().flatten())
        .unwrap_or_else(|| "main".to_string());

    let mut command = github_cli_command();
    command.args([
        "pr",
        "create",
        "--title",
        trimmed_title,
        "--body",
        body.trim(),
        "--base",
        &base_ref_name,
    ]);
    if draft {
        command.arg("--draft");
    }
    let output = command
        .current_dir(&repository_root)
        .output()
        .map_err(|err| AppError::Git(format!("无法启动 GitHub CLI（gh）：{err}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        return Err(AppError::Git(if detail.is_empty() {
            "创建拉取请求失败，请确认当前分支已推送且 GitHub CLI 已登录".to_string()
        } else {
            detail
        }));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let (url, number) = parse_created_pr_url(&stdout);
    Ok(PullRequestCreated {
        url,
        number,
        head_ref_name,
        base_ref_name,
        is_draft: draft,
    })
}

#[tauri::command(async)]
pub(crate) fn get_pull_request_detail(
    cwd: String,
    number: u64,
) -> Result<PullRequestDetail, AppError> {
    let cwd_path = PathBuf::from(&cwd);
    let repository_root =
        PathBuf::from(run_git(&cwd_path, &["rev-parse", "--show-toplevel"])?.trim());
    let output = github_cli_command()
        .args([
            "pr",
            "view",
            &number.to_string(),
            "--json",
            "number,title,body,url,state,isDraft,baseRefName,headRefName,author,reviewDecision,comments,reviews,statusCheckRollup",
        ])
        .current_dir(&repository_root)
        .output()
        .map_err(|err| AppError::Git(format!("无法启动 GitHub CLI（gh）：{err}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Git(if stderr.is_empty() {
            format!("无法读取拉取请求 #{number} 的详情")
        } else {
            stderr
        }));
    }
    parse_pull_request_detail_json(&output.stdout)
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

    #[test]
    fn builds_pull_request_prompt_with_custom_instructions() {
        let without =
            build_pull_request_prompt("feat/pr", "main", "- feat: add pr (abc1234)", "+line", "");
        assert!(!without.contains("用户的额外要求"));
        assert!(without.contains("`feat/pr` → 目标分支：`main`"));

        let with_rules = build_pull_request_prompt(
            "feat/pr",
            "main",
            "- feat: add pr (abc1234)",
            "+line",
            "请附带关联 Issue 编号并用中文撰写风险评估",
        );
        assert!(
            with_rules.contains("## 用户的额外要求\n\n请附带关联 Issue 编号并用中文撰写风险评估")
        );
    }

    #[test]
    fn parses_created_pr_url_and_detail_json() {
        let (url, number) = parse_created_pr_url(
            "Creating pull request for feat/x into main\nhttps://github.com/org/repo/pull/42\n",
        );
        assert_eq!(url, "https://github.com/org/repo/pull/42");
        assert_eq!(number, Some(42));

        let payload = br###"{
            "number": 42,
            "title": "feat: close PR loop",
            "body": "## Summary\nAll good",
            "url": "https://github.com/org/repo/pull/42",
            "state": "OPEN",
            "isDraft": false,
            "baseRefName": "main",
            "headRefName": "feat/pr",
            "author": { "login": "alice" },
            "reviewDecision": "CHANGES_REQUESTED",
            "comments": [
                { "id": "IC_1", "author": { "login": "bob" }, "body": "Please fix edge case", "createdAt": "2026-11-04T00:00:00Z" }
            ],
            "reviews": [
                { "id": "PRR_1", "author": { "login": "carol" }, "body": "Needs unit test", "state": "CHANGES_REQUESTED", "submittedAt": "2026-11-04T01:00:00Z" }
            ],
            "statusCheckRollup": [
                { "name": "ci / test", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "https://github.com/org/repo/actions/runs/1" },
                { "context": "lint", "state": "SUCCESS", "targetUrl": "https://github.com/org/repo/actions/runs/2" }
            ]
        }"###;
        let detail = parse_pull_request_detail_json(payload).expect("detail JSON should parse");
        assert_eq!(detail.number, 42);
        assert_eq!(detail.comments.len(), 2);
        assert_eq!(detail.comments[0].author, "bob");
        assert_eq!(detail.comments[1].kind, "review");
        assert_eq!(
            detail.comments[1].review_state.as_deref(),
            Some("CHANGES_REQUESTED")
        );
        assert_eq!(detail.checks.len(), 2);
        assert_eq!(detail.checks[0].conclusion, "FAILURE");
        assert_eq!(detail.checks[1].name, "lint");
    }
}
