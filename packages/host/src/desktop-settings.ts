/**
 * The desktop's settings as harness configuration (ADR 0013). The desktop
 * sends its public settings (no MCP secrets) as a `{"desktop": …}` line on
 * the host's stdin when the host starts and whenever they change; this maps
 * them onto harness.json, as the desktop once mapped them onto the Pi engine's
 * environment and arguments.
 *
 * Everything here is a pure function of the message, so the mapping is
 * tested field by field.
 */
import { join } from "node:path";
import type { Effort } from "@pid/llm";
import type { DesktopHookConfig } from "@pid/hooks";
import type { McpServerConfig } from "@pid/mcp";
import type { ToolPermissionRule } from "@pid/permissions";
import type { HarnessConfig } from "./harness-config.ts";

/** One `{"desktop": …}` control line. */
export interface DesktopMessage {
  /** `AppSettings` as the desktop serializes it (camelCase). */
  settings: Record<string, unknown>;
  /** The desktop's config directory: memory.md, mcp-secrets.dat, browser-profile. */
  configDir: string;
  /** Pi's agent directory, whose models.json is imported once. */
  piAgentDir?: string;
  /** The desktop executable, which doubles as the computer-use helper. */
  executable?: string;
}

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** Pi's thinking levels as the harness's efforts. */
export function effortFromThinking(level: string): Effort | undefined {
  switch (level) {
    case "off":
      return "off";
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
      return "high";
    default:
      return undefined;
  }
}

/** The personality line and custom instructions, as launch.rs appends them to Pi's system prompt. */
export function personalInstructions(settings: Record<string, unknown>): string {
  const personality = str(settings.personality);
  const style = personality === "friendly"
    ? "Communication style: be warm, collaborative, and clear while remaining technically precise."
    : personality === "pragmatic"
      ? "Communication style: be direct, implementation-focused, and concise. Lead with concrete outcomes."
      : "";
  return [style, str(settings.customInstructions).trim()].filter((part) => part !== "").join("\n\n");
}

export interface DesktopHarness {
  config: HarnessConfig;
  /** settings.provider/model, for providers.json's defaultModel. */
  defaultModel?: { provider: string; model: string };
}

export function harnessFromDesktop(message: DesktopMessage): DesktopHarness {
  const settings = message.settings;
  const provider = str(settings.provider);
  const model = str(settings.model);
  const defaultModel = provider !== "" && model !== "" ? { provider, model } : undefined;
  const effort = effortFromThinking(str(settings.thinkingLevel));
  const memoryEnabled = bool(settings.memoryEnabled, true);
  const executable = message.executable?.trim();
  const browserExecutable = str(settings.browserExecutable).trim();

  const config: HarnessConfig = {
    permissions: {
      defaultPermission: str(settings.permissionMode, "ask") as NonNullable<HarnessConfig["permissions"]["defaultPermission"]>,
      defaultAgentMode: str(settings.agentMode, "agent") as NonNullable<HarnessConfig["permissions"]["defaultAgentMode"]>,
      alwaysConfirmShell: bool(settings.alwaysConfirmShell, true),
      blockWriteOutsideWorkspace: bool(settings.blockWriteOutsideWorkspace, true),
      shellAllowPrefixes: str(settings.shellAllowPrefixes).split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
      toolRules: list<ToolPermissionRule>(settings.toolRules),
    },
    hooks: {
      hooks: bool(settings.hooksEnabled, false) ? list<DesktopHookConfig>(settings.hooks) : [],
      inheritEnvironment: bool(settings.hooksInheritEnvironment, false),
    },
    // Pi's memory switch also turned off context files (--no-context-files).
    memory: { enabled: memoryEnabled, file: join(message.configDir, "memory.md") },
    contextFiles: { enabled: memoryEnabled },
    plan: { enabled: bool(settings.planTrackingEnabled, true) },
    mcp: {
      servers: bool(settings.mcpEnabled, true) ? list<McpServerConfig>(settings.mcpServers) : [],
      confirmTools: bool(settings.mcpConfirmTools, true),
      secretsFile: join(message.configDir, "mcp-secrets.dat"),
    },
    subagents: {
      enabled: bool(settings.subagentsEnabled, true),
      concurrency: Math.min(4, Math.max(1, num(settings.subagentMaxConcurrency, 3))),
      ...(defaultModel === undefined ? {} : { model: defaultModel }),
      ...(effort === undefined ? {} : { effort }),
    },
    browser: {
      enabled: bool(settings.browserEnabled, true),
      headless: bool(settings.browserHeadless, true),
      confirmActions: bool(settings.browserConfirmActions, true),
      ...(str(settings.browserProfileMode) === "persistent" ? { profileDir: join(message.configDir, "browser-profile") } : {}),
      ...(browserExecutable === "" ? {} : { executable: browserExecutable }),
    },
    computer: {
      enabled: bool(settings.computerEnabled, true),
      confirmActions: bool(settings.computerConfirmActions, true),
      ...(executable ? { helper: executable } : {}),
    },
    // The host is the only scheduler since Pi and the desktop's own went (P6c).
    schedule: { enabled: true },
    prompt: { instructions: personalInstructions(settings) },
  };
  return { config, ...(defaultModel === undefined ? {} : { defaultModel }) };
}
