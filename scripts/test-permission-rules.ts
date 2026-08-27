/**
 * Drives the shipped pidesktop-rules.ts evaluation path (not a reimplementation).
 * Run: npx --yes tsx scripts/test-permission-rules.ts
 */
import {
  applyDesktopToolDefaults,
  agentModeSystemInstructions,
  commandMatchesAllowPrefix,
  evaluateToolPermission,
  insideWorkspace,
  normalizeAgentMode,
  permissionForAgentMode,
  resolveAgainstWorkspace,
  rulesFromEnv,
  shouldConfirmInteractiveAction,
} from "../src-tauri/resources/pidesktop-rules.ts";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const workspace = "D:/projects/demo";

assert(normalizeAgentMode("plan") === "plan", "plan mode should be recognized");
assert(normalizeAgentMode("unknown") === "agent", "unknown agent modes should fail closed to the normal agent mode");
assert(permissionForAgentMode("ask", "full-access") === "read-only", "ask mode must override full-access permissions");
assert(permissionForAgentMode("agent", "workspace-write") === "workspace-write", "agent mode should preserve its permission mode");
assert(agentModeSystemInstructions("plan").includes("implementation-ready plan"), "plan mode should add concrete planning instructions");
assert(!shouldConfirmInteractiveAction("full-access", true), "full-access must skip per-action computer approval");
assert(shouldConfirmInteractiveAction("ask", true), "ask mode must preserve per-action computer approval");
assert(!shouldConfirmInteractiveAction("ask", false), "disabled computer approval must skip per-action confirmation");

// PIDesktop web searches stay in-app by default, while explicit workflows are preserved.
{
  const defaults: Record<string, unknown> = { queries: ["Pi Desktop"] };
  applyDesktopToolDefaults("web_search", defaults);
  assert(defaults.workflow === "none", "web_search should default to the non-curator workflow");

  const explicit: Record<string, unknown> = { query: "Pi Desktop", workflow: "summary-review" };
  applyDesktopToolDefaults("web_search", explicit);
  assert(explicit.workflow === "summary-review", "an explicit web_search workflow must be preserved");

  const unrelated: Record<string, unknown> = { query: "Pi Desktop" };
  applyDesktopToolDefaults("grok_search", unrelated);
  assert(unrelated.workflow === undefined, "unrelated search tools must not be modified");
}

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

// read-only mode blocks side-effecting custom tools while preserving browser inspection.
const base = {
  mode: "read-only" as const,
  rules: { alwaysConfirmShell: true, blockWriteOutsideWorkspace: true, shellAllowPrefixes: [], toolRules: [] },
  workspace,
};
{
  assert(evaluateToolPermission({ ...base, toolName: "browser", input: { action: "inspect" } }).action === "allow", "browser inspection should stay available in read-only mode");
  assert(evaluateToolPermission({ ...base, toolName: "browser", input: { action: "click" } }).action === "block", "browser clicks should be blocked in read-only mode");
  assert(evaluateToolPermission({ ...base, toolName: "browser", input: { action: "press" } }).action === "block", "browser keypresses should be blocked in read-only mode");
  assert(evaluateToolPermission({ ...base, toolName: "browser", input: { action: "select" } }).action === "block", "browser form selection should be blocked in read-only mode");
  assert(evaluateToolPermission({ ...base, toolName: "computer", input: { action: "type" } }).action === "block", "computer input should be blocked in read-only mode");
  assert(evaluateToolPermission({ ...base, toolName: "computer", input: { action: "drag" } }).action === "block", "computer drag should be blocked in read-only mode");
  assert(evaluateToolPermission({ ...base, toolName: "computer", input: { action: "scroll" } }).action === "block", "computer scroll should be blocked in read-only mode");
  assert(evaluateToolPermission({ ...base, toolName: "computer", input: { action: "wait" } }).action === "allow", "computer wait should remain available in read-only mode");
  assert(evaluateToolPermission({ ...base, toolName: "mcp__demo__write", input: {} }).action === "block", "MCP tools should be blocked when their side effects cannot be classified");
  assert(evaluateToolPermission({ ...base, toolName: "delegate_task", input: { permission: "read-only" } }).action === "allow", "read-only mode should permit read-only subagents");
  assert(evaluateToolPermission({ ...base, toolName: "delegate_task", input: { permission: "workspace-write" } }).action === "block", "read-only mode should block writing subagents");
  assert(evaluateToolPermission({ ...base, toolName: "desktop_memory", input: { action: "read" } }).action === "allow", "read-only mode should permit reading memory");
  assert(evaluateToolPermission({ ...base, toolName: "desktop_memory", input: { action: "append", content: "x" } }).action === "block", "read-only mode should block memory writes");
  assert(evaluateToolPermission({ ...base, toolName: "update_plan", input: { items: [] } }).action === "allow", "plan state updates should remain available in read-only mode");
  assert(evaluateToolPermission({ ...base, toolName: "delete_file", input: { path: "data.txt" } }).action === "block", "read-only mode must fail closed for unclassified extension tools");
}
assert(evaluateToolPermission({ ...base, mode: "ask", toolName: "desktop_memory", input: { action: "append", content: "x" } }).action === "confirm", "ask mode should confirm memory writes");
assert(evaluateToolPermission({ ...base, mode: "ask", toolName: "deploy", input: { target: "production" } }).action === "confirm", "ask mode must confirm unclassified tools");
assert(evaluateToolPermission({ ...base, mode: "workspace-write", toolName: "upload_secrets", input: { path: "C:/Users/user/.ssh/id_rsa" } }).action === "confirm", "workspace-write must not silently allow unclassified tools");
assert(evaluateToolPermission({ ...base, mode: "full-access", toolName: "custom_tool", input: {} }).action === "allow", "full-access should continue to allow unclassified tools");

