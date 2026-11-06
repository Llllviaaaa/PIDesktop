/**
 * `<dataDir>/harness.json`: settings of the built-in feature plugins (ADR 0009).
 *
 * ```json
 * {
 *   "permissions": { "defaultPermission": "ask", "shellAllowPrefixes": ["git status"], "toolRules": [] },
 *   "hooks": { "hooks": [], "inheritEnvironment": false },
 *   "memory": { "enabled": true },
 *   "plan": { "enabled": true },
 *   "mcp": { "servers": [], "confirmTools": true },
 *   "subagents": { "enabled": true, "concurrency": 3 },
 *   "computer": { "enabled": true, "helper": "C:/.../Pi Desktop.exe", "confirmActions": true },
 *   "browser": { "enabled": true, "headless": true, "confirmActions": true, "profileDir": "…", "idleMinutes": 10 },
 *   "schedule": { "enabled": true }
 * }
 * ```
 *
 * A missing file means defaults. A section that is not an object is ignored
 * with a note, so one mistake does not disable everything.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config as BrowserConfig } from "@pid/browser";
import type { Config as ComputerConfig } from "@pid/computer";
import type { Config as HooksConfig } from "@pid/hooks";
import type { Config as McpConfig } from "@pid/mcp";
import type { Config as PermissionsConfig } from "@pid/permissions";
import type { Config as SubagentsConfig } from "@pid/subagents";

export interface HarnessConfig {
  permissions: PermissionsConfig;
  hooks: HooksConfig;
  /** `file` defaults to `<dataDir>/memory.md`; `projectEnabled` toggles `<cwd>/.pid/memory.md` independently. */
  memory: { enabled: boolean; projectEnabled?: boolean; file?: string };
  /** AGENTS.md / CLAUDE.md in the system prompt. */
  contextFiles: { enabled: boolean };
  plan: { enabled: boolean };
  /** `secretsFile`: the desktop's DPAPI-protected MCP env and headers, merged in memory. */
  mcp: McpConfig & { enabled?: boolean; secretsFile?: string };
  subagents: SubagentsConfig & { enabled: boolean };
  computer: ComputerConfig & { enabled: boolean };
  browser: BrowserConfig & { enabled: boolean };
  schedule: { enabled: boolean };
  /** Optional Windows lightweight sandbox for `bash` (Job Object + scrubbed env + command guard). */
  sandbox: { enabled: boolean };
  /** The user's personality and custom instructions, as one system prompt section. */
  prompt: { instructions: string };
}

