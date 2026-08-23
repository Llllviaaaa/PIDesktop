export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ContentBlock = TextContent | ThinkingContent | ImageContent | ToolCallContent;

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

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCallContent)[];
  provider: string;
  model: string;
  usage?: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | "pending";
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | CompactionSummaryMessage
  | BranchSummaryMessage;

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

export interface RpcData {
  model?: ModelInfo;
  models?: ModelInfo[];
  levels?: string[];
  messages?: AgentMessage[];
  commands?: SlashCommand[];
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
  cancelled?: boolean;
  path?: string;
  text?: string | null;
  level?: string;
  output?: string;
  exitCode?: number;
  truncated?: boolean;
  fullOutputPath?: string;
  [key: string]: unknown;
}

export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  error?: string;
  data?: RpcData;
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

export type PiEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: AgentMessage[]; willRetry?: boolean }
  | { type: "agent_settled" }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AssistantMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | {
      type: "message_update";
      /** Older Pi versions included the cumulative message; current RPC sends deltas only. */
      message?: AgentMessage;
      assistantMessageEvent: {
        type: string;
        contentIndex?: number;
        delta?: string;
        content?: string;
        toolCall?: ToolCallContent;
        message?: AssistantMessage;
        error?: AssistantMessage;
      };
    }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: Record<string, unknown>; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "bash_execution_update"; id?: string; delta?: string; output?: string; done?: boolean; cancelled?: boolean; exitCode?: number }
  | { type: "queue_update"; steering: unknown[]; followUp: unknown[] }
  | { type: "compaction_start"; reason?: string }
  | { type: "compaction_end"; reason?: string; result?: unknown; aborted?: boolean; errorMessage?: string; willRetry?: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "extension_error"; error: string; extensionPath?: string; event?: string }
  | ExtensionUIRequest
  | RpcResponse;

export interface AppSettings {
  piBinary: string;
  provider: string;
  model: string;
  thinkingLevel: string;
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
  autoConnect: boolean;
  followUpBehavior: "steer" | "followUp";
  requireCtrlEnter: boolean;
  preventSleep: boolean;
  language: "system" | "en" | "zh-CN";
  defaultFileOpener: "system" | "cursor" | "vscode" | "windsurf" | "antigravity";
  terminalShell: string;
  terminalOutput: "summary" | "full";
  notificationsEnabled: boolean;
  notifyOnCompletion: boolean;
  notifyOnApproval: boolean;
  notifyOnlyWhenUnfocused: boolean;
  theme: "system" | "dark" | "light";
  accentColor: string;
  backgroundColor: string;
  foregroundColor: string;
  uiFont: string;
  codeFont: string;
  uiScale: number;
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
  id: "cursor" | "vscode" | "windsurf" | "antigravity";
  name: string;
}

export interface SessionMessageTiming {
  role: "user" | "assistant";
  messageTimestamp: number;
  entryTimestamp: string;
}

export interface SessionHistory {
  messages: AgentMessage[];
  timings: SessionMessageTiming[];
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
}

export interface GitBranchInfo {
  name: string;
  current: boolean;
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
  enabled: boolean;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  lastStatus: "" | "running" | "success" | "error" | "interrupted";
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
  status: "running" | "success" | "error" | "interrupted";
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
  kind: "extension" | "skill" | "package" | "prompt" | "theme";
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

export interface BrowserState {
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
  screenshot?: ImageContent;
  updatedAt: number;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant" | "terminal" | "notice";
  content: string;
  images?: ImageContent[];
  thinking?: string;
  model?: string;
  usage?: Usage;
  isStreaming?: boolean;
  toolCalls?: UiToolCall[];
  isError?: boolean;
  durationMs?: number;
  timestamp: number;
}

export interface Toast {
  id: string;
  message: string;
  kind: "info" | "warning" | "error";
}

export type ConnectionState = "disconnected" | "starting" | "running" | "exited";
