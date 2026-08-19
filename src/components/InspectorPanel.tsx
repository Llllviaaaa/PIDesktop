import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ExternalLink,
  FileDiff,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Globe2,
  Laptop,
  ListTree,
  LoaderCircle,
  MonitorCog,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SearchCheck,
  Sparkles,
  Square,
  Undo2,
  X,
} from "lucide-react";
import { deriveEnvSources, summarizeToolAgents } from "../lib/envSources";
import { parseDiffRows } from "../lib/diffView";
import { aggregateDiffStats, perFileDiffStats } from "../lib/gitDiffStats";
import { pi } from "../lib/pi";
import type {
  BrowserState,
  ComputerState,
  GitBranchInfo,
  GitSnapshot,
  SessionTreeNodeView,
  UiMessage,
  WorktreeInfo,
} from "../types";

export type InspectorTab = "changes" | "tree" | "terminal" | "browser" | "computer" | "logs" | "compare" | "agents";

type MenuKind = "local" | "branch" | "sources" | null;

/** GitHub mark for the 比较分支 row (lucide-react ≥1.x removed brand icons, so inline the path). */
function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.66.5 12.03c0 5.1 3.29 9.42 7.86 10.95.58.11.79-.25.79-.56 0-.27-.01-1.18-.02-2.13-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.26.72-1.55-2.55-.29-5.24-1.28-5.24-5.71 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.11 3.06.74.81 1.19 1.84 1.19 3.1 0 4.44-2.7 5.42-5.27 5.7.41.36.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.67.8.55A11.53 11.53 0 0 0 23.5 12.03C23.5 5.66 18.35.5 12 .5Z" />
    </svg>
  );
}

function PiMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="env-pi-mark">
      <circle cx="5" cy="5" r="2.15" fill="#6366f1" />
      <circle cx="11" cy="5" r="2.15" fill="#818cf8" />
      <circle cx="5" cy="11" r="2.15" fill="#a5b4fc" />
      <circle cx="11" cy="11" r="2.15" fill="#c7d2fe" />
    </svg>
  );
}

function AgentMarks({ running, completed }: { running: number; completed: number }) {
  const count = Math.min(2, Math.max(running > 0 ? 1 : 0, completed > 0 ? 1 : 0) + (running > 1 || completed > 1 ? 1 : 0));
  if (count === 0) return <span className="env-agent-marks empty" aria-hidden />;
  return (
    <span className="env-agent-marks" aria-hidden>
      <span className="env-agent-mark tone-orange" />
      {count > 1 && <span className="env-agent-mark tone-purple" />}
    </span>
  );
}

