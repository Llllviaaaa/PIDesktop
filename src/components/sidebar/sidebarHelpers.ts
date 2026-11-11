import { sameLocalPath } from "../../lib/pathIdentity";
import type { AppNotification, ProjectConfig, SessionInfo } from "../../types";
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
  searchRequested?: boolean;
  onSearchRequestHandled?: () => void;
  hoverPreview?: boolean;
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
