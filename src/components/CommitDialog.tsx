/**
 * Commit from the app: pick files (or take what is staged), write or generate
 * a message, optionally move to a new branch, and push afterwards.
 *
 * Staged changes win, as in an editor's "smart commit": when the index has
 * anything, exactly that is committed and the file list is read-only. With an
 * empty index every changed file is listed and the checked ones are committed.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, LoaderCircle, Sparkles, TriangleAlert, X } from "lucide-react";
import { describeError } from "../lib/errors";
import { perFileDiffStats } from "../lib/gitDiffStats";
import { pi } from "../lib/pi";
import type { GitCommitResult, GitPushResult, GitSnapshot } from "../types";

export interface CommitOutcome {
  commit: GitCommitResult;
  /** Present when a push was requested. */
  push?: { result: GitPushResult } | { error: string };
}

interface CommitDialogProps {
  cwd: string;
  git: GitSnapshot;
  /** Starts with 提交后推送 checked. */
  initialPush: boolean;
  model: { provider: string; id: string } | null;
  /** Pi is still working, so files may change under the dialog. */
  agentRunning: boolean;
  onClose: () => void;
  onDone: (outcome: CommitOutcome) => void;
}

type Phase = "idle" | "generating" | "committing" | "pushing";

const STATUS_LABELS: Record<string, string> = { M: "修改", A: "新增", D: "删除", R: "重命名", C: "复制", U: "冲突", "?": "新文件" };

function statusLabel(status: string): string {
  return STATUS_LABELS[status.replace(/[^MADRCU?]/g, "").charAt(0)] ?? status;
}