/** Codex-style inline 环境信息 right column with real Local/branch/changes/sources actions. */
export function InspectorPanel({
  initialTab,
  openView = null,
  git,
  cwd,
  messages,
  environment,
  terminal,
  browser,
  computer,
  logs,
  sessionTree,
  sessionTreeLoading,
  sessionTreeError,
  sessionTreeLeafId,
  isStreaming,
  onRefreshGit,
  onReview,
  onReviewComment,
  onCommitOrPush,
  onRestoreFiles,
  onEnvironmentChange,
  onSwitchWorkspace,
  onRunCommand,
  onAbortCommand,
  onRefreshTree,
  onContinueFromNode,
  docked = false,
  onClose,
  onError,
}: {
  initialTab: InspectorTab;
  /** When set, open this sub-view instead of the 环境信息 home list. */
  openView?: InspectorTab | null;
  /** Right-column dock (审阅 / 浏览器), not the floating 环境信息 card. */
  docked?: boolean;
  onClose?: () => void;
  onError?: (message: string) => void;
  git: GitSnapshot | null;
  cwd: string;
  messages: UiMessage[];
  environment: "local" | "worktree";
  terminal: {
    running: boolean;
    command: string;
    output: string;
    exitCode?: number;
    history: Array<{ command: string; output: string; exitCode?: number }>;
  };
  browser: BrowserState | null;
  computer: ComputerState | null;
  logs: string[];
  sessionTree: SessionTreeNodeView[];
  sessionTreeLoading: boolean;
  sessionTreeError: string | null;
  sessionTreeLeafId: string | null;
  isStreaming: boolean;
  onRefreshGit: () => void;
  onReview: () => void;
  onReviewComment?: (path: string, line: number | null, comment: string) => void;
  onCommitOrPush: () => void;
  onRestoreFiles: (paths?: string[]) => void;
  onEnvironmentChange: (environment: "local" | "worktree") => void;
  onSwitchWorkspace: (path: string) => void;
  onRunCommand: (command: string, excludeFromContext?: boolean) => void;
  onAbortCommand: () => void;
  onRefreshTree: () => void;
  onContinueFromNode: (entryId: string) => void;
}) {
  const homeTabs: InspectorTab[] = ["changes", "tree", "terminal", "browser", "computer", "logs", "compare", "agents"];
  const [view, setView] = useState<InspectorTab | null>(
    openView ?? (initialTab === "changes" ? null : homeTabs.includes(initialTab) ? initialTab : null),
  );
  const [menu, setMenu] = useState<MenuKind>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [branchBusy, setBranchBusy] = useState(false);
  const [compareBase, setCompareBase] = useState<string>("");
  const [compareSnap, setCompareSnap] = useState<GitSnapshot | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [commentTarget, setCommentTarget] = useState<{ row: number; line: number | null } | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [command, setCommand] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (view === "tree") onRefreshTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tab entry only
  }, [view]);

  const requestedGitCwd = useRef("");
  useEffect(() => {
    if (git || !cwd || requestedGitCwd.current === cwd) return;
    requestedGitCwd.current = cwd;
    onRefreshGit();
  }, [cwd, git, onRefreshGit]);

  useEffect(() => {
    setView(openView ?? (initialTab === "changes" ? null : initialTab));
    setSelectedFile(null);
    setCommentTarget(null);
    setCommentDraft("");
    setMenu(null);
  }, [initialTab, openView]);

  useEffect(() => {
    if (!cwd) return;
    void pi.listWorktrees(cwd).then(setWorktrees).catch(() => setWorktrees([]));
  }, [cwd]);

  useEffect(() => {
    if (!menu) return;
    const onDoc = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menu]);

  const diffStats = useMemo(() => aggregateDiffStats(git?.diff), [git?.diff]);
  const fileStats = useMemo(() => normalizeStatMap(perFileDiffStats(git?.diff)), [git?.diff]);
  const compareStats = useMemo(() => aggregateDiffStats(compareSnap?.diff), [compareSnap?.diff]);
  const compareFileStats = useMemo(() => normalizeStatMap(perFileDiffStats(compareSnap?.diff)), [compareSnap?.diff]);
  const branch = git?.isRepository ? (git.branch || "游离 HEAD") : "非 Git 仓库";
  const hasChanges = (git?.files.length ?? 0) > 0;
  const sources = useMemo(() => deriveEnvSources(messages), [messages]);
  const agents = useMemo(() => summarizeToolAgents(messages), [messages]);
  const isWorktreeCwd = useMemo(
    () => worktrees.some((item) => !item.isMain && samePath(item.path, cwd)),
    [worktrees, cwd],
  );
  const envLabel = environment === "worktree" || isWorktreeCwd ? "Worktree" : "本地";

  const selectedFileName = selectedFile
    ? selectedFile.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || selectedFile
    : null;
  const title =
    view === null ? "环境信息"
      : view === "changes" ? (selectedFileName ?? "变更")
        : view === "compare" ? "比较分支"
          : view === "agents" ? "子智能体"
            : view === "tree" ? "会话树"
              : view === "terminal" ? "终端"
                : view === "browser" ? "浏览器"
                  : view === "computer" ? "计算机"
                    : "日志";

  const openLocalMenu = async () => {
    if (cwd) {
      try { setWorktrees(await pi.listWorktrees(cwd)); } catch { /* ignore */ }
    }
    setMenu((current) => (current === "local" ? null : "local"));
  };

  const openBranchMenu = async () => {
    if (!git?.isRepository || !cwd) return;
    try {
      setBranches(await pi.gitListBranches(cwd));
    } catch {
      setBranches([]);
    }
    setMenu((current) => (current === "branch" ? null : "branch"));
  };

  const switchBranch = async (name: string) => {
    if (!cwd || branchBusy) return;
    setBranchBusy(true);
    try {
      await pi.gitCheckoutBranch(cwd, name);
      setMenu(null);
      onRefreshGit();
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      setBranchBusy(false);
    }
  };

  const chooseLocal = () => {
    setMenu(null);
    onEnvironmentChange("local");
    const main = worktrees.find((item) => item.isMain);
    if (main && !samePath(main.path, cwd)) onSwitchWorkspace(main.path);
  };

  const chooseWorktree = async () => {
    setMenu(null);
    onEnvironmentChange("worktree");
    const existing = worktrees.find((item) => !item.isMain);
    if (existing) {
      onSwitchWorkspace(existing.path);
      return;
    }
    if (!cwd) return;
    try {
      const created = await pi.createWorktree(cwd, git?.branch);
      onSwitchWorkspace(created.path);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    }
  };

  const openCompare = async () => {
    setView("compare");
    setCompareSnap(null);
    if (!cwd || !git?.isRepository) return;
    try {
      const list = await pi.gitListBranches(cwd);
      setBranches(list);
      const fallback = list.find((item) => !item.current && (item.name === "main" || item.name === "master"))
        || list.find((item) => !item.current);
      const base = fallback?.name || "";
      setCompareBase(base);
      if (base) {
        setCompareLoading(true);
        setCompareSnap(await pi.gitCompare(cwd, base));
      }
    } catch {
      setBranches([]);
    } finally {
      setCompareLoading(false);
    }
  };

  const runCompare = async (base: string) => {
    setCompareBase(base);
    if (!cwd || !base) return;
    setCompareLoading(true);
    try {
      setCompareSnap(await pi.gitCompare(cwd, base));
    } catch (error) {
      setCompareSnap(null);
      onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      setCompareLoading(false);
    }
  };

  const selectedDiff = useMemo(() => {
    if (!selectedFile || !git?.diff) return "";
    return extractFileDiff(git.diff, selectedFile);
  }, [git?.diff, selectedFile]);

  const selectedStats = selectedFile ? fileStats.get(normalizePath(selectedFile)) : undefined;

  const diffRows = useMemo(() => parseDiffRows(selectedDiff), [selectedDiff]);

  return (
    <aside
      className={`inspector-panel env-panel${docked ? " workspace-dock-panel" : ""}`}
      ref={menuRef}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !menu) return;
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
      }}
    >
      <header className="inspector-header env-header">
        <div className="env-header-left">
          {view !== null && (!docked || Boolean(selectedFile)) && (
            <button
              type="button"
              className="icon-button env-back"
              onClick={() => {
                // File diff sub-view goes back to the changes list first, then to 环境信息.
                if (view === "changes" && selectedFile) {
                  setSelectedFile(null);
                  return;
                }
                if (docked) {
                  onClose?.();
                  return;
                }
                setView(null);
                setSelectedFile(null);
              }}
              title={view === "changes" && selectedFile ? "返回变更列表" : docked ? "关闭" : "返回环境信息"}
            >
              <ChevronLeft size={16} strokeWidth={1.75} />
            </button>
          )}
          <strong className="env-title">{docked && view === "changes" ? "审阅" : title}</strong>
        </div>
        <div className="env-header-actions">
          {view === null && !docked && (
            <div className="env-menu-anchor env-source-menu-anchor">
              <button
                type="button"
                className="icon-button env-close"
                title="来源"
                aria-label="来源"
                aria-haspopup="menu"
                aria-expanded={menu === "sources"}
                onClick={() => setMenu((current) => current === "sources" ? null : "sources")}
              >
                <Plus size={15} strokeWidth={1.75} />
              </button>
              {menu === "sources" && (
                <div className="env-menu env-source-menu" role="menu">
                  <button type="button" className="env-menu-item" role="menuitem" onClick={() => { setMenu(null); setView("tree"); }}>
                    <ListTree size={15} />
                    <span>查看全部来源</span>
                  </button>
                  {browser && (
                    <button type="button" className="env-menu-item" role="menuitem" onClick={() => { setMenu(null); setView("browser"); }}>
                      <Globe2 size={15} />
                      <span>浏览器来源</span>
                    </button>
                  )}
                  {computer && (
                    <button type="button" className="env-menu-item" role="menuitem" onClick={() => { setMenu(null); setView("computer"); }}>
                      <MonitorCog size={15} />
                      <span>桌面来源</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {docked && (
            <button type="button" className="icon-button env-close" title="关闭" onClick={onClose}>
              <X size={14} strokeWidth={1.7} />
            </button>
          )}
        </div>
      </header>

      {view === null && (
        <div className="inspector-content env-home">
          <section className="env-section">
            <button type="button" className="env-row" onClick={() => { setSelectedFile(null); setView("changes"); }}>
              <FileDiff size={16} strokeWidth={1.7} />
              <span className="env-row-label">变更</span>
              <span className="env-row-meta">
                {hasChanges ? (
                  diffStats.add > 0 || diffStats.del > 0 ? (
                    <>
                      {diffStats.add > 0 && <em className="diff-add-stat">+{diffStats.add.toLocaleString()}</em>}
                      {diffStats.del > 0 && <em className="diff-del-stat">-{diffStats.del.toLocaleString()}</em>}
                    </>
                  ) : (
                    <em className="muted">{git!.files.length} 文件</em>
                  )
                ) : (
                  <em className="muted">无</em>
                )}
              </span>
            </button>

            <div className="env-menu-anchor">
              <button type="button" className="env-row" onClick={() => void openLocalMenu()} title={cwd || "本地工作区"}>
                <Laptop size={16} strokeWidth={1.7} />
                <span className="env-row-label">{envLabel}</span>
                <span className="env-row-meta">
                  <ChevronDown size={14} strokeWidth={1.7} className="env-chevron" />
                </span>
              </button>
              {menu === "local" && (
                <div className="env-menu">
                  <button type="button" className="env-menu-item" onClick={chooseLocal}>
                    <Laptop size={15} />
                    <span>本地</span>
                    {envLabel === "本地" && <Check size={14} className="env-menu-check" />}
                  </button>
                  <button type="button" className="env-menu-item" onClick={() => void chooseWorktree()}>
                    <GitBranch size={15} />
                    <span>Worktree</span>
                    {envLabel === "Worktree" && <Check size={14} className="env-menu-check" />}
                  </button>
                </div>
              )}
            </div>

            <div className="env-menu-anchor">
              <button
                type="button"
                className="env-row"
                disabled={!git?.isRepository}
                onClick={() => void openBranchMenu()}
                title={branch}
              >
                <GitBranch size={16} strokeWidth={1.7} />
                <span className="env-row-label">{branch}</span>
                <span className="env-row-meta">
                  <ChevronDown size={14} strokeWidth={1.7} className="env-chevron" />
                </span>
              </button>
              {menu === "branch" && (
                <div className="env-menu env-menu-scroll">
                  {branches.length === 0 ? (
                    <div className="env-menu-empty">没有本地分支</div>
                  ) : branches.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      className="env-menu-item"
                      disabled={branchBusy || item.current}
                      onClick={() => void switchBranch(item.name)}
                    >
                      <GitBranch size={15} />
                      <span>{item.name}</span>
                      {item.current && <Check size={14} className="env-menu-check" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              className="env-row"
              disabled={!git?.isRepository}
              onClick={() => {
                onCommitOrPush();
                if (!docked) onClose?.();
              }}
              title="让 Pi 协助提交或推送"
            >
              <GitCommitHorizontal size={16} strokeWidth={1.7} />
              <span className="env-row-label">提交或推送</span>
            </button>

            <div className="env-row static muted-row">
              <GitPullRequest size={16} strokeWidth={1.7} />
              <span className="env-row-label">无法获取拉取请求状态</span>
            </div>

            <button
              type="button"
              className="env-row"
              disabled={!git?.isRepository}
              onClick={() => void openCompare()}
              title="与其他分支比较"
            >
              <GithubMark size={16} />
              <span className="env-row-label">比较分支</span>
              <span className="env-row-meta">
                <ExternalLink size={13} strokeWidth={1.7} className="env-chevron" />
              </span>
            </button>
          </section>

          <section className="env-section">
            <div className="env-section-label">子智能体</div>
            <button type="button" className="env-row" onClick={() => setView("agents")}>
              <AgentMarks running={agents.running + (isStreaming ? 1 : 0)} completed={agents.completed} />
              <span className="env-row-label">
                {agents.running > 0 ? `${agents.running} 个运行中` : isStreaming ? "1 个运行中" : "无运行中"}
              </span>
              {(agents.completed > 0 || agents.running > 0) && (
                <span className="env-row-meta">
                  <em className="muted">{agents.completed} 完成</em>
                </span>
              )}
            </button>
          </section>

          <section className="env-section">
            <div className="env-section-label">来源</div>
            {sources.length === 0 ? (
              <div className="env-row static muted-row">
                <Sparkles size={16} strokeWidth={1.7} />
                <span className="env-row-label">对话开始后显示引用</span>
              </div>
            ) : (
              sources.slice(0, 3).map((source) => (
                <div key={source.id} className={`env-row static ${source.kind === "pi" ? "env-row-brand" : ""}`} title={source.detail || source.label}>
                  {source.kind === "pi" ? <PiMark />
                    : source.kind === "file" ? <FileText size={16} strokeWidth={1.7} />
                      : source.kind === "web" || source.kind === "browser" ? <Globe2 size={16} strokeWidth={1.7} />
                        : source.kind === "search" ? <Search size={16} strokeWidth={1.7} />
                          : <Sparkles size={16} strokeWidth={1.7} />}
                  <span className={`env-row-label ${source.kind === "pi" || source.kind === "search" ? "brand" : ""}`}>{source.label}</span>
                </div>
              ))
            )}
            <button type="button" className="env-row quiet-link" onClick={() => setView("tree")}>
              <ListTree size={16} strokeWidth={1.7} />
              <span className="env-row-label">查看全部</span>
            </button>
            {browser && (
              <button type="button" className="env-row" onClick={() => setView("browser")} title={browser.url}>
                <Globe2 size={16} strokeWidth={1.7} />
                <span className="env-row-label">{browser.title || browser.url}</span>
              </button>
            )}
            {computer && (
              <button type="button" className="env-row" onClick={() => setView("computer")}>
                <MonitorCog size={16} strokeWidth={1.7} />
                <span className="env-row-label">桌面 {computer.width}×{computer.height}</span>
              </button>
            )}
          </section>
        </div>
      )}

      {view === "changes" && !selectedFile && (
        <div className="inspector-content changes-panel">
          <div className="changes-summary">
            <span>
              <FileDiff size={15} />
              {hasChanges ? (
                <>
                  {diffStats.add > 0 && <em className="diff-add-stat">+{diffStats.add.toLocaleString()}</em>}
                  {diffStats.del > 0 && <em className="diff-del-stat">-{diffStats.del.toLocaleString()}</em>}
                </>
              ) : (git?.isRepository ? "无未提交更改" : "不是 Git 仓库")}
            </span>
            <div className="changes-actions">
              <button className="secondary-button compact" disabled={!hasChanges} onClick={() => onRestoreFiles()} title="撤销全部本地更改">
                <Undo2 size={13} /> 撤销
              </button>
              <button className="secondary-button compact" disabled={!hasChanges} onClick={onReview} title="让 Pi 审查当前差异">
                <SearchCheck size={13} /> 审核
              </button>
              <button className="icon-button" onClick={onRefreshGit} title="刷新更改"><RefreshCw size={14} /></button>
            </div>
          </div>
          {hasChanges ? (
            <div className="changed-file-list env-file-list">
              {git!.files.map((file) => {
                const stats = fileStats.get(normalizePath(file.path));
                return (
                  <button
                    key={`${file.status}-${file.path}`}
                    type="button"
                    className="env-file-row"
                    title={`${file.path} · 查看差异`}
                    onClick={() => setSelectedFile(file.path)}
                  >
                    <span className={`git-status status-${file.status.trim().charAt(0).toLowerCase() || "u"}`}>{file.status || "?"}</span>
                    <span className="env-file-path">{file.path}</span>
                    <span className="env-file-stats">
                      {stats && stats.add > 0 && <em className="diff-add-stat">+{stats.add}</em>}
                      {stats && stats.del > 0 && <em className="diff-del-stat">-{stats.del}</em>}
                    </span>
                    <span
                      className="env-file-restore"
                      title="撤销此文件"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRestoreFiles([file.path]);
                      }}
                    >
                      <RotateCcw size={12} />
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="panel-empty">{git?.isRepository ? "工作区没有未提交更改" : "打开 Git 工作区以检查更改"}</div>
          )}
        </div>
      )}

      {view === "changes" && selectedFile && (
        <div className="inspector-content changes-panel">
          <div className="changes-summary">
            <span title={selectedFile}>
              <FileDiff size={15} />
              {selectedStats ? (
                <>
                  {selectedStats.add > 0 && <em className="diff-add-stat">+{selectedStats.add.toLocaleString()}</em>}
                  {selectedStats.del > 0 && <em className="diff-del-stat">-{selectedStats.del.toLocaleString()}</em>}
                </>
              ) : "差异"}
            </span>
            <div className="changes-actions">
              <button className="secondary-button compact" onClick={() => onRestoreFiles([selectedFile])} title="撤销此文件的本地更改">
                <Undo2 size={13} /> 撤销
              </button>
              <button className="icon-button" onClick={onRefreshGit} title="刷新更改"><RefreshCw size={14} /></button>
            </div>
          </div>
          {selectedDiff ? (
            <div className="diff-rich">
              {diffRows.map((row, index) =>
                row.kind === "hunk" ? (
                  <div key={index} className="diff-row diff-row-hunk">{row.text}</div>
                ) : (
                  <div key={index} className="diff-comment-row">
                    <div className={`diff-row diff-row-${row.kind}`}>
                      <span className="diff-lineno">{row.oldLine ?? ""}</span>
                      <span className="diff-lineno">{row.newLine ?? ""}</span>
                      <span className="diff-row-text">{row.text || " "}</span>
                      <button
                        type="button"
                        className="diff-comment-trigger"
                        title="对此行添加审阅意见"
                        aria-label="对此行添加审阅意见"
                        onClick={() => {
                          const line = row.newLine ?? row.oldLine ?? null;
                          setCommentTarget((current) => current?.row === index ? null : { row: index, line });
                          setCommentDraft("");
                        }}
                      >
                        <MessageSquarePlus size={13} strokeWidth={1.8} />
                      </button>
                    </div>
                    {commentTarget?.row === index && (
                      <form
                        className="diff-comment-composer"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const comment = commentDraft.trim();
                          if (!comment || !selectedFile) return;
                          onReviewComment?.(selectedFile, commentTarget.line, comment);
                          setCommentTarget(null);
                          setCommentDraft("");
                        }}
                      >
                        <textarea
                          autoFocus
                          value={commentDraft}
                          rows={3}
                          placeholder={commentTarget.line ? `评论第 ${commentTarget.line} 行` : "添加审阅意见"}
                          onChange={(event) => setCommentDraft(event.target.value)}
                        />
                        <div>
                          <button type="button" className="text-button" onClick={() => { setCommentTarget(null); setCommentDraft(""); }}>取消</button>
                          <button type="submit" className="primary-button" disabled={!commentDraft.trim()}>发送到对话</button>
                        </div>
                      </form>
                    )}
                  </div>
                ),
              )}
            </div>
          ) : (
            <div className="panel-empty">没有可显示的文本差异（可能是未跟踪或二进制文件）</div>
          )}
        </div>
      )}

      {view === "compare" && (
        <div className="inspector-content changes-panel">
          <div className="changes-summary">
            <label className="env-compare-picker">
              <span>基线</span>
              <select
                value={compareBase}
                disabled={compareLoading || branches.length === 0}
                onChange={(event) => void runCompare(event.target.value)}
              >
                {branches.filter((item) => !item.current).map((item) => (
                  <option key={item.name} value={item.name}>{item.name}</option>
                ))}
              </select>
            </label>
            <div className="changes-actions">
              {compareLoading ? <LoaderCircle className="spin" size={14} /> : (
                <>
                  {compareStats.add > 0 && <em className="diff-add-stat">+{compareStats.add.toLocaleString()}</em>}
                  {compareStats.del > 0 && <em className="diff-del-stat">-{compareStats.del.toLocaleString()}</em>}
                </>
              )}
            </div>
          </div>
          {compareSnap?.files.length ? (
            <div className="changed-file-list env-file-list">
              {compareSnap.files.map((file) => {
                const stats = compareFileStats.get(normalizePath(file.path));
                return (
                  <div key={`${file.status}-${file.path}`} className="env-file-row static">
                    <span className={`git-status status-${file.status.trim().charAt(0).toLowerCase() || "u"}`}>{file.status || "?"}</span>
                    <span className="env-file-path" title={file.path}>{file.path}</span>
                    <span className="env-file-stats">
                      {stats && stats.add > 0 && <em className="diff-add-stat">+{stats.add}</em>}
                      {stats && stats.del > 0 && <em className="diff-del-stat">-{stats.del}</em>}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="panel-empty">{compareLoading ? "正在比较…" : "与所选分支没有差异"}</div>
          )}
        </div>
      )}

      {view === "agents" && (
        <div className="inspector-content session-tree-panel">
          <div className="changes-summary">
            <span>
              <AgentMarks running={agents.running} completed={agents.completed} />
              {agents.running} 运行中 · {agents.completed} 完成
            </span>
          </div>
          {messages.flatMap((message) => message.toolCalls ?? []).length === 0 ? (
            <div className="panel-empty">当前会话还没有工具/子任务记录。</div>
          ) : (
            <div className="session-tree-list">
              {messages.flatMap((message) => message.toolCalls ?? []).slice(-40).reverse().map((call) => (
                <div key={call.id} className={`session-tree-node ${call.running ? "leaf" : ""}`}>
                  <div className="session-tree-meta">
                    <code>{call.name}</code>
                    {call.running ? <span className="tree-leaf-badge">运行中</span> : call.isError ? <span className="tree-leaf-badge">失败</span> : <span className="tree-leaf-badge">完成</span>}
                  </div>
                  <p title={summarizeArgs(call.args)}>{summarizeArgs(call.args)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "tree" && (
        <div className="inspector-content session-tree-panel">
          <div className="changes-summary">
            <span><ListTree size={15} /> 会话树</span>
            <div className="changes-actions">
              <button className="icon-button" onClick={onRefreshTree} title="刷新会话树"><RefreshCw size={14} /></button>
            </div>
          </div>
          {sessionTreeLoading ? (
            <div className="panel-empty"><LoaderCircle className="spin" size={16} /> 正在加载会话树…</div>
          ) : sessionTreeError ? (
            <div className="panel-empty session-tree-error">{sessionTreeError}</div>
          ) : sessionTree.length === 0 ? (
            <div className="panel-empty">当前会话还没有树节点。发送消息后可在此查看并从此处分叉继续。</div>
          ) : (
            <div className="session-tree-list">
              {sessionTree.map((node) => (
                <div
                  key={node.entryId}
                  className={`session-tree-node ${node.isLeaf || node.entryId === sessionTreeLeafId ? "leaf" : ""}`}
                  style={{ paddingLeft: 10 + node.depth * 14 }}
                >
                  <div className="session-tree-meta">
                    <code>{node.role}</code>
                    {node.entryId === sessionTreeLeafId && <span className="tree-leaf-badge">当前</span>}
                  </div>
                  <p title={node.summary}>{node.summary}</p>
                  <button
                    className="secondary-button compact"
                    disabled={isStreaming}
                    onClick={() => onContinueFromNode(node.entryId)}
                    title="从此节点分叉并继续（Pi fork）"
                  >
                    从此继续
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "terminal" && (
        <div className="inspector-content terminal-panel">
          <div className="terminal-console">
            <pre className="terminal-output">
              {terminal.history.map((entry, index) => (
                <span className="terminal-history-entry" key={`${index}-${entry.command}`}>
                  <span className="terminal-prompt">{cwd ? `PS ${cwd}>` : "PS>"}</span>
                  {` ${entry.command}\n${entry.output}${entry.output && !entry.output.endsWith("\n") ? "\n" : ""}`}
                </span>
              ))}
              {terminal.command && (
                <>
                  <span className="terminal-prompt">{cwd ? `PS ${cwd}>` : "PS>"}</span>
                  {` ${terminal.command}\n`}
                </>
              )}
              {terminal.output}
              {terminal.running && <LoaderCircle className="spin" size={14} />}
            </pre>
            <label className="terminal-prompt-line">
              <span className="terminal-prompt">{cwd ? `PS ${cwd}>` : "PS>"}</span>
              <input
                value={command}
                disabled={!cwd || terminal.running}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (command.trim()) {
                      onRunCommand(command);
                      setCommand("");
                    }
                  }
                }}
              />
              {terminal.running && (
                <button type="button" className="icon-button" title="停止" onClick={onAbortCommand}>
                  <Square size={12} fill="currentColor" />
                </button>
              )}
            </label>
          </div>
        </div>
      )}

      {view === "browser" && (
        <div className="inspector-content browser-panel">
          <div className="browser-frame">
            <div className="browser-chrome">
              <Globe2 size={14} strokeWidth={1.7} />
              <div className="browser-address" title={browser?.url || browser?.title || ""}>
                {browser?.url || browser?.title || "about:blank"}
              </div>
            </div>
            <div className="browser-viewport">
              {browser?.screenshot ? (
                <img src={`data:${browser.screenshot.mimeType};base64,${browser.screenshot.data}`} alt={browser.title || "页面"} />
              ) : (
                <div className="panel-empty browser-empty">
                  <Globe2 size={22} strokeWidth={1.5} />
                  <span>{browser ? "此页暂无预览" : "尚未打开页面"}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {view === "computer" && (
        <div className="inspector-content browser-panel computer-panel">
          {computer ? <>
            <div className="browser-panel-heading">
              <MonitorCog size={15} />
              <span><strong>Windows 桌面</strong><small>{computer.width}×{computer.height} · 原点 ({computer.left}, {computer.top}) · {computer.action}</small></span>
            </div>
            {computer.screenshot
              ? <img src={`data:${computer.screenshot.mimeType};base64,${computer.screenshot.data}`} alt="Windows 桌面截图" />
              : <div className="panel-empty">最近一次操作没有返回桌面截图。</div>}
          </> : <div className="panel-empty browser-empty"><MonitorCog size={24} />让 Pi 使用 computer 工具截图；最新桌面画面会显示在这里。</div>}
        </div>
      )}

      {view === "logs" && (
        <div className="inspector-content logs-panel">
          <pre>{logs.length ? logs.join("\n") : "暂无 Pi 进程日志。"}</pre>
        </div>
      )}
    </aside>
  );
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeStatMap(input: Map<string, { add: number; del: number }>): Map<string, { add: number; del: number }> {
  const result = new Map<string, { add: number; del: number }>();
  for (const [path, stats] of input) result.set(normalizePath(path), stats);
  return result;
}

function summarizeArgs(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path
    : typeof args.file === "string" ? args.file
      : typeof args.url === "string" ? args.url
        : typeof args.query === "string" ? args.query
          : typeof args.command === "string" ? args.command
            : "";
  if (path) return path;
  try {
    const text = JSON.stringify(args);
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  } catch {
    return "";
  }
}

function extractFileDiff(diff: string, filePath: string): string {
  const target = normalizePath(filePath);
  const lines = diff.split("\n");
  const chunks: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      capturing = false;
      const marker = line.replace(/\\/g, "/");
      if (marker.includes(`/${target}`) || marker.endsWith(target) || marker.includes(`b/${target}`)) {
        capturing = true;
        chunks.push(line);
      }
      continue;
    }
    if (line.startsWith("diff --git ") || line.startsWith("# ")) {
      capturing = false;
      continue;
    }
    if (capturing) chunks.push(line);
  }
  if (chunks.length) return chunks.join("\n");
  // Fallback: +++ path sections
  let current: string[] = [];
  let active = false;
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      if (active && current.length) chunks.push(current.join("\n"));
      current = [line];
      const raw = line.slice(4).trim().replace(/^[ab]\//, "").replace(/\\/g, "/");
      active = raw === target || raw.endsWith(`/${target}`);
      continue;
    }
    if (active) current.push(line);
  }
  if (active && current.length) chunks.push(current.join("\n"));
  return chunks.join("\n\n");
}
