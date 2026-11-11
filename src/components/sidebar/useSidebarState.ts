import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { agent } from "../../lib/agent";
import { sameLocalPath } from "../../lib/pathIdentity";
import { queryKeys } from "../../lib/queries";
import { sessionTitle } from "../../lib/sessionTitle";
import {
  reconcileSidebarOrder,
  sortSidebarProjectGroups,
  sortSidebarSessions,
  type SidebarOrder,
} from "../../lib/sidebarProjectOrder";
import type { AppNotification, ProjectConfig, SessionInfo } from "../../types";
import {
  COLLAPSED_PROJECTS_KEY,
  GROUP_MODE_KEY,
  NO_PROJECTS,
  pathsEqual,
  PINNED_SESSIONS_KEY,
  readGroupMode,
  readStringList,
  repoName,
  sameOrder,
  sessionTimestamp,
  SIDEBAR_PROJECT_ORDER_KEY,
  SIDEBAR_SESSION_ORDER_KEY,
  type PositionedProjectMenu,
  type PositionedThreadPreview,
  type SidebarGroupMode,
} from "./sidebarHelpers";
import { useProjectDragOrder } from "./useProjectDragOrder";

export interface UseSidebarStateOptions {
  sidebarRef: React.RefObject<HTMLElement | null>;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  sessions: SessionInfo[];
  currentSessionFile: string | null;
  notifications: AppNotification[];
  searchRequested: boolean;
  onSearchRequestHandled?: () => void;
}

export function useSidebarState({
  sidebarRef,
  searchInputRef,
  sessions,
  currentSessionFile,
  notifications,
  searchRequested,
  onSearchRequestHandled,
}: UseSidebarStateOptions) {
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
      // ignore storage errors
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
  const [expandedForSession, setExpandedForSession] = useState<string | null>(null);

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

  const visibleProjectPaths = useMemo(
    () => projectConfigs.filter((c) => !c.hidden && Boolean(c.path.trim())).map((c) => c.path),
    [projectConfigs],
  );
  const sidebarOrder = useMemo(
    () => reconcileSidebarOrder(persistedOrder, sessions, visibleProjectPaths),
    [persistedOrder, sessions, visibleProjectPaths],
  );
  const stableSessionOrder = sidebarOrder.sessions;

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

  const projectConfig = useCallback(
    (workspace: string): ProjectConfig => projectConfigs.find((project) => pathsEqual(project.path, workspace)) ?? {
      path: workspace,
      name: "",
      pinned: false,
      hidden: false,
    },
    [projectConfigs],
  );
  const displayProjectName = useCallback(
    (workspace: string) => projectConfig(workspace).name.trim() || repoName(workspace),
    [projectConfig],
  );

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

  const closePopovers = useCallback(() => {
    setNotificationsOpen(false);
    setSearchOpen(false);
    setProjectMenu(null);
    setThreadPreview(null);
    setFilterMenuOpen(false);
  }, []);

  const drag = useProjectDragOrder({
    sidebarRef,
    trimmedQuery,
    groups,
    projectConfig,
    sidebarOrder,
    setPersistedOrder,
    closePopovers,
  });

  const togglePinnedSession = useCallback((file: string) => {
    setPinnedSessionFiles((current) => {
      const next = current.includes(file) ? current.filter((item) => item !== file) : [...current, file];
      window.localStorage.setItem(PINNED_SESSIONS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const updateProjectConfig = async (workspace: string, changes: Partial<ProjectConfig>) => {
    const next = { ...projectConfig(workspace), ...changes, path: workspace };
    setProjectConfigs((current) => {
      const existingIndex = current.findIndex((project) => pathsEqual(project.path, workspace));
      if (existingIndex < 0) return [...current, next];
      return current.map((project, index) => (index === existingIndex ? next : project));
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
    setProjectMenu((current) => (current?.workspace === workspace ? null : { workspace, top }));
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
      .then((snapshot) => setBranchByWorkspace((current) => ({ ...current, [workspace]: snapshot.branch || "本地" })))
      .catch(() => setBranchByWorkspace((current) => ({ ...current, [workspace]: "本地" })));
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
    setProjectConfigs((current) => (current.some((project) => pathsEqual(project.path, workspace))
      ? current.map((project) => (pathsEqual(project.path, workspace) ? { ...project, hidden: true } : project))
      : [...current, { path: workspace, name: "", pinned: false, hidden: true }]));
    try {
      await agent.removeLocalProject(workspace);
    } catch {
      await loadProjectConfigs();
    }
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
  }, [closePopovers, editingProject, filterMenuOpen, notificationsOpen, projectMenu, searchOpen, sidebarRef]);

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
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
    onSearchRequestHandled?.();
  }, [onSearchRequestHandled, searchInputRef, searchRequested]);

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

  return {
    query, setQuery, trimmedQuery, searchOpen, setSearchOpen,
    notificationsOpen, setNotificationsOpen, workspaceView, setWorkspaceView, groupMode, setGroupMode,
    recentExpanded, setRecentExpanded, filterMenuOpen, setFilterMenuOpen, expandedProjects, setExpandedProjects,
    collapsedProjectPaths, pinnedSessionFiles, togglePinnedSession, projectMenu, setProjectMenu,
    threadPreview, setThreadPreview, branchByWorkspace, editingProject, setEditingProject, aliasDraft, setAliasDraft,
    archivedSessionsQuery, archivedSessions, snippetByFile, groups, recentSessions, unreadNotificationCount,
    projectConfig, displayProjectName, setProjectCollapsed, closePopovers, updateProjectConfig,
    openProjectMenu, showThreadPreview, schedulePreviewClose, keepPreviewOpen,
    beginProjectRename, finishProjectRename, removeProject, ...drag,
  };
}
