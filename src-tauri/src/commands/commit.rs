//! Committing and pushing from the app, and the prompt for drafting a commit message.
//!
//! `git.rs` reads the repository and moves changes in and out of the index;
//! this module writes history, talks to remotes and describes the changes for
//! the message, which the Harness Host's `llm.complete` writes. The agent is
//! never asked to commit on the user's behalf.

use crate::pi::process::kill_process_tree;
use crate::*;
use std::io::{Read, Write};
use std::path::Path;
use std::process::Stdio;

/// A push that has not finished by now is waiting on something we cannot answer.
const PUSH_TIMEOUT: Duration = Duration::from_secs(180);
/// Enough of the diff to summarize it without sending a whole refactor.
const MESSAGE_DIFF_LIMIT: usize = 48 * 1024;
const UNTRACKED_PREVIEW_LIMIT: usize = 4 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitCommitResult {
    pub(crate) sha: String,
    pub(crate) short_sha: String,
    pub(crate) subject: String,
    pub(crate) branch: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitPushResult {
    pub(crate) remote: String,
    pub(crate) branch: String,
    /// The push published the branch and made the remote branch its upstream.
    pub(crate) set_upstream: bool,
}

fn workspace_root(cwd: &str) -> Result<PathBuf, AppError> {
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return Err(AppError::NotFound("workspace no longer exists".to_string()));
    }
    Ok(root)
}

/// `run_git` for commands that take stdin, need a deadline or write to a
/// remote. Git's own message is the error, so hook output reaches the user.
fn run_git_process(
    root: &Path,
    args: &[&str],
    input: Option<&str>,
    timeout: Option<Duration>,
) -> Result<String, AppError> {
    let mut command = hidden_command("git");
    command
        .args(["-c", "core.quotePath=false"])
        .args(args)
        .current_dir(root)
        // Never wait on a terminal prompt nobody can see; credential helpers still show their own windows.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| AppError::Process(format!("failed to run git: {err}")))?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin
            .write_all(input.as_bytes())
            .map_err(|err| AppError::Process(format!("failed to write to git: {err}")))?;
    }
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stream) = stdout.as_mut() {
            let _ = stream.read_to_string(&mut text);
        }
        text
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stream) = stderr.as_mut() {
            let _ = stream.read_to_string(&mut text);
        }
        text
    });

    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(err) => return Err(AppError::Process(format!("failed to wait for git: {err}"))),
        }
        if timeout.is_some_and(|limit| started.elapsed() >= limit) {
            let _ = kill_process_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::Network(format!(
                "git {} 超过 {} 秒没有完成，已停止。检查网络和远程仓库的登录状态后再试。",
                args.first().copied().unwrap_or_default(),
                timeout.map(|limit| limit.as_secs()).unwrap_or_default()
            )));
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    if status.success() {
        return Ok(stdout);
    }
    let detail = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Err(AppError::Git(if detail.is_empty() {
        format!("git {} failed", args.join(" "))
    } else {
        detail
    }))
}

fn has_staged_changes(root: &Path) -> Result<bool, AppError> {
    Ok(!run_git(root, &["diff", "--cached", "--name-only"])?
        .trim()
        .is_empty())
}

/// `origin` when it exists, otherwise the first remote.
fn primary_remote(root: &Path) -> Option<String> {
    let remotes = run_git(root, &["remote"]).ok()?;
    let names = remotes
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    names
        .iter()
        .find(|name| **name == "origin")
        .or(names.first())
        .map(|name| name.to_string())
}

fn current_branch(root: &Path) -> Result<String, AppError> {
    Ok(run_git(root, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string())
}

/// The branch the remote treats as default (`origin/HEAD`), else a local `main` or `master`.
#[tauri::command(async)]
pub(crate) fn git_default_branch(cwd: String) -> Result<Option<String>, AppError> {
    let root = workspace_root(&cwd)?;
    if let Some(remote) = primary_remote(&root) {
        let head = run_git(
            &root,
            &[
                "symbolic-ref",
                "--quiet",
                "--short",
                &format!("refs/remotes/{remote}/HEAD"),
            ],
        );
        if let Some(name) = head.ok().and_then(|head| {
            head.trim()
                .strip_prefix(&format!("{remote}/"))
                .map(str::to_string)
        }) {
            return Ok(Some(name));
        }
    }
    Ok(["main", "master"]
        .into_iter()
        .find(|name| {
            run_git(
                &root,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{name}"),
                ],
            )
            .is_ok()
        })
        .map(str::to_string))
}

