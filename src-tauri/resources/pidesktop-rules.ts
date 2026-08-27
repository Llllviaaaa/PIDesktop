/**
 * Pure permission-rule helpers shared by the Pi Desktop guard extension.
 * Keep this file free of Pi runtime imports so unit tests can load it directly.
 */

export type PermissionMode = "read-only" | "ask" | "workspace-write" | "full-access";
export type AgentMode = "agent" | "plan" | "ask";

export function normalizeAgentMode(value: string | undefined | null): AgentMode {
  return value === "plan" || value === "ask" ? value : "agent";
}

export function normalizePermissionMode(value: string | undefined | null): PermissionMode {
  return value === "read-only" || value === "workspace-write" || value === "full-access" ? value : "ask";
}

export function shouldConfirmInteractiveAction(
  permissionMode: string | undefined | null,
  confirmActions: boolean,
): boolean {
  return confirmActions && normalizePermissionMode(permissionMode) !== "full-access";
}

export function permissionForAgentMode(agentMode: AgentMode, permissionMode: PermissionMode): PermissionMode {
  return agentMode === "agent" ? permissionMode : "read-only";
}

export function agentModeSystemInstructions(mode: AgentMode): string {
  if (mode === "ask") {
    return "PIDesktop mode: Ask. Investigate with read-only tools and answer the user's question. Do not edit files, run shell commands, or perform side-effecting actions.";
  }
  if (mode === "plan") {
    return "PIDesktop mode: Plan. Investigate with read-only tools, record the proposed ordered steps with update_plan, then produce an implementation-ready plan with affected files, key symbols, risks, and verification. Do not edit files, run shell commands, or perform side-effecting actions.";
  }
  return "";
}

export interface PermissionRules {
  alwaysConfirmShell: boolean;
  blockWriteOutsideWorkspace: boolean;
  /** Command prefixes that skip shell confirmation under ask / workspace-write. */
  shellAllowPrefixes: string[];
  toolRules: ToolPermissionRule[];
}

export interface ToolPermissionRule {
  id: string;
  enabled: boolean;
  toolPattern: string;
  action: "allow" | "confirm" | "block";
  commandPrefix: string;
  pathPrefix: string;
}

export type ToolDecision =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "confirm"; title: string; message: string };

/** Keep web search inline unless the caller explicitly requests a curator workflow. */
export function applyDesktopToolDefaults(toolName: string, input: Record<string, unknown>): void {
  if (toolName.toLowerCase() === "web_search" && input.workflow === undefined) {
    input.workflow = "none";
  }
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True for Windows drive paths, UNC, or POSIX absolute paths. */
export function isAbsolutePath(path: string): boolean {
  const candidate = path.replace(/\\/g, "/");
  return /^[a-zA-Z]:(\/|$)/.test(candidate) || candidate.startsWith("/") || candidate.startsWith("//");
}

/**
 * Resolve a tool path against the workspace root (Pi write/edit often pass relative paths).
 * Mirrors a lightweight resolveToCwd so outside-workspace checks do not false-block `src/main.ts`.
 */
export function resolveAgainstWorkspace(path: string, workspace: string): string {
  const raw = path.trim();
  if (!raw) return raw;
  const slashPath = raw.replace(/\\/g, "/");
  if (isAbsolutePath(slashPath)) {
    return normalizePath(slashPath);
  }

  const root = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  // Windows "D:/foo" keeps "D:" as the first segment.
  const stack = root.match(/^[a-zA-Z]:/i)
    ? root.split("/").filter((segment, index) => index === 0 || segment.length > 0)
    : root.split("/").filter(Boolean);

  for (const segment of slashPath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length > 1 || (stack.length === 1 && !/^[a-zA-Z]:$/i.test(stack[0] || ""))) {
        stack.pop();
      }
      continue;
    }
    stack.push(segment);
  }

  if (stack.length && /^[a-zA-Z]:$/i.test(stack[0])) {
    return normalizePath(`${stack[0]}/${stack.slice(1).join("/")}`);
  }
  if (root.startsWith("/")) {
    return normalizePath(`/${stack.join("/")}`);
  }
  return normalizePath(stack.join("/"));
}

