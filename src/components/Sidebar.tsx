import { useMemo, useState } from "react";
import {
  Archive,
  Blocks,
  ChevronDown,
  Clock3,
  Folder,
  FolderOpen,
  GitPullRequest,
  Globe2,
  MessageSquarePlus,
  PanelLeftClose,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import type { ConnectionState, SessionInfo } from "../types";

interface SidebarProps {
  sessions: SessionInfo[];
  currentSessionFile: string | null;
  cwd: string;
  connection: ConnectionState;
  onNewSession: () => void;
  onQuickChat: () => void;
  onOpenPullRequests: () => void;
  onOpenSites: () => void;
  onOpenScheduled: () => void;
  onOpenPlugins: () => void;
  onOpenSession: (session: SessionInfo) => void;
  onDeleteSession: (session: SessionInfo) => void;
  onArchiveSession: (session: SessionInfo) => void;
  onOpenSettings: () => void;
  onPickFolder: () => void;
  onClose: () => void;
}

function titleFor(session: SessionInfo) {
  return session.name || session.firstMessage || "未命名任务";
}

function relativeTime(timestamp?: number): string {
  if (!timestamp) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)} 天`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function repoName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path || "未知工作区";
}

export function Sidebar({
  sessions,
  currentSessionFile,
  cwd,
  connection,
  onNewSession,
  onQuickChat,
  onOpenPullRequests,
  onOpenSites,
  onOpenScheduled,
  onOpenPlugins,
  onOpenSession,
  onDeleteSession,
  onArchiveSession,
  onOpenSettings,
  onPickFolder,
  onClose,
}: SidebarProps) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const result = new Map<string, SessionInfo[]>();
    for (const session of sessions) {
      const haystack = `${titleFor(session)} ${session.cwd}`.toLowerCase();
      if (normalizedQuery && !haystack.includes(normalizedQuery)) continue;
      const key = session.cwd || "未知工作区";
      result.set(key, [...(result.get(key) ?? []), session]);
    }
    return [...result.entries()];
  }, [query, sessions]);

  return (
    <aside className="sidebar">
      <div className="sidebar-heading">
        <button className="brand" onClick={onPickFolder} title="打开工作区">
          <span className="brand-mark">π</span>
          <span>Pi Desktop</span>
        </button>
        <button className="icon-button" onClick={onClose} title="隐藏侧栏">
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div className="sidebar-actions">
        <div className="new-task-action-wrap">
          <button className="primary-sidebar-action" onClick={onNewSession}>
            <MessageSquarePlus size={16} />
            新任务
          </button>
          <button className="quick-chat-action" onClick={onQuickChat} title="快速对话"><MessageSquarePlus size={14} /></button>
        </div>
        <nav className="sidebar-navigation">
          <button onClick={onOpenPullRequests}><GitPullRequest size={15} />拉取请求</button>
          <button onClick={onOpenSites}><Globe2 size={15} />站点</button>
          <button onClick={onOpenScheduled}><Clock3 size={15} />已安排</button>
          <button onClick={onOpenPlugins}><Blocks size={15} />插件</button>
        </nav>
        <label className="session-search">
          <Search size={14} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务" />
        </label>
      </div>

      <div className="sidebar-scroll">
        {groups.length === 0 ? (
          <div className="sidebar-empty">
            <FolderOpen size={22} />
            <span>{query ? "没有匹配的任务" : "打开项目以开始"}</span>
          </div>
        ) : (
          groups.map(([workspace, chats]) => {
            const isCollapsed = collapsed[workspace] ?? false;
            return (
              <section className="workspace-group" key={workspace}>
                <button
                  className="workspace-row"
                  onClick={() => setCollapsed((value) => ({ ...value, [workspace]: !isCollapsed }))}
                  title={workspace}
                >
                  <ChevronDown size={13} className={isCollapsed ? "chevron collapsed" : "chevron"} />
                  <Folder size={14} />
                  <span>{repoName(workspace)}</span>
                  <small>{chats.length}</small>
                </button>
                {!isCollapsed && (
                  <div className="session-list">
                    {chats.map((session) => (
                      <button
                        key={session.file}
                        className={`session-row ${session.file === currentSessionFile ? "active" : ""}`}
                        onClick={() => onOpenSession(session)}
                        title={titleFor(session)}
                      >
                        <span className="session-title">{titleFor(session)}</span>
                        <span className="session-time">{relativeTime(session.updatedAt)}</span>
                        <span
                          role="button"
                          tabIndex={0}
                          className="session-archive"
                          title="归档任务"
                          onClick={(event) => {
                            event.stopPropagation();
                            onArchiveSession(session);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") onArchiveSession(session);
                          }}
                        >
                          <Archive size={12} />
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          className="session-delete"
                          title="移到回收站"
                          onClick={(event) => {
                            event.stopPropagation();
                            onDeleteSession(session);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") onDeleteSession(session);
                          }}
                        >
                          <Trash2 size={12} />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>

      <div className="sidebar-footer">
        <button className="workspace-picker" onClick={onPickFolder} title={cwd || "打开工作区"}>
          <span className={`status-dot ${connection}`} />
          <span className="workspace-picker-copy">
            <strong>{cwd ? repoName(cwd) : "未打开工作区"}</strong>
            <small>{connection === "running" ? "本地" : connection === "starting" ? "正在连接" : connection === "exited" ? "已退出" : "未连接"}</small>
          </span>
          <FolderOpen size={14} />
        </button>
        <button className="icon-button" onClick={onOpenSettings} title="设置">
          <Settings size={16} />
        </button>
      </div>
    </aside>
  );
}
