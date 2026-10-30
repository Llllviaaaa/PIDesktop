/** Dialogs the agent asks, toasts and notifications. */
import { respondToExtension } from "../lib/agent";
import { readStoredNotifications } from "../lib/notificationCenter";
import { sameLocalPath } from "../lib/pathIdentity";
import type { GetState, SetState, StoreContext } from "./context";
import type { UiSlice } from "./types";

export function createUiSlice(set: SetState, get: GetState, ctx: StoreContext): UiSlice {
  return {
    extensionRequest: null,
    extensionStatuses: {},
    composerPrefill: null,
    toasts: [],
    notifications: readStoredNotifications(),
    answerExtension: async (response) => {
      const request = get().extensionRequest;
      const runtimeId = get().runtimeId;
      if (!request || !runtimeId) return;
      set({ extensionRequest: null });
      ctx.updateRuntime(runtimeId, { extensionRequest: null });
      await respondToExtension(runtimeId, request, response);
    },

    showToast: ctx.toast,

    addNotification: ctx.notices.addNotification,

    setViewedSession: (sessionFile) => {
      ctx.viewedSessionFile = sessionFile;
      if (!sessionFile || typeof document === "undefined" || !document.hasFocus()) return;
      ctx.notices.removeNotifications((notification) => sameLocalPath(notification.sessionFile, sessionFile));
    },

    markNotificationRead: (id) => {
      ctx.notices.removeNotifications((notification) => notification.id === id);
    },

    markAllNotificationsRead: () => {
      ctx.notices.removeNotifications(() => true);
    },

    dismissNotification: (id) => {
      ctx.notices.removeNotifications((notification) => notification.id === id);
    },
    clearComposerPrefill: () => set({ composerPrefill: null }),
    dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
  };
}
