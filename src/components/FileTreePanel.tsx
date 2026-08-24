import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ExternalLink, File, Folder, Paperclip, RefreshCw, Search, X } from "lucide-react";
import { pi } from "../lib/pi";
import type { WorkspaceDirEntry } from "../types";

interface FileTreePanelProps {
  cwd: string;
  activePath?: string | null;
  onOpenFile: (path: string) => void;
  onAddToChat: (path: string) => void;
  onOpenExternal: (path: string) => void;
  onClose: () => void;
}

export function FileTreePanel({ cwd, activePath, onOpenFile, onAddToChat, onOpenExternal, onClose }: FileTreePanelProps) {
  const [query, setQuery] = useState("");
  const [roots, setRoots] = useState<WorkspaceDirEntry[]>([]);
  const [matches, setMatches] = useState<WorkspaceDirEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const searchSequence = useRef(0);

  useEffect(() => {
    if (!cwd) {
      setRoots([]);
      setError(null);
      return;
    }
    let disposed = false;
    void pi.listWorkspaceDir(cwd)
      .then((entries) => {
        if (!disposed) {
          setRoots(entries);
          setError(null);
        }
      })
      .catch((err) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      disposed = true;
    };
  }, [cwd, refreshKey]);

  useEffect(() => {
    const needle = query.trim();
    if (!cwd || !needle) {
      setMatches([]);
      setSearching(false);
      return;
    }
    let disposed = false;
    const requestId = `workspace-search-${Date.now()}-${++searchSequence.current}`;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void pi.searchWorkspaceFiles(cwd, needle, requestId)
        .then((entries) => { if (!disposed) setMatches(entries); })
        .catch(() => { if (!disposed) setMatches([]); })
        .finally(() => { if (!disposed) setSearching(false); });
    }, 140);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      void pi.cancelWorkspaceSearch(requestId).catch(() => undefined);
    };
  }, [cwd, query, refreshKey]);

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
          <button type="button" className="icon-button" title="刷新文件" onClick={() => setRefreshKey((value) => value + 1)}>
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
  const [children, setChildren] = useState<WorkspaceDirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const active = activePath?.replace(/\\/g, "/") === entry.path.replace(/\\/g, "/");

  useEffect(() => {
    if (!open || !entry.isDir || children) return;
    setLoading(true);
    void pi.listWorkspaceDir(cwd, entry.path)
      .then(setChildren)
      .catch(() => setChildren([]))
      .finally(() => setLoading(false));
  }, [children, cwd, entry.isDir, entry.path, open]);

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
