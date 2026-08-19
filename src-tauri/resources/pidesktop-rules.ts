/**
 * Pure permission-rule helpers shared by the Pi Desktop guard extension.
 * Keep this file free of Pi runtime imports so unit tests can load it directly.
 */

export type PermissionMode = "read-only" | "ask" | "workspace-write" | "full-access";

export interface PermissionRules {
  alwaysConfirmShell: boolean;
  blockWriteOutsideWorkspace: boolean;
  /** Command prefixes that skip shell confirmation under ask / workspace-write. */
  shellAllowPrefixes: string[];
}

export type ToolDecision =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "confirm"; title: string; message: string };

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

export function pathFromToolInput(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file", "filePath", "target"]) {
    if (typeof input[key] === "string" && (input[key] as string).trim()) {
      return input[key] as string;
    }
  }
  return undefined;
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
 * full-access short-circuits to allow (caller may still apply quick-chat blocks).
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
  const target = pathFromToolInput(input);
  const command = shellCommandFromInput(input);

  if (options.quickChat && ["read", "write", "edit", "apply_patch", "grep", "find", "bash", "shell", "exec"].includes(tool)) {
    return { action: "block", reason: "Quick chat does not use local project files or shell commands" };
  }

  if (mode === "full-access") {
    return { action: "allow" };
  }

  if (mode === "read-only" && (isWrite || isShell)) {
    return { action: "block", reason: "Pi Desktop is in read-only mode" };
  }

  if (isWrite && target && !insideWorkspace(target, workspace)) {
    const resolved = resolveAgainstWorkspace(target, workspace);
    if (rules.blockWriteOutsideWorkspace) {
      return {
        action: "block",
        reason: `Write outside workspace blocked by rule: ${target} → ${resolved}`,
      };
    }
    return {
      action: "confirm",
      title: "Write outside workspace?",
      message: `${tool}: ${target}\nResolved: ${resolved}\n\nWorkspace: ${workspace}`,
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

  return { action: "allow" };
}

export function rulesFromEnv(env: {
  alwaysConfirmShell?: string;
  blockWriteOutsideWorkspace?: string;
  shellAllowPrefixes?: string;
}): PermissionRules {
  const always = env.alwaysConfirmShell;
  const block = env.blockWriteOutsideWorkspace;
  return {
    // Default on: always confirm shell unless explicitly disabled
    alwaysConfirmShell: always !== "0" && always !== "false",
    // Default on: block outside-workspace writes unless explicitly disabled
    blockWriteOutsideWorkspace: block !== "0" && block !== "false",
    shellAllowPrefixes: parseAllowPrefixes(env.shellAllowPrefixes),
  };
}
