import assert from "node:assert/strict";
import { validateDesktopHooks } from "../src-tauri/resources/pidesktop-hooks-core";

const hooks = validateDesktopHooks([{
  id: " verify ",
  name: " Verify ",
  enabled: true,
  event: "tool_call",
  command: " npm test ",
  timeoutSeconds: 12.4,
  blocking: true,
}]);
assert.deepEqual(hooks[0], {
  id: "verify",
  name: "Verify",
  enabled: true,
  event: "tool_call",
  command: "npm test",
  timeoutSeconds: 12,
  blocking: true,
});
assert.equal(validateDesktopHooks([{ ...hooks[0], event: "agent_settled", blocking: true }])[0].blocking, false);
assert.throws(() => validateDesktopHooks([{ ...hooks[0], timeoutSeconds: 0 }]), /between 1 and 300/);
assert.throws(() => validateDesktopHooks([hooks[0], hooks[0]]), /Duplicate/);

console.log("hooks tests passed");
