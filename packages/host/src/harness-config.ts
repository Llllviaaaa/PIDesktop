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
import { readFileSync } from "node:fs";
import type { Config as BrowserConfig } from "@pid/browser";
import type { Config as ComputerConfig } from "@pid/computer";
import type { Config as HooksConfig } from "@pid/hooks";
import type { Config as McpConfig } from "@pid/mcp";
import type { Config as PermissionsConfig } from "@pid/permissions";
import type { Config as SubagentsConfig } from "@pid/subagents";

export interface HarnessConfig {
  permissions: PermissionsConfig;
  hooks: HooksConfig;
  /** `file` defaults to `<dataDir>/memory.md`; the desktop points it at its own memory file. */
  memory: { enabled: boolean; file?: string };
  /** AGENTS.md / CLAUDE.md in the system prompt. */
  contextFiles: { enabled: boolean };
  plan: { enabled: boolean };
  /** `secretsFile`: the desktop's DPAPI-protected MCP env and headers, merged in memory. */
  mcp: McpConfig & { secretsFile?: string };
  subagents: SubagentsConfig & { enabled: boolean };
  computer: ComputerConfig & { enabled: boolean };
  browser: BrowserConfig & { enabled: boolean };
  schedule: { enabled: boolean };
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
    mcp: { servers: [] },
    subagents: { enabled: true },
    computer: { enabled: true },
    browser: { enabled: true },
    schedule: { enabled: true },
    prompt: { instructions: "" },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readHarnessConfig(file: string): { config: HarnessConfig; problems: string[] } {
  const config = defaultHarnessConfig();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config, problems: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config, problems: [`${file} is not valid JSON; using defaults`] };
  }
  if (!isObject(parsed)) return { config, problems: [`${file} is not an object; using defaults`] };
  const problems: string[] = [];
  const section = (key: keyof HarnessConfig): Record<string, unknown> | undefined => {
    const value = parsed[key];
    if (value === undefined) return undefined;
    if (isObject(value)) return value;
    problems.push(`${key} must be an object; using its defaults`);
    return undefined;
  };
  const permissions = section("permissions");
  if (permissions !== undefined) config.permissions = permissions as PermissionsConfig;
  const hooks = section("hooks");
  if (hooks !== undefined) {
    config.hooks = { hooks: Array.isArray(hooks.hooks) ? (hooks.hooks as HooksConfig["hooks"]) : [], inheritEnvironment: hooks.inheritEnvironment === true };
  }
  const memory = section("memory");
  if (memory !== undefined) config.memory = { enabled: memory.enabled !== false, ...(typeof memory.file === "string" ? { file: memory.file } : {}) };
  const contextFiles = section("contextFiles");
  if (contextFiles !== undefined) config.contextFiles = { enabled: contextFiles.enabled !== false };
  const prompt = section("prompt");
  if (prompt !== undefined) config.prompt = { instructions: typeof prompt.instructions === "string" ? prompt.instructions : "" };
  const plan = section("plan");
  if (plan !== undefined) config.plan = { enabled: plan.enabled !== false };
  const mcp = section("mcp");
  if (mcp !== undefined) {
    config.mcp = {
      servers: Array.isArray(mcp.servers) ? (mcp.servers as McpConfig["servers"]) : [],
      confirmTools: mcp.confirmTools !== false,
      ...(typeof mcp.secretsFile === "string" ? { secretsFile: mcp.secretsFile } : {}),
    };
  }
  const subagents = section("subagents");
  if (subagents !== undefined) config.subagents = { ...(subagents as SubagentsConfig), enabled: subagents.enabled !== false };
  const computer = section("computer");
  if (computer !== undefined) {
    config.computer = {
      enabled: computer.enabled !== false,
      ...(typeof computer.helper === "string" ? { helper: computer.helper } : {}),
      confirmActions: computer.confirmActions !== false,
    };
  }
  const browser = section("browser");
  if (browser !== undefined) {
    config.browser = {
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
  return { config, problems };
}
