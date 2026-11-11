/**
 * Authoritative tri-end `AppSettings` contract and defaults shared across:
 * 1. Rust Desktop persistence (`src-tauri/src/config.rs`, `#[serde(rename_all = "camelCase")]`)
 * 2. Harness Host control bridge (`packages/host/src/desktop-settings.ts`)
 * 3. React Renderer (`src/types.ts`, `src/components/SettingsModal.tsx`)
 *
 * Verified 1-to-1 against `src-tauri/src/config.rs` by `tests/test-appsettings-alignment.test.ts`.
 */
import type { AgentModeName, PermissionModeName } from "./methods.ts";

export type SettingsDisplayMode = "page" | "modal";

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  inheritEnvironment: boolean;
  url: string;
  headers: Record<string, string>;
  trustedReadOnly: boolean;
}

export interface DesktopHookConfig {
  id: string;
  name: string;
  enabled: boolean;
  event:
    | "session_start"
    | "before_agent_start"
    | "agent_end"
    | "agent_settled"
    | "tool_call"
    | "tool_result";
  command: string;
  timeoutSeconds: number;
  blocking: boolean;
}

export interface ToolPermissionRule {
  id: string;
  enabled: boolean;
  toolPattern: string;
  action: "allow" | "confirm" | "block";
  commandPrefix: string;
  pathPrefix: string;
}

export interface AppSettings {
  provider: string;
  model: string;
  thinkingLevel: string;
  /** Legacy global custom thinking tiers; superseded by `modelCustomThinkingLevels`. */
  customThinkingLevels?: string[];
  /** Per-model preferred thinking level keyed by `provider/model`. */
  modelThinkingLevels?: Record<string, string>;
  /** Per-model user-defined custom thinking levels keyed by `provider/model`. */
  modelCustomThinkingLevels?: Record<string, string[]>;
  /** `provider/model` keys hidden from the composer model picker. */
  hiddenModels?: string[];
  /** Whether Settings renders as a standalone full-window page or a centered modal. */
  settingsDisplayMode?: SettingsDisplayMode;
  agentMode: AgentModeName;
  permissionMode: PermissionModeName;
  /** Shell/bash/exec always requires confirmation (unless full-access). */
  alwaysConfirmShell: boolean;
  /** Block model writes outside the workspace without prompting. */
  blockWriteOutsideWorkspace: boolean;
  /** Newline- or comma-separated command prefixes that skip shell confirmation. */
  shellAllowPrefixes: string;
  sandboxEnabled: boolean;
  toolRules: ToolPermissionRule[];
  /** Default new-task environment when starting a coding task. */
  defaultTaskEnvironment: "local" | "worktree";
  /** Optional custom default workspace directory; falls back to quick-chat directory when empty. */
  defaultWorkspace?: string;
  showThinking: boolean;
  /** Conversation transcript density: summary hides work, verbose expands it. */
  transcriptDensity: "summary" | "normal" | "verbose";
  autoConnect: boolean;
  followUpBehavior: "steer" | "followUp";
  requireCtrlEnter: boolean;
  preventSleep: boolean;
  language: "system" | "en" | "zh-CN";
  /** `system` picks the first detected editor; otherwise a WorkspaceEditorInfo id. */
  defaultFileOpener: string;
  terminalShell: string;
  terminalShellArgs: string;
  terminalOutput: "summary" | "full";
  notificationsEnabled: boolean;
  notifyOnCompletion: boolean;
  notifyOnApproval: boolean;
  notifyOnlyWhenUnfocused: boolean;
  theme: string;
  petEnabled?: boolean;
  petCharacter?: string;
  petSize?: number;
  accentColor: string;
  backgroundColor: string;
  foregroundColor: string;
  uiFont: string;
  codeFont: string;
  uiScale: number;
  /** Transcript body size in px (10-22). */
  messageFontSize: number;
  personality: "friendly" | "pragmatic" | "none";
  customInstructions: string;
  suggestedPrompts: boolean;
  memoryEnabled: boolean;
  projectMemoryEnabled: boolean;
  planTrackingEnabled: boolean;
  intelligentUiEnabled: boolean;
  hooksEnabled: boolean;
  hooksInheritEnvironment: boolean;
  hooks: DesktopHookConfig[];
  subagentsEnabled: boolean;
  subagentMaxConcurrency: number;
  browserEnabled: boolean;
  browserHeadless: boolean;
  browserProfileMode: "temporary" | "persistent";
  browserConfirmActions: boolean;
  browserExecutable: string;
  computerEnabled: boolean;
  computerConfirmActions: boolean;
  mcpEnabled: boolean;
  mcpConfirmTools: boolean;
  mcpServers: McpServerConfig[];
  reviewDelivery: "inline" | "detached";
  branchPrefix: string;
  allowForcePush: boolean;
  commitMessageInstructions: string;
  pullRequestInstructions?: string;
  logLevel: "error" | "warn" | "info" | "debug";
  shortcutNewChat: string;
  shortcutSettings: string;
  shortcutTerminal: string;
  shortcutChanges: string;
  shortcutToggleSidebar: string;
  archivedSessions: string[];
}

