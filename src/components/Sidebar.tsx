import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Archive,
  ArchiveRestore,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Clock3,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  ListFilter,
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
import type { SettingsPage } from "./SettingsModal";
import { QIANJI_BRAND_MARK_SVG } from "../lib/claudeCrabSheets";
import { agent } from "../lib/agent";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/queries";
import { useSyncOnChange } from "../hooks/useSyncOnChange";
import type { AppNotification, ProjectConfig, SessionInfo } from "../types";
import { sessionTitle } from "../lib/sessionTitle";
import {
  reconcileSidebarOrder,
  reorderSidebarWorkspaces,
  sortSidebarProjectGroups,
  sortSidebarSessions,
  type SidebarOrder,
} from "../lib/sidebarProjectOrder";
import { sameLocalPath } from "../lib/pathIdentity";

type SidebarHub = "scheduled" | null;

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
  onOpenScheduled: () => void;
  onOpenSession: (session: SessionInfo) => void;
  onOpenNotification: (notification: AppNotification) => void;
  onMarkAllNotificationsRead: () => void;
  onDismissNotification: (id: string) => void;
  onOpenProject: (workspace: string) => void;
  onNewProjectSession: (workspace: string) => void;
  onArchiveSession: (session: SessionInfo) => void | Promise<void>;
  /** A session came back from the archive, so the session list has to be read again. */
  onSessionRestored: () => void;
  onOpenProjectFolder: (workspace: string) => void;
  onCreateWorktree: (workspace: string) => void | Promise<void>;
  onArchiveProject: (workspace: string, sessions: SessionInfo[]) => void | Promise<void>;
  onOpenSettings: (page: SettingsPage) => void;
  onPickFolder: () => void;
  /** Shown beside 设置 in the footer, e.g. "Ctrl+,". */
  settingsShortcut?: string;
  /** Shown on the new session row, e.g. "Ctrl+Shift+N". */
  newChatShortcut?: string;
  /** Set by the Ctrl+K shortcut; the sidebar opens its search and then reports back. */
  searchRequested?: boolean;
  onSearchRequestHandled?: () => void;
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

interface ProjectDropTarget {
  workspace: string;
  position: "before" | "after";
}

const PINNED_SESSIONS_KEY = "qianji:pinned-sessions";
const NO_PROJECTS: ProjectConfig[] = [];

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

const COLLAPSED_PROJECTS_KEY = "qianji:collapsed-projects";
const SIDEBAR_SESSION_ORDER_KEY = "qianji:sidebar-session-order";
const SIDEBAR_PROJECT_ORDER_KEY = "qianji:sidebar-project-order";

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

