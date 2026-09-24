import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../lib/queries";
import { useSyncOnChange } from "../hooks/useSyncOnChange";
import { describeError } from "../lib/errors";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  FileCode2,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  History,
  ListCollapse,
  ListTree,
  LoaderCircle,
  MessageSquareText,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SearchCheck,
  SendHorizontal,
  Trash2,
  X,
} from "lucide-react";
import {
  deriveLatestCodeReviewComments,
  type CodeReviewComment,
  type CodeReviewScope,
} from "../lib/codeReview";
import type { DiffRow } from "../lib/diffView";
import {
  buildFilePatch,
  buildHunkPatch,
  hunkActions,
  hunksForPath,
  resolveHunkOrigin,
  splitUnifiedDiff,
  type HunkOrigin,
} from "../lib/diffHunks";
import { aggregateDiffStats, perFileDiffStats } from "../lib/gitDiffStats";
import { pi } from "../lib/pi";
import { highlightLine } from "../lib/syntaxHighlight";
import { usePiStore } from "../store";
import type { GitBranchInfo, GitCommitInfo, GitFileChange, GitSnapshot } from "../types";
import { useFileActions, WorkspaceEditorIcon } from "./WorkspaceOpeners";

export type ReviewTarget =
  | { mode: "uncommitted" }
  | { mode: "base-branch"; baseBranch: string };

export type ReviewFilter = "uncommitted" | "unstaged" | "staged" | "turn" | "branch" | "commit";

/** A review comment written in the pane and not yet sent to the agent. */
export interface PendingReviewComment {
  id: string;
  path: string;
  line: number | null;
  body: string;
}

interface ReviewPanelProps {
  cwd: string;
  git: GitSnapshot | null;
  isStreaming: boolean;
  /** Switches the pane to a scope from outside (task summary, change chip). */
  request?: { filter: ReviewFilter; nonce: number } | null;
  onRefreshGit: () => void;
  onReview: (target: ReviewTarget) => void;
  /** Sends every pending comment to the agent as one message. */
  onSubmitComments?: (comments: PendingReviewComment[]) => Promise<boolean>;
  onCommitOrPush: () => void;
  onOpenFile?: (path: string, line?: number) => void;
  onRestoreFiles: (paths?: string[]) => void;
  onStageFiles: (paths: string[]) => Promise<void>;
  onUnstageFiles: (paths: string[]) => Promise<void>;
  /** Applies a hunk (or file) patch; resolves false when Git refused it. */
  onApplyPatch: (patch: string, options: { cached: boolean; reverse: boolean }, done: string) => Promise<boolean>;
  onError?: (message: string) => void;
}

interface ReviewRow extends DiffRow {
  /** Index into the section's hunks; -1 for rows outside any hunk. */
  hunk: number;
}

interface ReviewHunk {
  patch: string;
  origin: HunkOrigin | null;
}

interface ReviewFileSection {
  change: GitFileChange;
  path: string;
  rows: ReviewRow[];
  hunks: ReviewHunk[];
  /** Every hunk of the file as one patch (discarding a whole file's turn changes). */
  filePatch: string | null;
  highlightedRows: string[];
  stats?: { add: number; del: number };
  comments: CodeReviewComment[];
  commentsByRow: Map<number, CodeReviewComment[]>;
}

interface ReviewSearchMatch {
  path: string;
  row: number;
}

interface LoadRequest {
  filter: Exclude<ReviewFilter, "uncommitted">;
  target?: string;
  nonce: number;
}

const FILTERS: Array<{ id: ReviewFilter; label: string; hint: string; Icon: typeof FileDiff }> = [
  { id: "uncommitted", label: "未提交", hint: "已暂存、未暂存和未跟踪", Icon: FileDiff },
  { id: "unstaged", label: "未暂存", hint: "工作区相对暂存区", Icon: Minus },
  { id: "staged", label: "已暂存", hint: "暂存区相对 HEAD", Icon: Plus },
  { id: "turn", label: "上一轮", hint: "最近一轮 Agent 回合的改动", Icon: Bot },
  { id: "branch", label: "分支", hint: "当前分支相对基线分支", Icon: GitBranch },
  { id: "commit", label: "提交", hint: "某次提交的改动", Icon: History },
];

