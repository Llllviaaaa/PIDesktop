import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Archive,
  ArchiveRestore,
  MessageSquare,
  AtSign,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock3,
  Folder,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  MoreHorizontal,
  Pin,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  SquarePen,
  Trash2,
  MessageCircleQuestion,
  X,
} from "lucide-react";
import { PI_BRAND_MARK_SVG } from "../lib/claudeCrabSheets";
import { pi } from "../lib/pi";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/queries";
import { useSyncOnChange } from "../hooks/useSyncOnChange";
import type { AppNotification, ProjectConfig, SessionInfo } from "../types";
import { sessionTitle } from "../lib/sessionTitle";
import {
  reconcileSidebarSessionOrder,
  sortSidebarProjectGroups,
  sortSidebarSessions,
} from "../lib/sidebarProjectOrder";
import { sameLocalPath } from "../lib/pathIdentity";

type SidebarHub = "pull-requests" | "scheduled" | "plugins" | null;

interface SidebarProps {
  sessions: SessionInfo[];
  currentSessionFile: string | null;
  runningSessionFiles: string[];
  approvalSessionFiles: string[];
  notifications: AppNotification[];
  cwd: string;
  newTaskActive: boolean;
  activeHub: SidebarHub;
  onNewSession: () => void;
  onOpenPullRequests: () => void;
  onOpenScheduled: () => void;
  onOpenPlugins: () => void;
  onOpenSession: (session: SessionInfo) => void;
  onOpenNotification: (notification: AppNotification) => void;
  onMarkAllNotificationsRead: () => void;
  onDismissNotification: (id: string) => void;
  onOpenProject: (workspace: string) => void;
  onNewProjectSession: (workspace: string) => void;
  onArchiveSession: (session: SessionInfo) => void | Promise<void>;
  onOpenProjectFolder: (workspace: string) => void;
  onCreateWorktree: (workspace: string) => void | Promise<void>;
  onArchiveProject: (workspace: string, sessions: SessionInfo[]) => void | Promise<void>;
  onOpenSettings: () => void;
  onPickFolder: () => void;
  hoverPreview?: boolean;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
}

interface PositionedProjectMenu {
  workspace: string;
  top: number;
}

interface PositionedThreadPreview {
  session: SessionInfo;
  top: number;
}

const PINNED_SESSIONS_KEY = "pid-desktop:pinned-sessions";
const NO_PROJECTS: ProjectConfig[] = [];

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

const COLLAPSED_PROJECTS_KEY = "pid-desktop:collapsed-projects";
const SIDEBAR_SESSION_ORDER_KEY = "pid-desktop:sidebar-session-order";

