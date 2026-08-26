import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/common";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileCode2,
  FileDiff,
  Folders,
  GitBranch,
  GitCommitHorizontal,
  Globe2,
  History,
  ListCollapse,
  ListTree,
  LoaderCircle,
  MessageSquarePlus,
  MessageSquareText,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SearchCheck,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  deriveLatestCodeReviewComments,
  type CodeReviewComment,
  type CodeReviewScope,
} from "../lib/codeReview";
import { parseDiffRows, type DiffRow } from "../lib/diffView";
import { aggregateDiffStats, perFileDiffStats } from "../lib/gitDiffStats";
import { pi } from "../lib/pi";
import { usePiStore } from "../store";
import type { GitBranchInfo, GitCommitInfo, GitFileChange, GitSnapshot } from "../types";

export type ReviewTarget =
  | { mode: "uncommitted" }
  | { mode: "base-branch"; baseBranch: string };

type ReviewFilter = "uncommitted" | "unstaged" | "staged" | "branch" | "commit";
type ReviewAuxiliaryTool = "terminal" | "browser" | "files" | "side-chat";

interface ReviewPanelProps {
  cwd: string;
  git: GitSnapshot | null;
  isStreaming: boolean;
  onClose: () => void;
  onRefreshGit: () => void;
  onReview: (target: ReviewTarget) => void;
  onReviewComment?: (path: string, line: number | null, comment: string) => void;
  onCommitOrPush: () => void;
  onOpenTool?: (tool: ReviewAuxiliaryTool) => void;
  onOpenFile?: (path: string, line?: number) => void;
  onRestoreFiles: (paths?: string[]) => void;
  onStageFiles: (paths: string[]) => Promise<void>;
  onUnstageFiles: (paths: string[]) => Promise<void>;
  onError?: (message: string) => void;
}

interface ReviewFileSection {
  change: GitFileChange;
  path: string;
  rows: DiffRow[];
  highlightedRows: string[];
  stats?: { add: number; del: number };
  comments: CodeReviewComment[];
  commentsByRow: Map<number, CodeReviewComment[]>;
}

interface ReviewSearchMatch {
  path: string;
  row: number;
}

const FILTERS: Array<{ id: ReviewFilter; label: string; Icon: typeof FileDiff }> = [
  { id: "uncommitted", label: "未提交", Icon: FileDiff },
  { id: "unstaged", label: "未暂存", Icon: Minus },
  { id: "staged", label: "已暂存", Icon: Plus },
  { id: "branch", label: "分支", Icon: GitBranch },
  { id: "commit", label: "提交", Icon: History },
];

const AUXILIARY_TOOLS: Array<{ id: ReviewAuxiliaryTool; label: string; Icon: typeof FileDiff }> = [
  { id: "terminal", label: "终端", Icon: SquareTerminal },
  { id: "browser", label: "浏览器", Icon: Globe2 },
  { id: "files", label: "文件", Icon: Folders },
  { id: "side-chat", label: "侧边聊天", Icon: MessageSquarePlus },
];

