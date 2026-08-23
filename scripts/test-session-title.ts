import assert from "node:assert/strict";
import { activeSessionTitle, sessionTitle } from "../src/lib/sessionTitle.ts";
import type { SessionInfo } from "../src/types.ts";

const session: SessionInfo = {
  file: "D:\\sessions\\task.jsonl",
  sessionId: "01a0288a-full-id",
  cwd: "D:\\workspace",
  firstMessage: "按照paseo",
  messageCount: 4,
};

assert.equal(sessionTitle(session), "按照paseo");
assert.equal(activeSessionTitle({
  sessions: [session],
  sessionFile: "d:/sessions/task.jsonl",
  sessionId: session.sessionId,
  sessionName: null,
}), "按照paseo", "header should use the same first-message fallback as the sidebar");

assert.equal(activeSessionTitle({
  sessions: [session],
  sessionFile: session.file,
  sessionId: session.sessionId,
  sessionName: "显式任务名称",
}), "显式任务名称", "runtime session name should override the first message");

assert.equal(activeSessionTitle({
  sessions: [],
  sessionFile: session.file,
  sessionId: session.sessionId,
  sessionName: null,
  firstMessage: "按照paseo",
}), "按照paseo", "live messages should cover metadata refresh delays");

assert.equal(activeSessionTitle({
  sessions: [],
  sessionId: session.sessionId,
  sessionName: null,
}), "任务 01a0288a", "task id remains the final fallback");

console.log("session-title: sidebar and header title fallbacks are consistent");