export function insideWorkspace(path: string, workspace: string): boolean {
  const candidate = resolveAgainstWorkspace(path, workspace);
  const root = normalizePath(workspace);
  if (!root) return false;
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function parseAllowPrefixes(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function commandMatchesAllowPrefix(command: string, prefixes: string[]): boolean {
  const normalized = command.trim();
  if (!normalized || prefixes.length === 0) return false;
  const lower = normalized.toLowerCase();
  return prefixes.some((prefix) => {
    const needle = prefix.trim();
    if (!needle) return false;
    return lower === needle.toLowerCase() || lower.startsWith(`${needle.toLowerCase()} `) || lower.startsWith(`${needle.toLowerCase()}\t`);
  });
}

export function toolPatternMatches(toolName: string, pattern: string): boolean {
  const escaped = pattern.trim().toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  if (!escaped) return false;
  return new RegExp(`^${escaped}$`).test(toolName.toLowerCase());
}

export function parseToolRules(encoded: string | undefined | null): ToolPermissionRule[] {
  if (!encoded) return [];
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    if (!Array.isArray(value)) return [];
    return value.slice(0, 64).flatMap((item): ToolPermissionRule[] => {
      if (!item || typeof item !== "object") return [];
      const rule = item as Partial<ToolPermissionRule>;
      if (typeof rule.id !== "string" || typeof rule.toolPattern !== "string") return [];
      if (rule.action !== "allow" && rule.action !== "confirm" && rule.action !== "block") return [];
      return [{
        id: rule.id,
        enabled: rule.enabled !== false,
        toolPattern: rule.toolPattern.trim(),
        action: rule.action,
        commandPrefix: typeof rule.commandPrefix === "string" ? rule.commandPrefix.trim() : "",
        pathPrefix: typeof rule.pathPrefix === "string" ? rule.pathPrefix.trim() : "",
      }];
    });
  } catch {
    return [];
  }
}

function matchingToolRule(options: {
  rules: PermissionRules;
  workspace: string;
  toolName: string;
  input: Record<string, unknown>;
}): ToolPermissionRule | null {
  const command = shellCommandFromInput(options.input);
  const target = pathFromToolInput(options.input);
  return (options.rules.toolRules ?? []).find((rule) => {
    if (!rule.enabled || !toolPatternMatches(options.toolName, rule.toolPattern)) return false;
    if (rule.commandPrefix && !commandMatchesAllowPrefix(command, [rule.commandPrefix])) return false;
    if (rule.pathPrefix) {
      if (!target) return false;
      const candidate = resolveAgainstWorkspace(target, options.workspace);
      const prefix = resolveAgainstWorkspace(rule.pathPrefix, options.workspace);
      if (candidate !== prefix && !candidate.startsWith(`${prefix}/`)) return false;
    }
    return true;
  }) ?? null;
}

export function pathFromToolInput(input: Record<string, unknown>): string | undefined {
  return pathsFromToolInput(input)[0];
}

export function pathsFromToolInput(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of ["path", "file", "filePath", "target"]) {
    if (typeof input[key] === "string" && (input[key] as string).trim()) {
      paths.push((input[key] as string).trim());
    }
  }
  for (const key of ["paths", "files", "targets"]) {
    const values = input[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      if (typeof value === "string" && value.trim()) paths.push(value.trim());
    }
  }
  return [...new Set(paths)];
}