/// Commits what is staged, or, with `paths`, exactly those files when nothing
/// is staged (the same rule as an editor's "smart commit"). `new_branch`
/// switches to a new branch first, keeping the working tree as it is.
#[tauri::command(async)]
pub(crate) fn git_commit(
    cwd: String,
    message: String,
    paths: Option<Vec<String>>,
    new_branch: Option<String>,
) -> Result<GitCommitResult, AppError> {
    let message = message.trim();
    if message.is_empty() {
        return Err(AppError::InvalidInput("提交说明不能为空".to_string()));
    }
    let root = workspace_root(&cwd)?;
    let staged = has_staged_changes(&root)?;
    match &paths {
        Some(paths) => {
            validate_git_paths(&cwd, paths)?;
            if staged {
                return Err(AppError::InvalidInput(
                    "暂存区里已经有更改，要提交的内容和对话框里的不一致。关闭后重新打开提交对话框再试。"
                        .to_string(),
                ));
            }
        }
        None if !staged => {
            return Err(AppError::InvalidInput(
                "没有已暂存的更改可以提交".to_string(),
            ));
        }
        None => {}
    }
    if let Some(branch) = new_branch
        .as_deref()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
    {
        run_git(&root, &["check-ref-format", "--branch", branch])
            .map_err(|_| AppError::InvalidInput(format!("“{branch}”不是有效的分支名")))?;
        run_git(&root, &["switch", "--create", branch])?;
    }
    if let Some(paths) = &paths {
        run_git_path_command(&root, &["add", "--all"], paths)?;
    }
    if let Err(error) = run_git_process(&root, &["commit", "--file=-"], Some(message), None) {
        // A rejected commit (a failing hook, say) leaves the index as the dialog found it.
        if let Some(paths) = &paths {
            let _ = run_git_path_command(&root, &["reset", "--quiet"], paths);
        }
        return Err(error);
    }
    let head = run_git(&root, &["log", "-1", "--format=%H%x00%h%x00%s"])?;
    let mut fields = head.trim_end().splitn(3, '\0');
    Ok(GitCommitResult {
        sha: fields.next().unwrap_or_default().to_string(),
        short_sha: fields.next().unwrap_or_default().to_string(),
        subject: fields.next().unwrap_or_default().to_string(),
        branch: current_branch(&root)?,
    })
}

/// Pushes the current branch to its upstream, or publishes it to the primary
/// remote and sets that as its upstream.
#[tauri::command(async)]
pub(crate) fn git_push(cwd: String) -> Result<GitPushResult, AppError> {
    let root = workspace_root(&cwd)?;
    let branch = current_branch(&root)?;
    if branch == "HEAD" {
        return Err(AppError::InvalidInput(
            "当前不在任何分支上（分离的 HEAD）。先切换到一个分支或新建分支，再推送。".to_string(),
        ));
    }
    let configured_remote = run_git(
        &root,
        &["config", "--get", &format!("branch.{branch}.remote")],
    )
    .ok()
    .map(|remote| remote.trim().to_string())
    .filter(|remote| !remote.is_empty());
    let (remote, set_upstream, result) = match configured_remote {
        Some(remote) => {
            let result = run_git_process(&root, &["push"], None, Some(PUSH_TIMEOUT));
            (remote, false, result)
        }
        None => {
            let remote = primary_remote(&root).ok_or_else(|| {
                AppError::InvalidInput("这个仓库还没有配置远程仓库，无法推送。".to_string())
            })?;
            let result = run_git_process(
                &root,
                &["push", "--set-upstream", &remote, &branch],
                None,
                Some(PUSH_TIMEOUT),
            );
            (remote, true, result)
        }
    };
    result.map_err(explain_push_error)?;
    Ok(GitPushResult {
        remote,
        branch,
        set_upstream,
    })
}

fn explain_push_error(error: AppError) -> AppError {
    let AppError::Git(detail) = &error else {
        return error;
    };
    if detail.contains("[rejected]")
        || detail.contains("non-fast-forward")
        || detail.contains("fetch first")
    {
        return AppError::Git(format!(
            "远程分支有本地没有的提交，先拉取合并后再推送。\n\n{detail}"
        ));
    }
    error
}

