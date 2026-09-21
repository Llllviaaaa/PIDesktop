import { useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { describeError } from "../lib/errors";
import { ChevronRight, ExternalLink, File, Folder, Paperclip, RefreshCw, Search, X } from "lucide-react";
import { pi } from "../lib/pi";
import { queryKeys } from "../lib/queries";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { searchWorkspace } from "../lib/workspaceSearch";
import type { WorkspaceDirEntry } from "../types";

interface FileTreePanelProps {
  cwd: string;
  activePath?: string | null;
  onOpenFile: (path: string) => void;
  onAddToChat: (path: string) => void;
  onOpenExternal: (path: string) => void;
  onClose: () => void;
}

const NO_ENTRIES: WorkspaceDirEntry[] = [];
export function FileTreePanel({ cwd, activePath, onOpenFile, onAddToChat, onOpenExternal, onClose }: FileTreePanelProps) {
  const [query, setQuery] = useState("");
  const queryClient = useQueryClient();
  const needle = query.trim();
  // Search once typing pauses; the previous search is cancelled on the backend.
  const settledNeedle = useDebouncedValue(needle, 140);

  const rootsQuery = useQuery({
    queryKey: queryKeys.directory(cwd, ""),
    queryFn: () => pi.listWorkspaceDir(cwd),
    enabled: Boolean(cwd),
  });
  const roots = (cwd && rootsQuery.data) || NO_ENTRIES;
  const error = cwd && rootsQuery.error ? describeError(rootsQuery.error) : null;

  const searchQuery = useQuery({
    queryKey: queryKeys.search(cwd, settledNeedle),
    queryFn: ({ signal }) => searchWorkspace(cwd, settledNeedle, signal),
    enabled: Boolean(cwd && settledNeedle),
    // Keep showing the last matches while the next search runs, as before.
    placeholderData: keepPreviousData,
  });
  const searching = Boolean(cwd && needle) && (needle !== settledNeedle || searchQuery.isFetching);
  const matches = cwd && needle && !searchQuery.isError ? searchQuery.data ?? NO_ENTRIES : NO_ENTRIES;

  // Refreshing reloads everything read from this workspace, expanded folders included.
  const refresh = () => void queryClient.invalidateQueries({ queryKey: queryKeys.workspace(cwd) });

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return roots;
    return matches;
  }, [matches, query, roots]);

  return (
    <aside className="files-pane" aria-label="文件">
      <header className="workspace-pane-header">
        <span className="workspace-pane-title"><Folder size={15} strokeWidth={1.75} /><strong>文件</strong></span>
        <div className="workspace-pane-actions">
          <button type="button" className="icon-button" title="刷新文件" onClick={refresh}>
            <RefreshCw size={13} strokeWidth={1.75} />
          </button>
          <button type="button" className="icon-button" title="关闭文件" onClick={onClose}>
            <X size={14} strokeWidth={1.7} />
          </button>
        </div>
      </header>
      <label className="files-filter">
        <Search size={13} strokeWidth={1.75} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="筛选文件..."
          disabled={!cwd}
        />
      </label>
      <div className="files-tree">
        {!cwd && <div className="panel-empty">打开项目以浏览文件</div>}
        {cwd && error && <div className="panel-empty">{error}</div>}
        {cwd && !error && searching && <div className="panel-empty">正在搜索…</div>}
        {cwd && !error && !searching && visible.length === 0 && <div className="panel-empty">{query ? "没有匹配项" : "空文件夹"}</div>}
        {cwd && !error && visible.map((entry) => (
          <TreeNode
            key={entry.path}
            cwd={cwd}
            entry={entry}
            depth={0}
            filter={query.trim().toLowerCase()}
            activePath={activePath ?? null}
            onOpenFile={onOpenFile}
            onAddToChat={onAddToChat}
            onOpenExternal={onOpenExternal}
          />
        ))}
      </div>
    </aside>
  );
}

function TreeNode({
  cwd,
  entry,
  depth,
  filter,
  activePath,
  onOpenFile,
  onAddToChat,
  onOpenExternal,
}: {
  cwd: string;
  entry: WorkspaceDirEntry;
  depth: number;
  filter: string;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onAddToChat: (path: string) => void;
  onOpenExternal: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const active = activePath?.replace(/\\/g, "/") === entry.path.replace(/\\/g, "/");

  const childrenQuery = useQuery({
    queryKey: queryKeys.directory(cwd, entry.path),
    queryFn: () => pi.listWorkspaceDir(cwd, entry.path),
    enabled: open && entry.isDir,
  });
  // An unreadable folder shows as empty rather than as an error, as before.
  const children = childrenQuery.isError ? NO_ENTRIES : childrenQuery.data ?? null;
  const loading = open && entry.isDir && childrenQuery.isPending;

  const visibleChildren = useMemo(() => {
    if (!children) return [];
    if (!filter) return children;
    return children.filter((child) => child.name.toLowerCase().includes(filter));
  }, [children, filter]);

  if (entry.isDir) {
    return (
      <div className="tree-node">
        <button
          type="button"
          className="tree-row"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => setOpen((value) => !value)}
          title={entry.path}
        >
          <ChevronRight size={12} className={open ? "tree-chevron open" : "tree-chevron"} />
          <Folder size={14} strokeWidth={1.7} />
          <span>{entry.name}</span>
        </button>
        {open && (
          <div className="tree-children">
            {loading && <div className="tree-loading" style={{ paddingLeft: 24 + depth * 12 }}>加载中…</div>}
            {visibleChildren.map((child) => (
              <TreeNode
                key={child.path}
                cwd={cwd}
                entry={child}
                depth={depth + 1}
                filter={filter}
                activePath={activePath}
                onOpenFile={onOpenFile}
                onAddToChat={onAddToChat}
                onOpenExternal={onOpenExternal}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`tree-file-row ${active ? "active" : ""}`}>
      <button
        type="button"
        className="tree-row file"
        style={{ paddingLeft: 8 + depth * 12 }}
        title={`预览 ${entry.path}`}
        onClick={() => onOpenFile(entry.path)}
      >
        <span className="tree-file-spacer" />
        <File size={14} strokeWidth={1.7} />
        <span>{entry.name}</span>
      </button>
      <div className="tree-file-actions">
        <button type="button" title="添加到聊天" aria-label={`将 ${entry.name} 添加到聊天`} onClick={() => onAddToChat(entry.path)}>
          <Paperclip size={12} strokeWidth={1.8} />
        </button>
        <button type="button" title="打开方式…" aria-label={`打开 ${entry.name}`} onClick={() => onOpenExternal(entry.path)}>
          <ExternalLink size={12} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}
