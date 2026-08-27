import {
  appendNotification,
  parseNotifications,
} from "../src/lib/notificationCenter.ts";
import { usePiStore } from "../src/store.ts";

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

usePiStore.setState({
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
usePiStore.getState().handleEvent("runtime-test", { type: "agent_end" });
assert(usePiStore.getState().notifications[0]?.kind === "completion", "agent completion must enter the notification center");

const request = {
  type: "extension_ui_request" as const,
  id: "confirm-1",
  method: "confirm" as const,
  title: "允许执行命令？",
  message: "npm test",
};
usePiStore.getState().handleEvent("runtime-test", request);
usePiStore.getState().handleEvent("runtime-test", request);
assert(usePiStore.getState().notifications.filter((item) => item.id.endsWith("confirm-1")).length === 1,
  "duplicate approval events must produce one notification");
assert(usePiStore.getState().notifications[0]?.kind === "approval", "confirmation requests must be classified as approvals");

usePiStore.getState().handleEvent("runtime-test", {
  type: "extension_ui_request",
  id: "input-1",
  method: "input",
  title: "请选择分支",
});
assert(usePiStore.getState().notifications[0]?.kind === "question", "input requests must be classified as questions");

console.log("notification center tests passed");