const NO_BRANCHES: GitBranchInfo[] = [];
let pendingCommentSeq = 0;
function nextPendingCommentId(): string {
  pendingCommentSeq += 1;
  return `pending-comment-${pendingCommentSeq}`;
}
const NO_COMMITS: GitCommitInfo[] = [];
const NO_FILES: GitFileChange[] = [];

function defaultOriginFor(filter: ReviewFilter): HunkOrigin | null {
  if (filter === "unstaged") return "unstaged";
  if (filter === "staged") return "staged";
  if (filter === "turn") return "worktree";
  return null;
}

export function ReviewPanel({
  cwd,
  git,
  isStreaming,
  request = null,
  onRefreshGit,
  onReview,
  onSubmitComments,
  onCommitOrPush,
  onOpenFile,
  onRestoreFiles,
  onStageFiles,
  onUnstageFiles,
  onApplyPatch,
  onError,
}: ReviewPanelProps) {
  const messages = usePiStore((state) => state.messages);
  const fileActions = useFileActions();
  const [filter, setFilter] = useState<ReviewFilter>("uncommitted");
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(git);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [noTurnYet, setNoTurnYet] = useState(false);
  const [loadRequest, setLoadRequest] = useState<LoadRequest | null>(null);
  const [baseBranch, setBaseBranch] = useState("");
  const [commitSha, setCommitSha] = useState("");
  const [loading, setLoading] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQueryState] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  // A new query starts at its first match.
  const setSearchQuery = (next: string) => {
    setSearchQueryState(next);
    setSearchIndex(0);
  };
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [commentTarget, setCommentTarget] = useState<{ path: string; row: number; line: number | null } | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [pendingComments, setPendingComments] = useState<PendingReviewComment[]>([]);
  const [sendingComments, setSendingComments] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const onErrorRef = useRef(onError);

  const activeSnapshot = filter === "uncommitted" ? git : snapshot;
  const files = activeSnapshot?.files ?? NO_FILES;

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  // The uncommitted view mirrors the live git snapshot.
  useSyncOnChange([filter, git], () => {
    if (filter === "uncommitted") setSnapshot(git);
  });

  const inTauri = "__TAURI_INTERNALS__" in window;
  const isRepository = Boolean(git?.isRepository);
  // Branches and commits load per workspace, not on every git refresh.
  const sourcesEnabled = Boolean(cwd) && inTauri && isRepository;
  const sourcesQuery = useQuery({
    queryKey: queryKeys.reviewSources(cwd),
    queryFn: async () => {
      try {
        const [branches, commits] = await Promise.all([pi.gitListBranches(cwd), pi.gitListCommits(cwd)]);
        return { branches, commits };
      } catch (error) {
        onErrorRef.current?.(`无法加载审查来源：${describeError(error)}`);
        throw error;
      }
    },
    enabled: sourcesEnabled,
  });
  const sources = sourcesEnabled && !sourcesQuery.isError ? sourcesQuery.data : undefined;
  const branches = sources?.branches ?? NO_BRANCHES;
  const commits = sources?.commits ?? NO_COMMITS;

  // Pick a comparison base and a commit once they are known, unless one is already chosen.
  useSyncOnChange([sources], () => {
    if (!sources) return;
    const fallbackBase = sources.branches.find((branch) => !branch.current)?.name ?? "";
    setBaseBranch((current) => current || fallbackBase);
    setCommitSha((current) => current || sources.commits[0]?.sha || "");
  });

  // Leaving a repository falls back to the uncommitted view.
  useSyncOnChange([cwd, isRepository], () => {
    if (!cwd || !inTauri || isRepository) return;
    setFilter("uncommitted");
    setSnapshot(git);
    setBaseBranch("");
    setCommitSha("");
    setLoading(false);
    setLoadRequest(null);
  });

  useEffect(() => {
    if (!filterOpen && !optionsOpen && !reviewOpen && !commitOpen) return;
    const closeMenus = (event: PointerEvent) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      setFilterOpen(false);
      setOptionsOpen(false);
      setReviewOpen(false);
      setCommitOpen(false);
    };
    document.addEventListener("pointerdown", closeMenus);
    return () => document.removeEventListener("pointerdown", closeMenus);
  }, [commitOpen, filterOpen, optionsOpen, reviewOpen]);

  // Every non-live scope loads here; requests only describe what to load.
  useEffect(() => {
    if (!loadRequest || !cwd) return;
    let cancelled = false;
    const load = async () => {
      try {
        if (loadRequest.filter === "turn") {
          const lastTurn = await pi.gitLastTurnSnapshot(cwd);
          if (cancelled) return;
          setNoTurnYet(!lastTurn);
          setTurnStartedAt(lastTurn?.startedAt ?? null);
          setSnapshot(lastTurn ?? { isRepository: true, files: [], diff: "" });
          return;
        }
        let next: GitSnapshot;
        if (loadRequest.filter === "branch") next = await pi.gitCompare(cwd, loadRequest.target ?? "");
        else if (loadRequest.filter === "commit") next = await pi.gitCommitSnapshot(cwd, loadRequest.target ?? "");
        else next = await pi.gitReviewSnapshot(cwd, loadRequest.filter);
        if (!cancelled) setSnapshot(next);
      } catch (error) {
        if (!cancelled) onErrorRef.current?.(`加载审查内容失败：${describeError(error)}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [cwd, loadRequest]);

  const stats = useMemo(() => aggregateDiffStats(activeSnapshot?.diff), [activeSnapshot?.diff]);
  const fileStats = useMemo(() => normalizeStatMap(perFileDiffStats(activeSnapshot?.diff)), [activeSnapshot?.diff]);
  const reviewScope = useMemo<CodeReviewScope | null>(() => {
    if (filter === "branch" && baseBranch) return { mode: "base-branch", baseBranch };
    if (filter === "commit" || filter === "turn") return null;
    return { mode: "uncommitted" };
  }, [baseBranch, filter]);
  const comments = useMemo(
    () => deriveLatestCodeReviewComments(messages, reviewScope),
    [messages, reviewScope],
  );
  const diffFiles = useMemo(
    () => splitUnifiedDiff(activeSnapshot?.diff ?? "", defaultOriginFor(filter)),
    [activeSnapshot?.diff, filter],
  );
  const sections = useMemo<ReviewFileSection[]>(() => files.map((change) => {
    const path = change.path;
    const fileHunks = hunksForPath(diffFiles, path);
    const rows: ReviewRow[] = fileHunks.flatMap((item, index) => item.rows.map((row) => ({ ...row, hunk: index })));
    const hunks: ReviewHunk[] = fileHunks.map((item) => ({
      patch: buildHunkPatch(item.file, item.hunk),
      origin: filter === "uncommitted" ? resolveHunkOrigin(item.hunk.origin, change) : item.hunk.origin,
    }));
    const onlyFile = fileHunks.length > 0 && fileHunks.every((item) => item.file === fileHunks[0].file) ? fileHunks[0].file : null;
    const highlightedRows = rows.map((row) => row.kind === "hunk" ? "" : highlightLine(row.text || " ", path));
    const fileComments = comments.filter((comment) => pathMatches(comment.file, path));
    const commentsByRow = new Map<number, CodeReviewComment[]>();
    for (const comment of fileComments) {
      if (comment.start === null) continue;
      let rowIndex = rows.findIndex((row) => row.kind !== "del" && row.newLine === comment.start);
      if (rowIndex < 0) rowIndex = rows.findIndex((row) => row.kind === "del" && row.oldLine === comment.start);
      if (rowIndex >= 0) commentsByRow.set(rowIndex, [...(commentsByRow.get(rowIndex) ?? []), comment]);
    }
    return {
      change,
      path,
      rows,
      hunks,
      filePatch: onlyFile ? buildFilePatch(onlyFile) : null,
      highlightedRows,
      stats: fileStats.get(normalizePath(path)),
      comments: fileComments,
      commentsByRow,
    };
  }), [comments, diffFiles, fileStats, files, filter]);
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
  const indexActionsAvailable = filter === "uncommitted" || filter === "unstaged" || filter === "staged";
  const preferredEditor = fileActions?.preferredEditor ?? null;

  const closeAllMenus = () => {
    setFilterOpen(false);
    setOptionsOpen(false);
    setReviewOpen(false);
    setCommitOpen(false);
  };

  /** Switch scope. Safe during render: it only sets this component's state. */
  const selectFilter = (nextFilter: ReviewFilter, target?: string) => {
    if (nextFilter !== "uncommitted" && !git?.isRepository) return false;
    setFilter(nextFilter);
    setCollapsedFiles(new Set());
    setCommentTarget(null);
    if (nextFilter === "uncommitted") {
      setSnapshot(git);
      setLoading(false);
      setLoadRequest(null);
      return true;
    }
    let resolved = target;
    if (nextFilter === "branch") {
      resolved = target || baseBranch || branches.find((item) => !item.current)?.name;
      if (!resolved) {
        setLoadRequest(null);
        setSnapshot(null);
        return false;
      }
      setBaseBranch(resolved);
    } else if (nextFilter === "commit") {
      resolved = target || commitSha || commits[0]?.sha;
      if (!resolved) {
        setLoadRequest(null);
        setSnapshot(null);
        return false;
      }
      setCommitSha(resolved);
    }
    if (!inTauri) {
      setSnapshot(filterFixtureSnapshot(git, nextFilter));
      return true;
    }
    setLoading(true);
    setLoadRequest((current) => ({ filter: nextFilter, target: resolved, nonce: (current?.nonce ?? 0) + 1 }));
    return true;
  };

  const loadFilter = (nextFilter: ReviewFilter, target?: string) => {
    closeAllMenus();
    const ok = selectFilter(nextFilter, target);
    if (nextFilter === "uncommitted") onRefreshGit();
    if (!ok && (nextFilter === "branch" || nextFilter === "commit")) {
      onErrorRef.current?.(nextFilter === "branch" ? "没有可比较的基线分支" : "没有可查看的提交");
    }
  };

  // Scope requests from outside (the task summary's "比较分支", the change chip).
  useSyncOnChange([request?.nonce], () => {
    if (request) selectFilter(request.filter);
  });

  const currentTarget = filter === "branch" ? baseBranch : filter === "commit" ? commitSha : undefined;

  const refresh = () => {
    onRefreshGit();
    if (filter !== "uncommitted") loadFilter(filter, currentTarget);
  };

  const updateIndex = async (action: "stage" | "unstage", paths: string[]) => {
    if (!paths.length) return;
    setBusyKey(paths.length === 1 ? `file:${paths[0]}` : "*");
    try {
      if (action === "stage") await onStageFiles(paths);
      else await onUnstageFiles(paths);
      refresh();
    } finally {
      setBusyKey(null);
    }
  };

  const applyPatch = async (
    key: string,
    patch: string,
    options: { cached: boolean; reverse: boolean },
    done: string,
    confirmMessage?: string,
  ) => {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setBusyKey(key);
    try {
      if (await onApplyPatch(patch, options, done)) refresh();
    } finally {
      setBusyKey(null);
    }
  };

  const hunkAction = (section: ReviewFileSection, index: number, action: "stage" | "unstage" | "discard") => {
    const hunk = section.hunks[index];
    if (!hunk) return;
    const key = `hunk:${section.path}:${index}`;
    if (action === "stage") void applyPatch(key, hunk.patch, { cached: true, reverse: false }, "已暂存此块");
    else if (action === "unstage") void applyPatch(key, hunk.patch, { cached: true, reverse: true }, "已取消暂存此块");
    else {
      void applyPatch(
        key,
        hunk.patch,
        { cached: false, reverse: true },
        "已撤销此块",
        `撤销 ${fileName(section.path)} 中的这一块改动？此操作会修改工作区文件。`,
      );
    }
  };

  const discardFile = (section: ReviewFileSection) => {
    if (filter === "turn") {
      if (!section.filePatch) {
        onErrorRef.current?.("这个文件没有可撤销的文本差异（可能是二进制文件）");
        return;
      }
      void applyPatch(
        `file:${section.path}`,
        section.filePatch,
        { cached: false, reverse: true },
        `已撤销上一轮对 ${fileName(section.path)} 的改动`,
        `撤销上一轮 Agent 对 ${section.path} 的改动？该文件会恢复到这一轮开始前的内容。`,
      );
      return;
    }
    onRestoreFiles([section.path]);
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

  /** Adds the open draft to the batch; returns the batch including it. */
  const addDraftComment = (): PendingReviewComment[] => {
    const body = commentDraft.trim();
    if (!commentTarget || !body) return pendingComments;
    const next = [
      ...pendingComments,
      {
        id: nextPendingCommentId(),
        path: commentTarget.path,
        line: commentTarget.line,
        body,
      },
    ];
    setPendingComments(next);
    setCommentTarget(null);
    setCommentDraft("");
    return next;
  };

  const submitComments = async (batch = pendingComments) => {
    if (!batch.length || !onSubmitComments || sendingComments) return;
    setSendingComments(true);
    try {
      if (await onSubmitComments(batch)) setPendingComments([]);
    } finally {
      setSendingComments(false);
    }
  };

  const openLineInEditor = (event: ReactMouseEvent, path: string, line: number | null) => {
    if (!(event.ctrlKey || event.metaKey) || !fileActions) return false;
    event.preventDefault();
    fileActions.openInEditor(path, line ?? undefined);
    return true;
  };

  const pendingByRow = (path: string, rows: ReviewRow[]) => {
    const map = new Map<number, PendingReviewComment[]>();
    for (const comment of pendingComments) {
      if (!pathMatches(comment.path, path)) continue;
      const index = comment.line === null ? -1 : rows.findIndex((row) => (row.newLine ?? row.oldLine) === comment.line);
      map.set(index, [...(map.get(index) ?? []), comment]);
    }
    return map;
  };

  const emptyTitle = filter === "turn" && noTurnYet
    ? "还没有记录的 Agent 回合"
    : activeSnapshot?.isRepository ? "没有文件更改" : "没有 Git 仓库";
  const emptyBody = filter === "turn" && noTurnYet
    ? "Agent 开始一轮可写入的任务时会记录检查点，之后这里只显示那一轮改了什么。"
    : filter === "turn"
      ? "最近一轮 Agent 回合之后，工作区没有新的改动。"
      : activeSnapshot?.isRepository ? "此审查来源当前没有差异。" : "在 Git 工作区中打开审查后，更改会显示在这里。";

  return (
    <aside ref={panelRef} className="review-workspace-panel workspace-dock-panel" aria-label="审查">
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
                  <button type="button" role="menuitemradio" aria-checked={item.id === filter} className={item.id === filter ? "active" : ""} disabled={loading || (item.id !== "uncommitted" && !git?.isRepository)} key={item.id} onClick={() => loadFilter(item.id)}>
                    <Icon size={14} strokeWidth={1.75} /><span><strong>{item.label}</strong><small>{item.hint}</small></span>{item.id === filter && <Check size={13} />}
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
              <button type="button" disabled={!unstagedPaths.length || !indexActionsAvailable} onClick={() => { closeAllMenus(); void updateIndex("stage", unstagedPaths); }}><Plus size={15} /><span><strong>暂存全部</strong><small>{unstagedPaths.length} 个文件</small></span></button>
              <button type="button" disabled={!stagedPaths.length || !indexActionsAvailable} onClick={() => { closeAllMenus(); void updateIndex("unstage", stagedPaths); }}><Minus size={15} /><span><strong>取消暂存全部</strong><small>{stagedPaths.length} 个文件</small></span></button>
            </div>
          )}
        </div>
      </div>

      <div className="review-compare-bar">
        <GitBranch size={13} />
        {filter === "branch" ? (
          <>
            <select value={baseBranch} onChange={(event) => loadFilter("branch", event.target.value)} aria-label="选择基线分支">
              {branches.filter((branch) => !branch.current).map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
            </select>
            <ArrowRight size={13} />
            <strong title={activeSnapshot?.branch || ""}>{activeSnapshot?.branch || "HEAD"}</strong>
          </>
        ) : filter === "commit" ? (
          <select value={commitSha} onChange={(event) => loadFilter("commit", event.target.value)} aria-label="选择提交">
            {commits.map((commit) => <option key={commit.sha} value={commit.sha}>{commit.shortSha} · {commit.subject}</option>)}
          </select>
        ) : filter === "turn" ? (
          <>
            <span>{turnStartedAt ? `自 ${formatClock(turnStartedAt)} 这一轮开始以来` : "最近一轮 Agent 回合"}</span>
            <ArrowRight size={13} />
            <span>工作区</span>
          </>
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
              const pending = pendingByRow(section.path, section.rows);
              const fileBusy = busyKey === `file:${section.path}` || busyKey === "*";
              return (
                <article className={`review-file-section-continuous${pathSearchHit ? " search-hit" : ""}${pathSearchActive ? " search-active" : ""}`} id={sectionId(section.path)} key={`${section.change.status}-${section.path}`}>
                  <header className="review-file-header" onContextMenu={(event) => fileActions?.showMenu(event, section.path)}>
                    <button type="button" className="review-file-collapse" aria-expanded={!collapsed} onClick={() => toggleFile(section.path)} title={section.path}>
                      {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      <span className={`review-file-kind kind-${fileKindClass(section.path)}`}>{fileKind(section.path)}</span>
                      <strong>{normalizedPath}</strong>
                    </button>
                    <span className="review-file-line-stats">{section.stats?.add ? <em>+{section.stats.add}</em> : null}{section.stats?.del ? <b>-{section.stats.del}</b> : null}</span>
                    {section.comments.length > 0 && <button type="button" className="review-file-comment-count" title={`${section.comments.length} 条意见`} onClick={() => selectComment(section.comments[0])}><MessageSquareText size={12} />{section.comments.length}</button>}
                    <span className="review-file-actions">
                      {indexActionsAvailable && section.change.unstaged && <button type="button" disabled={Boolean(busyKey)} title="暂存文件" aria-label={`暂存 ${fileName(section.path)}`} onClick={() => void updateIndex("stage", [section.path])}><Plus size={14} /></button>}
                      {indexActionsAvailable && section.change.staged && <button type="button" disabled={Boolean(busyKey)} title="取消暂存" aria-label={`取消暂存 ${fileName(section.path)}`} onClick={() => void updateIndex("unstage", [section.path])}><Minus size={14} /></button>}
                      {filter !== "branch" && filter !== "commit" && (
                        <button type="button" disabled={fileBusy} title={filter === "turn" ? "撤销上一轮对此文件的改动" : "撤销文件更改"} aria-label={`撤销 ${fileName(section.path)}`} onClick={() => discardFile(section)}><RotateCcw size={14} /></button>
                      )}
                      {onOpenFile && <button type="button" title="在应用内预览" aria-label={`预览 ${fileName(section.path)}`} onClick={() => onOpenFile(section.path)}><Eye size={14} /></button>}
                      {preferredEditor && fileActions && (
                        <button type="button" title={`在 ${preferredEditor.name} 中打开（右键查看更多）`} aria-label={`在 ${preferredEditor.name} 中打开 ${fileName(section.path)}`} onClick={() => fileActions.openInEditor(section.path)}>
                          <WorkspaceEditorIcon editorId={preferredEditor.id} size={13} />
                        </button>
                      )}
                    </span>
                  </header>
                  {!collapsed && (
                    <div className="review-file-diff">
                      {section.rows.length > 0 ? section.rows.map((row, index) => {
                        const line = row.newLine ?? row.oldLine ?? null;
                        const rowComments = section.commentsByRow.get(index) ?? [];
                        const rowPending = pending.get(index) ?? [];
                        const commentOpen = commentTarget?.path === section.path && commentTarget.row === index;
                        const matchKey = searchKey(section.path, index);
                        const searchHit = searchMatchKeys.has(matchKey);
                        const searchActive = activeSearchMatch?.path === section.path && activeSearchMatch.row === index;
                        const hunk = row.kind === "hunk" ? section.hunks[row.hunk] : undefined;
                        const actions = hunkActions(hunk?.origin ?? null);
                        const hunkBusy = busyKey === `hunk:${section.path}:${row.hunk}`;
                        return (
                          <div className="review-diff-unit" key={`${index}-${row.kind}-${line ?? "h"}`} id={rowId(section.path, index)}>
                            {row.kind === "hunk" ? (
                              <div className="review-hunk-row">
                                <span />
                                <code>{row.text}</code>
                                {(actions.stage || actions.unstage || actions.discard) && (
                                  <span className="review-hunk-actions">
                                    {actions.stage && <button type="button" disabled={Boolean(busyKey)} title="暂存此块" onClick={() => hunkAction(section, row.hunk, "stage")}><Plus size={12} /><span>暂存</span></button>}
                                    {actions.unstage && <button type="button" disabled={Boolean(busyKey)} title="取消暂存此块" onClick={() => hunkAction(section, row.hunk, "unstage")}><Minus size={12} /><span>取消暂存</span></button>}
                                    {actions.discard && <button type="button" className="danger" disabled={Boolean(busyKey)} title="撤销此块" onClick={() => hunkAction(section, row.hunk, "discard")}>{hunkBusy ? <LoaderCircle className="spin" size={12} /> : <RotateCcw size={12} />}<span>撤销</span></button>}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <div
                                className={`review-code-row ${row.kind}${searchHit ? " search-hit" : ""}${searchActive ? " search-active" : ""}`}
                                onContextMenu={(event) => fileActions?.showMenu(event, section.path, line ?? undefined)}
                              >
                                <span className="review-comment-slot">
                                  {onSubmitComments && <button type="button" title="对此行添加审阅意见" aria-label={`评论 ${section.path} 第 ${line ?? "此"} 行`} onClick={() => { setCommentTarget(commentOpen ? null : { path: section.path, row: index, line }); setCommentDraft(""); }}><Plus size={13} /></button>}
                                </span>
                                <span className="review-line-number" title="Ctrl+单击在编辑器中打开此行" onClick={(event) => openLineInEditor(event, section.path, row.oldLine ?? null)}>{row.oldLine ?? ""}</span>
                                <span className="review-line-number" title="Ctrl+单击在编辑器中打开此行" onClick={(event) => openLineInEditor(event, section.path, row.newLine ?? null)}>{row.newLine ?? ""}</span>
                                <code dangerouslySetInnerHTML={{ __html: section.highlightedRows[index] }} onClick={(event) => { openLineInEditor(event, section.path, line); }} />
                              </div>
                            )}
                            {commentOpen && (
                              <form className="review-inline-composer" onSubmit={(event) => { event.preventDefault(); addDraftComment(); }}>
                                <textarea
                                  autoFocus
                                  rows={3}
                                  value={commentDraft}
                                  placeholder={line ? `评论第 ${line} 行 · Ctrl+Enter 添加并全部发送` : "添加审阅意见"}
                                  onChange={(event) => setCommentDraft(event.target.value)}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                                      event.preventDefault();
                                      void submitComments(addDraftComment());
                                    }
                                    if (event.key === "Escape") {
                                      event.preventDefault();
                                      setCommentTarget(null);
                                      setCommentDraft("");
                                    }
                                  }}
                                />
                                <div>
                                  <button type="button" onClick={() => { setCommentTarget(null); setCommentDraft(""); }}>取消</button>
                                  <button type="submit" disabled={!commentDraft.trim()}>添加意见</button>
                                  <button type="button" className="primary" disabled={!commentDraft.trim() || sendingComments} onClick={() => void submitComments(addDraftComment())}>添加并发送</button>
                                </div>
                              </form>
                            )}
                            {rowPending.map((comment) => (
                              <div className="review-inline-comment pending" key={comment.id}>
                                <span><MessageSquareText size={12} /></span>
                                <div><strong>待发送</strong><p>{comment.body}</p></div>
                                <button type="button" title="删除这条意见" aria-label="删除这条意见" onClick={() => setPendingComments((current) => current.filter((item) => item.id !== comment.id))}><Trash2 size={12} /></button>
                              </div>
                            ))}
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
            <strong>{emptyTitle}</strong>
            <span>{emptyBody}</span>
          </div>
        )}
      </section>

      {pendingComments.length > 0 && (
        <div className="review-pending-bar" role="status">
          <MessageSquareText size={14} />
          <span>{pendingComments.length} 条意见待发送</span>
          <button type="button" className="review-pending-clear" title="清空待发送意见" onClick={() => setPendingComments([])}><X size={13} /></button>
          <button type="button" className="review-pending-send" disabled={sendingComments || !onSubmitComments} onClick={() => void submitComments()}>
            {sendingComments ? <LoaderCircle className="spin" size={13} /> : <SendHorizontal size={13} />}
            <span>全部发送给 Pi</span>
          </button>
        </div>
      )}
    </aside>
  );
}

function formatClock(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} ${time}`;
}

function filterFixtureSnapshot(git: GitSnapshot | null, filter: ReviewFilter): GitSnapshot | null {
  if (!git || filter === "branch" || filter === "commit" || filter === "turn") return git;
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
