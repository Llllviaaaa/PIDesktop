/**
 * Pins the contract between src-tauri/src/error.rs and the renderer.
 * Run: npx vitest run test-errors.test.ts
 */
import assert from "node:assert/strict";
import { describeError, errorKind, isRetryable } from "../src/lib/errors";
import { test } from "vitest";

test("errors", async () => {
  // The exact shape AppError serialises to. See error.rs's serialisation test.
  const fromCommand = { kind: "git", message: "not a git repository" };
  assert.equal(describeError(fromCommand), "not a git repository", "the message is what the user reads");
  assert.equal(errorKind(fromCommand), "git");
  assert.equal(isRetryable(fromCommand), false, "a git failure will not fix itself on retry");

  const network = { kind: "network", message: "无法连接提供商模型接口: timed out" };
  assert.equal(isRetryable(network), true, "network failures are worth retrying");
  assert.equal(errorKind(network), "network");

  const spawned = { kind: "process", message: "模型目录后台任务失败: panicked" };
  assert.equal(isRetryable(spawned), true, "a dead worker can be started again");

  // Commands that have not been migrated still reject with a bare string.
  assert.equal(describeError("workspace no longer exists"), "workspace no longer exists");
  assert.equal(errorKind("workspace no longer exists"), null, "an unmigrated error has no kind");
  assert.equal(isRetryable("anything"), false, "unknown is never treated as retryable");

  // Anything else that can reach a catch block.
  assert.equal(describeError(new Error("boom")), "boom");
  assert.equal(describeError(new TypeError("bad argument")), "bad argument");
  assert.equal(describeError(null), "null", "a thrown null must still render something");
  assert.equal(describeError(undefined), "undefined");
  assert.equal(describeError(42), "42");

  // An object that only looks like an AppError must not be trusted.
  assert.equal(errorKind({ kind: "banana", message: "x" }), null, "unknown kinds are rejected");
  assert.equal(describeError({ kind: "banana", message: "x" }), "[object Object]", "and fall through to String()");
  assert.equal(errorKind({ message: "no kind" }), null);
  assert.equal(errorKind({ kind: "git" }), null, "a kind without a message is not an AppError");
});