function readStringList(key: string): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function repoName(path: string): string {
  if (!path) return "未知项目";
  if (path.toLowerCase().endsWith("quick-chat")) return "快速对话";
  if (/^https?:\/\//i.test(path)) {
    try {
      const u = new URL(path);
      return u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    } catch {
      return "远程项目";
    }
  }
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function pathsEqual(a: string, b: string): boolean {
  return sameLocalPath(a, b);
}

function relativeTime(session: SessionInfo): string {
  const parsedCreated = session.createdAt ? Date.parse(session.createdAt) : 0;
  const timestamp = session.updatedAt || parsedCreated;
  if (!timestamp) return "刚刚";
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;
  return new Date(timestamp).toLocaleDateString();
}

/** Sidebar row timestamp: "2h", "5d" — short enough to sit beside a truncated title. */
function compactRelativeTime(session: SessionInfo): string {
  const parsedCreated = session.createdAt ? Date.parse(session.createdAt) : 0;
  const timestamp = session.updatedAt || parsedCreated;
  if (!timestamp) return "";
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo` : `${Math.floor(days / 365)}y`;
}

export function Sidebar({
  sessions,
  currentSessionFile,
  runningSessionFiles,
  approvalSessionFiles,
  notifications,
  cwd,
  newTaskActive,
  activeHub,
  onNewSession,
  onOpenPullRequests,
  onOpenScheduled,
  onOpenPlugins,
  onOpenSession,
  onOpenNotification,
  onMarkAllNotificationsRead,
  onDismissNotification,
  onOpenProject,
  onNewProjectSession,
  onArchiveSession,
  onOpenProjectFolder,
  onCreateWorktree,
  onArchiveProject,
  onOpenSettings,
  onPickFolder,
  hoverPreview = false,
  onHoverEnter,
  onHoverLeave,
}: SidebarProps) {
  const sidebarRef = useRef<HTMLElement>(null);
  const previewCloseTimer = useRef<number | null>(null);
  const requestedBranches = useRef(new Set<string>());
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<"active" | "archived">("active");
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [collapsedProjectPaths, setCollapsedProjectPaths] = useState(() => readStringList(COLLAPSED_PROJECTS_KEY));
  useEffect(() => {
    window.localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify(collapsedProjectPaths));
  }, [collapsedProjectPaths]);
  const [pinnedSessionFiles, setPinnedSessionFiles] = useState(() => readStringList(PINNED_SESSIONS_KEY));
  const [persistedSessionOrder, setPersistedSessionOrder] = useState(() => readStringList(SIDEBAR_SESSION_ORDER_KEY));
  const [projectMenu, setProjectMenu] = useState<PositionedProjectMenu | null>(null);
  const [threadPreview, setThreadPreview] = useState<PositionedThreadPreview | null>(null);
  const [branchByWorkspace, setBranchByWorkspace] = useState<Record<string, string>>({});
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => pi.listProjects().catch((): ProjectConfig[] => []),
  });
  const archivedSessionsQuery = useQuery({
    queryKey: ["claude-sidebar-archived-sessions"],
    queryFn: () => pi.listArchivedSessions().catch((): SessionInfo[] => []),
    enabled: workspaceView === "archived",
  });
  const archivedSessions = archivedSessionsQuery.data ?? [];
  const projectConfigs = projectsQuery.data ?? NO_PROJECTS;
  const setProjectConfigs = useCallback(
    (update: (current: ProjectConfig[]) => ProjectConfig[]) =>
      queryClient.setQueryData<ProjectConfig[]>(queryKeys.projects(), (current) => update(current ?? [])),
    [queryClient],
  );
  const loadProjectConfigs = useCallback(
    () => queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
    [queryClient],
  );
  // The session whose project was last auto-expanded; see the sync further down.
  const [expandedForSession, setExpandedForSession] = useState<string | null>(null);
  const stableSessionOrder = useMemo(
    () => reconcileSidebarSessionOrder(persistedSessionOrder, sessions),
    [persistedSessionOrder, sessions],
  );

  // Remember the reconciled order so new sessions keep their slot across restarts.
  useSyncOnChange([stableSessionOrder], () => {
    if (sameOrder(stableSessionOrder, persistedSessionOrder)) return;
    setPersistedSessionOrder(stableSessionOrder);
  });
  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_SESSION_ORDER_KEY, JSON.stringify(persistedSessionOrder));
  }, [persistedSessionOrder]);

  const projectConfig = (workspace: string): ProjectConfig => projectConfigs.find((project) => pathsEqual(project.path, workspace)) ?? {
    path: workspace,
    name: "",
    pinned: false,
    hidden: false,
  };
  const displayProjectName = (workspace: string) => projectConfig(workspace).name.trim() || repoName(workspace);

  const setProjectCollapsed = useCallback((workspace: string, collapsed: boolean) => {
    setCollapsedProjectPaths((current) => {
      const withoutWorkspace = current.filter((path) => !pathsEqual(path, workspace));
      return collapsed ? [...withoutWorkspace, workspace] : withoutWorkspace;
    });
    setThreadPreview(null);
  }, []);

  const groups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const result = new Map<string, SessionInfo[]>();
    for (const session of sessions) {
      const config = projectConfigs.find((project) => pathsEqual(project.path, session.cwd));
      if (config?.hidden) continue;
      const title = sessionTitle(session);
      const projectName = config?.name.trim() || repoName(session.cwd);
      const haystack = `${title} ${projectName} ${session.cwd}`.toLowerCase();
      if (normalizedQuery && !haystack.includes(normalizedQuery)) continue;
      const key = session.cwd || "未知项目";
      result.set(key, [...(result.get(key) ?? []), session]);
    }
    for (const config of projectConfigs) {
      if (config.hidden || !config.path.trim() || result.has(config.path)) continue;
      const projectName = config.name.trim() || repoName(config.path);
      const haystack = `${projectName} ${config.path}`.toLowerCase();
      if (normalizedQuery && !haystack.includes(normalizedQuery)) continue;
      result.set(config.path, []);
    }
    for (const [key, chats] of result) {
      result.set(key, sortSidebarSessions(chats, pinnedSessionFiles, stableSessionOrder));
    }
    return sortSidebarProjectGroups([...result.entries()], projectConfigs, stableSessionOrder);
  }, [pinnedSessionFiles, projectConfigs, query, sessions, stableSessionOrder]);

  const unreadNotificationCount = useMemo(
    () => notifications.reduce((count, item) => count + Number(!item.read), 0),
    [notifications],
  );

  const closePopovers = () => {
    setBrandMenuOpen(false);
    setNotificationsOpen(false);
    setSearchOpen(false);
    setProjectMenu(null);
    setThreadPreview(null);
  };

  const toggleStringSetting = (
    value: string,
    values: string[],
    setValues: (next: string[]) => void,
    storageKey: string,
  ) => {
    const next = values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
    setValues(next);
    window.localStorage.setItem(storageKey, JSON.stringify(next));
  };

  const updateProjectConfig = async (workspace: string, changes: Partial<ProjectConfig>) => {
    const next = { ...projectConfig(workspace), ...changes, path: workspace };
    setProjectConfigs((current) => {
      const existingIndex = current.findIndex((project) => pathsEqual(project.path, workspace));
      if (existingIndex < 0) return [...current, next];
      return current.map((project, index) => index === existingIndex ? next : project);
    });
    try {
      await pi.saveProject(next);
    } catch {
      await loadProjectConfigs();
    }
  };

  const openProjectMenu = (event: ReactMouseEvent<HTMLButtonElement>, workspace: string) => {
    event.stopPropagation();
    const sidebarRect = sidebarRef.current?.getBoundingClientRect();
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const top = sidebarRect
      ? Math.max(54, Math.min(buttonRect.top - sidebarRect.top - 7, sidebarRect.height - 260))
      : 54;
    setProjectMenu((current) => current?.workspace === workspace ? null : { workspace, top });
    setBrandMenuOpen(false);
    setNotificationsOpen(false);
    setSearchOpen(false);
    setThreadPreview(null);
  };

  const showThreadPreview = (session: SessionInfo, element: HTMLElement) => {
    if (previewCloseTimer.current !== null) window.clearTimeout(previewCloseTimer.current);
    const sidebarRect = sidebarRef.current?.getBoundingClientRect();
    const rowRect = element.getBoundingClientRect();
    const top = sidebarRect
      ? Math.max(58, Math.min(rowRect.top - sidebarRect.top - 8, sidebarRect.height - 152))
      : 58;
    setThreadPreview({ session, top });
    const workspace = session.cwd;
    if (branchByWorkspace[workspace] !== undefined || requestedBranches.current.has(workspace)) return;
    requestedBranches.current.add(workspace);
    void pi.gitSnapshot(workspace)
      .then((snapshot) => {
        setBranchByWorkspace((current) => ({ ...current, [workspace]: snapshot.branch || "本地" }));
      })
      .catch(() => {
        setBranchByWorkspace((current) => ({ ...current, [workspace]: "本地" }));
      });
  };

  const schedulePreviewClose = () => {
    if (previewCloseTimer.current !== null) window.clearTimeout(previewCloseTimer.current);
    previewCloseTimer.current = window.setTimeout(() => setThreadPreview(null), 100);
  };

  const keepPreviewOpen = () => {
    if (previewCloseTimer.current !== null) window.clearTimeout(previewCloseTimer.current);
  };

  const beginProjectRename = (workspace: string) => {
    setProjectMenu(null);
    setEditingProject(workspace);
    setAliasDraft(displayProjectName(workspace));
  };

  const finishProjectRename = () => {
    if (!editingProject) return;
    const alias = aliasDraft.trim();
    void updateProjectConfig(editingProject, { name: alias === repoName(editingProject) ? "" : alias });
    setEditingProject(null);
  };

  const removeProject = async (workspace: string) => {
    setProjectMenu(null);
    setProjectConfigs((current) => current.some((project) => pathsEqual(project.path, workspace))
      ? current.map((project) => pathsEqual(project.path, workspace) ? { ...project, hidden: true } : project)
      : [...current, { path: workspace, name: "", pinned: false, hidden: true }]);
    try {
      await pi.removeLocalProject(workspace);
    } catch {
      await loadProjectConfigs();
    }
  };

  useEffect(() => {
    const hasOpenPopover = brandMenuOpen || notificationsOpen || searchOpen || projectMenu || editingProject;
    if (!hasOpenPopover) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!sidebarRef.current?.contains(event.target as Node)) {
        closePopovers();
        setEditingProject(null);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [brandMenuOpen, editingProject, notificationsOpen, projectMenu, searchOpen]);

  useEffect(() => () => {
    if (previewCloseTimer.current !== null) window.clearTimeout(previewCloseTimer.current);
  }, []);

  useEffect(() => {
    const reload = () => void loadProjectConfigs();
    window.addEventListener("pid-desktop:projects-changed", reload);
    return () => window.removeEventListener("pid-desktop:projects-changed", reload);
  }, [loadProjectConfigs]);

  useSyncOnChange([currentSessionFile, sessions], () => {
    if (!currentSessionFile || expandedForSession === currentSessionFile) return;
    const activeSession = sessions.find((session) => sameLocalPath(session.file, currentSessionFile));
    if (!activeSession) return;
    setExpandedForSession(currentSessionFile);
    setProjectCollapsed(activeSession.cwd, false);
  });

  return (
    <aside
      className={`sidebar codex-sidebar${hoverPreview ? " sidebar-hover-preview" : ""}`}
      data-slot="sidebar"
      data-sidebar-mode={hoverPreview ? "preview" : "pinned"}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
      ref={sidebarRef}
    >
      <div className="sidebar-brand-row" data-dsh-claude-search-row="">
        <button
          type="button"
          className={`codex-brand ${brandMenuOpen ? "active" : ""}`}
          onClick={() => {
            onNewSession();
          }}
          title="Pi Desktop"
        >
          <span
            className="dsh-claude-brand-mark"
            style={{ backgroundImage: `url("${PI_BRAND_MARK_SVG}")` }}
            aria-hidden="true"
          />
          <span className="codex-brand-name">Pi Desktop</span>
        </button>

        <button
          type="button"
          className="dsh-claude-search-trigger"
          onClick={() => {
            setSearchOpen(true);
            setBrandMenuOpen(false);
            setNotificationsOpen(false);
            setProjectMenu(null);
          }}
          title="搜索会话与项目 (Ctrl+K)"
        >
          <span className="dsh-claude-search-trigger-icon"><Search size={14} strokeWidth={1.8} /></span>
          <span className="dsh-claude-search-trigger-label">{query ? `搜索：${query}` : "搜索"}</span>
          <span className="dsh-claude-search-keys" aria-hidden="true">
            <kbd className="dsh-claude-search-key">Ctrl</kbd>
            <kbd className="dsh-claude-search-key">K</kbd>
          </span>
        </button>

        <div className="sidebar-brand-actions">
          <button
            type="button"
            className={`icon-button notification-button ${notificationsOpen ? "active" : ""}`}
            title="通知"
            aria-label="通知"
            aria-expanded={notificationsOpen}
            onClick={() => {
              setNotificationsOpen((value) => !value);
              setBrandMenuOpen(false);
              setSearchOpen(false);
              setProjectMenu(null);
            }}
          >
            <Bell size={15} strokeWidth={1.7} />
            {unreadNotificationCount > 0 && <span className="notification-dot" />}
          </button>
        </div>
      </div>

      {searchOpen && (
        <label className="session-search sidebar-search-popover" data-sidebar-popover>
          <Search size={13} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setSearchOpen(false);
                setQuery("");
              }
            }}
            placeholder="搜索"
          />
        </label>
      )}

      {notificationsOpen && (
        <div className="sidebar-popover sidebar-notifications" data-sidebar-popover>
          <div className="sidebar-popover-heading">
            <strong>通知</strong>
            {unreadNotificationCount > 0 && (
              <button type="button" onClick={onMarkAllNotificationsRead} title="全部标为已读">
                <Check size={13} />全部已读
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div className="sidebar-notification-empty">暂无新通知</div>
          ) : notifications.map((notification) => (
            <div
              key={notification.id}
              className={`sidebar-notification-row${notification.read ? "" : " unread"}`}
            >
              <button
                type="button"
                className="sidebar-notification-open"
                onClick={() => {
                  setNotificationsOpen(false);
                  onOpenNotification(notification);
                }}
              >
                <span className={`sidebar-notification-icon ${notification.kind}`}>
                  {notification.kind === "completion"
                    ? <CheckCircle2 size={15} />
                    : notification.kind === "approval"
                      ? <ShieldCheck size={15} />
                      : <MessageCircleQuestion size={15} />}
                </span>
                <span className="sidebar-notification-copy">
                  <strong>{notification.title}</strong>
                  <small>{notification.body}</small>
                  <time>{new Date(notification.createdAt).toLocaleString()}</time>
                </span>
              </button>
              <button
                type="button"
                className="sidebar-notification-dismiss"
                title="移除通知"
                aria-label="移除通知"
                onClick={() => onDismissNotification(notification.id)}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <nav className="sidebar-main-nav">
        <button
          type="button"
          className={`nav-item dsh-claude-new-session ${newTaskActive ? "active" : ""}`}
          onClick={() => { closePopovers(); onNewSession(); }}
        >
          <span className="dsh-claude-new-session-circle" aria-hidden="true">
            <Plus size={12} strokeWidth={2.2} />
          </span>
          <span className="dsh-claude-new-session-label">新会话</span>
          <span className="dsh-claude-new-session-shortcut" aria-hidden="true">
            <kbd>Ctrl</kbd>
            <kbd>N</kbd>
          </span>
        </button>
        <button type="button" className={`nav-item ${activeHub === "plugins" ? "active" : ""}`} onClick={() => { closePopovers(); onOpenPlugins(); }}>
          <AtSign size={14} strokeWidth={1.75} />
          <span>插件</span>
        </button>
        <button type="button" className={`nav-item ${activeHub === "scheduled" ? "active" : ""}`} onClick={() => { closePopovers(); onOpenScheduled(); }}>
          <Clock3 size={14} strokeWidth={1.75} />
          <span>定时任务</span>
        </button>
        <button type="button" className={`nav-item ${activeHub === "pull-requests" ? "active" : ""}`} onClick={() => { closePopovers(); onOpenPullRequests(); }}>
          <GitPullRequest size={14} strokeWidth={1.75} />
          <span>拉取请求</span>
        </button>
      </nav>

      <div className="sidebar-projects-header" data-dsh-claude-ws-view={workspaceView}>
        <span className="sidebar-projects-label" data-dsh-claude-ws-label="">工作区</span>
        <div className="dsh-claude-ws-segments" role="radiogroup" aria-label="会话视图切换">
          <button
            type="button"
            role="radio"
            aria-checked={workspaceView === "active"}
            className="dsh-claude-ws-segment"
            onClick={() => setWorkspaceView("active")}
          >
            进行中
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={workspaceView === "archived"}
            className="dsh-claude-ws-segment"
            onClick={() => setWorkspaceView("archived")}
          >
            已归档
          </button>
        </div>
      </div>

      <div className="sidebar-scroll" data-dsh-claude-ws-view={workspaceView}>
        {workspaceView === "archived" ? (
          <div className="dsh-claude-archive-list">
            {archivedSessionsQuery.isLoading ? (
              <div className="dsh-claude-archive-status">正在加载…</div>
            ) : archivedSessions.length === 0 ? (
              <div className="dsh-claude-archive-status">没有已归档的会话</div>
            ) : (
              archivedSessions.map((session) => (
                <div key={session.file} className="dsh-claude-archive-row" role="button" tabIndex={0}>
                  <span className="dsh-claude-archive-title" title={sessionTitle(session)}>
                    {sessionTitle(session)}
                  </span>
                  <span className="dsh-claude-archive-time">{compactRelativeTime(session)}</span>
                  <span className="dsh-claude-archive-action">
                    <button
                      type="button"
                      className="dsh-claude-archive-restore"
                      title="取消归档"
                      aria-label="取消归档"
                      onClick={(event) => {
                        event.stopPropagation();
                        void pi.restoreSession(session.file).then(() => {
                          void archivedSessionsQuery.refetch();
                          window.dispatchEvent(new Event("pid-desktop:projects-changed"));
                        });
                      }}
                    >
                      <ArchiveRestore size={14} />
                    </button>
                  </span>
                  <span className="dsh-claude-archive-action">
                    <button
                      type="button"
                      className="dsh-claude-archive-delete"
                      title="删除会话"
                      aria-label="删除会话"
                      onClick={(event) => {
                        event.stopPropagation();
                        void pi.deleteSession(session.file).then(() => {
                          void archivedSessionsQuery.refetch();
                        });
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>
        ) : groups.length === 0 ? (
          <div className="sidebar-empty">
            <span>{query ? "没有匹配项" : "打开项目以开始"}</span>
            <button type="button" className="text-link" onClick={onPickFolder}>选择文件夹</button>
          </div>
        ) : groups.map(([workspace, chats]) => {
          const collapsed = !query.trim() && collapsedProjectPaths.some((path) => pathsEqual(path, workspace));
          const expanded = Boolean(query.trim()) || expandedProjects[workspace];
          const visibleChats = expanded ? chats : chats.slice(0, 4);
          const projectPinned = projectConfig(workspace).pinned;
          const isEditing = editingProject === workspace;
          return (
            <section className={`project-block ${cwd && pathsEqual(workspace, cwd) ? "is-current" : ""}`} key={workspace}>
              <div className="project-header-row">
                {isEditing ? (
                  <form className="project-rename-editor" onSubmit={(event) => { event.preventDefault(); finishProjectRename(); }}>
                    <input
                      autoFocus
                      value={aliasDraft}
                      onChange={(event) => setAliasDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setEditingProject(null);
                      }}
                      aria-label="项目名称"
                    />
                    <button type="submit" title="保存" aria-label="保存"><Check size={14} /></button>
                    <button type="button" title="取消" aria-label="取消" onClick={() => setEditingProject(null)}><X size={14} /></button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="project-header"
                      title={workspace}
                      onClick={() => {
                        closePopovers();
                        setProjectCollapsed(workspace, false);
                        onOpenProject(workspace);
                      }}
                    >
                      <Folder size={15} strokeWidth={1.7} />
                      <span className="project-name">{displayProjectName(workspace)}</span>
                    </button>
                    <button
                      type="button"
                      className={`project-collapse-toggle ${collapsed ? "is-collapsed" : ""}`}
                      title={collapsed ? "展开会话" : "折叠会话"}
                      aria-label={`${collapsed ? "展开" : "折叠"} ${displayProjectName(workspace)} 的会话`}
                      aria-expanded={!collapsed}
                      disabled={chats.length === 0}
                      onClick={(event) => {
                        event.stopPropagation();
                        setProjectCollapsed(workspace, !collapsed);
                      }}
                    >
                      <ChevronDown size={13} strokeWidth={1.8} />
                    </button>
                    <div className="project-actions">
                      {projectPinned && <Pin className="project-pinned-mark" size={13} />}
                      <button type="button" title="项目操作" aria-label={`${displayProjectName(workspace)} 项目操作`} onClick={(event) => openProjectMenu(event, workspace)}>
                        <MoreHorizontal size={15} />
                      </button>
                      <button type="button" title="在此项目中新建对话" aria-label={`在 ${displayProjectName(workspace)} 中新建对话`} onClick={(event) => { event.stopPropagation(); closePopovers(); onNewProjectSession(workspace); }}>
                        <SquarePen size={14} />
                      </button>
                    </div>
                  </>
                )}
              </div>
              {!collapsed && <div className="thread-list">
                {visibleChats.map((session) => {
                  const running = runningSessionFiles.some((file) => sameLocalPath(file, session.file));
                  const approval = approvalSessionFiles.some((file) => sameLocalPath(file, session.file));
                  const active = !newTaskActive && sameLocalPath(session.file, currentSessionFile);
                  const pinned = pinnedSessionFiles.includes(session.file);
                  return (
                    <div
                      className={`thread-row-shell ${active ? "active" : ""}`}
                      key={session.file}
                      onMouseEnter={(event) => showThreadPreview(session, event.currentTarget)}
                      onMouseLeave={schedulePreviewClose}
                    >
                      <button
                        type="button"
                        className={`thread-row ${active ? "active" : ""}`}
                        onClick={() => {
                          closePopovers();
                          setQuery("");
                          setProjectCollapsed(workspace, false);
                          onOpenSession(session);
                        }}
                        title={sessionTitle(session)}
                      >
                        <MessageSquare className="thread-row-icon" size={15} strokeWidth={1.6} aria-hidden />
                        <span className="thread-title">{sessionTitle(session)}</span>
                        {!running && !approval && <span className="thread-row-time">{compactRelativeTime(session)}</span>}
                      </button>
                      <div className="thread-row-actions">
                        {(running || approval) && (
                          <span className={`thread-dot ${approval ? "approval" : "running"}`} title={approval ? "等待审批" : "运行中"} />
                        )}
                        <button
                          type="button"
                          className={pinned ? "is-pinned" : ""}
                          title={pinned ? "取消置顶" : "置顶对话"}
                          aria-label={pinned ? "取消置顶对话" : "置顶对话"}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleStringSetting(session.file, pinnedSessionFiles, setPinnedSessionFiles, PINNED_SESSIONS_KEY);
                          }}
                        >
                          <Pin size={14} />
                        </button>
                        <button
                          type="button"
                          title="归档对话"
                          aria-label="归档对话"
                          onClick={(event) => {
                            event.stopPropagation();
                            setThreadPreview(null);
                            void onArchiveSession(session);
                          }}
                        >
                          <Archive size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {!query.trim() && chats.length > 4 && (
                  <button
                    type="button"
                    className="expand-threads"
                    onClick={() => setExpandedProjects((current) => ({ ...current, [workspace]: !current[workspace] }))}
                  >
                    {expanded ? "收起" : "展开显示"}
                  </button>
                )}
              </div>}
            </section>
          );
        })}
      </div>

      {projectMenu && (() => {
        const chats = groups.find(([workspace]) => workspace === projectMenu.workspace)?.[1] ?? [];
        const pinned = projectConfig(projectMenu.workspace).pinned;
        return (
          <div className="sidebar-popover project-context-menu" style={{ top: projectMenu.top }} data-sidebar-popover>
            <button type="button" onClick={() => { void updateProjectConfig(projectMenu.workspace, { pinned: !pinned }); setProjectMenu(null); }}>
              <Pin size={15} />{pinned ? "取消置顶项目" : "置顶项目"}
            </button>
            <button type="button" onClick={() => { onOpenProjectFolder(projectMenu.workspace); setProjectMenu(null); }}>
              <FolderOpen size={15} />在资源管理器中打开
            </button>
            <button type="button" onClick={() => { void onCreateWorktree(projectMenu.workspace); setProjectMenu(null); }}>
              <GitBranch size={15} />创建永久工作树
            </button>
            <button type="button" onClick={() => beginProjectRename(projectMenu.workspace)}>
              <SlidersHorizontal size={15} />编辑项目
            </button>
            <button type="button" onClick={() => { void onArchiveProject(projectMenu.workspace, chats); setProjectMenu(null); }}>
              <Archive size={15} />归档聊天
            </button>
            <div className="sidebar-popover-separator" />
            <button type="button" className="danger" onClick={() => void removeProject(projectMenu.workspace)}>
              <X size={15} />移除本地项目
            </button>
          </div>
        );
      })()}

      {threadPreview && (
        <div
          className="thread-hover-card"
          style={{ top: threadPreview.top }}
          onMouseEnter={keepPreviewOpen}
          onMouseLeave={schedulePreviewClose}
        >
          <div className="thread-hover-heading">
            <strong>{sessionTitle(threadPreview.session)}</strong>
            <span>{relativeTime(threadPreview.session)}</span>
          </div>
          <div><Folder size={15} /><span>{displayProjectName(threadPreview.session.cwd)}</span></div>
          <div><GitBranch size={15} /><span>{branchByWorkspace[threadPreview.session.cwd] || "读取中..."}</span></div>
        </div>
      )}

      <div className="sidebar-footer codex-footer">
        {brandMenuOpen && (
          <div className="sidebar-popover dsh-claude-account-popover" data-sidebar-popover>
            <div className="dsh-claude-account-popover-header">
              <span className="dsh-claude-account-popover-name">Pi Desktop</span>
              <span className="dsh-claude-account-popover-sub">本地工作区模式</span>
            </div>
            <div className="sidebar-popover-separator" />
            <button type="button" onClick={() => { closePopovers(); onPickFolder(); }}>
              <FolderOpen size={15} />打开项目文件夹…
            </button>
            <button type="button" onClick={() => { closePopovers(); onOpenPlugins(); }}>
              <AtSign size={15} />插件与资源中心
            </button>
            <div className="sidebar-popover-separator" />
            <button type="button" onClick={() => { closePopovers(); onOpenSettings(); }}>
              <Settings size={15} />设置
            </button>
          </div>
        )}
        <button
          type="button"
          className="footer-account dsh-claude-account-btn"
          data-open={brandMenuOpen ? "true" : undefined}
          onClick={() => {
            setBrandMenuOpen((value) => !value);
            setNotificationsOpen(false);
            setSearchOpen(false);
            setProjectMenu(null);
          }}
          title="账户与设置"
        >
          <span
            className="dsh-claude-account-avatar"
            style={{ backgroundImage: `url("${PI_BRAND_MARK_SVG}")` }}
            aria-hidden="true"
          />
          <span className="dsh-claude-account-label">
            <span className="dsh-claude-account-user">Pi Desktop</span>
          </span>
          <span className="dsh-claude-account-chevron" aria-hidden="true">
            {brandMenuOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          </span>
        </button>
      </div>
    </aside>
  );
}