export function CommitDialog({ cwd, git, initialPush, model, agentRunning, onClose, onDone }: CommitDialogProps) {
  const stagedMode = git.files.some((file) => file.staged);
  const listed = useMemo(() => (stagedMode ? git.files.filter((file) => file.staged) : git.files), [git.files, stagedMode]);
  const unstagedLeftOut = stagedMode ? git.files.filter((file) => !file.staged).length : 0;
  const stats = useMemo(() => perFileDiffStats(git.diff), [git.diff]);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState("");
  const [push, setPush] = useState(initialPush && Boolean(git.sync?.hasRemote));
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [useNewBranch, setUseNewBranch] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const busy = phase !== "idle";
  const branch = git.branch ?? "HEAD";
  const onDefaultBranch = Boolean(defaultBranch) && branch === defaultBranch;
  const selectedPaths = listed.map((file) => file.path).filter((path) => !excluded.has(path));
  const targetBranch = useNewBranch ? newBranch.trim() : branch;
  const canSubmit = !busy
    && selectedPaths.length > 0
    && (!useNewBranch || Boolean(newBranch.trim()));

  useEffect(() => {
    let cancelled = false;
    void pi.gitDefaultBranch(cwd).then((name) => { if (!cancelled) setDefaultBranch(name); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [cwd]);

  useEffect(() => { messageRef.current?.focus(); }, []);

  // With an empty index the commit is exactly the checked files; with a staged one, the index.
  const commitPaths = stagedMode ? undefined : selectedPaths;

  const generate = async (): Promise<string | null> => {
    setPhase("generating");
    setError("");
    try {
      const text = await pi.gitGenerateCommitMessage(cwd, { paths: commitPaths, provider: model?.provider, model: model?.id });
      setMessage(text);
      return text;
    } catch (generateError) {
      setError(`没能生成提交说明：${describeError(generateError)}`);
      return null;
    } finally {
      setPhase("idle");
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    let text = message.trim();
    if (!text) {
      const generated = await generate();
      if (!generated) return;
      text = generated;
    }
    setError("");
    setPhase("committing");
    let commit: GitCommitResult;
    try {
      commit = await pi.gitCommit(cwd, text, { paths: commitPaths, newBranch: useNewBranch ? newBranch.trim() : undefined });
    } catch (commitError) {
      setError(describeError(commitError));
      setPhase("idle");
      return;
    }
    if (!push) {
      onDone({ commit });
      return;
    }
    setPhase("pushing");
    try {
      onDone({ commit, push: { result: await pi.gitPush(cwd) } });
    } catch (pushError) {
      onDone({ commit, push: { error: describeError(pushError) } });
    }
  };

  const toggle = (path: string) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const allChecked = excluded.size === 0;

  const submitLabel = phase === "generating"
    ? "正在生成提交说明…"
    : phase === "committing"
      ? "正在提交…"
      : phase === "pushing"
        ? "正在推送…"
        : push
          ? `提交并推送到 ${targetBranch || "新分支"}`
          : `提交 ${selectedPaths.length} 个文件`;

  return (
    <div
      className="commit-dialog-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <div
        className="commit-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="提交更改"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!busy) onClose();
          } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        <header>
          <strong>提交更改</strong>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} title="关闭 (Esc)" aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="commit-dialog-body">
          <div className="commit-dialog-branch">
            <GitBranch size={14} />
            <span>分支</span>
            <strong title={branch}>{branch}</strong>
          </div>
          {onDefaultBranch && (
            <div className="commit-dialog-default">
              <p><TriangleAlert size={14} />你在默认分支 {defaultBranch} 上{push ? "，提交会直接推送到它" : ""}。</p>
              <label className="commit-dialog-check">
                <input type="checkbox" checked={useNewBranch} disabled={busy} onChange={(event) => setUseNewBranch(event.target.checked)} />
                <span>改为提交到新分支</span>
              </label>
              {useNewBranch && (
                <input
                  className="commit-dialog-input"
                  value={newBranch}
                  disabled={busy}
                  onChange={(event) => setNewBranch(event.target.value)}
                  placeholder="新分支名，例如 fix/login-timeout"
                  aria-label="新分支名"
                />
              )}
            </div>
          )}

          <div className="commit-dialog-files">
            <div className="commit-dialog-files-head">
              {stagedMode ? (
                <span>提交已暂存的 {listed.length} 个文件{unstagedLeftOut > 0 ? ` · 另有 ${unstagedLeftOut} 个文件的改动未暂存，不会提交` : ""}</span>
              ) : (
                <label className="commit-dialog-check">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    disabled={busy}
                    onChange={() => setExcluded(allChecked ? new Set(listed.map((file) => file.path)) : new Set())}
                  />
                  <span>文件 · 已选 {selectedPaths.length}/{listed.length}</span>
                </label>
              )}
            </div>
            <ul>
              {listed.map((file) => {
                const lineStats = stats.get(file.path);
                const partlyStaged = stagedMode && file.unstaged;
                return (
                  <li key={file.path} className={excluded.has(file.path) ? "excluded" : undefined}>
                    {!stagedMode && (
                      <input type="checkbox" checked={!excluded.has(file.path)} disabled={busy} onChange={() => toggle(file.path)} aria-label={`提交 ${file.path}`} />
                    )}
                    <em className={`commit-file-status status-${file.untracked ? "new" : file.status.charAt(0).toLowerCase()}`}>{statusLabel(file.untracked ? "?" : file.status)}</em>
                    <span className="commit-file-path" title={file.path}>{file.path}</span>
                    {partlyStaged ? (
                      <small>部分暂存</small>
                    ) : lineStats && (lineStats.add > 0 || lineStats.del > 0) ? (
                      <small>
                        {lineStats.add > 0 && <b className="add">+{lineStats.add}</b>}
                        {lineStats.del > 0 && <b className="del">−{lineStats.del}</b>}
                      </small>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="commit-dialog-message">
            <div className="commit-dialog-message-head">
              <span>提交说明</span>
              <button type="button" disabled={busy || selectedPaths.length === 0} onClick={() => void generate()} title="让 Pi 根据选中的改动写提交说明">
                {phase === "generating" ? <LoaderCircle size={13} className="spin" /> : <Sparkles size={13} />}
                <span>生成</span>
              </button>
            </div>
            <textarea
              ref={messageRef}
              value={message}
              disabled={busy}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="留空则由 Pi 根据改动生成"
              rows={5}
            />
          </div>

          {agentRunning && <p className="commit-dialog-hint">Pi 还在运行，文件可能还会变化。</p>}
          {error && <pre className="commit-dialog-error" role="alert">{error}</pre>}
        </div>

        <footer>
          <label className="commit-dialog-check" title={git.sync?.hasRemote ? undefined : "这个仓库还没有配置远程仓库"}>
            <input type="checkbox" checked={push} disabled={busy || !git.sync?.hasRemote} onChange={(event) => setPush(event.target.checked)} />
            <span>提交后推送</span>
          </label>
          <span className="commit-dialog-spacer" />
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="primary-button" onClick={() => void submit()} disabled={!canSubmit} title="Ctrl+Enter">
            {busy && <LoaderCircle size={14} className="spin" />}
            <span>{submitLabel}</span>
          </button>
        </footer>
      </div>
    </div>
  );
}