export const DEFAULT_UI_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const DEFAULT_CODE_FONT =
  'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export const DEFAULT_APP_SETTINGS: Required<AppSettings> = {
  provider: "",
  model: "",
  thinkingLevel: "medium",
  customThinkingLevels: [],
  modelThinkingLevels: {},
  modelCustomThinkingLevels: {},
  hiddenModels: [],
  settingsDisplayMode: "page",
  agentMode: "agent",
  permissionMode: "ask",
  alwaysConfirmShell: true,
  blockWriteOutsideWorkspace: true,
  shellAllowPrefixes: "",
  sandboxEnabled: false,
  toolRules: [],
  defaultTaskEnvironment: "local",
  defaultWorkspace: "",
  showThinking: true,
  transcriptDensity: "normal",
  autoConnect: false,
  followUpBehavior: "steer",
  requireCtrlEnter: false,
  preventSleep: true,
  language: "zh-CN",
  defaultFileOpener: "system",
  terminalShell: "PowerShell",
  terminalShellArgs: "",
  terminalOutput: "summary",
  notificationsEnabled: true,
  notifyOnCompletion: true,
  notifyOnApproval: true,
  notifyOnlyWhenUnfocused: true,
  theme: "light",
  petEnabled: false,
  petCharacter: "cat",
  petSize: 96,
  accentColor: "#006ee4",
  backgroundColor: "#fcfcfc",
  foregroundColor: "#111112",
  uiFont: DEFAULT_UI_FONT,
  codeFont: DEFAULT_CODE_FONT,
  uiScale: 100,
  messageFontSize: 15,
  personality: "pragmatic",
  customInstructions: "",
  suggestedPrompts: false,
  memoryEnabled: true,
  projectMemoryEnabled: true,
  planTrackingEnabled: true,
  intelligentUiEnabled: true,
  hooksEnabled: false,
  hooksInheritEnvironment: false,
  hooks: [],
  subagentsEnabled: true,
  subagentMaxConcurrency: 3,
  browserEnabled: true,
  browserHeadless: true,
  browserProfileMode: "temporary",
  browserConfirmActions: true,
  browserExecutable: "",
  computerEnabled: true,
  computerConfirmActions: true,
  mcpEnabled: true,
  mcpConfirmTools: true,
  mcpServers: [],
  reviewDelivery: "inline",
  branchPrefix: "qianji/",
  allowForcePush: false,
  commitMessageInstructions: "",
  pullRequestInstructions: "",
  logLevel: "info",
  shortcutNewChat: "Ctrl+Shift+N",
  shortcutSettings: "Ctrl+,",
  shortcutTerminal: "Ctrl+Shift+T",
  shortcutChanges: "Ctrl+Shift+G",
  shortcutToggleSidebar: "Ctrl+B",
  archivedSessions: [],
};

export const APP_SETTINGS_FIELD_NAMES = Object.freeze(
  Object.keys(DEFAULT_APP_SETTINGS) as Array<keyof AppSettings>,
);
