/**
 * `<dataDir>/harness.json`: settings of the built-in feature plugins (ADR 0009).
 *
 * ```json
 * {
 *   "permissions": { "defaultPermission": "ask", "shellAllowPrefixes": ["git status"], "toolRules": [] },
 *   "hooks": { "hooks": [], "inheritEnvironment": false },
 *   "memory": { "enabled": true },
 *   "plan": { "enabled": true }
 * }
 * ```
 *
 * A missing file means defaults. A section that is not an object is ignored
 * with a note, so one mistake does not disable everything.
 */
import { readFileSync } from "node:fs";
import type { Config as HooksConfig } from "@pid/hooks";
import type { Config as PermissionsConfig } from "@pid/permissions";

export interface HarnessConfig {
  permissions: PermissionsConfig;
  hooks: HooksConfig;
  memory: { enabled: boolean };
  plan: { enabled: boolean };
}

export function defaultHarnessConfig(): HarnessConfig {
  return { permissions: {}, hooks: { hooks: [] }, memory: { enabled: true }, plan: { enabled: true } };
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
  if (memory !== undefined) config.memory = { enabled: memory.enabled !== false };
  const plan = section("plan");
  if (plan !== undefined) config.plan = { enabled: plan.enabled !== false };
  return { config, problems };
}
