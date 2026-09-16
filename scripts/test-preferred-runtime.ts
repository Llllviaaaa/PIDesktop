import assert from "node:assert/strict";
import {
  preferredModelFromSettings,
  settingsWithPreferredModel,
  settingsWithPreferredThinking,
  shouldApplyPreferredModel,
  shouldApplyPreferredThinking,
} from "../src/lib/preferredRuntime";
import type { AppSettings, ModelInfo } from "../src/types";

const gemini: ModelInfo = { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", provider: "google", reasoning: true };
const grok: ModelInfo = { id: "grok-4", name: "Grok 4", provider: "xai", reasoning: true };
const settings: AppSettings = {
  piBinary: "pi",
  provider: "",
  model: "",
  thinkingLevel: "medium",
  sessionDir: "",
  agentMode: "agent",
  permissionMode: "ask",
  alwaysConfirmShell: true,
  blockWriteOutsideWorkspace: true,
  shellAllowPrefixes: "",
  toolRules: [],
  defaultTaskEnvironment: "local",
  showThinking: true,
  transcriptDensity: "normal",
  autoConnect: false,
  followUpBehavior: "steer",
  requireCtrlEnter: false,
  preventSleep: true,
  language: "zh-CN",
  defaultFileOpener: "system",
  terminalShell: "PowerShell",
  terminalOutput: "summary",
  notificationsEnabled: true,
  notifyOnCompletion: true,
  notifyOnApproval: true,
  notifyOnlyWhenUnfocused: true,
  theme: "light",
  petEnabled: false,
  petCharacter: "cat",
  petSize: 96,
  accentColor: "#111111",
  backgroundColor: "#ffffff",
  foregroundColor: "#1a1a1a",
  uiFont: "sans-serif",
  codeFont: "monospace",
  uiScale: 100,
  personality: "pragmatic",
  customInstructions: "",
  suggestedPrompts: true,
  memoryEnabled: true,
  planTrackingEnabled: true,
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
  branchPrefix: "pi/",
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

assert.equal(preferredModelFromSettings(settings, [gemini, grok]), null);
assert.equal(preferredModelFromSettings({ ...settings, model: "grok-4", provider: "xai" }, [gemini, grok]), grok);
assert.equal(preferredModelFromSettings({ ...settings, model: "grok-4" }, [gemini, grok]), grok);
assert.equal(preferredModelFromSettings({ ...settings, model: "missing", provider: "google" }, [gemini, grok]), null);

const withModel = settingsWithPreferredModel(settings, gemini);
assert.equal(withModel.provider, "google");
assert.equal(withModel.model, "gemini-3.7-flash");
assert.strictEqual(settingsWithPreferredModel(withModel, gemini), withModel);

const withThinking = settingsWithPreferredThinking(settings, "high");
assert.equal(withThinking.thinkingLevel, "high");
assert.strictEqual(settingsWithPreferredThinking(withThinking, "high"), withThinking);
assert.strictEqual(settingsWithPreferredThinking(settings, "  "), settings);

assert.equal(shouldApplyPreferredModel(gemini, gemini), false);
assert.equal(shouldApplyPreferredModel(grok, gemini), true);
assert.equal(shouldApplyPreferredModel(null, gemini), true);
assert.equal(shouldApplyPreferredModel(gemini, null), false);

assert.equal(shouldApplyPreferredThinking("medium", "high"), true);
assert.equal(shouldApplyPreferredThinking("high", "high"), false);
assert.equal(shouldApplyPreferredThinking("high", "  "), false);

console.log("preferred runtime tests passed");