/// The prompt for drafting a commit message for what `git_commit` would commit
/// with the same arguments: the rules, the recent subjects and the diff. The
/// frontend sends it to the Harness Host's `llm.complete` (P6a).
#[tauri::command(async)]
pub(crate) fn git_commit_message_prompt(
    cwd: String,
    paths: Option<Vec<String>>,
) -> Result<String, AppError> {
    let root = workspace_root(&cwd)?;
    let changes = describe_changes(&root, paths.as_deref())?;
    if changes.trim().is_empty() {
        return Err(AppError::InvalidInput("没有可以描述的改动".to_string()));
    }
    let recent = run_git(&root, &["log", "-8", "--format=%s"]).unwrap_or_default();
    Ok(commit_message_input(&recent, &changes))
}

/// The diff (and new files' contents) of what the commit would contain.
fn describe_changes(root: &Path, paths: Option<&[String]>) -> Result<String, AppError> {
    let mut text = String::new();
    match paths {
        None => {
            text.push_str(&run_git(
                root,
                &["diff", "--cached", "--no-ext-diff", "--stat"],
            )?);
            text.push('\n');
            text.push_str(&run_git(
                root,
                &["diff", "--cached", "--no-ext-diff", "--unified=2"],
            )?);
        }
        Some(paths) => {
            let with_paths = |leading: &[&str]| {
                let mut args = leading.to_vec();
                args.push("--");
                args.extend(paths.iter().map(String::as_str));
                run_git(root, &args)
            };
            text.push_str(&with_paths(&["diff", "--no-ext-diff", "--stat"])?);
            text.push('\n');
            text.push_str(&with_paths(&["diff", "--no-ext-diff", "--unified=2"])?);
            let untracked = with_paths(&["ls-files", "--others", "--exclude-standard"])?;
            for path in untracked.lines().filter(|line| !line.trim().is_empty()) {
                text.push_str(&format!("\n新文件 {path}\n"));
                text.push_str(&preview_new_file(&root.join(path)));
            }
        }
    }
    Ok(truncate_for_prompt(text, MESSAGE_DIFF_LIMIT))
}

