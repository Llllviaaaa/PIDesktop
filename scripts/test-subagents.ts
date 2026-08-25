import assert from "node:assert/strict";
import { normalizeSubagentTasks, subagentPrompt } from "../src-tauri/resources/pidesktop-subagents-core";
import {
  deriveEnvSources,
  deriveSubagentActivities,
  deriveTaskOutputs,
  deriveTaskPlan,
  summarizeSubagents,
} from "../src/lib/envSources";
import type { UiMessage } from "../src/types";

const tasks = normalizeSubagentTasks([
  { label: " inspect ", task: " Read the store ", role: "explorer" },
  { task: "Find regressions", role: "reviewer" },
]);
assert.deepEqual(tasks.map(({ label, role }) => ({ label, role })), [
  { label: "inspect", role: "explorer" },
  { label: "reviewer-2", role: "reviewer" },
]);
assert.match(subagentPrompt(tasks[0]), /Do not make changes/);
assert.match(subagentPrompt({ label: "worker", task: "Implement", role: "worker" }), /Implement the delegated task/);
assert.throws(() => normalizeSubagentTasks([]), /At least one/);
assert.throws(() => normalizeSubagentTasks(Array.from({ length: 9 }, (_, index) => ({ task: String(index) }))), /At most 8/);

const ordinaryTools: UiMessage[] = [{
  id: "assistant-tools",
  role: "assistant",
  content: "",
  timestamp: 1,
  toolCalls: ["update_plan", "write", "browser", "bash", "read"].map((name, index) => ({
    id: `ordinary-${index}`,
    name,
    args: {},
    running: false,
    result: "done",
  })),
}];
assert.equal(deriveSubagentActivities(ordinaryTools).length, 0, "ordinary tools must not be counted as subagents");

const delegated: UiMessage[] = [{
  id: "assistant-delegate",
  role: "assistant",
  content: "",
  timestamp: 2,
  toolCalls: [{
    id: "delegate-1",
    name: "delegate_task",
    args: {
      permission: "read-only",
      tasks: [
        { label: "inspect", role: "explorer", task: "Inspect the store" },
        { label: "plan", role: "planner", task: "Plan the fix" },
        { label: "review", role: "reviewer", task: "Review the result" },
      ],
    },
    running: true,
    details: {
      completed: 1,
      total: 3,
      tasks: [
        { label: "inspect", role: "explorer", task: "Inspect the store", status: "completed" },
        { label: "plan", role: "planner", task: "Plan the fix", status: "running" },
        { label: "review", role: "reviewer", task: "Review the result", status: "queued" },
      ],
    },
  }],
}];
const activities = deriveSubagentActivities(delegated);
assert.deepEqual(activities.map(({ label, status }) => ({ label, status })), [
  { label: "inspect", status: "completed" },
  { label: "plan", status: "running" },
  { label: "review", status: "queued" },
]);
assert.deepEqual(summarizeSubagents(activities), { total: 3, queued: 1, running: 1, completed: 1, failed: 0 });

const completedDelegation: UiMessage[] = [{
  id: "assistant-completed-delegate",
  role: "assistant",
  content: "",
  timestamp: 3,
  toolCalls: [{
    id: "delegate-2",
    name: "delegate_task",
    args: { tasks: [{ task: "Implement", role: "worker" }, { task: "Review", role: "reviewer" }] },
    running: false,
    result: "1/2 subagents completed",
    details: {
      results: [
        { label: "worker-1", task: "Implement", role: "worker", ok: true },
        { label: "reviewer-2", task: "Review", role: "reviewer", ok: false },
      ],
    },
  }],
}];
assert.deepEqual(
  summarizeSubagents(deriveSubagentActivities(completedDelegation)),
  { total: 2, queued: 0, running: 0, completed: 1, failed: 1 },
  "historic delegate_task results should retain per-subagent completion state",
);

const taskActivity: UiMessage[] = [{
  id: "assistant-summary",
  role: "assistant",
  content: "done",
  timestamp: 4,
  toolCalls: [
    { id: "read-1", name: "read", args: { path: "src/App.tsx" }, running: false, result: "source" },
    { id: "read-2", name: "read", args: { path: "src/App.tsx" }, running: false, result: "source again" },
    { id: "write-1", name: "write", args: { path: "src/new.ts" }, running: false, result: "ok" },
    { id: "edit-1", name: "edit", args: { path: "src/App.tsx" }, running: false, result: "ok" },
    { id: "mcp-1", name: "mcp__docs__search", args: { query: "sidebar" }, running: false, result: "docs" },
    {
      id: "plan-1",
      name: "update_plan",
      args: {
        explanation: "Implementation order",
        items: [
          { id: "inspect", text: "Inspect", status: "completed" },
          { id: "build", text: "Build", status: "in_progress" },
        ],
      },
      running: false,
      result: "Plan updated",
    },
  ],
}];

const sources = deriveEnvSources(taskActivity);
assert.equal(sources.some((source) => source.label === "Pi"), false, "assistant messages must not create a fake Pi source");
assert.equal(sources.find((source) => source.id === "mcp-1")?.kind, "mcp", "MCP tools must not be folded into code search");
assert.deepEqual(
  sources.find((source) => source.detail === "src/App.tsx"),
  {
    id: "read-1",
    kind: "file",
    label: "App.tsx",
    detail: "src/App.tsx",
    activity: "updated",
    count: 3,
    running: false,
    failed: false,
  },
);
assert.deepEqual(
  deriveTaskOutputs(taskActivity).map(({ path, activity, count }) => ({ path, activity, count })),
  [
    { path: "src/App.tsx", activity: "updated", count: 1 },
    { path: "src/new.ts", activity: "written", count: 1 },
  ],
);
assert.deepEqual(deriveTaskPlan(taskActivity), {
  explanation: "Implementation order",
  completed: 1,
  steps: [
    { id: "inspect", text: "Inspect", status: "completed" },
    { id: "build", text: "Build", status: "in_progress" },
  ],
});

console.log("subagent tests passed");
