import { sameLocalPath } from "../../lib/pathIdentity";
import { sessionTitle } from "../../lib/sessionTitle";
import {
  sortSidebarProjectGroups,
  sortSidebarSessions,
} from "../../lib/sidebarProjectOrder";
import type { AppNotification, ProjectConfig, SessionInfo, SessionSearchMatch } from "../../types";
import type { SettingsPage } from "../SettingsModal";

export type SidebarHub = "scheduled" | null;
export type SidebarGroupMode = "project" | "recent";

export interface SidebarProps {
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
  onSessionRestored: () => void;
  onOpenProjectFolder: (workspace: string) => void;
  onCreateWorktree: (workspace: string) => void | Promise<void>;
  onArchiveProject: (workspace: string, sessions: SessionInfo[]) => void | Promise<void>;
  onOpenSettings: (page: SettingsPage) => void;
  onPickFolder: () => void;
  settingsShortcut?: string;
  newChatShortcut?: string;
  toggleSidebarShortcut?: string;
  searchRequested?: boolean;
  onSearchRequestHandled?: () => void;
  hoverPreview?: boolean;
  onPinSidebar?: () => void;
  onCloseSidebar?: () => void;
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
}

export interface PositionedProjectMenu {
  workspace: string;
  top: number;
}

export interface PositionedThreadPreview {
  session: SessionInfo;
  top: number;
}

export interface ProjectDropTarget {
  workspace: string;
  position: "before" | "after";
}

export const PINNED_SESSIONS_KEY = "qianji:pinned-sessions";
export const COLLAPSED_PROJECTS_KEY = "qianji:collapsed-projects";
export const SIDEBAR_SESSION_ORDER_KEY = "qianji:sidebar-session-order";
export const SIDEBAR_PROJECT_ORDER_KEY = "qianji:sidebar-project-order";
export const GROUP_MODE_KEY = "qianji:sidebar-group-mode";
export const NO_PROJECTS: ProjectConfig[] = [];
export const VISIBLE_THREADS_PER_PROJECT = 5;
export const VISIBLE_RECENT_THREADS = 15;

export function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((file, index) => file === right[index]);
}

export function readStringList(key: string): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || "[]") as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function repoName(path: string): string {
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

export function pathsEqual(a: string, b: string): boolean {
  return sameLocalPath(a, b);
}

export function relativeTime(session: SessionInfo): string {
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

export function compactRelativeTime(session: SessionInfo): string {
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

export function readGroupMode(): SidebarGroupMode {
  try {
    return window.localStorage.getItem(GROUP_MODE_KEY) === "recent" ? "recent" : "project";
  } catch {
    return "project";
  }
}

export function sessionTimestamp(session: SessionInfo): number {
  return session.updatedAt || (session.createdAt ? Date.parse(session.createdAt) : 0) || 0;
}

export function buildSidebarProjectGroups(options: {
  query: string;
  sessions: readonly SessionInfo[];
  projectConfigs: readonly ProjectConfig[];
  snippetByFile: ReadonlyMap<string, string>;
  workspaceView: "active" | "archived";
  searchHits: readonly SessionSearchMatch[] | undefined;
  pinnedSessionFiles: readonly string[];
  stableSessionOrder: readonly string[];
  workspaceOrder: readonly string[];
}): Array<[string, SessionInfo[]]> {
  const {
    query,
    sessions,
    projectConfigs,
    snippetByFile,
    workspaceView,
    searchHits,
    pinnedSessionFiles,
    stableSessionOrder,
    workspaceOrder,
  } = options;
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
  const appendSession = (key: string, session: SessionInfo) => {
    let bucket = result.get(key);
    if (!bucket) {
      bucket = [];
      result.set(key, bucket);
    }
    bucket.push(session);
  };

  for (const session of sessions) {
    seenFiles.add(session.file);
    const config = projectConfigs.find((project) => pathsEqual(project.path, session.cwd));
    if (config?.hidden) continue;
    const title = sessionTitle(session);
    const projectName = config?.name.trim() || repoName(session.cwd);
    const haystack = `${title} ${projectName} ${session.cwd}`.toLowerCase();
    if (normalizedQuery && !haystack.includes(normalizedQuery) && !snippetByFile.has(session.file)) continue;
    appendSession(canonicalKey(session.cwd), session);
  }
  if (normalizedQuery && workspaceView === "active") {
    for (const hit of searchHits ?? []) {
      if (seenFiles.has(hit.session.file)) continue;
      const config = projectConfigs.find((project) => pathsEqual(project.path, hit.session.cwd));
      if (config?.hidden) continue;
      appendSession(canonicalKey(hit.session.cwd), hit.session);
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
    result.set(key, sortSidebarSessions(chats, [...pinnedSessionFiles], [...stableSessionOrder]));
  }
  return sortSidebarProjectGroups(
    [...result.entries()],
    [...projectConfigs],
    [...stableSessionOrder],
    [...workspaceOrder],
  );
}
