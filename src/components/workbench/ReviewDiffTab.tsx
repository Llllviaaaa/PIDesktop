import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  GitBranch,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { agent } from "../../lib/agent";
import {
  OVERSIZED_DIFF_THRESHOLD,
  diffStats,
  displayPath,
  parseUnifiedDiff,
  unifiedSegments,
  type ParsedDiffFile,
} from "../../lib/diffView";
import { describeError } from "../../lib/errors";
import { useAppStore } from "../../store";
import { useWorkbenchStore } from "../../stores/workbenchStore";
import type { GitFileChange, GitSnapshot } from "../../types";

export interface ReviewDiffTabProps {
  cwd: string;
  git: GitSnapshot | null;
  onRefreshGit: () => Promise<void>;
  onRestoreFiles: (paths?: string[]) => Promise<void>;
  onRequestReview: () => void;
}

type DiffFilter = "uncommitted" | "staged" | "unstaged";

function resolvedFilePath(file: ParsedDiffFile): string {
  const next = displayPath(file.newPath);
  if (next && next !== "/dev/null") return next;
  return displayPath(file.oldPath);
}

export function ReviewDiffTab({
  cwd,
  git,
  onRefreshGit,
  onRestoreFiles,
  onRequestReview,
}: ReviewDiffTabProps) {
  const [filter, setFilter] = useState<DiffFilter>("uncommitted");
  const [collapsedPaths, setCollapsedPaths] = useState<Record<string, boolean>>({});
  const [expandedOversized, setExpandedOversized] = useState<Record<string, boolean>>({});
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const filteredSnapshotQuery = useQuery({
    queryKey: ["workbench-review", cwd, filter, git?.diff?.length ?? 0, git?.files.length ?? 0],
    queryFn: () => agent.gitReviewSnapshot(cwd, filter),
    enabled: Boolean(cwd) && Boolean(git?.isRepository) && filter !== "uncommitted",
    staleTime: 3_000,
  });

  const activeSnapshot = filter === "uncommitted" ? git : (filteredSnapshotQuery.data ?? git);

  const parsedFiles = useMemo(() => {
    const rawDiff = activeSnapshot?.diff ?? "";
    if (!rawDiff.trim()) return [];
    return parseUnifiedDiff(rawDiff).files;
  }, [activeSnapshot?.diff]);

  const fileChangeMap = useMemo(() => {
    const map = new Map<string, GitFileChange>();
    for (const file of git?.files ?? []) {
      map.set(file.path.replace(/\\/g, "/"), file);
    }
    return map;
  }, [git?.files]);

  const handleRefresh = useCallback(async () => {
    await onRefreshGit();
    if (filter !== "uncommitted") {
      await filteredSnapshotQuery.refetch();
    }
  }, [filter, filteredSnapshotQuery, onRefreshGit]);

  const handleStageToggle = useCallback(async (path: string, stage: boolean) => {
    if (!cwd) return;
    setBusyPath(path);
    try {
      if (stage) await agent.gitStageFiles(cwd, [path]);
      else await agent.gitUnstageFiles(cwd, [path]);
      await handleRefresh();
    } catch (error) {
      useAppStore.getState().showToast(describeError(error), "error");
    } finally {
      setBusyPath(null);
    }
  }, [cwd, handleRefresh]);

  if (!cwd) {
    return <div className="pid-wb-empty">选择工作区后即可查看代码变更。</div>;
  }

  if (!git?.isRepository) {
    return <div className="pid-wb-empty">当前目录不是 Git 仓库。</div>;
  }

  const allFiles = git.files;
  const stagedCount = allFiles.filter((file) => file.staged).length;
  const unstagedCount = allFiles.filter((file) => file.unstaged || file.untracked).length;
  const filteredFiles = filter === "staged"
    ? allFiles.filter((file) => file.staged)
    : filter === "unstaged"
      ? allFiles.filter((file) => file.unstaged || file.untracked)
      : allFiles;

  return (
    <div className="pid-wb-pane">
      <div className="pid-wb-subbar">
        <div className="pid-wb-filter-pills" role="tablist" aria-label="变更范围">
          <button
            type="button"
            className={`pid-wb-pill${filter === "uncommitted" ? " active" : ""}`}
            onClick={() => setFilter("uncommitted")}
          >
            全部 ({allFiles.length})
          </button>
          <button
            type="button"
            className={`pid-wb-pill${filter === "staged" ? " active" : ""}`}
            onClick={() => setFilter("staged")}
          >
            已暂存 ({stagedCount})
          </button>
          <button
            type="button"
            className={`pid-wb-pill${filter === "unstaged" ? " active" : ""}`}
            onClick={() => setFilter("unstaged")}
          >
            未暂存 ({unstagedCount})
          </button>
        </div>
        <div className="pid-wb-subbar-actions">
          <button
            type="button"
            className="pid-wb-btn small"
            disabled={allFiles.length === 0}
            title="使用 AI 审查当前变更"
            onClick={onRequestReview}
          >
            <Sparkles size={12} />
            <span>AI 审查</span>
          </button>
          <button
            type="button"
            className="pid-wb-icon-btn"
            title="刷新变更"
            onClick={() => void handleRefresh()}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {git.branch && (
        <div className="pid-wb-meta-strip">
          <GitBranch size={12} />
          <span>{git.branch}</span>
          {git.sync?.upstream && (
            <span className="pid-wb-muted">
              ↑{git.sync.ahead} ↓{git.sync.behind} ({git.sync.upstream})
            </span>
          )}
        </div>
      )}

      <div className="pid-wb-scroll">
        {allFiles.length === 0 ? (
          <div className="pid-wb-empty">工作区干净，没有未提交的更改。</div>
        ) : filteredFiles.length === 0 ? (
          <div className="pid-wb-empty">
            {filter === "staged" ? "当前没有已暂存的更改。" : "当前没有未暂存的更改。"}
          </div>
        ) : parsedFiles.length === 0 ? (
          <div className="pid-wb-section">
            {filteredFiles.map((change) => (
              <div key={change.path} className="pid-wb-diff-card">
                <div className="pid-wb-diff-header">
                  <button
                    type="button"
                    className="pid-wb-diff-title"
                    onClick={() => void useWorkbenchStore.getState().openFile(cwd, change.path)}
                  >
                    <span className="pid-wb-status-tag">{change.status}</span>
                    <span>{change.path}</span>
                  </button>
                  <div className="pid-wb-subbar-actions">
                    {!change.staged && (
                      <button
                        type="button"
                        className="pid-wb-icon-btn"
                        disabled={busyPath === change.path}
                        title="暂存文件"
                        onClick={() => void handleStageToggle(change.path, true)}
                      >
                        <Plus size={13} />
                      </button>
                    )}
                    {change.staged && (
                      <button
                        type="button"
                        className="pid-wb-icon-btn"
                        disabled={busyPath === change.path}
                        title="取消暂存"
                        onClick={() => void handleStageToggle(change.path, false)}
                      >
                        <Minus size={13} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="pid-wb-icon-btn"
                      title="放弃更改"
                      onClick={() => void onRestoreFiles([change.path])}
                    >
                      <RotateCcw size={13} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="pid-wb-diff-list">
            {parsedFiles.map((file) => {
              const path = resolvedFilePath(file);
              const normalized = path.replace(/\\/g, "/");
              const statusEntry = fileChangeMap.get(normalized);
              const segments = unifiedSegments(file);
              const stats = diffStats(segments);
              const totalRows = segments.reduce(
                (sum, seg) => sum + (seg.kind === "hunk" ? seg.rows.length : 1),
                0,
              );
              const isOversized = totalRows > OVERSIZED_DIFF_THRESHOLD && !expandedOversized[path];
              const collapsed = Boolean(collapsedPaths[path]);

              return (
                <div key={`${file.oldPath}->${file.newPath}`} className="pid-wb-diff-card">
                  <div className="pid-wb-diff-header">
                    <button
                      type="button"
                      className="pid-wb-diff-title"
                      onClick={() => setCollapsedPaths((prev) => ({ ...prev, [path]: !collapsed }))}
                    >
                      {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      <span className="pid-wb-diff-path" title={path}>{path}</span>
                      {(stats.added > 0 || stats.deleted > 0) && (
                        <span className="pid-wb-diff-counts">
                          {stats.added > 0 && <em className="add">+{stats.added}</em>}
                          {stats.deleted > 0 && <em className="del">−{stats.deleted}</em>}
                        </span>
                      )}
                    </button>
                    <div className="pid-wb-subbar-actions">
                      <button
                        type="button"
                        className="pid-wb-icon-btn"
                        title="在编辑器中打开"
                        onClick={() => void useWorkbenchStore.getState().openFile(cwd, path)}
                      >
                        <FileCode2 size={13} />
                      </button>
                      {statusEntry && !statusEntry.staged && (
                        <button
                          type="button"
                          className="pid-wb-icon-btn"
                          disabled={busyPath === path}
                          title="暂存文件"
                          onClick={() => void handleStageToggle(path, true)}
                        >
                          <Plus size={13} />
                        </button>
                      )}
                      {statusEntry?.staged && (
                        <button
                          type="button"
                          className="pid-wb-icon-btn"
                          disabled={busyPath === path}
                          title="取消暂存"
                          onClick={() => void handleStageToggle(path, false)}
                        >
                          <Minus size={13} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="pid-wb-icon-btn"
                        title="放弃此文件更改"
                        onClick={() => void onRestoreFiles([path])}
                      >
                        <RotateCcw size={13} />
                      </button>
                    </div>
                  </div>

                  {!collapsed && (
                    file.binary ? (
                      <div className="pid-wb-diff-notice">二进制文件已更改</div>
                    ) : isOversized ? (
                      <div className="pid-wb-diff-notice">
                        <span>差异较大（{totalRows} 行），已默认折叠。</span>
                        <button
                          type="button"
                          className="pid-wb-btn small"
                          onClick={() => setExpandedOversized((prev) => ({ ...prev, [path]: true }))}
                        >
                          展开完整差异
                        </button>
                      </div>
                    ) : (
                      <div className="pid-wb-diff-table">
                        {segments.map((segment, segIndex) => (
                          segment.kind === "fold" ? (
                            <div key={`fold-${segIndex}`} className="pid-wb-diff-fold">
                              ⋯ 隐藏 {segment.count} 行未更改上下文（{segment.newStart}–{segment.newEnd}）
                            </div>
                          ) : (
                            segment.rows.map((row, rowIndex) => (
                              <div
                                key={`r-${segIndex}-${rowIndex}`}
                                className={`pid-wb-diff-row kind-${row.kind}${row.kind === "mod" ? (row.newLine !== undefined ? " side-add" : " side-del") : ""}`}
                              >
                                <span className="pid-wb-diff-ln">{row.oldLine ?? ""}</span>
                                <span className="pid-wb-diff-ln">{row.newLine ?? ""}</span>
                                <span className="pid-wb-diff-sign">
                                  {row.kind === "add" || (row.kind === "mod" && row.newLine !== undefined)
                                    ? "+"
                                    : row.kind === "del" || (row.kind === "mod" && row.oldLine !== undefined)
                                      ? "−"
                                      : " "}
                                </span>
                                <span className="pid-wb-diff-code">{row.text}</span>
                              </div>
                            ))
                          )
                        ))}
                      </div>
                    )
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
