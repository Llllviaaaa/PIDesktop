import type { AppNotification } from "../types";

const NOTIFICATION_STORAGE_KEY = "pid-desktop:notifications:v1";
const MAX_NOTIFICATIONS = 50;

export type NotificationDraft = Omit<AppNotification, "createdAt" | "read"> & {
  createdAt?: number;
  read?: boolean;
};

function isNotification(value: unknown): value is AppNotification {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AppNotification>;
  return typeof item.id === "string"
    && ["completion", "approval", "question"].includes(item.kind ?? "")
    && typeof item.title === "string"
    && typeof item.body === "string"
    && typeof item.cwd === "string"
    && (typeof item.sessionFile === "string" || item.sessionFile === null)
    && typeof item.createdAt === "number"
    && Number.isFinite(item.createdAt)
    && typeof item.read === "boolean";
}

export function parseNotifications(value: unknown): AppNotification[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isNotification)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_NOTIFICATIONS);
}

export function appendNotification(
  notifications: AppNotification[],
  draft: NotificationDraft,
  now = Date.now(),
): AppNotification[] {
  if (notifications.some((item) => item.id === draft.id)) return notifications;
  return parseNotifications([{ ...draft, createdAt: draft.createdAt ?? now, read: draft.read ?? false }, ...notifications]);
}

export function readStoredNotifications(): AppNotification[] {
  if (typeof window === "undefined") return [];
  try {
    return parseNotifications(JSON.parse(window.localStorage.getItem(NOTIFICATION_STORAGE_KEY) || "[]"));
  } catch {
    return [];
  }
}

export function persistNotifications(notifications: AppNotification[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify(parseNotifications(notifications)));
  } catch {
    // Notification delivery must not interrupt the task when storage is unavailable.
  }
}