fn preview_new_file(path: &Path) -> String {
    let Ok(bytes) = fs::read(path) else {
        return "（无法读取）\n".to_string();
    };
    if bytes.iter().take(8 * 1024).any(|byte| *byte == 0) {
        return "（二进制文件）\n".to_string();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut preview = truncate_for_prompt(text.into_owned(), UNTRACKED_PREVIEW_LIMIT);
    if !preview.ends_with('\n') {
        preview.push('\n');
    }
    preview
}

fn truncate_for_prompt(mut text: String, limit: usize) -> String {
    if text.len() <= limit {
        return text;
    }
    let mut cut = limit;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    text.push_str("\n…（后面的内容过长，已省略）\n");
    text
}

fn commit_message_input(recent_subjects: &str, changes: &str) -> String {
    let recent = recent_subjects
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>();
    let style = if recent.is_empty() {
        "- 这个仓库还没有提交历史：使用 Conventional Commits 格式，例如 \"fix: …\"。".to_string()
    } else {
        format!(
            "- 沿用这个仓库最近提交的语言和格式：\n{}",
            recent.join("\n")
        )
    };
    format!(
        "为下面的 Git 改动写一条提交说明。\n\
         - 第一行是摘要，不超过 72 个字符，说清楚改了什么。\n\
         - 改动不止一处时，空一行后用几行正文说明改了什么、为什么改。\n\
         - 只输出提交说明本身：不要解释，不要加引号或代码块。\n\
         {style}\n\n\
         ## 改动\n\n{changes}\n\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "pid-desktop-{label}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("temporary directory should be created");
        directory
    }

    fn repository() -> PathBuf {
        let directory = temp_dir("commit");
        run_git(&directory, &["init", "--initial-branch=main"])
            .expect("git repository should initialize");
        for (key, value) in [
            ("user.email", "pid-desktop@example.invalid"),
            ("user.name", "PIDesktop Tests"),
            ("commit.gpgsign", "false"),
        ] {
            run_git(&directory, &["config", key, value]).expect("test identity should be set");
        }
        fs::write(directory.join("tracked.txt"), "first\n")
            .expect("tracked file should be written");
        run_git(&directory, &["add", "tracked.txt"]).expect("file should stage");
        run_git(&directory, &["commit", "-m", "initial"]).expect("initial commit should succeed");
        directory
    }

    fn cwd(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    #[test]
    fn commits_only_the_selected_files_when_nothing_is_staged() {
        let directory = repository();
        fs::write(directory.join("tracked.txt"), "second\n").expect("tracked file should change");
        fs::write(directory.join("new.txt"), "new\n").expect("new file should be written");
        fs::write(directory.join("left.txt"), "left out\n")
            .expect("left-out file should be written");

        let result = git_commit(
            cwd(&directory),
            "  feat: pick files\n".to_string(),
            Some(vec!["tracked.txt".to_string(), "new.txt".to_string()]),
            None,
        )
        .expect("selected files should commit");
        assert_eq!(result.subject, "feat: pick files");
        assert_eq!(result.branch, "main");
        let committed = run_git(&directory, &["show", "--name-only", "--format=", "HEAD"])
            .expect("commit should be readable");
        assert_eq!(
            committed
                .lines()
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>(),
            ["new.txt", "tracked.txt"]
        );
        let status = run_git(&directory, &["status", "--porcelain"]).expect("status should read");
        assert_eq!(status.trim(), "?? left.txt");
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn commits_the_index_as_staged_and_can_start_a_branch() {
        let directory = repository();
        fs::write(directory.join("tracked.txt"), "staged\n").expect("tracked file should change");
        run_git(&directory, &["add", "tracked.txt"]).expect("change should stage");
        fs::write(directory.join("tracked.txt"), "staged\nand more\n")
            .expect("worktree should change again");

        let error = git_commit(
            cwd(&directory),
            "x".to_string(),
            Some(vec!["tracked.txt".to_string()]),
            None,
        )
        .expect_err("a file list must not mix with a staged index");
        assert!(matches!(error, AppError::InvalidInput(_)));

        let result = git_commit(
            cwd(&directory),
            "fix: staged part".to_string(),
            None,
            Some("topic/staged".to_string()),
        )
        .expect("staged changes should commit");
        assert_eq!(result.branch, "topic/staged");
        let committed =
            run_git(&directory, &["show", "HEAD:tracked.txt"]).expect("blob should read");
        assert_eq!(committed, "staged\n");
        let status = run_git(&directory, &["status", "--porcelain"]).expect("status should read");
        assert_eq!(status.trim(), "M tracked.txt");
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn refuses_an_empty_message_and_an_empty_index() {
        let directory = repository();
        assert!(git_commit(cwd(&directory), "   ".to_string(), None, None).is_err());
        assert!(git_commit(cwd(&directory), "msg".to_string(), None, None).is_err());
        fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn publishes_a_branch_then_pushes_to_its_upstream() {
        let directory = repository();
        let remote = temp_dir("remote");
        run_git(&remote, &["init", "--bare"]).expect("bare remote should initialize");
        run_git(&directory, &["remote", "add", "origin", &cwd(&remote)])
            .expect("remote should be added");

        let first = git_push(cwd(&directory)).expect("branch should publish");
        assert!(first.set_upstream);
        assert_eq!(
            (first.remote.as_str(), first.branch.as_str()),
            ("origin", "main")
        );
        assert_eq!(
            git_default_branch(cwd(&directory))
                .expect("default branch should resolve")
                .as_deref(),
            Some("main")
        );

        fs::write(directory.join("tracked.txt"), "pushed\n").expect("tracked file should change");
        git_commit(
            cwd(&directory),
            "second".to_string(),
            Some(vec!["tracked.txt".to_string()]),
            None,
        )
        .expect("second commit should succeed");
        let header = run_git(&directory, &["status", "--porcelain=v1", "--branch"])
            .expect("status should read");
        assert_eq!(
            parse_branch_header(header.lines().next().unwrap_or_default()).ahead,
            1
        );

        let second = git_push(cwd(&directory)).expect("upstream push should succeed");
        assert!(!second.set_upstream);
        let header = run_git(&directory, &["status", "--porcelain=v1", "--branch"])
            .expect("status should read");
        assert_eq!(
            parse_branch_header(header.lines().next().unwrap_or_default()).ahead,
            0
        );
        fs::remove_dir_all(directory).ok();
        fs::remove_dir_all(remote).ok();
    }

    #[test]
    fn keeps_the_prompt_within_its_limit_on_a_char_boundary() {
        let text = truncate_for_prompt("改".repeat(100), 10);
        assert!(text.starts_with("改改改"));
        assert!(text.contains("已省略"));
    }
}
