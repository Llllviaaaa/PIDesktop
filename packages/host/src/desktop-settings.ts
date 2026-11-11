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
import { DEFAULT_APP_SETTINGS } from "@qianji/protocol";
import type { Effort } from "@qianji/llm";
import type { DesktopHookConfig } from "@qianji/hooks";
import type { McpServerConfig } from "@qianji/mcp";
import type { ToolPermissionRule } from "@qianji/permissions";
import type { HarnessConfig } from "./harness-config.ts";

/** One `{"desktop": …}` control line. */
export interface DesktopMessage {
  /** `AppSettings` as the desktop serializes it (camelCase). */
  settings: Record<string, unknown>;
  /** The desktop's config directory: memory.md, mcp-secrets.dat, browser-profile. */
  configDir: string;
  /** The desktop executable, which doubles as the computer-use helper. */
  executable?: string;
}

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const EFFORT_ID_RE = /^[a-zA-Z0-9._:-]{1,64}$/;

/** Desktop thinking levels as harness reasoning efforts (preserving extended & custom tiers). */
export function effortFromThinking(level: string): Effort | undefined {
  const trimmed = level.trim();
  if (trimmed === "" || !EFFORT_ID_RE.test(trimmed)) return undefined;
  return trimmed;
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
  const provider = str(settings.provider, DEFAULT_APP_SETTINGS.provider);
  const model = str(settings.model, DEFAULT_APP_SETTINGS.model);
  const defaultModel = provider !== "" && model !== "" ? { provider, model } : undefined;
  const modelThinkingLevels = settings.modelThinkingLevels && typeof settings.modelThinkingLevels === "object" && !Array.isArray(settings.modelThinkingLevels)
    ? (settings.modelThinkingLevels as Record<string, unknown>)
    : undefined;
  const perModelEffort = defaultModel ? str(modelThinkingLevels?.[`${provider}/${model}`]) : "";
  const effort = effortFromThinking(perModelEffort || str(settings.thinkingLevel));
  const memoryEnabled = bool(settings.memoryEnabled, DEFAULT_APP_SETTINGS.memoryEnabled);
  const projectMemoryEnabled = typeof settings.projectMemoryEnabled === "boolean" ? settings.projectMemoryEnabled : memoryEnabled;
  const executable = message.executable?.trim();
  const browserExecutable = str(settings.browserExecutable, DEFAULT_APP_SETTINGS.browserExecutable).trim();

  const config: HarnessConfig = {
    permissions: {
      defaultPermission: str(settings.permissionMode, DEFAULT_APP_SETTINGS.permissionMode) as NonNullable<HarnessConfig["permissions"]["defaultPermission"]>,
      defaultAgentMode: str(settings.agentMode, DEFAULT_APP_SETTINGS.agentMode) as NonNullable<HarnessConfig["permissions"]["defaultAgentMode"]>,
      alwaysConfirmShell: bool(settings.alwaysConfirmShell, DEFAULT_APP_SETTINGS.alwaysConfirmShell),
      blockWriteOutsideWorkspace: bool(settings.blockWriteOutsideWorkspace, DEFAULT_APP_SETTINGS.blockWriteOutsideWorkspace),
      allowForcePush: bool(settings.allowForcePush, DEFAULT_APP_SETTINGS.allowForcePush),
      shellAllowPrefixes: str(settings.shellAllowPrefixes, DEFAULT_APP_SETTINGS.shellAllowPrefixes).split(/[\n,]/).map((item) => item.trim()).filter(Boolean),
      toolRules: list<ToolPermissionRule>(settings.toolRules),
    },
    hooks: {
      hooks: bool(settings.hooksEnabled, DEFAULT_APP_SETTINGS.hooksEnabled) ? list<DesktopHookConfig>(settings.hooks) : [],
      inheritEnvironment: bool(settings.hooksInheritEnvironment, DEFAULT_APP_SETTINGS.hooksInheritEnvironment),
    },
    // Pi's memory switch also turned off context files (--no-context-files).
    memory: {
      enabled: memoryEnabled,
      ...(typeof settings.projectMemoryEnabled === "boolean" ? { projectEnabled: settings.projectMemoryEnabled } : {}),
      file: join(message.configDir, "memory.md"),
    },
    contextFiles: { enabled: memoryEnabled || projectMemoryEnabled },
    plan: { enabled: bool(settings.planTrackingEnabled, DEFAULT_APP_SETTINGS.planTrackingEnabled) },
    mcp: {
      enabled: bool(settings.mcpEnabled, DEFAULT_APP_SETTINGS.mcpEnabled),
      servers: bool(settings.mcpEnabled, DEFAULT_APP_SETTINGS.mcpEnabled) ? list<McpServerConfig>(settings.mcpServers) : [],
      confirmTools: bool(settings.mcpConfirmTools, DEFAULT_APP_SETTINGS.mcpConfirmTools),
      secretsFile: join(message.configDir, "mcp-secrets.dat"),
    },
    subagents: {
      enabled: bool(settings.subagentsEnabled, DEFAULT_APP_SETTINGS.subagentsEnabled),
      concurrency: Math.min(4, Math.max(1, num(settings.subagentMaxConcurrency, DEFAULT_APP_SETTINGS.subagentMaxConcurrency))),
      ...(defaultModel === undefined ? {} : { model: defaultModel }),
      ...(effort === undefined ? {} : { effort }),
    },
    browser: {
      enabled: bool(settings.browserEnabled, DEFAULT_APP_SETTINGS.browserEnabled),
      headless: bool(settings.browserHeadless, DEFAULT_APP_SETTINGS.browserHeadless),
      confirmActions: bool(settings.browserConfirmActions, DEFAULT_APP_SETTINGS.browserConfirmActions),
      ...(str(settings.browserProfileMode) === "persistent" ? { profileDir: join(message.configDir, "browser-profile") } : {}),
      ...(browserExecutable === "" ? {} : { executable: browserExecutable }),
    },
    computer: {
      enabled: bool(settings.computerEnabled, DEFAULT_APP_SETTINGS.computerEnabled),
      confirmActions: bool(settings.computerConfirmActions, DEFAULT_APP_SETTINGS.computerConfirmActions),
      ...(executable ? { helper: executable } : {}),
    },
    // The host is the only scheduler since Pi and the desktop's own went (P6c).
    schedule: { enabled: true },
    intelligentUi: { enabled: bool(settings.intelligentUiEnabled, DEFAULT_APP_SETTINGS.intelligentUiEnabled) },
    sandbox: { enabled: bool(settings.sandboxEnabled, DEFAULT_APP_SETTINGS.sandboxEnabled) },
    prompt: { instructions: personalInstructions(settings) },
  };
  return { config, ...(defaultModel === undefined ? {} : { defaultModel }) };
}