export function shellCommandFromInput(input: Record<string, unknown>): string {
  if (typeof input.command === "string") return input.command;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/**
 * Decide whether a model tool call is allowed, blocked, or needs confirmation.
 * Read-only is a hard cap. Explicit tool rules then apply before the mode defaults.
 */
export function evaluateToolPermission(options: {
  mode: PermissionMode;
  rules: PermissionRules;
  workspace: string;
  toolName: string;
  input: Record<string, unknown>;
  quickChat?: boolean;
}): ToolDecision {
  const { mode, rules, workspace, input } = options;
  const tool = options.toolName.toLowerCase();
  const isWrite = tool === "write" || tool === "edit" || tool === "apply_patch";
  const isShell = tool === "bash" || tool === "shell" || tool === "exec";
  const action = typeof input.action === "string" ? input.action.toLowerCase() : "";
  const isInteractiveBrowser = tool === "browser" && ["open", "new_tab", "close_tab", "click", "type", "press", "select", "upload", "download", "close"].includes(action);
  const isBrowserDownload = tool === "browser" && action === "download";
  const isInteractiveComputer = tool === "computer" && ["focus_window", "move", "click", "double_click", "drag", "scroll", "type", "key", "keypress"].includes(action);
  const isMcpTool = tool.startsWith("mcp__");
  const isSubagent = tool === "delegate_task";
  const isMemoryWrite = tool === "desktop_memory" && action !== "read";
  const subagentPermission = input.permission === "workspace-write" ? "workspace-write" : "read-only";
  const targets = pathsFromToolInput(input);
  const target = targets[0];
  const outsideTarget = (isWrite || isBrowserDownload)
    ? targets.find((candidate) => !insideWorkspace(candidate, workspace))
    : undefined;
  const command = shellCommandFromInput(input);
  const knownReadOnlyTools = new Set([
    "read",
    "grep",
    "find",
    "glob",
    "ls",
    "view_image",
    "web_search",
    "web_fetch",
    "fetch",
    "update_plan",
    "mcp_list_resources",
    "mcp_read_resource",
    "mcp_subscribe_resource",
    "mcp_unsubscribe_resource",
    "mcp_list_prompts",
    "mcp_get_prompt",
  ]);
  const isKnownTool = isWrite
    || isShell
    || tool === "browser"
    || tool === "computer"
    || isMcpTool
    || isSubagent
    || tool === "desktop_memory"
    || knownReadOnlyTools.has(tool);

  if (options.quickChat && (["read", "write", "edit", "apply_patch", "grep", "find", "bash", "shell", "exec"].includes(tool) || isSubagent)) {
    return { action: "block", reason: "Quick chat does not use local project files or shell commands" };
  }

  if (mode === "read-only" && (isWrite || isShell || isInteractiveBrowser || isInteractiveComputer || isMcpTool || isMemoryWrite)) {
    return { action: "block", reason: "Pi Desktop is in read-only mode" };
  }

  if (mode === "read-only" && isSubagent && subagentPermission !== "read-only") {
    return { action: "block", reason: "Pi Desktop read-only mode only permits read-only subagents" };
  }

  if (mode === "read-only" && !isKnownTool) {
    return { action: "block", reason: `Pi Desktop read-only mode blocks unclassified tool: ${tool}` };
  }

  // Workspace confinement is a hard cap, like read-only mode. A broad custom
  // allow rule must not silently override it.
  if (outsideTarget && rules.blockWriteOutsideWorkspace && mode !== "full-access") {
    const resolved = resolveAgainstWorkspace(outsideTarget, workspace);
    return {
      action: "block",
      reason: `${isBrowserDownload ? "Browser download" : "Write"} outside workspace blocked by rule: ${outsideTarget} → ${resolved}`,
    };
  }

  const customRule = matchingToolRule({ rules, workspace, toolName: tool, input });
  if (customRule) {
    if (customRule.action === "allow") return { action: "allow" };
    if (customRule.action === "block") {
      return { action: "block", reason: `Blocked by tool rule: ${customRule.id}` };
    }
    return {
      action: "confirm",
      title: "Allow tool call?",
      message: `${tool} matched rule ${customRule.id}`,
    };
  }

  if (mode === "full-access") {
    return { action: "allow" };
  }

  if (isMemoryWrite && (mode === "ask" || mode === "workspace-write")) {
    return {
      action: "confirm",
      title: "Update local memory?",
      message: action === "clear" ? "Clear the Pi Desktop memory file" : `Store a durable preference using ${action}`,
    };
  }

  if ((mode === "ask" || mode === "workspace-write") && isSubagent && subagentPermission === "workspace-write") {
    return {
      action: "confirm",
      title: "Allow a subagent to edit this workspace?",
      message: "The delegated worker may use read, edit, and write in the current workspace. Shell access is disabled.",
    };
  }

  if (isWrite && outsideTarget) {
    const resolved = resolveAgainstWorkspace(outsideTarget, workspace);
    return {
      action: "confirm",
      title: "Write outside workspace?",
      message: `${tool}: ${outsideTarget}\nResolved: ${resolved}\n\nWorkspace: ${workspace}`,
    };
  }

  if (isWrite && targets.length === 0 && (mode === "ask" || mode === "workspace-write")) {
    return {
      action: "confirm",
      title: "Allow unscoped file change?",
      message: `${tool}: ${JSON.stringify(input)}`,
    };
  }

  if (mode === "ask" && isWrite) {
    return {
      action: "confirm",
      title: "Allow file change?",
      message: `${tool}: ${target || JSON.stringify(input)}`,
    };
  }

  if (isShell) {
    const allowlisted = commandMatchesAllowPrefix(command, rules.shellAllowPrefixes);
    // Allowlist only skips confirm when alwaysConfirmShell is off (ask / workspace-write).
    if (allowlisted && !rules.alwaysConfirmShell && (mode === "ask" || mode === "workspace-write")) {
      return { action: "allow" };
    }
    if (rules.alwaysConfirmShell || mode === "ask" || mode === "workspace-write") {
      return {
        action: "confirm",
        title: "Allow command?",
        message: command,
      };
    }
  }

  if (!isKnownTool && (mode === "ask" || mode === "workspace-write")) {
    return {
      action: "confirm",
      title: "Allow unclassified tool call?",
      message: `${tool}: ${JSON.stringify(input).slice(0, 1800)}`,
    };
  }

  return { action: "allow" };
}

export function rulesFromEnv(env: {
  alwaysConfirmShell?: string;
  blockWriteOutsideWorkspace?: string;
  shellAllowPrefixes?: string;
  toolRulesEncoded?: string;
}): PermissionRules {
  const always = env.alwaysConfirmShell;
  const block = env.blockWriteOutsideWorkspace;
  return {
    // Default on: always confirm shell unless explicitly disabled
    alwaysConfirmShell: always !== "0" && always !== "false",
    // Default on: block outside-workspace writes unless explicitly disabled
    blockWriteOutsideWorkspace: block !== "0" && block !== "false",
    shellAllowPrefixes: parseAllowPrefixes(env.shellAllowPrefixes),
    toolRules: parseToolRules(env.toolRulesEncoded),
  };
}
