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
  AtSign,
  Bell,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Folder,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  MoreHorizontal,
  Pin,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
  X,
} from "lucide-react";
import { pi } from "../lib/pi";
import type { ProjectConfig, SessionInfo } from "../types";
import { sessionRecency, sessionTitle } from "../lib/sessionTitle";

type SidebarHub = "pull-requests" | "scheduled" | null;

interface SidebarProps {
  sessions: SessionInfo[];
  currentSessionFile: string | null;
  runningSessionFiles: string[];
  approvalSessionFiles: string[];
  cwd: string;
  newTaskActive: boolean;
  activeHub: SidebarHub;
  onNewSession: () => void;
  onOpenPullRequests: () => void;
  onOpenScheduled: () => void;
  onOpenPlugins: () => void;
  onOpenSession: (session: SessionInfo) => void;
  onOpenProject: (workspace: string) => void;
  onNewProjectSession: (workspace: string) => void;
  onArchiveSession: (session: SessionInfo) => void | Promise<void>;
  onOpenProjectFolder: (workspace: string) => void;
  onCreateWorktree: (workspace: string) => void | Promise<void>;
  onArchiveProject: (workspace: string, sessions: SessionInfo[]) => void | Promise<void>;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onPickFolder: () => void;
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
const COLLAPSED_PROJECTS_KEY = "pid-desktop:collapsed-projects";

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
  return a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
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

export function Sidebar({
  sessions,
  currentSessionFile,
  runningSessionFiles,
  approvalSessionFiles,
  cwd,
  newTaskActive,
  activeHub,
  onNewSession,
  onOpenPullRequests,
  onOpenScheduled,
  onOpenPlugins,
  onOpenSession,
  onOpenProject,
  onNewProjectSession,
  onArchiveSession,
  onOpenProjectFolder,
  onCreateWorktree,
  onArchiveProject,
  onOpenSettings,
  onOpenHelp,
  onPickFolder,
}: SidebarProps) {
  const sidebarRef = useRef<HTMLElement>(null);
  const previewCloseTimer = useRef<number | null>(null);
  const requestedBranches = useRef(new Set<string>());
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [collapsedProjectPaths, setCollapsedProjectPaths] = useState(() => readStringList(COLLAPSED_PROJECTS_KEY));
  const [pinnedSessionFiles, setPinnedSessionFiles] = useState(() => readStringList(PINNED_SESSIONS_KEY));
  const [projectConfigs, setProjectConfigs] = useState<ProjectConfig[]>([]);
  const [projectMenu, setProjectMenu] = useState<PositionedProjectMenu | null>(null);
  const [threadPreview, setThreadPreview] = useState<PositionedThreadPreview | null>(null);
  const [branchByWorkspace, setBranchByWorkspace] = useState<Record<string, string>>({});
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const lastOpenedSessionFile = useRef<string | null>(null);

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
      const next = collapsed ? [...withoutWorkspace, workspace] : withoutWorkspace;
      window.localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify(next));
      return next;
    });
    setThreadPreview(null);
  }, []);

  const loadProjectConfigs = useCallback(async () => {
    try {
      setProjectConfigs(await pi.listProjects());
    } catch {
      setProjectConfigs([]);
    }
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
    const pinnedSessionSet = new Set(pinnedSessionFiles);
    for (const [key, chats] of result) {
      result.set(key, [...chats].sort((a, b) => {
        const pinDifference = Number(pinnedSessionSet.has(b.file)) - Number(pinnedSessionSet.has(a.file));
        return pinDifference || sessionRecency(b) - sessionRecency(a);
      }));
    }
    return [...result.entries()].sort((a, b) => {
      const pinDifference = Number(projectConfigs.some((project) => project.pinned && pathsEqual(project.path, b[0])))
        - Number(projectConfigs.some((project) => project.pinned && pathsEqual(project.path, a[0])));
      if (pinDifference) return pinDifference;
      const currentDifference = Number(pathsEqual(b[0], cwd)) - Number(pathsEqual(a[0], cwd));
      if (currentDifference) return currentDifference;
      return (b[1][0] ? sessionRecency(b[1][0]) : 0) - (a[1][0] ? sessionRecency(a[1][0]) : 0);
    });
  }, [cwd, pinnedSessionFiles, projectConfigs, query, sessions]);

  const notifications = useMemo(() => {
    const byFile = new Map(sessions.map((session) => [session.file, session]));
    return [
      ...approvalSessionFiles.map((file) => ({ file, kind: "approval" as const, session: byFile.get(file) })),
      ...runningSessionFiles
        .filter((file) => !approvalSessionFiles.includes(file))
        .map((file) => ({ file, kind: "running" as const, session: byFile.get(file) })),
    ].filter((item): item is typeof item & { session: SessionInfo } => Boolean(item.session));
  }, [approvalSessionFiles, runningSessionFiles, sessions]);

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
    void loadProjectConfigs();
    const reload = () => void loadProjectConfigs();
    window.addEventListener("pid-desktop:projects-changed", reload);
    return () => window.removeEventListener("pid-desktop:projects-changed", reload);
  }, [loadProjectConfigs]);

  useEffect(() => {
    if (!currentSessionFile || lastOpenedSessionFile.current === currentSessionFile) return;
    const activeSession = sessions.find((session) => session.file === currentSessionFile);
    if (!activeSession) return;
    lastOpenedSessionFile.current = currentSessionFile;
    setProjectCollapsed(activeSession.cwd, false);
  }, [currentSessionFile, sessions, setProjectCollapsed]);

  return (
    <aside className="sidebar codex-sidebar" ref={sidebarRef}>
      <div className="sidebar-brand-row">
        <button
          type="button"
          className={`codex-brand ${brandMenuOpen ? "active" : ""}`}
          onClick={() => {
            setBrandMenuOpen((value) => !value);
            setNotificationsOpen(false);
            setSearchOpen(false);
            setProjectMenu(null);
          }}
          title="打开 Pi 菜单"
          aria-expanded={brandMenuOpen}
        >
          <span className="codex-brand-name">Pi</span>
          <ChevronDown size={14} strokeWidth={1.75} />
        </button>
        <div className="sidebar-brand-actions">
          <button
            type="button"
            className={`icon-button ${searchOpen ? "active" : ""}`}
            title="搜索"
            aria-label="搜索"
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((value) => !value);
              setBrandMenuOpen(false);
              setNotificationsOpen(false);
              setProjectMenu(null);
            }}
          >
            <Search size={17} strokeWidth={1.75} />
          </button>
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
            <Bell size={17} strokeWidth={1.7} />
            {notifications.length > 0 && <span className="notification-dot" />}
          </button>
        </div>
      </div>

      {brandMenuOpen && (
        <div className="sidebar-popover sidebar-brand-menu" data-sidebar-popover>
          <button type="button" onClick={() => { closePopovers(); onPickFolder(); }}><FolderOpen size={15} />选择项目</button>
          <button type="button" onClick={() => { closePopovers(); onOpenSettings(); }}><Settings size={15} />设置</button>
        </div>
      )}

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
          <div className="sidebar-popover-heading">通知</div>
          {notifications.length === 0 ? (
            <div className="sidebar-notification-empty">暂无新通知</div>
          ) : notifications.map(({ file, kind, session }) => (
            <button
              type="button"
              key={`${kind}:${file}`}
              className="sidebar-notification-row"
              onClick={() => {
                setNotificationsOpen(false);
                onOpenSession(session);
              }}
            >
              <span className={`thread-dot ${kind}`} />
              <span><strong>{sessionTitle(session)}</strong><small>{kind === "approval" ? "等待审批" : "正在运行"}</small></span>
            </button>
          ))}
        </div>
      )}

      <nav className="sidebar-main-nav">
        <button type="button" className={`nav-item ${newTaskActive ? "active" : ""}`} onClick={() => { closePopovers(); onNewSession(); }}>
          <SquarePen size={16} strokeWidth={1.75} />
          <span>新对话</span>
        </button>
        <button type="button" className={`nav-item ${activeHub === "pull-requests" ? "active" : ""}`} onClick={() => { closePopovers(); onOpenPullRequests(); }}>
          <GitPullRequest size={16} strokeWidth={1.75} />
          <span>拉取请求</span>
        </button>
        <button type="button" className={`nav-item ${activeHub === "scheduled" ? "active" : ""}`} onClick={() => { closePopovers(); onOpenScheduled(); }}>
          <Clock3 size={16} strokeWidth={1.75} />
          <span>已安排</span>
        </button>
        <button type="button" className="nav-item" onClick={() => { closePopovers(); onOpenPlugins(); }}>
          <AtSign size={16} strokeWidth={1.75} />
          <span>插件</span>
        </button>
      </nav>

      <div className="sidebar-projects-label">项目</div>

      <div className="sidebar-scroll">
        {groups.length === 0 ? (
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
                      <ChevronDown size={14} strokeWidth={1.8} />
                    </button>
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
                    <div className="project-actions">
                      {projectPinned && <Pin className="project-pinned-mark" size={13} />}
                      <button type="button" title="项目操作" aria-label={`${displayProjectName(workspace)} 项目操作`} onClick={(event) => openProjectMenu(event, workspace)}>
                        <MoreHorizontal size={16} />
                      </button>
                      <button type="button" title="在此项目中新建对话" aria-label={`在 ${displayProjectName(workspace)} 中新建对话`} onClick={(event) => { event.stopPropagation(); closePopovers(); onNewProjectSession(workspace); }}>
                        <SquarePen size={15} />
                      </button>
                    </div>
                  </>
                )}
              </div>
              {!collapsed && <div className="thread-list">
                {visibleChats.map((session) => {
                  const running = runningSessionFiles.includes(session.file);
                  const approval = approvalSessionFiles.includes(session.file);
                  const active = !newTaskActive && session.file === currentSessionFile;
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
                        <span className="thread-title">{sessionTitle(session)}</span>
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
        <button type="button" className="footer-account" onClick={onOpenSettings} title="账户与设置">
          <Settings size={15} strokeWidth={1.75} />
          <span>Pi Desktop</span>
        </button>
        <button type="button" className="icon-button footer-help" onClick={onOpenHelp} title="帮助" aria-label="帮助">
          <CircleHelp size={17} strokeWidth={1.7} />
        </button>
      </div>
    </aside>
  );
}