export function defaultHarnessConfig(): HarnessConfig {
  return {
    permissions: {},
    hooks: { hooks: [] },
    memory: { enabled: true },
    contextFiles: { enabled: true },
    plan: { enabled: true },
    mcp: { enabled: true, servers: [] },
    subagents: { enabled: true },
    computer: { enabled: true },
    browser: { enabled: true },
    schedule: { enabled: true },
    sandbox: { enabled: false },
    prompt: { instructions: "" },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyHarnessLayer(config: HarnessConfig, file: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [`${file} is not valid JSON; using defaults`];
  }
  if (!isObject(parsed)) return [`${file} is not an object; using defaults`];
  const problems: string[] = [];
  const section = (key: keyof HarnessConfig): Record<string, unknown> | undefined => {
    const value = parsed[key];
    if (value === undefined) return undefined;
    if (isObject(value)) return value;
    problems.push(`${key} must be an object; using its defaults`);
    return undefined;
  };
  const permissions = section("permissions");
  if (permissions !== undefined) config.permissions = { ...config.permissions, ...(permissions as PermissionsConfig) };
  const hooks = section("hooks");
  if (hooks !== undefined) {
    config.hooks = {
      hooks: Array.isArray(hooks.hooks) ? (hooks.hooks as HooksConfig["hooks"]) : config.hooks.hooks,
      inheritEnvironment: typeof hooks.inheritEnvironment === "boolean" ? hooks.inheritEnvironment : config.hooks.inheritEnvironment === true,
    };
  }
  const memory = section("memory");
  if (memory !== undefined) {
    config.memory = {
      ...config.memory,
      enabled: memory.enabled !== false,
      ...(typeof memory.projectEnabled === "boolean" ? { projectEnabled: memory.projectEnabled } : {}),
      ...(typeof memory.file === "string" ? { file: memory.file } : {}),
    };
  }
  const contextFiles = section("contextFiles");
  if (contextFiles !== undefined) config.contextFiles = { enabled: contextFiles.enabled !== false };
  const prompt = section("prompt");
  if (prompt !== undefined) config.prompt = { instructions: typeof prompt.instructions === "string" ? prompt.instructions : "" };
  const plan = section("plan");
  if (plan !== undefined) config.plan = { enabled: plan.enabled !== false };
  const mcp = section("mcp");
  if (mcp !== undefined) {
    config.mcp = {
      enabled: mcp.enabled !== false,
      servers: Array.isArray(mcp.servers) ? (mcp.servers as McpConfig["servers"]) : config.mcp.servers,
      confirmTools: mcp.confirmTools !== false,
      ...(typeof mcp.secretsFile === "string"
        ? { secretsFile: mcp.secretsFile }
        : config.mcp.secretsFile === undefined
          ? {}
          : { secretsFile: config.mcp.secretsFile }),
    };
  }
  const subagents = section("subagents");
  if (subagents !== undefined) config.subagents = { ...config.subagents, ...(subagents as SubagentsConfig), enabled: subagents.enabled !== false };
  const computer = section("computer");
  if (computer !== undefined) {
    config.computer = {
      ...config.computer,
      enabled: computer.enabled !== false,
      ...(typeof computer.helper === "string" ? { helper: computer.helper } : {}),
      confirmActions: computer.confirmActions !== false,
    };
  }
  const browser = section("browser");
  if (browser !== undefined) {
    config.browser = {
      ...config.browser,
      enabled: browser.enabled !== false,
      headless: browser.headless !== false,
      confirmActions: browser.confirmActions !== false,
      ...(typeof browser.profileDir === "string" ? { profileDir: browser.profileDir } : {}),
      ...(typeof browser.executable === "string" ? { executable: browser.executable } : {}),
      ...(typeof browser.idleMinutes === "number" ? { idleMinutes: browser.idleMinutes } : {}),
    };
  }
  const schedule = section("schedule");
  if (schedule !== undefined) config.schedule = { enabled: schedule.enabled !== false };
  const sandbox = section("sandbox");
  if (sandbox !== undefined) config.sandbox = { enabled: sandbox.enabled === true };
  return problems;
}

export function readHarnessConfig(file: string): { config: HarnessConfig; problems: string[] } {
  const config = defaultHarnessConfig();
  const problems = applyHarnessLayer(config, file);
  return { config, problems };
}

/**
 * Read `<dataDir>/harness.json` and, when `trustedWorkspace` is provided and
 * contains `.pid/harness.json`, overlay workspace-scoped settings cleanly.
 */
export function readEffectiveHarnessConfig(
  dataDir: string,
  trustedWorkspace?: string,
): { config: HarnessConfig; problems: string[] } {
  const config = defaultHarnessConfig();
  const problems = [...applyHarnessLayer(config, join(dataDir, "harness.json"))];
  if (trustedWorkspace !== undefined && trustedWorkspace.trim() !== "") {
    const projectFile = join(trustedWorkspace, ".pid", "harness.json");
    if (existsSync(projectFile)) {
      problems.push(...applyHarnessLayer(config, projectFile));
    }
  }
  return { config, problems };
}

/** Built-in plugin IDs whose default `enabled` state is mirrored in `HarnessConfig`. */
export const HARNESS_TOGGLED_PLUGIN_IDS = [
  "plan",
  "mcp",
  "subagents",
  "computer",
  "browser",
  "schedule",
  "sandbox",
] as const;

export function pluginEnabledInHarness(config: HarnessConfig, pluginId: string): boolean | undefined {
  switch (pluginId) {
    case "plan":
      return config.plan.enabled;
    case "mcp":
      return config.mcp.enabled !== false;
    case "subagents":
      return config.subagents.enabled;
    case "computer":
      return config.computer.enabled;
    case "browser":
      return config.browser.enabled;
    case "schedule":
      return config.schedule.enabled;
    case "sandbox":
      return config.sandbox.enabled;
    default:
      return undefined;
  }
}