export function ReviewPanel({
  cwd,
  git,
  isStreaming,
  onClose,
  onRefreshGit,
  onReview,
  onReviewComment,
  onCommitOrPush,
  onOpenTool,
  onOpenFile,
  onRestoreFiles,
  onStageFiles,
  onUnstageFiles,
  onError,
}: ReviewPanelProps) {
  const messages = usePiStore((state) => state.messages);
  const [filter, setFilter] = useState<ReviewFilter>("uncommitted");
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(git);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [commits, setCommits] = useState<GitCommitInfo[]>([]);
  const [baseBranch, setBaseBranch] = useState("");
  const [commitSha, setCommitSha] = useState("");
  const [loading, setLoading] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [commentTarget, setCommentTarget] = useState<{ path: string; row: number; line: number | null } | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const panelRef = useRef<HTMLElement | null>(null);
  const loadRequestRef = useRef(0);
  const onErrorRef = useRef(onError);
  const activeSnapshot = filter === "uncommitted" ? git : snapshot;
  const files = activeSnapshot?.files ?? [];

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    if (filter === "uncommitted") setSnapshot(git);
  }, [filter, git]);

  useEffect(() => {
    if (!cwd || !("__TAURI_INTERNALS__" in window)) return;
    if (!git?.isRepository) {
      loadRequestRef.current += 1;
      setFilter("uncommitted");
      setSnapshot(git);
      setBranches([]);
      setCommits([]);
      setBaseBranch("");
      setCommitSha("");
      setLoading(false);
      return;
    }
    let cancelled = false;
    void Promise.all([pi.gitListBranches(cwd), pi.gitListCommits(cwd)])
      .then(([nextBranches, nextCommits]) => {
        if (cancelled) return;
        setBranches(nextBranches);
        setCommits(nextCommits);
        const fallbackBase = nextBranches.find((branch) => !branch.current)?.name ?? "";
        setBaseBranch((current) => current || fallbackBase);
        setCommitSha((current) => current || nextCommits[0]?.sha || "");
      })
      .catch((error) => {
        if (!cancelled) onErrorRef.current?.(`无法加载审查来源：${error instanceof Error ? error.message : String(error)}`);
      });
    return () => { cancelled = true; };
  }, [cwd, git?.isRepository]);

  useEffect(() => {
    if (!filterOpen && !optionsOpen && !reviewOpen && !commitOpen && !toolsOpen) return;
    const closeMenus = (event: PointerEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      setFilterOpen(false);
      setOptionsOpen(false);
      setReviewOpen(false);
      setCommitOpen(false);
      setToolsOpen(false);
    };
    document.addEventListener("pointerdown", closeMenus);
    return () => document.removeEventListener("pointerdown", closeMenus);
  }, [commitOpen, filterOpen, optionsOpen, reviewOpen, toolsOpen]);

  useEffect(() => setSearchIndex(0), [searchQuery]);

  const stats = useMemo(() => aggregateDiffStats(activeSnapshot?.diff), [activeSnapshot?.diff]);
  const fileStats = useMemo(() => normalizeStatMap(perFileDiffStats(activeSnapshot?.diff)), [activeSnapshot?.diff]);
  const reviewScope = useMemo<CodeReviewScope | null>(() => {
    if (filter === "branch" && baseBranch) return { mode: "base-branch", baseBranch };
    if (filter === "commit") return null;
    return { mode: "uncommitted" };
  }, [baseBranch, filter]);
  const comments = useMemo(
    () => deriveLatestCodeReviewComments(messages, reviewScope),
    [messages, reviewScope],
  );
  const sections = useMemo<ReviewFileSection[]>(() => files.map((change) => {
    const path = change.path;
    const rows = parseDiffRows(extractFileDiff(activeSnapshot?.diff ?? "", path));
    const highlightedRows = rows.map((row) => row.kind === "hunk" ? "" : highlightLine(row.text || " ", path));
    const fileComments = comments.filter((comment) => pathMatches(comment.file, path));
    const commentsByRow = new Map<number, CodeReviewComment[]>();
    for (const comment of fileComments) {
      if (comment.start === null) continue;
      let rowIndex = rows.findIndex((row) => row.kind !== "del" && row.newLine === comment.start);
      if (rowIndex < 0) rowIndex = rows.findIndex((row) => row.kind === "del" && row.oldLine === comment.start);
      if (rowIndex >= 0) commentsByRow.set(rowIndex, [...(commentsByRow.get(rowIndex) ?? []), comment]);
    }
    return { change, path, rows, highlightedRows, stats: fileStats.get(normalizePath(path)), comments: fileComments, commentsByRow };
  }), [activeSnapshot?.diff, comments, fileStats, files]);
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const searchMatches = useMemo<ReviewSearchMatch[]>(() => {
    if (!normalizedSearch) return [];
    const output: ReviewSearchMatch[] = [];
    for (const section of sections) {
      let foundRow = false;
      section.rows.forEach((row, index) => {
        if (row.text.toLowerCase().includes(normalizedSearch)) {
          output.push({ path: section.path, row: index });
          foundRow = true;
        }
      });
      if (!foundRow && normalizePath(section.path).toLowerCase().includes(normalizedSearch)) {
        output.push({ path: section.path, row: -1 });
      }
    }
    return output;
  }, [normalizedSearch, sections]);
  const searchMatchKeys = useMemo(() => new Set(searchMatches.map((match) => searchKey(match.path, match.row))), [searchMatches]);
  const activeSearchMatch = searchMatches.length > 0 ? searchMatches[Math.min(searchIndex, searchMatches.length - 1)] : null;
  const activeFilter = FILTERS.find((item) => item.id === filter) ?? FILTERS[0];
  const ActiveFilterIcon = activeFilter.Icon;
  const allCollapsed = sections.length > 0 && sections.every((section) => collapsedFiles.has(normalizePath(section.path)));
  const unstagedPaths = files.filter((file) => file.unstaged).map((file) => file.path);
  const stagedPaths = files.filter((file) => file.staged).map((file) => file.path);

  const closeAllMenus = () => {
    setFilterOpen(false);
    setOptionsOpen(false);
    setReviewOpen(false);
    setCommitOpen(false);
    setToolsOpen(false);
  };

  const loadFilter = async (nextFilter: ReviewFilter, target?: string) => {
    closeAllMenus();
    if (nextFilter !== "uncommitted" && !git?.isRepository) return;
    const requestId = ++loadRequestRef.current;
    setFilter(nextFilter);
    setCollapsedFiles(new Set());
    setCommentTarget(null);
    if (nextFilter === "uncommitted") {
      setSnapshot(git);
      setLoading(false);
      onRefreshGit();
      return;
    }
    if (!("__TAURI_INTERNALS__" in window)) {
      setSnapshot(filterFixtureSnapshot(git, nextFilter));
      return;
    }
    setLoading(true);
    try {
      let next: GitSnapshot;
      if (nextFilter === "branch") {
        const branch = target || baseBranch || branches.find((item) => !item.current)?.name;
        if (!branch) throw new Error("没有可比较的基线分支");
        setBaseBranch(branch);
        next = await pi.gitCompare(cwd, branch);
      } else if (nextFilter === "commit") {
        const commit = target || commitSha || commits[0]?.sha;
        if (!commit) throw new Error("没有可查看的提交");
        setCommitSha(commit);
        next = await pi.gitCommitSnapshot(cwd, commit);
      } else {
        next = await pi.gitReviewSnapshot(cwd, nextFilter);
      }
      if (requestId !== loadRequestRef.current) return;
      setSnapshot(next);
    } catch (error) {
      if (requestId === loadRequestRef.current) {
        onErrorRef.current?.(`加载审查内容失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  };

  const refresh = () => {
    if (filter === "uncommitted") {
      onRefreshGit();
      return;
    }
    void loadFilter(filter, filter === "branch" ? baseBranch : filter === "commit" ? commitSha : undefined);
  };

  const updateIndex = async (action: "stage" | "unstage", paths: string[]) => {
    if (!paths.length) return;
    setBusyFile(paths.length === 1 ? paths[0] : "*");
    try {
      if (action === "stage") await onStageFiles(paths);
      else await onUnstageFiles(paths);
      onRefreshGit();
      if (filter !== "uncommitted") await loadFilter(filter, filter === "branch" ? baseBranch : filter === "commit" ? commitSha : undefined);
    } finally {
      setBusyFile(null);
    }
  };

  const toggleFile = (path: string) => {
    const normalized = normalizePath(path);
    setCollapsedFiles((current) => {
      const next = new Set(current);
      if (next.has(normalized)) next.delete(normalized);
      else next.add(normalized);
      return next;
    });
  };

  const toggleAllFiles = () => {
    setCollapsedFiles(allCollapsed ? new Set() : new Set(sections.map((section) => normalizePath(section.path))));
  };

  const navigateSearch = (direction: 1 | -1) => {
    if (!searchMatches.length) return;
    const nextIndex = (searchIndex + direction + searchMatches.length) % searchMatches.length;
    const match = searchMatches[nextIndex];
    setSearchIndex(nextIndex);
    setCollapsedFiles((current) => {
      const next = new Set(current);
      next.delete(normalizePath(match.path));
      return next;
    });
    window.requestAnimationFrame(() => {
      document.getElementById(match.row >= 0 ? rowId(match.path, match.row) : sectionId(match.path))
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const selectComment = (comment: CodeReviewComment) => {
    const section = sections.find((candidate) => pathMatches(comment.file, candidate.path));
    if (!section) return;
    const row = comment.start === null ? -1 : section.rows.findIndex((candidate) => (
      candidate.kind === "del" ? candidate.oldLine === comment.start : candidate.newLine === comment.start
    ));
    setCollapsedFiles((current) => {
      const next = new Set(current);
      next.delete(normalizePath(section.path));
      return next;
    });
    window.requestAnimationFrame(() => {
      document.getElementById(row >= 0 ? rowId(section.path, row) : sectionId(section.path))
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const submitComment = () => {
    const comment = commentDraft.trim();
    if (!commentTarget || !comment || !onReviewComment) return;
    onReviewComment(commentTarget.path, commentTarget.line, comment);
    setCommentTarget(null);
    setCommentDraft("");
  };

  return (
    <aside ref={panelRef} className="review-workspace-panel workspace-dock-panel" aria-label="审查">
      <header className="review-workspace-tabs">
        <div className="review-active-tab">
          <FileDiff size={15} strokeWidth={1.8} />
          <span>审查</span>
          <button type="button" title="关闭审查" aria-label="关闭审查" onClick={onClose}><X size={13} /></button>
        </div>
        {onOpenTool && (
          <div className="review-menu-wrap">
            <button type="button" className="review-new-tab" title="打开工具" aria-label="打开工具" aria-expanded={toolsOpen} onClick={() => { const next = !toolsOpen; closeAllMenus(); setToolsOpen(next); }}><Plus size={16} /></button>
            {toolsOpen && (
              <div className="review-popover review-tools-menu" role="menu">
                {AUXILIARY_TOOLS.map((item) => {
                  const Icon = item.Icon;
                  return <button type="button" role="menuitem" key={item.id} onClick={() => { closeAllMenus(); onOpenTool(item.id); }}><Icon size={15} /><span><strong>{item.label}</strong></span></button>;
                })}
              </div>
            )}
          </div>
        )}
      </header>

      <div className="review-command-bar">
        <div className="review-menu-wrap">
          <button type="button" className="review-source-trigger" aria-expanded={filterOpen} onClick={() => { const next = !filterOpen; closeAllMenus(); setFilterOpen(next); }}>
            <ActiveFilterIcon size={14} strokeWidth={1.8} />
            <span>{activeFilter.label}</span>
            <ChevronDown size={12} />
          </button>
          {filterOpen && (
            <div className="review-popover review-source-menu" role="menu">
              {FILTERS.map((item) => {
                const Icon = item.Icon;
                return (
                  <button type="button" role="menuitemradio" aria-checked={item.id === filter} className={item.id === filter ? "active" : ""} disabled={loading || (item.id !== "uncommitted" && !git?.isRepository)} key={item.id} onClick={() => void loadFilter(item.id)}>
                    <Icon size={14} strokeWidth={1.75} /><span><strong>{item.label}</strong></span>{item.id === filter && <Check size={13} />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <span className="review-total-stats" aria-label={`新增 ${stats.add} 行，删除 ${stats.del} 行`}>
          {stats.add > 0 && <em>+{stats.add.toLocaleString()}</em>}
          {stats.del > 0 && <b>-{stats.del.toLocaleString()}</b>}
        </span>
        <span className="review-command-spacer" />
        {searchOpen && (
          <div className="review-search-box">
            <Search size={13} />
            <input autoFocus value={searchQuery} placeholder="搜索差异" aria-label="搜索差异" onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter") navigateSearch(event.shiftKey ? -1 : 1);
              if (event.key === "Escape") { setSearchOpen(false); setSearchQuery(""); }
            }} />
            <span>{normalizedSearch ? `${searchMatches.length ? searchIndex + 1 : 0}/${searchMatches.length}` : ""}</span>
            <button type="button" disabled={!searchMatches.length} title="上一个匹配" aria-label="上一个匹配" onClick={() => navigateSearch(-1)}><ArrowUp size={12} /></button>
            <button type="button" disabled={!searchMatches.length} title="下一个匹配" aria-label="下一个匹配" onClick={() => navigateSearch(1)}><ArrowDown size={12} /></button>
          </div>
        )}
        <button type="button" className="review-tool-icon" title={searchOpen ? "关闭搜索" : "搜索差异"} aria-label={searchOpen ? "关闭搜索" : "搜索差异"} aria-pressed={searchOpen} onClick={() => { setSearchOpen((value) => !value); if (searchOpen) setSearchQuery(""); }}><Search size={14} /></button>
        <button type="button" className="review-tool-icon" title={allCollapsed ? "展开全部文件" : "折叠全部文件"} aria-label={allCollapsed ? "展开全部文件" : "折叠全部文件"} onClick={toggleAllFiles}>{allCollapsed ? <ListTree size={14} /> : <ListCollapse size={14} />}</button>
        <button type="button" className="review-tool-icon" title="刷新" aria-label="刷新" disabled={loading} onClick={refresh}><RefreshCw className={loading ? "spin" : ""} size={14} /></button>
        <div className="review-menu-wrap">
          <button type="button" className="review-tool-icon" title="显示选项" aria-label="显示选项" aria-expanded={optionsOpen} onClick={() => { const next = !optionsOpen; closeAllMenus(); setOptionsOpen(next); }}><MoreHorizontal size={15} /></button>
          {optionsOpen && (
            <div className="review-popover review-options-menu" role="menu">
              <button type="button" onClick={() => setWrapLines((value) => !value)}><FileCode2 size={14} /><span><strong>{wrapLines ? "禁用自动换行" : "启用自动换行"}</strong></span>{wrapLines && <Check size={13} />}</button>
              <button type="button" onClick={toggleAllFiles}>{allCollapsed ? <ListTree size={14} /> : <ListCollapse size={14} />}<span><strong>{allCollapsed ? "展开全部文件" : "折叠全部文件"}</strong></span></button>
            </div>
          )}
        </div>
        {comments.length > 0 && (
          <button type="button" className="review-comment-summary" title={`${comments.length} 条审查意见`} aria-label={`${comments.length} 条审查意见`} onClick={() => selectComment(comments[0])}><MessageSquareText size={13} /><span>{comments.length}</span></button>
        )}
        <div className="review-menu-wrap">
          <button type="button" className="review-tool-icon" disabled={isStreaming || !git?.isRepository} title="使用 Pi 审查" aria-label="使用 Pi 审查" aria-expanded={reviewOpen} onClick={() => { const next = !reviewOpen; closeAllMenus(); setReviewOpen(next); }}>
            {isStreaming ? <LoaderCircle className="spin" size={14} /> : <SearchCheck size={14} />}
          </button>
          {reviewOpen && (
            <div className="review-popover review-run-menu" role="menu">
              <div className="review-menu-heading">使用 Pi 审查</div>
              <button type="button" onClick={() => { closeAllMenus(); onReview({ mode: "uncommitted" }); }}>
                <FileDiff size={15} /><span><strong>审查未提交更改</strong><small>已暂存、未暂存和未跟踪文件</small></span>
              </button>
              <div className="review-menu-section">与基线分支比较</div>
              {branches.filter((branch) => !branch.current).slice(0, 8).map((branch) => (
                <button type="button" key={branch.name} onClick={() => { closeAllMenus(); onReview({ mode: "base-branch", baseBranch: branch.name }); }}>
                  <GitBranch size={15} /><span><strong>{branch.name}</strong></span>
                </button>
              ))}
              {branches.filter((branch) => !branch.current).length === 0 && <div className="review-menu-empty">没有可用的基线分支</div>}
            </div>
          )}
        </div>
        <div className="review-menu-wrap">
          <button type="button" className="review-commit-button" disabled={!activeSnapshot?.isRepository} aria-label="提交或推送" aria-expanded={commitOpen} onClick={() => { const next = !commitOpen; closeAllMenus(); setCommitOpen(next); }}><GitCommitHorizontal size={14} /><span>提交或推送</span><ChevronDown size={12} /></button>
          {commitOpen && (
            <div className="review-popover review-commit-menu" role="menu">
              <button type="button" onClick={() => { closeAllMenus(); onCommitOrPush(); }}><GitCommitHorizontal size={15} /><span><strong>让 Pi 提交或推送</strong><small>生成提交说明并处理远程推送</small></span></button>
              <button type="button" disabled={!unstagedPaths.length} onClick={() => { closeAllMenus(); void updateIndex("stage", unstagedPaths); }}><Plus size={15} /><span><strong>暂存全部</strong><small>{unstagedPaths.length} 个文件</small></span></button>
              <button type="button" disabled={!stagedPaths.length} onClick={() => { closeAllMenus(); void updateIndex("unstage", stagedPaths); }}><Minus size={15} /><span><strong>取消暂存全部</strong><small>{stagedPaths.length} 个文件</small></span></button>
            </div>
          )}
        </div>
      </div>

      <div className="review-compare-bar">
        <GitBranch size={13} />
        {filter === "branch" ? (
          <>
            <select value={baseBranch} onChange={(event) => void loadFilter("branch", event.target.value)} aria-label="选择基线分支">
              {branches.filter((branch) => !branch.current).map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
            </select>
            <ArrowRight size={13} />
            <strong title={activeSnapshot?.branch || ""}>{activeSnapshot?.branch || "HEAD"}</strong>
          </>
        ) : filter === "commit" ? (
          <select value={commitSha} onChange={(event) => void loadFilter("commit", event.target.value)} aria-label="选择提交">
            {commits.map((commit) => <option key={commit.sha} value={commit.sha}>{commit.shortSha} · {commit.subject}</option>)}
          </select>
        ) : (
          <>
            <strong title={activeSnapshot?.branch || ""}>{activeSnapshot?.branch || "HEAD"}</strong>
            <ArrowRight size={13} />
            <span>{filter === "staged" ? "暂存区" : filter === "unstaged" ? "工作区" : "本地更改"}</span>
          </>
        )}
        <span className="review-file-count">{files.length} 个文件</span>
      </div>

      <section className="review-diff-pane">
        {loading ? (
          <div className="review-surface-empty"><LoaderCircle className="spin" size={22} /><strong>正在加载差异…</strong></div>
        ) : sections.length > 0 ? (
          <div className={`review-diff-scroll continuous${wrapLines ? " wrap" : ""}`}>
            {sections.map((section) => {
              const normalizedPath = normalizePath(section.path);
              const collapsed = collapsedFiles.has(normalizedPath);
              const pathSearchHit = searchMatchKeys.has(searchKey(section.path, -1));
              const pathSearchActive = activeSearchMatch?.path === section.path && activeSearchMatch.row === -1;
              return (
                <article className={`review-file-section-continuous${pathSearchHit ? " search-hit" : ""}${pathSearchActive ? " search-active" : ""}`} id={sectionId(section.path)} key={`${section.change.status}-${section.path}`}>
                  <header className="review-file-header">
                    <button type="button" className="review-file-collapse" aria-expanded={!collapsed} onClick={() => toggleFile(section.path)} title={section.path}>
                      {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      <span className={`review-file-kind kind-${fileKindClass(section.path)}`}>{fileKind(section.path)}</span>
                      <strong>{normalizedPath}</strong>
                    </button>
                    <span className="review-file-line-stats">{section.stats?.add ? <em>+{section.stats.add}</em> : null}{section.stats?.del ? <b>-{section.stats.del}</b> : null}</span>
                    {section.comments.length > 0 && <button type="button" className="review-file-comment-count" title={`${section.comments.length} 条意见`} onClick={() => selectComment(section.comments[0])}><MessageSquareText size={12} />{section.comments.length}</button>}
                    <span className="review-file-actions">
                      {section.change.unstaged && <button type="button" disabled={Boolean(busyFile)} title="暂存文件" aria-label={`暂存 ${fileName(section.path)}`} onClick={() => void updateIndex("stage", [section.path])}><Plus size={14} /></button>}
                      {section.change.staged && <button type="button" disabled={Boolean(busyFile)} title="取消暂存" aria-label={`取消暂存 ${fileName(section.path)}`} onClick={() => void updateIndex("unstage", [section.path])}><Minus size={14} /></button>}
                      {filter !== "branch" && filter !== "commit" && <button type="button" title="撤销文件更改" aria-label={`撤销 ${fileName(section.path)}`} onClick={() => onRestoreFiles([section.path])}><RotateCcw size={14} /></button>}
                      {onOpenFile && <button type="button" title="打开文件" aria-label={`打开 ${fileName(section.path)}`} onClick={() => onOpenFile(section.path)}><ExternalLink size={14} /></button>}
                    </span>
                  </header>
                  {!collapsed && (
                    <div className="review-file-diff">
                      {section.rows.length > 0 ? section.rows.map((row, index) => {
                        const line = row.newLine ?? row.oldLine ?? null;
                        const rowComments = section.commentsByRow.get(index) ?? [];
                        const commentOpen = commentTarget?.path === section.path && commentTarget.row === index;
                        const matchKey = searchKey(section.path, index);
                        const searchHit = searchMatchKeys.has(matchKey);
                        const searchActive = activeSearchMatch?.path === section.path && activeSearchMatch.row === index;
                        return (
                          <div className="review-diff-unit" key={`${index}-${row.kind}-${line ?? "h"}`} id={rowId(section.path, index)}>
                            {row.kind === "hunk" ? (
                              <div className="review-hunk-row"><span />{row.text}</div>
                            ) : (
                              <div className={`review-code-row ${row.kind}${searchHit ? " search-hit" : ""}${searchActive ? " search-active" : ""}`}>
                                <span className="review-comment-slot">
                                  {onReviewComment && <button type="button" title="对此行添加审阅意见" aria-label={`评论 ${section.path} 第 ${line ?? "此"} 行`} onClick={() => { setCommentTarget(commentOpen ? null : { path: section.path, row: index, line }); setCommentDraft(""); }}><Plus size={13} /></button>}
                                </span>
                                <span className="review-line-number">{row.oldLine ?? ""}</span>
                                <span className="review-line-number">{row.newLine ?? ""}</span>
                                <code dangerouslySetInnerHTML={{ __html: section.highlightedRows[index] }} />
                              </div>
                            )}
                            {commentOpen && (
                              <form className="review-inline-composer" onSubmit={(event) => { event.preventDefault(); submitComment(); }}>
                                <textarea autoFocus rows={3} value={commentDraft} placeholder={line ? `评论第 ${line} 行` : "添加审阅意见"} onChange={(event) => setCommentDraft(event.target.value)} />
                                <div><button type="button" onClick={() => { setCommentTarget(null); setCommentDraft(""); }}>取消</button><button type="submit" className="primary" disabled={!commentDraft.trim()}>发送到对话</button></div>
                              </form>
                            )}
                            {rowComments.map((comment) => (
                              <div className="review-inline-comment" key={comment.id}>
                                <span>{comment.priority !== null ? `P${comment.priority}` : <MessageSquareText size={12} />}</span>
                                <div><strong>{comment.title}</strong><p>{comment.body}</p></div>
                              </div>
                            ))}
                          </div>
                        );
                      }) : (
                        <div className="review-file-empty"><FileCode2 size={18} /><span>没有可显示的文本差异，文件可能是未跟踪、二进制文件或仅发生了重命名。</span></div>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="review-surface-empty">
            <CheckCircle2 size={26} />
            <strong>{activeSnapshot?.isRepository ? "没有文件更改" : "没有 Git 仓库"}</strong>
            <span>{activeSnapshot?.isRepository ? "此审查来源当前没有差异。" : "在 Git 工作区中打开审查后，更改会显示在这里。"}</span>
          </div>
        )}
      </section>
    </aside>
  );
}

function filterFixtureSnapshot(git: GitSnapshot | null, filter: ReviewFilter): GitSnapshot | null {
  if (!git || filter === "branch" || filter === "commit") return git;
  const files = git.files.filter((file) => filter === "staged" ? file.staged : file.unstaged);
  return { ...git, files };
}

function pathMatches(a: string, b: string): boolean {
  const first = normalizePath(a).toLowerCase();
  const second = normalizePath(b).toLowerCase();
  return first === second || first.endsWith(`/${second}`) || second.endsWith(`/${first}`);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeStatMap(input: Map<string, { add: number; del: number }>): Map<string, { add: number; del: number }> {
  const output = new Map<string, { add: number; del: number }>();
  for (const [path, stats] of input) output.set(normalizePath(path), stats);
  return output;
}

function fileName(path: string): string {
  return normalizePath(path).split("/").pop() || path;
}

function fileKind(path: string): string {
  const extension = fileName(path).split(".").pop()?.toUpperCase() ?? "FILE";
  return extension.length <= 4 ? extension : extension.slice(0, 4);
}

function fileKindClass(path: string): string {
  return fileName(path).split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "file";
}

function domKey(path: string): string {
  return normalizePath(path).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sectionId(path: string): string {
  return `review-file-${domKey(path)}`;
}

function rowId(path: string, row: number): string {
  return `${sectionId(path)}-row-${row}`;
}

function searchKey(path: string, row: number): string {
  return `${normalizePath(path).toLowerCase()}:${row}`;
}

function languageForPath(path: string): string | null {
  const extension = fileName(path).split(".").pop()?.toLowerCase();
  const languages: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    rs: "rust", css: "css", scss: "scss", less: "less", html: "xml", htm: "xml", xml: "xml",
    json: "json", jsonc: "json", py: "python", sh: "bash", bash: "bash", ps1: "powershell",
    md: "markdown", markdown: "markdown", yaml: "yaml", yml: "yaml", sql: "sql", toml: "ini",
  };
  return extension ? languages[extension] ?? null : null;
}

function highlightLine(text: string, path: string): string {
  const language = languageForPath(path);
  if (!language || !hljs.getLanguage(language)) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function extractFileDiff(diff: string, filePath: string): string {
  const target = normalizePath(filePath);
  const lines = diff.split("\n");
  const chunks: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current?.length) chunks.push(current.join("\n"));
      const marker = normalizePath(line);
      current = marker.includes(`b/${target}`) || marker.endsWith(target) ? [line] : null;
      continue;
    }
    if (current) current.push(line);
  }
  if (current?.length) chunks.push(current.join("\n"));
  return chunks.join("\n\n");
}
