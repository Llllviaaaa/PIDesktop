/**
 * Covers the notification policy the store used to inline in its event reducer.
 * Run: npx --yes tsx scripts/test-event-notifications.ts
 */
import assert from "node:assert/strict";
import {
  completionNotification,
  isSilentUiRequest,
  projectLabelFromCwd,
  SILENT_UI_REQUEST_METHODS,
  uiRequestNotification,
} from "../src/lib/eventNotifications";
import type { ExtensionUIRequest } from "../src/types";

// Silent methods render inline and must never raise a notification.
for (const method of SILENT_UI_REQUEST_METHODS) {
  assert.equal(isSilentUiRequest(method), true, `${method} should stay silent`);
}
assert.equal(isSilentUiRequest("confirm"), false, "confirm must raise a notification");
assert.equal(isSilentUiRequest("input"), false, "input must raise a notification");

// A background runtime is identified by its workspace folder, not its session name.
assert.equal(projectLabelFromCwd("D:\\repo\\PIDesktop"), "PIDesktop", "Windows paths");
assert.equal(projectLabelFromCwd("/home/me/pi-desktop/"), "pi-desktop", "POSIX paths with a trailing slash");
assert.equal(projectLabelFromCwd(""), "后台任务", "an unknown workspace falls back to a generic label");

const background = completionNotification("runtime-a", {
  cwd: "D:\\repo\\PIDesktop",
  sessionFile: "session.jsonl",
}, true);
assert.equal(background.draft.kind, "completion");
assert.equal(background.draft.body, "PIDesktop", "background completions name the project");
assert.equal(background.osTitle, "Pi 后台任务已完成");
assert.equal(background.requiresApproval, false, "completions must not demand interaction");
assert.match(background.draft.id, /^runtime-a:completion:\d+$/, "ids stay unique per completion");

const foreground = completionNotification("runtime-a", {
  cwd: "D:\\repo\\PIDesktop",
  sessionFile: "session.jsonl",
  sessionName: "Fix the approval gate",
}, false);
assert.equal(foreground.draft.body, "Fix the approval gate", "the active session is named by its title");
assert.equal(foreground.osTitle, "Pi 已完成");

const unnamed = completionNotification("runtime-a", { cwd: "C:\\x", sessionFile: null }, false);
assert.equal(unnamed.draft.body, "本地编码任务已完成，可以开始检查。", "an unnamed session still reads as finished work");

const confirm = uiRequestNotification("runtime-b", {
  type: "extension_ui_request",
  id: "req-1",
  method: "confirm",
  title: "Allow command?",
  message: "npm test",
} as ExtensionUIRequest, { cwd: "D:\\repo\\PIDesktop", sessionFile: null }, true);
assert.ok(confirm, "a confirm request raises a notification");
assert.equal(confirm.draft.kind, "approval");
assert.equal(confirm.requiresApproval, true, "approvals stay on screen until acted on");
assert.equal(confirm.osTitle, "Pi 后台任务等待审批");
assert.equal(confirm.draft.body, "打开任务以确认本地操作。", "background approvals tell the user where to go");

const foregroundConfirm = uiRequestNotification("runtime-b", {
  type: "extension_ui_request",
  id: "req-1",
  method: "confirm",
  title: "Allow command?",
  message: "npm test",
} as ExtensionUIRequest, { cwd: "D:\\repo\\PIDesktop", sessionFile: null }, false);
assert.ok(foregroundConfirm);
assert.equal(foregroundConfirm.draft.body, "有一项本地操作正在等待你的决定。");
assert.equal(foregroundConfirm.osTitle, "Pi 需要审批");

const silent = uiRequestNotification("runtime-b", {
  type: "extension_ui_request",
  id: "req-2",
  method: "setStatus",
  extensionId: "pidesktop-browser",
  text: "loading",
} as unknown as ExtensionUIRequest, { cwd: "C:\\x", sessionFile: null }, true);
assert.equal(silent, null, "status updates must not reach the notification centre");

const question = uiRequestNotification("runtime-c", {
  type: "extension_ui_request",
  id: "req-3",
  method: "input",
  title: "",
  placeholder: "Which branch?",
} as ExtensionUIRequest, { cwd: "C:\\x", sessionFile: null }, true);
assert.ok(question);
assert.equal(question.draft.kind, "question");
assert.equal(question.draft.title, "需要输入", "an untitled input falls back to a generic prompt, not the placeholder");

console.log("event-notifications: all assertions passed");
