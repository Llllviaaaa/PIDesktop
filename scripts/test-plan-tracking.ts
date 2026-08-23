import assert from "node:assert/strict";
import { planWidgetLines, validatePlanState } from "../src-tauri/resources/pidesktop-plan-core";

const state = validatePlanState({
  explanation: "  implementation order  ",
  items: [
    { id: "inspect", text: " Inspect current behavior ", status: "completed" },
    { id: "build", text: "Build the change", status: "in_progress" },
    { id: "verify", text: "Verify behavior", status: "pending" },
  ],
});
assert.equal(state.explanation, "implementation order");
assert.deepEqual(planWidgetLines(state), [
  "计划 1/3",
  "[x] Inspect current behavior",
  "[>] Build the change",
  "[ ] Verify behavior",
]);
assert.throws(() => validatePlanState({ explanation: "", items: [
  { id: "a", text: "A", status: "in_progress" },
  { id: "b", text: "B", status: "in_progress" },
] }), /Only one/);
assert.throws(() => validatePlanState({ explanation: "", items: [
  { id: "a", text: "A", status: "pending" },
  { id: "a", text: "B", status: "pending" },
] }), /Duplicate/);

console.log("plan tracking tests passed");
