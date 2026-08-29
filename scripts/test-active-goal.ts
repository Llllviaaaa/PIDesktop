import assert from "node:assert/strict";
import { deriveActiveGoal, goalToolKind, isGoalToolCall } from "../src/lib/activeGoal";
import type { UiMessage, UiToolCall } from "../src/types";

const call = (overrides: Partial<UiToolCall>): UiToolCall => ({
  id: "goal-call",
  name: "create_goal",
  args: { objective: "Finish the goal lifecycle" },
  running: false,
  ...overrides,
});

const assistant = (id: string, toolCalls: UiToolCall[]): UiMessage => ({
  id,
  role: "assistant",
  content: "",
  timestamp: 1_000,
  toolCalls,
});

assert.equal(goalToolKind("create_goal"), "create");
assert.equal(goalToolKind("functions.update_goal"), "update");
assert.equal(goalToolKind("mcp__codex__getGoal"), "get");
assert.equal(isGoalToolCall(call({ name: "read" })), false);

const active = deriveActiveGoal([
  assistant("create", [call({ args: { objective: "Ship it", token_budget: 5_000 }, startedAt: 500 })]),
]);
assert.equal(active?.objective, "Ship it");
assert.equal(active?.status, "active");
assert.equal(active?.tokenBudget, 5_000);

const completed = deriveActiveGoal([
  assistant("create", [call({})]),
  assistant("complete", [call({ id: "complete-call", name: "update_goal", args: { status: "complete" } })]),
]);
assert.equal(completed, null);

const completing = deriveActiveGoal([
  assistant("create", [call({})]),
  assistant("complete", [call({ id: "complete-call", name: "update_goal", args: { status: "complete" }, running: true })]),
]);
assert.equal(completing?.status, "active");

const failedCompletion = deriveActiveGoal([
  assistant("create", [call({})]),
  assistant("complete", [call({ id: "complete-call", name: "update_goal", args: { status: "complete" }, isError: true })]),
]);
assert.equal(failedCompletion?.status, "active");

const replacement = deriveActiveGoal([
  assistant("first", [call({ args: { objective: "First" } })]),
  assistant("complete", [call({ name: "update_goal", args: { status: "complete" } })]),
  assistant("second", [call({ id: "second-goal", args: { objective: "Second" } })]),
]);
assert.equal(replacement?.objective, "Second");

console.log("active goal tests passed");