/** Sidebar row timestamp: "2小时", "5天" — short enough to sit beside a truncated title. */
function compactRelativeTime(session: SessionInfo): string {
  const parsedCreated = session.createdAt ? Date.parse(session.createdAt) : 0;
  const timestamp = session.updatedAt || parsedCreated;
  if (!timestamp) return "";
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}个月` : `${Math.floor(days / 365)}年`;
}

/** Rows a project shows before "展开其余 N 个会话". */
const VISIBLE_THREADS_PER_PROJECT = 5;
/** Rows the flat "按时间" list shows before it folds. */
const VISIBLE_RECENT_THREADS = 15;

type SidebarGroupMode = "project" | "recent";

const GROUP_MODE_KEY = "qianji:sidebar-group-mode";

function readGroupMode(): SidebarGroupMode {
  try {
    return window.localStorage.getItem(GROUP_MODE_KEY) === "recent" ? "recent" : "project";
  } catch {
    return "project";
  }
}

function sessionTimestamp(session: SessionInfo): number {
  return session.updatedAt || (session.createdAt ? Date.parse(session.createdAt) : 0) || 0;
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
  onOpenScheduled,
  onOpenSession,
  onOpenNotification,
  onMarkAllNotificationsRead,
  onDismissNotification,
  onOpenProject,
  onNewProjectSession,
  onArchiveSession,
  onSessionRestored,
  onOpenProjectFolder,
  onCreateWorktree,
  onArchiveProject,
  onOpenSettings,
  onPickFolder,
  settingsShortcut,
  newChatShortcut,
  searchRequested = false,
  onSearchRequestHandled,
  hoverPreview = false,
  onHoverEnter,
  onHoverLeave,
}: SidebarProps) {
  const sidebarRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const previewCloseTimer = useRef<number | null>(null);
  const requestedBranches = useRef(new Set<string>());
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<"active" | "archived">("active");
  const [groupMode, setGroupMode] = useState<SidebarGroupMode>(readGroupMode);
  useEffect(() => {
    try {
      window.localStorage.setItem(GROUP_MODE_KEY, groupMode);
    } catch {
      // The mode is a convenience; losing it only resets to 按项目.
    }
  }, [groupMode]);
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [collapsedProjectPaths, setCollapsedProjectPaths] = useState(() => readStringList(COLLAPSED_PROJECTS_KEY));
  useEffect(() => {
    window.localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify(collapsedProjectPaths));
  }, [collapsedProjectPaths]);
  const [pinnedSessionFiles, setPinnedSessionFiles] = useState(() => readStringList(PINNED_SESSIONS_KEY));
  const [persistedOrder, setPersistedOrder] = useState<SidebarOrder>(() => ({
    sessions: readStringList(SIDEBAR_SESSION_ORDER_KEY),
    workspaces: readStringList(SIDEBAR_PROJECT_ORDER_KEY),
  }));
  const [projectMenu, setProjectMenu] = useState<PositionedProjectMenu | null>(null);
  const [threadPreview, setThreadPreview] = useState<PositionedThreadPreview | null>(null);
  const [branchByWorkspace, setBranchByWorkspace] = useState<Record<string, string>>({});
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const queryClient = useQueryClient();
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => agent.listProjects().catch((): ProjectConfig[] => []),
  });
  const archivedSessionsQuery = useQuery({
    queryKey: ["claude-sidebar-archived-sessions"],
    queryFn: () => agent.listArchivedSessions().catch((): SessionInfo[] => []),
    enabled: workspaceView === "archived",
  });
  const trimmedQuery = query.trim();
  const sessionSearchQuery = useQuery({
    queryKey: queryKeys.sessionSearch(trimmedQuery, workspaceView === "archived"),
    queryFn: () => agent.searchSessions(trimmedQuery, { includeArchived: workspaceView === "archived", limit: 50 }),
    enabled: trimmedQuery.length > 0,
    placeholderData: (previous) => previous,
  });
  const snippetByFile = useMemo(() => {
    if (!trimmedQuery) return new Map<string, string>();
    return new Map((sessionSearchQuery.data ?? []).map((hit) => [hit.session.file, hit.snippet]));
  }, [sessionSearchQuery.data, trimmedQuery]);
  const archivedSessions = useMemo(() => {
    const allArchived = archivedSessionsQuery.data ?? [];
    if (!trimmedQuery) return allArchived;
    const lower = trimmedQuery.toLowerCase();
    return allArchived.filter((session) => {
      const haystack = `${sessionTitle(session)} ${repoName(session.cwd)} ${session.cwd}`.toLowerCase();
      return haystack.includes(lower) || snippetByFile.has(session.file);
    });
  }, [archivedSessionsQuery.data, snippetByFile, trimmedQuery]);
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
  const [draggingWorkspace, setDraggingWorkspace] = useState<string | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<ProjectDropTarget | null>(null);
  const suppressProjectClickRef = useRef(false);
  const projectDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    projectDragCleanupRef.current?.();
  }, []);

  const visibleProjectPaths = useMemo(
    () => projectConfigs
      .filter((config) => !config.hidden && Boolean(config.path.trim()))
      .map((config) => config.path),
    [projectConfigs],
  );
  const sidebarOrder = useMemo(
    () => reconcileSidebarOrder(persistedOrder, sessions, visibleProjectPaths),
    [persistedOrder, sessions, visibleProjectPaths],
  );
  const stableSessionOrder = sidebarOrder.sessions;

  // Remember the reconciled order so sessions and projects keep their slots across restarts.
  useSyncOnChange([sidebarOrder], () => {
    if (
      sameOrder(sidebarOrder.sessions, persistedOrder.sessions)
      && sameOrder(sidebarOrder.workspaces, persistedOrder.workspaces)
    ) return;
    setPersistedOrder(sidebarOrder);
  });
  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_SESSION_ORDER_KEY, JSON.stringify(persistedOrder.sessions));
    window.localStorage.setItem(SIDEBAR_PROJECT_ORDER_KEY, JSON.stringify(persistedOrder.workspaces));
  }, [persistedOrder]);

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
    const seenFiles = new Set<string>();
    const canonicalKey = (rawWorkspace: string): string => {
      if (!rawWorkspace) return "未知项目";
      for (const existing of result.keys()) {
        if (pathsEqual(existing, rawWorkspace)) return existing;
      }
      const configured = projectConfigs.find((project) => pathsEqual(project.path, rawWorkspace));
      return configured?.path.trim() || rawWorkspace;
    };
    for (const session of sessions) {
      seenFiles.add(session.file);
      const config = projectConfigs.find((project) => pathsEqual(project.path, session.cwd));
      if (config?.hidden) continue;
      const title = sessionTitle(session);
      const projectName = config?.name.trim() || repoName(session.cwd);
      const haystack = `${title} ${projectName} ${session.cwd}`.toLowerCase();
      if (normalizedQuery && !haystack.includes(normalizedQuery) && !snippetByFile.has(session.file)) continue;
      const key = canonicalKey(session.cwd);
      result.set(key, [...(result.get(key) ?? []), session]);
    }
    if (normalizedQuery && workspaceView === "active") {
      for (const hit of sessionSearchQuery.data ?? []) {
        if (seenFiles.has(hit.session.file)) continue;
        const config = projectConfigs.find((project) => pathsEqual(project.path, hit.session.cwd));
        if (config?.hidden) continue;
        const key = canonicalKey(hit.session.cwd);
        result.set(key, [...(result.get(key) ?? []), hit.session]);
      }
    }
    for (const config of projectConfigs) {
      if (config.hidden || !config.path.trim()) continue;
      if ([...result.keys()].some((existing) => pathsEqual(existing, config.path))) continue;
      const projectName = config.name.trim() || repoName(config.path);
      const haystack = `${projectName} ${config.path}`.toLowerCase();
      if (normalizedQuery && !haystack.includes(normalizedQuery)) continue;
      result.set(config.path, []);
    }
    for (const [key, chats] of result) {
      result.set(key, sortSidebarSessions(chats, pinnedSessionFiles, stableSessionOrder));
    }
    return sortSidebarProjectGroups([...result.entries()], projectConfigs, stableSessionOrder, sidebarOrder.workspaces);
  }, [pinnedSessionFiles, projectConfigs, query, sessionSearchQuery.data, sessions, sidebarOrder.workspaces, snippetByFile, stableSessionOrder, workspaceView]);

  // 按时间: every visible session in one list, pinned first, then most recently updated.
  const recentSessions = useMemo(() => groups
    .flatMap(([, chats]) => chats)
    .sort((left, right) => {
      const pinnedOrder = Number(pinnedSessionFiles.includes(right.file)) - Number(pinnedSessionFiles.includes(left.file));
      return pinnedOrder || sessionTimestamp(right) - sessionTimestamp(left);
    }), [groups, pinnedSessionFiles]);

  const unreadNotificationCount = useMemo(
    () => notifications.reduce((count, item) => count + Number(!item.read), 0),
    [notifications],
  );

  const closePopovers = () => {
    setNotificationsOpen(false);
    setSearchOpen(false);
    setProjectMenu(null);
    setThreadPreview(null);
    setFilterMenuOpen(false);
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
      await agent.saveProject(next);
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
    void agent.gitSnapshot(workspace)
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
      await agent.removeLocalProject(workspace);
    } catch {
      await loadProjectConfigs();
    }
  };

  const startProjectDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    workspace: string,
    pinned: boolean,
  ) => {
    if (event.button !== 0 || Boolean(trimmedQuery) || groups.length < 2) return;
    if ((event.target as Element | null)?.closest(".project-actions, .project-collapse-toggle, .project-rename-editor")) return;
    projectDragCleanupRef.current?.();
    const startY = event.clientY;
    const baselineGroupOrder = groups
      .filter(([candidate]) => projectConfig(candidate).pinned === pinned)
      .map(([candidate]) => candidate);
    if (baselineGroupOrder.length < 2) return;

    let started = false;
    let latestDrop: ProjectDropTarget | null = null;

    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKeyDown, true);
      if (projectDragCleanupRef.current === cleanup) projectDragCleanupRef.current = null;
      setDraggingWorkspace(null);
      setProjectDropTarget(null);
    };

    const computeDropTarget = (clientY: number): ProjectDropTarget | null => {
      const container = sidebarRef.current;
      if (!container) return null;
      const blocks = Array.from(container.querySelectorAll<HTMLElement>(".project-block[data-workspace]"))
        .filter((block) => (block.dataset.pinned === "true") === pinned && Boolean(block.dataset.workspace));
      if (blocks.length < 2) return null;

      let candidate: ProjectDropTarget | null = null;
      for (const block of blocks) {
        const rect = block.getBoundingClientRect();
        const blockWorkspace = block.dataset.workspace ?? "";
        if (clientY <= rect.top + rect.height / 2) {
          candidate = { workspace: blockWorkspace, position: "before" };
          break;
        }
      }
      if (!candidate) {
        const lastWorkspace = blocks[blocks.length - 1]?.dataset.workspace ?? "";
        candidate = lastWorkspace ? { workspace: lastWorkspace, position: "after" } : null;
      }
      if (!candidate || pathsEqual(candidate.workspace, workspace)) return null;
      const reordered = reorderSidebarWorkspaces(baselineGroupOrder, workspace, candidate.workspace, candidate.position);
      const baselineNormalized = reorderSidebarWorkspaces(baselineGroupOrder, workspace, workspace, "before");
      return sameOrder(reordered, baselineNormalized) ? null : candidate;
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (!started) {
        if (Math.abs(moveEvent.clientY - startY) < 5) return;
        started = true;
        suppressProjectClickRef.current = true;
        setDraggingWorkspace(workspace);
        setNotificationsOpen(false);
        setSearchOpen(false);
        setProjectMenu(null);
        setThreadPreview(null);
        setFilterMenuOpen(false);
      }
      moveEvent.preventDefault();
      const nextDrop = computeDropTarget(moveEvent.clientY);
      latestDrop = nextDrop;
      setProjectDropTarget((current) => (
        current?.workspace === nextDrop?.workspace && current?.position === nextDrop?.position
          ? current
          : nextDrop
      ));
    };

    const finishDrag = (commit: boolean) => {
      const shouldCommit = commit && started && latestDrop !== null;
      const drop = latestDrop;
      cleanup();
      if (started) {
        window.setTimeout(() => {
          suppressProjectClickRef.current = false;
        }, 0);
      }
      if (shouldCommit && drop) {
        const allWorkspaces = [...sidebarOrder.workspaces, ...groups.map(([item]) => item)];
        const nextWorkspaces = reorderSidebarWorkspaces(allWorkspaces, workspace, drop.workspace, drop.position);
        setPersistedOrder((current) => ({ ...current, workspaces: nextWorkspaces }));
      }
    };

    const onPointerUp = () => finishDrag(true);
    const onPointerCancel = () => finishDrag(false);
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape" && started) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        finishDrag(false);
      }
    };

    projectDragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKeyDown, true);
  };

  useEffect(() => {
    const hasOpenPopover = notificationsOpen || searchOpen || projectMenu || editingProject || filterMenuOpen;
    if (!hasOpenPopover) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!sidebarRef.current?.contains(event.target as Node)) {
        closePopovers();
        setEditingProject(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (filterMenuOpen || projectMenu)) closePopovers();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [editingProject, filterMenuOpen, notificationsOpen, projectMenu, searchOpen]);

  useEffect(() => () => {
    if (previewCloseTimer.current !== null) window.clearTimeout(previewCloseTimer.current);
  }, []);

  useSyncOnChange([searchRequested], () => {
    if (!searchRequested) return;
    setSearchOpen(true);
    setNotificationsOpen(false);
    setProjectMenu(null);
  });
  useEffect(() => {
    if (!searchRequested) return;
    // The search may already be open with focus elsewhere, where autoFocus would not fire again.
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
    onSearchRequestHandled?.();
  }, [onSearchRequestHandled, searchRequested]);

  useEffect(() => {
    const reload = () => void loadProjectConfigs();
    window.addEventListener("qianji:projects-changed", reload);
    return () => window.removeEventListener("qianji:projects-changed", reload);
  }, [loadProjectConfigs]);

  useSyncOnChange([currentSessionFile, sessions], () => {
    if (!currentSessionFile || expandedForSession === currentSessionFile) return;
    const activeSession = sessions.find((session) => sameLocalPath(session.file, currentSessionFile));
    if (!activeSession) return;
    setExpandedForSession(currentSessionFile);
    setProjectCollapsed(activeSession.cwd, false);
  });

  const renderThreadRow = (session: SessionInfo) => {
    const running = runningSessionFiles.some((file) => sameLocalPath(file, session.file));
    const approval = approvalSessionFiles.some((file) => sameLocalPath(file, session.file));
    const active = !newTaskActive && sameLocalPath(session.file, currentSessionFile);
    const pinned = pinnedSessionFiles.includes(session.file);
    const status = approval ? "approval" : running ? "running" : active ? "active" : "idle";
    const snippet = trimmedQuery ? snippetByFile.get(session.file) : undefined;
    const openTargetSession = () => {
      closePopovers();
      setQuery("");
      setProjectCollapsed(session.cwd, false);
      onOpenSession(session);
    };
    return (
      <div
        className={`thread-row-shell ${active ? "active" : ""}${snippet ? " has-snippet" : ""}`}
        key={session.file}
        onMouseEnter={(event) => showThreadPreview(session, event.currentTarget)}
        onMouseLeave={schedulePreviewClose}
      >
        <button
          type="button"
          className={`thread-row ${active ? "active" : ""}`}
          onClick={openTargetSession}
          title={sessionTitle(session)}
        >
          <span
            className="thread-status"
            data-status={status}
            title={approval ? "等待审批" : running ? "运行中" : undefined}
          />
          <span className="thread-title">{sessionTitle(session)}</span>
          {approval
            ? <span className="thread-row-time thread-row-badge">待审批</span>
            : <span className="thread-row-time">{compactRelativeTime(session)}</span>}
        </button>
        {snippet && (
          <button
            type="button"
            className="thread-search-snippet"
            onClick={openTargetSession}
            title={snippet}
          >
            {snippet}
          </button>
        )}
        <div className="thread-row-actions">
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
  };

  return (
    <aside
      className={`sidebar codex-sidebar${hoverPreview ? " sidebar-hover-preview" : ""}${draggingWorkspace ? " is-reordering-projects" : ""}`}
      data-slot="sidebar"
      data-sidebar-mode={hoverPreview ? "preview" : "pinned"}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
      ref={sidebarRef}
    >
      <div className="sidebar-brand-row" data-dsh-claude-search-row="">
        <button
          type="button"
          className="codex-brand"
          onClick={() => {
            onNewSession();
          }}
          title="千机"
        >
          <span
            className="dsh-claude-brand-mark"
            style={{ backgroundImage: `url("${QIANJI_BRAND_MARK_SVG}")` }}
            aria-hidden="true"
          />
          <span className="codex-brand-name">千机</span>
        </button>

        <div className="sidebar-brand-actions">
          <button
            type="button"
            className={`icon-button ${searchOpen || query ? "active" : ""}`}
            title={query ? `搜索：${query} (Ctrl+K)` : "搜索会话与项目 (Ctrl+K)"}
            aria-label="搜索会话与项目"
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((value) => !value);
              setNotificationsOpen(false);
              setProjectMenu(null);
            }}
          >
            <Search size={15} strokeWidth={1.7} />
          </button>
          <button
            type="button"
            className={`icon-button notification-button ${notificationsOpen ? "active" : ""}`}
            title="通知"
            aria-label="通知"
            aria-expanded={notificationsOpen}
            onClick={() => {
              setNotificationsOpen((value) => !value);
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
            ref={searchInputRef}
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
            placeholder="搜索会话标题、正文或项目…"
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
          <Plus size={15} strokeWidth={1.85} aria-hidden="true" />
          <span className="dsh-claude-new-session-label">新会话</span>
          {newChatShortcut && (
            <span className="dsh-claude-new-session-shortcut" aria-hidden="true">
              {newChatShortcut}
            </span>
          )}
        </button>
        <button type="button" className={`nav-item ${activeHub === "scheduled" ? "active" : ""}`} onClick={() => { closePopovers(); onOpenScheduled(); }}>
          <Clock3 size={15} strokeWidth={1.75} />
          <span>定时任务</span>
        </button>
      </nav>

      <div className="sidebar-projects-header" data-ws-view={workspaceView}>
        {workspaceView === "archived" ? (
          <button
            type="button"
            className="sidebar-projects-back"
            title="返回会话列表"
            onClick={() => setWorkspaceView("active")}
          >
            <ChevronLeft size={13} strokeWidth={1.8} />
            <span>已归档</span>
          </button>
        ) : (
          <span className="sidebar-projects-label">{groupMode === "recent" ? "最近" : "工作区"}</span>
        )}
        <div className="sidebar-projects-tools">
          <button
            type="button"
            className={filterMenuOpen ? "active" : ""}
            title="筛选与分组"
            aria-label="筛选与分组"
            aria-expanded={filterMenuOpen}
            onClick={(event) => {
              event.stopPropagation();
              const open = !filterMenuOpen;
              closePopovers();
              setFilterMenuOpen(open);
            }}
          >
            <ListFilter size={14} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            title="打开项目文件夹"
            aria-label="打开项目文件夹"
            onClick={() => { closePopovers(); onPickFolder(); }}
          >
            <FolderPlus size={14} strokeWidth={1.8} />
          </button>
        </div>
        {filterMenuOpen && (
          <div className="sidebar-popover sidebar-filter-menu" data-sidebar-popover role="menu">
            <div className="sidebar-popover-caption">分组方式</div>
            {([["project", "按项目"], ["recent", "按时间"]] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="menuitemradio"
                aria-checked={workspaceView === "active" && groupMode === mode}
                onClick={() => { setGroupMode(mode); setWorkspaceView("active"); setFilterMenuOpen(false); }}
              >
                <span>{label}</span>
                {workspaceView === "active" && groupMode === mode && <Check size={14} />}
              </button>
            ))}
            <div className="sidebar-popover-separator" />
            <button
              type="button"
              role="menuitemradio"
              aria-checked={workspaceView === "archived"}
              onClick={() => { setWorkspaceView(workspaceView === "archived" ? "active" : "archived"); setFilterMenuOpen(false); }}
            >
              <span>已归档会话</span>
              {workspaceView === "archived" && <Check size={14} />}
            </button>
          </div>
        )}
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
                        void agent.restoreSession(session.file).then(() => {
                          void archivedSessionsQuery.refetch();
                          onSessionRestored();
                          window.dispatchEvent(new Event("qianji:projects-changed"));
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
                        void agent.deleteSession(session.file).then(() => {
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
        ) : groupMode === "recent" ? (
          <div className="thread-list thread-list-recent">
            {(recentExpanded || query.trim() ? recentSessions : recentSessions.slice(0, VISIBLE_RECENT_THREADS)).map(renderThreadRow)}
            {!query.trim() && recentSessions.length > VISIBLE_RECENT_THREADS && (
              <button type="button" className="expand-threads" onClick={() => setRecentExpanded((value) => !value)}>
                {recentExpanded ? "收起" : `展开其余 ${recentSessions.length - VISIBLE_RECENT_THREADS} 个会话`}
              </button>
            )}
          </div>
        ) : groups.map(([workspace, chats]) => {
          const collapsed = !query.trim() && collapsedProjectPaths.some((path) => pathsEqual(path, workspace));
          const expanded = Boolean(query.trim()) || expandedProjects[workspace];
          const visibleChats = expanded ? chats : chats.slice(0, VISIBLE_THREADS_PER_PROJECT);
          const hiddenChatCount = chats.length - VISIBLE_THREADS_PER_PROJECT;
          const projectPinned = projectConfig(workspace).pinned;
          const isEditing = editingProject === workspace;
          // A collapsed project still has to say when one of its sessions needs the user.
          const projectStatus = chats.some((session) => approvalSessionFiles.some((file) => sameLocalPath(file, session.file)))
            ? "approval"
            : chats.some((session) => runningSessionFiles.some((file) => sameLocalPath(file, session.file)))
              ? "running"
              : null;
          const isDragging = draggingWorkspace !== null && pathsEqual(draggingWorkspace, workspace);
          const dropPosition = projectDropTarget && pathsEqual(projectDropTarget.workspace, workspace)
            ? projectDropTarget.position
            : undefined;
          return (
            <section
              className={`project-block${cwd && pathsEqual(workspace, cwd) ? " is-current" : ""}${isDragging ? " is-dragging" : ""}`}
              data-workspace={workspace}
              data-pinned={projectPinned ? "true" : "false"}
              data-drop-position={dropPosition}
              key={workspace}
            >
              <div
                className="project-header-row"
                onPointerDown={(event) => startProjectDrag(event, workspace, projectPinned)}
              >
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
                      onClick={(event) => {
                        if (suppressProjectClickRef.current) {
                          suppressProjectClickRef.current = false;
                          event.preventDefault();
                          event.stopPropagation();
                          return;
                        }
                        closePopovers();
                        setProjectCollapsed(workspace, false);
                        onOpenProject(workspace);
                      }}
                    >
                      <Folder size={15} strokeWidth={1.7} />
                      <span className="project-name">{displayProjectName(workspace)}</span>
                      {collapsed && projectStatus && (
                        <span
                          className="thread-status project-status"
                          data-status={projectStatus}
                          title={projectStatus === "approval" ? "有会话等待审批" : "有会话正在运行"}
                        />
                      )}
                      {collapsed && chats.length > 0 && <span className="project-count">{chats.length}</span>}
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
                {visibleChats.map(renderThreadRow)}
                {!query.trim() && hiddenChatCount > 0 && (
                  <button
                    type="button"
                    className="expand-threads"
                    onClick={() => setExpandedProjects((current) => ({ ...current, [workspace]: !current[workspace] }))}
                  >
                    {expanded ? "收起" : `展开其余 ${hiddenChatCount} 个会话`}
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
        <button
          type="button"
          className="footer-account dsh-claude-account-btn"
          onClick={() => {
            closePopovers();
            onOpenSettings("general");
          }}
          title={settingsShortcut ? `设置 (${settingsShortcut})` : "设置"}
          aria-label="设置"
        >
          <Settings size={15} strokeWidth={1.7} aria-hidden="true" />
          <span className="dsh-claude-account-user">设置</span>
          {settingsShortcut && <span className="sidebar-footer-shortcut" aria-hidden="true">{settingsShortcut}</span>}
        </button>
      </div>
    </aside>
  );
}