const customRules = {
  ...base.rules,
  toolRules: [
    { id: "deny-deploy", enabled: true, toolPattern: "bash", action: "block" as const, commandPrefix: "npm run deploy", pathPrefix: "" },
    { id: "allow-tests", enabled: true, toolPattern: "bash", action: "allow" as const, commandPrefix: "npm test", pathPrefix: "" },
  ],
};
assert(evaluateToolPermission({ ...base, mode: "full-access", rules: customRules, toolName: "bash", input: { command: "npm run deploy prod" } }).action === "block", "explicit deny rules should apply even in full-access");
assert(evaluateToolPermission({ ...base, mode: "ask", rules: customRules, toolName: "bash", input: { command: "npm test -- --run" } }).action === "allow", "explicit allow rules should skip confirmation");
assert(evaluateToolPermission({ ...base, mode: "read-only", rules: customRules, toolName: "bash", input: { command: "npm test" } }).action === "block", "read-only must remain a hard cap over allow rules");
const broadWriteAllow = {
  ...base.rules,
  toolRules: [{ id: "allow-write", enabled: true, toolPattern: "write", action: "allow" as const, commandPrefix: "", pathPrefix: "" }],
};
assert(evaluateToolPermission({ ...base, mode: "workspace-write", rules: broadWriteAllow, toolName: "write", input: { path: "C:/outside.txt" } }).action === "block", "custom allow rules must not bypass workspace confinement");

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

  const browserDownloadEscape = evaluateToolPermission({
    mode: "workspace-write",
    rules: { alwaysConfirmShell: true, blockWriteOutsideWorkspace: true, shellAllowPrefixes: [], toolRules: [] },
    workspace,
    toolName: "browser",
    input: { action: "download", path: "../../outside" },
  });
  assert(browserDownloadEscape.action === "block", "browser downloads outside the workspace must be blocked");

  const readOnlyUpload = evaluateToolPermission({
    mode: "read-only",
    rules: { alwaysConfirmShell: true, blockWriteOutsideWorkspace: true, shellAllowPrefixes: [], toolRules: [] },
    workspace,
    toolName: "browser",
    input: { action: "upload", paths: ["upload.txt"] },
  });
  assert(readOnlyUpload.action === "block", "browser uploads must be blocked in read-only mode");

  const multiPathEscape = evaluateToolPermission({
    mode: "workspace-write",
    rules: { alwaysConfirmShell: true, blockWriteOutsideWorkspace: true, shellAllowPrefixes: [] },
    workspace,
    toolName: "write",
    input: { paths: ["src/main.ts", "../../outside.txt"], content: "x" },
  });
  assert(multiPathEscape.action === "block", "every path in a write tool payload must stay inside the workspace");

  const unscopedWrite = evaluateToolPermission({
    mode: "workspace-write",
    rules: { alwaysConfirmShell: true, blockWriteOutsideWorkspace: true, shellAllowPrefixes: [] },
    workspace,
    toolName: "write",
    input: { content: "x" },
  });
  assert(unscopedWrite.action === "confirm", "writes without a classifiable target must not be silently allowed");
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
