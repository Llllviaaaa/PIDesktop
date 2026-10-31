export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens?: number;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Record<string, unknown>;
}

export interface ModelProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow?: number | null;
  maxTokens?: number | null;
}

export interface ModelProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  hasApiKey: boolean;
  apiKeySource: "none" | "stored" | "environment" | "command";
  authHeader: boolean;
  models: ModelProviderModel[];
}

export interface ModelProviderInput {
  originalId?: string | null;
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  keepExistingApiKey: boolean;
  authHeader: boolean;
  models: ModelProviderModel[];
}

export interface ModelProviderCheckResult {
  ok: boolean;
  message: string;
}

export interface SessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

export interface SlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: unknown;
}

export type ExtensionUIRequest =
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export interface AppSettings {
  provider: string;
  model: string;
  thinkingLevel: string;
  /** `provider/model` keys hidden from the composer model picker. */
  hiddenModels?: string[];
  /** Where Pi kept its sessions, if not `~/.pi/agent/sessions`; only read to import them (P6b). */
  sessionDir: string;
  agentMode: "agent" | "plan" | "ask";
  permissionMode: "read-only" | "ask" | "workspace-write" | "full-access";
  /** Shell/bash/exec always requires confirmation (unless full-access). */
  alwaysConfirmShell: boolean;
  /** Block model writes outside the workspace without prompting. */
  blockWriteOutsideWorkspace: boolean;
  /** Newline- or comma-separated command prefixes that skip shell confirmation. */
  shellAllowPrefixes: string;
  toolRules: ToolPermissionRule[];
  /** Default new-task environment when starting a coding task. */
  defaultTaskEnvironment: "local" | "worktree";
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
  terminalOutput: "summary" | "full";
  notificationsEnabled: boolean;
  notifyOnCompletion: boolean;
  notifyOnApproval: boolean;
  notifyOnlyWhenUnfocused: boolean;
  theme: string;
  petEnabled: boolean;
  petCharacter: string;
  petSize: number;
  accentColor: string;
  backgroundColor: string;
  foregroundColor: string;
  uiFont: string;
  codeFont: string;
  uiScale: number;
  /** Transcript body size in px (10–22), as DSH's content font size. */
  messageFontSize: number;
  personality: "friendly" | "pragmatic" | "none";
  customInstructions: string;
  suggestedPrompts: boolean;
  memoryEnabled: boolean;
  planTrackingEnabled: boolean;
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
  pullRequestInstructions: string;
  logLevel: "error" | "warn" | "info" | "debug";
  shortcutNewChat: string;
  shortcutSettings: string;
  shortcutTerminal: string;
  shortcutChanges: string;
  shortcutToggleSidebar: string;
  archivedSessions: string[];
}

export type AppNotificationKind = "completion" | "approval" | "question";

export interface AppNotification {
  id: string;
  kind: AppNotificationKind;
  title: string;
  body: string;
  cwd: string;
  sessionFile: string | null;
  createdAt: number;
  read: boolean;
}

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

export interface SessionInfo {
  file: string;
  sessionId: string;
  cwd: string;
  name?: string;
  firstMessage?: string;
  messageCount: number;
  createdAt?: string;
  updatedAt?: number;
}

export interface DesktopHookConfig {
  id: string;
  name: string;
  enabled: boolean;
  event: "session_start" | "before_agent_start" | "agent_end" | "agent_settled" | "tool_call" | "tool_result";
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

export interface WorkspaceEditorInfo {
  /** Catalog id from the backend (`vscode`, `cursor`, `webstorm`, ...). */
  id: string;
  name: string;
  /** Whether the editor can open a file at a given line. */
  supportsLine: boolean;
}

/** An external terminal app the "open in" menu can hand the workspace to. */
export interface TerminalAppInfo {
  id: string;
  name: string;
}

export interface AttachmentPayload {
  path: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: "image" | "text" | "file";
  data?: string;
  text?: string;
}

export interface ManagedQueuedMessage {
  id: string;
  text: string;
  attachments: AttachmentPayload[];
  createdAt: number;
}

export interface GitFileChange {
  path: string;
  status: string;
  indexStatus?: string;
  worktreeStatus?: string;
  staged?: boolean;
  unstaged?: boolean;
  untracked?: boolean;
}

export interface GitSnapshot {
  isRepository: boolean;
  branch?: string;
  files: GitFileChange[];
  diff: string;
  /** Only the working-tree snapshot (`git_snapshot`) reports this. */
  sync?: GitSyncStatus;
}

/** Where the current branch stands against its remote. */
export interface GitSyncStatus {
  /** `origin/main`; absent until the branch is published, or after its remote branch was deleted. */
  upstream?: string;
  ahead: number;
  behind: number;
  hasRemote: boolean;
}

export interface GitCommitResult {
  sha: string;
  shortSha: string;
  subject: string;
  branch: string;
}

export interface GitPushResult {
  remote: string;
  branch: string;
  /** The push published the branch and made the remote branch its upstream. */
  setUpstream: boolean;
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
}

export interface GitCommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  timestamp: number;
}

export interface WorktreeInfo {
  path: string;
  head?: string;
  branch?: string;
  isMain: boolean;
}

