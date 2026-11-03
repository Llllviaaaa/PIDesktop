import {
  appendNotification,
  parseNotifications,
} from "../src/lib/notificationCenter.ts";
import { useAppStore } from "../src/store/index.ts";
import { test } from "vitest";

test("notification center", async () => {
  function assert(condition: unknown, message: string): void {
    if (!condition) throw new Error(message);
  }

  const base = {
    kind: "completion" as const,
    title: "任务已完成",
    body: "PIDesktop",
    cwd: "D:\\repo",
    sessionFile: "D:\\repo\\session.jsonl",
  };

  const first = appendNotification([], { id: "done-1", ...base }, 100);
  assert(first.length === 1 && !first[0].read, "new notifications must be unread");

  const duplicate = appendNotification(first, { id: "done-1", ...base }, 200);
  assert(duplicate === first, "duplicate runtime events must not add a second notification");

  const second = appendNotification(first, {
    id: "question-1",
    ...base,
    kind: "question",
    title: "需要输入",
  }, 300);
  assert(second[0].id === "question-1", "newest notification must be shown first");

  const parsed = parseNotifications([
    ...second,
    { id: "invalid", kind: "running", createdAt: 400 },
    null,
  ]);
  assert(parsed.length === 2, "invalid or legacy running-state entries must be ignored");

  useAppStore.setState({
    runtimeId: "runtime-test",
    cwd: "D:\\repo",
    sessionFile: "D:\\repo\\session.jsonl",
    sessionName: "通知测试",
    notifications: [],
    settings: null,
    runtimes: {
      "runtime-test": {
        runtimeId: "runtime-test",
        cwd: "D:\\repo",
        sessionFile: "D:\\repo\\session.jsonl",
        isStreaming: true,
        status: "running",
        extensionRequest: null,
        updatedAt: 1,
      },
    },
  });
  useAppStore.getState().handleEvent("runtime-test", { type: "turn-end" });
  assert(useAppStore.getState().notifications[0]?.kind === "completion", "agent completion must enter the notification center");

  useAppStore.getState().markNotificationRead(useAppStore.getState().notifications[0].id);
  assert(useAppStore.getState().notifications.length === 0, "reading a notification must remove it from the center");

  useAppStore.getState().handleEvent("runtime-test", { type: "turn-end" });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { hasFocus: () => true, visibilityState: "visible" },
  });
  useAppStore.getState().setViewedSession("D:\\repo\\session.jsonl");
  assert(useAppStore.getState().notifications.length === 0, "viewing a session must clear its notifications");
  useAppStore.getState().handleEvent("runtime-test", { type: "turn-end" });
  assert(useAppStore.getState().notifications.length === 0, "a visible session must not receive a completion notification");
  useAppStore.getState().setViewedSession(null);

  const request = {
    type: "extension_ui_request" as const,
    id: "confirm-1",
    method: "confirm" as const,
    title: "允许执行命令？",
    message: "npm test",
  };
  useAppStore.getState().handleEvent("runtime-test", { type: "ui-request", request });
  useAppStore.getState().handleEvent("runtime-test", { type: "ui-request", request });
  assert(useAppStore.getState().notifications.filter((item) => item.id.endsWith("confirm-1")).length === 1,
    "duplicate approval events must produce one notification");
  assert(useAppStore.getState().notifications[0]?.kind === "approval", "confirmation requests must be classified as approvals");

  useAppStore.getState().handleEvent("runtime-test", {
    type: "ui-request",
    request: { type: "extension_ui_request", id: "input-1", method: "input", title: "请选择分支" },
  });
  assert(useAppStore.getState().notifications[0]?.kind === "question", "input requests must be classified as questions");
});
