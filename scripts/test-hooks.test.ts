import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDesktopHooks } from "../src-tauri/resources/pidesktop-hooks-core";
import registerHooks from "../src-tauri/resources/pidesktop-hooks";
import { test } from "vitest";

test("hooks", async () => {
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
});

test("blocking hook with a quoted command blocks the tool call", async () => {
  // A script file rather than `node -e`, whose inline code would itself trip cmd quoting.
  const dir = mkdtempSync(join(tmpdir(), "pidesktop-hooks-"));
  try {
    const script = join(dir, "deny.js");
    writeFileSync(script, "process.stderr.write('denied'); process.exit(3);\n");
    process.env.PIDESKTOP_HOOKS_CONFIG_B64 = Buffer.from(JSON.stringify([{
      id: "deny",
      name: "Deny",
      enabled: true,
      event: "tool_call",
      command: `"${process.execPath}" "${script}"`,
      timeoutSeconds: 30,
      blocking: true,
    }])).toString("base64");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    registerHooks({ on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, handler) } as never);
    const toolCall = handlers.get("tool_call");
    assert.ok(toolCall);
    const result = await toolCall(
      { toolCallId: "1", toolName: "bash", input: {} },
      { cwd: dir, hasUI: false },
    );
    assert.deepEqual(result, { block: true, reason: "Deny: denied" });
  } finally {
    delete process.env.PIDESKTOP_HOOKS_CONFIG_B64;
    rmSync(dir, { recursive: true, force: true });
  }
});
