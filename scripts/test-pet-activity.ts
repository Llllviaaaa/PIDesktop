import assert from "node:assert/strict";
import { buildPetActivities, petStatusToAnimation } from "../src/lib/petActivity";
import type { RuntimeState } from "../src/storeTypes";
import type { AppNotification, SessionInfo } from "../src/types";

const sessions: SessionInfo[] = [{
  file: "C:\\workspace\\sessions\\alpha.jsonl",
  sessionId: "alpha",
  cwd: "C:\\workspace",
  name: "Alpha task",
  messageCount: 4,
}];

const runtimes: Record<string, RuntimeState> = {
  alpha: {
    runtimeId: "alpha",
    cwd: "C:\\workspace",
    sessionFile: sessions[0].file,
    isStreaming: true,
    status: "running",
    extensionRequest: null,
    updatedAt: 20,
  },
  beta: {
    runtimeId: "beta",
    cwd: "C:\\beta",
    sessionFile: "C:\\beta\\beta.jsonl",
    isStreaming: false,
    status: "running",
    extensionRequest: {
      type: "extension_ui_request",
      id: "approval-1",
      method: "confirm",
      title: "需要批准命令",
      message: "允许执行？",
    },
    updatedAt: 30,
  },
};

const notifications: AppNotification[] = [{
  id: "done-alpha",
  kind: "completion",
  title: "任务已完成",
  body: "Alpha task",
  cwd: "C:\\workspace",
  sessionFile: sessions[0].file,
  createdAt: 40,
  read: false,
}];

const activities = buildPetActivities({
  runtimes,
  notifications,
  sessions,
  current: {
    id: "current:blocked",
    status: "blocked",
    title: "Blocked task",
    body: "连接已断开",
    cwd: "C:\\blocked",
    sessionFile: null,
    updatedAt: 50,
  },
});

assert.deepEqual(activities.map((item) => item.status), ["needs-input", "blocked", "ready"]);
assert.equal(activities.find((item) => item.title === "Alpha task")?.status, "ready");
assert.equal(petStatusToAnimation(activities[0]?.status), "waiting");
assert.equal(petStatusToAnimation(undefined), "idle");

console.log("pet activity tests passed");