export interface ProjectConfig {
  path: string;
  name: string;
  pinned: boolean;
  hidden: boolean;
}

export type ScheduledFrequency = "hourly" | "daily" | "weekdays" | "weekly";
export type ScheduledPermissionMode = "read-only" | "ask" | "workspace-write";

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  frequency: ScheduledFrequency;
  hour: number;
  minute: number;
  weekday: number;
  permissionMode: ScheduledPermissionMode;
  timeoutMinutes?: number | null;
  enabled: boolean;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  lastStatus: "" | "running" | "success" | "error" | "interrupted" | "cancelled" | "timed-out";
  lastMessage: string;
}

export interface ScheduledRunRecord {
  id: string;
  taskId: string;
  taskName: string;
  cwd: string;
  prompt: string;
  permissionMode: ScheduledPermissionMode;
  trigger: "manual" | "scheduled";
  status: "running" | "success" | "error" | "interrupted" | "cancelled" | "timed-out";
  startedAt: number;
  finishedAt?: number | null;
  durationMs?: number | null;
  exitCode?: number | null;
  output: string;
  sessionFile?: string | null;
}

export interface ScheduledRunResult {
  success: boolean;
  output: string;
  run: ScheduledRunRecord;
}

export interface PullRequestInfo {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  url: string;
  author: string;
  reviewDecision: string;
}

export interface PullRequestCollection {
  repository: string;
  remoteUrl: string;
  items: PullRequestInfo[];
}

export interface WorkspaceDirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface WorkspaceFileContent {
  path: string;
  fileName: string;
  text: string | null;
  mimeType?: string | null;
  data?: string | null;
  truncated: boolean;
  isBinary: boolean;
  size: number;
}

export interface ResourceItem {
  kind: "extension" | "skill" | "package" | "prompt" | "theme" | "pet";
  name: string;
  path: string;
  scope: "user" | "project";
  version?: string | null;
}

export interface PackageCatalogItem {
  name: string;
  version: string;
  description: string;
  author: string;
  publishedAt: string;
  downloads: number;
  score: number;
  keywords: string[];
  npmUrl: string;
  repositoryUrl?: string | null;
  homepageUrl?: string | null;
}

export interface PackageCatalogPage {
  items: PackageCatalogItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PackageCatalogDetail {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  keywords: string[];
  npmUrl: string;
  repositoryUrl?: string | null;
  homepageUrl?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
  extensions: string[];
  skills: string[];
  prompts: string[];
  themes: string[];
  dependencyCount: number;
  peerDependencyCount: number;
  unpackedSize: number;
  integrity: string;
}

export interface ForkPoint {
  entryId: string;
  text: string;
}

export interface SessionTreeNodeView {
  entryId: string;
  parentId: string | null;
  role: string;
  summary: string;
  depth: number;
  isLeaf: boolean;
  childCount: number;
}

export interface UsageSummary {
  sessions: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
}

export interface UiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  images?: ImageContent[];
  details?: Record<string, unknown>;
  isError?: boolean;
  running: boolean;
  startedAt?: number;
  finishedAt?: number;
}

/** One native process row inside a DeepSeek-Harness-style turn fold. */
export type WorkStep =
  | { kind: "thinking"; text: string }
  | { kind: "note"; text: string }
  | { kind: "tool"; call: UiToolCall };

export interface AgentBrowserState {
  url: string;
  title: string;
  screenshot?: ImageContent;
  updatedAt: number;
}

export interface ComputerState {
  action: string;
  width: number;
  height: number;
  left: number;
  top: number;
  imageWidth?: number;
  imageHeight?: number;
  scaleX?: number;
  scaleY?: number;
  captureBackend?: string;
  frameId?: string;
  stable?: boolean;
  windowTitle?: string;
  windowHandle?: string;
  elements?: ComputerElementState[];
  observationError?: string;
  screenshot?: ImageContent;
  updatedAt: number;
}

export interface ComputerElementState {
  ref: string;
  role: string;
  name: string;
  value?: string;
  bounds: { x: number; y: number; width: number; height: number };
  enabled: boolean;
  focused: boolean;
  focusable: boolean;
  patterns: string[];
}

export interface UiMessage {
  id: string;
  /** The user message's seq in its Host session log, which rewind and fork take. */
  entryId?: string;
  role: "user" | "assistant" | "terminal" | "notice";
  content: string;
  /** Distinguishes compaction/branch notices from generic system notes. */
  noticeKind?: "compaction" | "branch";
  images?: ImageContent[];
  thinking?: string;
  /** Ordered thinking / narration / tool rows for the compact turn fold. */
  workSteps?: WorkStep[];
  model?: string;
  usage?: Usage;
  isStreaming?: boolean;
  toolCalls?: UiToolCall[];
  isError?: boolean;
  /** The user stopped this turn; what it wrote so far is kept, and it is not an error. */
  isAborted?: boolean;
  durationMs?: number;
  timestamp: number;
}

export interface Toast {
  id: string;
  message: string;
  kind: "info" | "warning" | "error";
}

export type ConnectionState = "disconnected" | "starting" | "running" | "exited";
