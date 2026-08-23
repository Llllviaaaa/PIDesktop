import assert from "node:assert/strict";
import { normalizeSubagentTasks, subagentPrompt } from "../src-tauri/resources/pidesktop-subagents-core";

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

console.log("subagent tests passed");
