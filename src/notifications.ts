import type { AppNotification, Toast } from "./types";
import { redactSensitiveText } from "./lib/redact";
import {
  appendNotification,
  persistNotifications,
  type NotificationDraft,
} from "./lib/notificationCenter";
import type { NotificationPlan } from "./lib/eventNotifications";

/** Toast and notification operations, kept out of the conversation module.
 *  The shell store still owns the fields so existing selectors keep working. */
export interface NoticeState {
  toasts: Toast[];
  notifications: AppNotification[];
}

export interface NoticeDeps {
  get: () => NoticeState & { settings: { notificationsEnabled: boolean; notifyOnApproval: boolean; notifyOnCompletion: boolean; notifyOnlyWhenUnfocused: boolean } | null };
  set: (partial: Partial<NoticeState> | ((state: NoticeState) => Partial<NoticeState>)) => void;
  dismissToast: (id: string) => void;
  sessionIsBeingViewed: (sessionFile: string | null) => boolean;
}

type NoticeApi = ReturnType<typeof createNotices>;
let active: NoticeApi | null = null;

/** Components that only need a toast call this. The shell store registers the implementation. */
export function showToast(message: string, kind: Toast["kind"] = "info") {
  active?.showToast(message, kind);
}

export function createNotices(deps: NoticeDeps) {
  const systemNotifications = new Map<string, Notification>();

  const showToast = (message: string, kind: Toast["kind"] = "info") => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const safeMessage = redactSensitiveText(message);
    let added = false;
    deps.set((state) => {
      if (state.toasts.some((item) => item.kind === kind && item.message === safeMessage)) return state;
      added = true;
      return { toasts: [...state.toasts.slice(-3), { id, message: safeMessage, kind }] };
    });
    if (added) window.setTimeout(() => deps.dismissToast(id), 5500);
  };

  const closeSystemNotification = (id: string) => {
    systemNotifications.get(id)?.close();
    systemNotifications.delete(id);
  };

  const removeNotifications = (predicate: (notification: NotificationDraft) => boolean) => {
    const removedIds: string[] = [];
    deps.set((state) => {
      const notifications = state.notifications.filter((item) => {
        if (!predicate(item)) return true;
        removedIds.push(item.id);
        return false;
      });
      if (notifications.length === state.notifications.length) return state;
      persistNotifications(notifications);
      return { notifications };
    });
    removedIds.forEach(closeSystemNotification);
  };

  const addNotification = (notification: NotificationDraft): boolean => {
    if (deps.sessionIsBeingViewed(notification.sessionFile)) return false;
    let added = false;
    deps.set((state) => {
      const notifications = appendNotification(state.notifications, {
        ...notification,
        title: redactSensitiveText(notification.title),
        body: redactSensitiveText(notification.body),
      });
      if (notifications === state.notifications) return state;
      added = true;
      persistNotifications(notifications);
      return { notifications };
    });
    return added;
  };

  const notify = (id: string, title: string, body: string, approval = false) => {
    const settings = deps.get().settings;
    if (!settings?.notificationsEnabled) return;
    if (approval ? !settings.notifyOnApproval : !settings.notifyOnCompletion) return;
    if (settings.notifyOnlyWhenUnfocused && document.hasFocus()) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    closeSystemNotification(id);
    const notification = new Notification(redactSensitiveText(title), { body: redactSensitiveText(body) });
    systemNotifications.set(id, notification);
    notification.onclose = () => systemNotifications.delete(id);
  };

  const raise = (plan: NotificationPlan | null) => {
    if (!plan) return;
    if (addNotification(plan.draft)) {
      notify(plan.draft.id, plan.osTitle, plan.osBody, plan.requiresApproval);
    }
  };

  const api = { showToast, addNotification, raise, removeNotifications };
  active = api;
  return api;
}
