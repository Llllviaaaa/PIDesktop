/**
 * Drives the shipped pidesktop-rules.ts evaluation path (not a reimplementation).
 * Run: npx --yes tsx scripts/test-permission-rules.ts
 */
import {
  commandMatchesAllowPrefix,
  evaluateToolPermission,
  insideWorkspace,
  resolveAgainstWorkspace,
  rulesFromEnv,
} from "../src-tauri/resources/pidesktop-rules.ts";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const workspace = "D:/projects/demo";

// outside workspace blocked when rule on
{
  const decision = evaluateToolPermission({
    mode: "ask",
    rules: { alwaysConfirmShell: true, blockWriteOutsideWorkspace: true, shellAllowPrefixes: [] },
    workspace,
    toolName: "write",
    input: { path: "C:/other/secret.txt", content: "x" },
  });
  assert(decision.action === "block", `expected block for outside write, got ${JSON.stringify(decision)}`);
  assert(
    decision.action === "block" && decision.reason.includes("outside workspace"),
    "block reason should mention outside workspace",
  );
}

// outside workspace confirms when rule off
{
  const decision = evaluateToolPermission({
    mode: "ask",
    rules: { alwaysConfirmShell: true, blockWriteOutsideWorkspace: false, shellAllowPrefixes: [] },
    workspace,
    toolName: "edit",
    input: { filePath: "C:/other/file.ts" },
  });
  assert(decision.action === "confirm", `expected confirm when block rule off, got ${JSON.stringify(decision)}`);
}

// allowlisted shell auto-allowed under ask when alwaysConfirmShell is false
{
  const decision = evaluateToolPermission({
    mode: "ask",
    rules: {
      alwaysConfirmShell: false,
      blockWriteOutsideWorkspace: true,
      shellAllowPrefixes: ["git status", "npm test"],
    },
    workspace,
    toolName: "bash",
    input: { command: "git status --short" },
  });
  assert(decision.action === "allow", `expected allow for allowlisted shell, got ${JSON.stringify(decision)}`);
  assert(commandMatchesAllowPrefix("git status --short", ["git status"]), "prefix helper should match");
}

// unmatched shell remains confirm under ask
{
  const decision = evaluateToolPermission({
    mode: "ask",
    rules: {
      alwaysConfirmShell: false,
      blockWriteOutsideWorkspace: true,
      shellAllowPrefixes: ["git status"],
    },
    workspace,
    toolName: "shell",
    input: { command: "rm -rf /" },
  });
  assert(decision.action === "confirm", `expected confirm for unmatched shell, got ${JSON.stringify(decision)}`);
}

// alwaysConfirmShell forces confirm even for allowlisted commands
{
  const decision = evaluateToolPermission({
    mode: "ask",
    rules: {
      alwaysConfirmShell: true,
      blockWriteOutsideWorkspace: true,
      shellAllowPrefixes: ["git status"],
    },
    workspace,
    toolName: "bash",
    input: { command: "git status" },
  });
  assert(decision.action === "confirm", `alwaysConfirmShell should force confirm, got ${JSON.stringify(decision)}`);
}

// inside workspace write under workspace-write allowed without confirm
{
  const decision = evaluateToolPermission({
    mode: "workspace-write",
    rules: { alwaysConfirmShell: false, blockWriteOutsideWorkspace: true, shellAllowPrefixes: [] },
    workspace,
    toolName: "write",
    input: { path: `${workspace}/src/main.ts`, content: "ok" },
  });
  assert(decision.action === "allow", `workspace write should allow, got ${JSON.stringify(decision)}`);
  assert(insideWorkspace(`${workspace}/src/main.ts`, workspace), "path should be inside workspace");
}

// relative in-workspace write must NOT be treated as outside (default block rule on)
{
  assert(
    resolveAgainstWorkspace("src/main.ts", workspace) === normalizeExpect(`${workspace}/src/main.ts`),
    `relative resolve failed: ${resolveAgainstWorkspace("src/main.ts", workspace)}`,
  );
  assert(insideWorkspace("src/main.ts", workspace), "relative src/main.ts must be inside workspace");
  assert(insideWorkspace("./src/lib/pi.ts", workspace), "relative ./ path must be inside workspace");
  assert(insideWorkspace("src\\components\\App.tsx", workspace), "backslash relative must be inside workspace");

  const relativeWrite = evaluateToolPermission({
    mode: "workspace-write",
    rules: { alwaysConfirmShell: true, blockWriteOutsideWorkspace: true, shellAllowPrefixes: [] },
    workspace,
    toolName: "write",
    input: { path: "src/main.ts", content: "ok" },
  });
  assert(
    relativeWrite.action === "allow",
    `relative in-workspace write must allow under workspace-write, got ${JSON.stringify(relativeWrite)}`,
  );

  const relativeAsk = evaluateToolPermission({
    mode: "ask",
    rules: { alwaysConfirmShell: true, blockWriteOutsideWorkspace: true, shellAllowPrefixes: [] },
    workspace,
    toolName: "edit",
    input: { filePath: "src/main.ts" },
  });
  assert(
    relativeAsk.action === "confirm",
    `relative in-workspace edit under ask should confirm (not block-outside), got ${JSON.stringify(relativeAsk)}`,
  );

  const relativeEscape = evaluateToolPermission({
    mode: "ask",
    rules: { alwaysConfirmShell: true, blockWriteOutsideWorkspace: true, shellAllowPrefixes: [] },
    workspace,
    toolName: "write",
    input: { path: "../../outside.txt", content: "x" },
  });
  assert(
    relativeEscape.action === "block",
    `relative path escaping workspace must still block, got ${JSON.stringify(relativeEscape)}`,
  );
}

function normalizeExpect(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// rulesFromEnv defaults
{
  const rules = rulesFromEnv({});
  assert(rules.alwaysConfirmShell === true, "alwaysConfirmShell defaults true");
  assert(rules.blockWriteOutsideWorkspace === true, "block outside defaults true");
  assert(rules.shellAllowPrefixes.length === 0, "allowlist defaults empty");
  const off = rulesFromEnv({ alwaysConfirmShell: "0", blockWriteOutsideWorkspace: "false", shellAllowPrefixes: "git status,npm test" });
  assert(off.alwaysConfirmShell === false, "env 0 disables always confirm");
  assert(off.blockWriteOutsideWorkspace === false, "env false disables block outside");
  assert(off.shellAllowPrefixes.join(",") === "git status,npm test", "env allowlist parsed");
}

console.log("permission-rules: all assertions passed");
