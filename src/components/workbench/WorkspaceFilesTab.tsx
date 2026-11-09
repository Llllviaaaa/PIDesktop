import { useCallback, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  MessageSquarePlus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { agent } from "../../lib/agent";
import { describeError } from "../../lib/errors";
import { useWorkbenchStore } from "../../stores/workbenchStore";
import type { WorkspaceDirEntry } from "../../types";

export interface WorkspaceFilesTabProps {
  cwd: string;
  onAddToChat?: (path: string) => void;
}

function sortEntries(entries: readonly WorkspaceDirEntry[]): WorkspaceDirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

export function WorkspaceFilesTab({ cwd, onAddToChat }: WorkspaceFilesTabProps) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [childEntries, setChildEntries] = useState<Record<string, WorkspaceDirEntry[]>>({});
  const [loadingDirs, setLoadingDirs] = useState<Record<string, boolean>>({});
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({});
  const searchBaseId = useId();
  const activeFilePath = useWorkbenchStore((state) => state.activeFilePath);

  useSyncOnChange([cwd], () => {
    setExpanded({});
    setChildEntries({});
    setLoadingDirs({});
    setDirErrors({});
  });

  const rootQuery = useQuery({
    queryKey: ["workbench-dir", cwd],
    queryFn: async () => sortEntries(await agent.listWorkspaceDir(cwd)),
    enabled: Boolean(cwd),
    staleTime: 10_000,
  });

  const trimmedQuery = query.trim();
  const searchQuery = useQuery({
    queryKey: ["workbench-search", cwd, trimmedQuery],
    queryFn: async () => {
      const requestId = `${searchBaseId}-${Date.now()}`;
      return agent.searchWorkspaceFiles(cwd, trimmedQuery, requestId);
    },
    enabled: Boolean(cwd) && trimmedQuery.length > 0,
    staleTime: 5_000,
  });

  const refreshAll = useCallback(() => {
    setChildEntries({});
    setExpanded({});
    setDirErrors({});
    void rootQuery.refetch();
  }, [rootQuery]);

  const toggleDirectory = useCallback(async (dirPath: string) => {
    const nextOpen = !expanded[dirPath];
    setExpanded((prev) => ({ ...prev, [dirPath]: nextOpen }));
    if (!nextOpen || childEntries[dirPath] !== undefined || !cwd) return;
    setLoadingDirs((prev) => ({ ...prev, [dirPath]: true }));
    setDirErrors((prev) => {
      const next = { ...prev };
      delete next[dirPath];
      return next;
    });
    try {
      const listed = sortEntries(await agent.listWorkspaceDir(cwd, dirPath));
      setChildEntries((prev) => ({ ...prev, [dirPath]: listed }));
    } catch (error) {
      setDirErrors((prev) => ({ ...prev, [dirPath]: describeError(error) }));
    } finally {
      setLoadingDirs((prev) => ({ ...prev, [dirPath]: false }));
    }
  }, [childEntries, cwd, expanded]);

  const handleOpenFile = useCallback((filePath: string) => {
    if (!cwd) return;
    void useWorkbenchStore.getState().openFile(cwd, filePath);
  }, [cwd]);

  const renderTree = (entries: readonly WorkspaceDirEntry[], depth: number) => (
    <ul className="pid-wb-tree-list" role={depth === 0 ? "tree" : "group"}>
      {entries.map((entry) => {
        const isExpanded = Boolean(expanded[entry.path]);
        const isLoading = Boolean(loadingDirs[entry.path]);
        const children = childEntries[entry.path];
        const dirError = dirErrors[entry.path];
        const isSelected = !entry.isDir && activeFilePath === entry.path;

        return (
          <li key={entry.path} className="pid-wb-tree-item" role="treeitem" aria-expanded={entry.isDir ? isExpanded : undefined}>
            <div
              className={`pid-wb-tree-row${isSelected ? " active" : ""}`}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
            >
              <button
                type="button"
                className="pid-wb-tree-main"
                onClick={() => {
                  if (entry.isDir) void toggleDirectory(entry.path);
                  else handleOpenFile(entry.path);
                }}
                title={entry.path}
              >
                {entry.isDir ? (
                  <>
                    <span className="pid-wb-tree-chevron">
                      {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </span>
                    {isExpanded ? <FolderOpen size={14} className="pid-wb-icon-folder" /> : <Folder size={14} className="pid-wb-icon-folder" />}
                  </>
                ) : (
                  <>
                    <span className="pid-wb-tree-chevron" />
                    <FileText size={14} className="pid-wb-icon-file" />
                  </>
                )}
                <span className="pid-wb-tree-name">{entry.name}</span>
              </button>
              {!entry.isDir && onAddToChat && (
                <button
                  type="button"
                  className="pid-wb-row-action"
                  title="附加到主对话"
                  onClick={(event) => {
                    event.stopPropagation();
                    onAddToChat(entry.path);
                  }}
                >
                  <MessageSquarePlus size={13} />
                </button>
              )}
            </div>
            {entry.isDir && isExpanded && (
              isLoading ? (
                <div className="pid-wb-tree-hint" style={{ paddingLeft: `${26 + depth * 14}px` }}>正在读取…</div>
              ) : dirError ? (
                <div className="pid-wb-tree-hint error" style={{ paddingLeft: `${26 + depth * 14}px` }}>{dirError}</div>
              ) : children && children.length > 0 ? (
                renderTree(children, depth + 1)
              ) : (
                <div className="pid-wb-tree-hint" style={{ paddingLeft: `${26 + depth * 14}px` }}>空文件夹</div>
              )
            )}
          </li>
        );
      })}
    </ul>
  );

  if (!cwd) {
    return <div className="pid-wb-empty">先打开一个项目工作区以浏览文件。</div>;
  }

  return (
    <div className="pid-wb-pane">
      <div className="pid-wb-subbar">
        <div className="pid-wb-search-box">
          <Search size={13} className="pid-wb-search-icon" />
          <input
            type="text"
            className="pid-wb-search-input"
            placeholder="搜索工作区文件…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" className="pid-wb-icon-btn" title="清除搜索" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </div>
        <button type="button" className="pid-wb-icon-btn" title="刷新文件树" onClick={refreshAll}>
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="pid-wb-scroll">
        {trimmedQuery ? (
          searchQuery.isLoading ? (
            <div className="pid-wb-empty">正在搜索文件…</div>
          ) : searchQuery.isError ? (
            <div className="pid-wb-empty error">{describeError(searchQuery.error)}</div>
          ) : (searchQuery.data?.length ?? 0) === 0 ? (
            <div className="pid-wb-empty">未找到匹配的文件</div>
          ) : (
            <ul className="pid-wb-tree-list">
              {(searchQuery.data ?? []).map((entry) => (
                <li key={entry.path} className="pid-wb-tree-item">
                  <div className={`pid-wb-tree-row${activeFilePath === entry.path ? " active" : ""}`}>
                    <button
                      type="button"
                      className="pid-wb-tree-main"
                      onClick={() => handleOpenFile(entry.path)}
                      title={entry.path}
                    >
                      <FileText size={14} className="pid-wb-icon-file" />
                      <span className="pid-wb-tree-name">{entry.path}</span>
                    </button>
                    {onAddToChat && (
                      <button
                        type="button"
                        className="pid-wb-row-action"
                        title="附加到主对话"
                        onClick={() => onAddToChat(entry.path)}
                      >
                        <MessageSquarePlus size={13} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : rootQuery.isLoading ? (
          <div className="pid-wb-empty">正在加载工作区文件…</div>
        ) : rootQuery.isError ? (
          <div className="pid-wb-empty error">{describeError(rootQuery.error)}</div>
        ) : (rootQuery.data?.length ?? 0) === 0 ? (
          <div className="pid-wb-empty">此工作区中暂无文件</div>
        ) : (
          renderTree(rootQuery.data ?? [], 0)
        )}
      </div>
    </div>
  );
}
