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
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: { type: string; contentIndex?: number; delta?: string; toolCall?: ToolCallContent; partial?: ToolCallContent } }
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
  permissionMode: "read-only" | "ask" | "workspace-write" | "full-access";
  showThinking: boolean;
  autoConnect: boolean;
  followUpBehavior: "steer" | "followUp";
  requireCtrlEnter: boolean;
  preventSleep: boolean;
  language: "system" | "en" | "zh-CN";
  defaultFileOpener: "system" | "cursor" | "vscode";
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

export interface AttachmentPayload {
  path: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: "image" | "text" | "file";
  data?: string;
  text?: string;
}

export interface GitFileChange {
  path: string;
  status: string;
}

export interface GitSnapshot {
  isRepository: boolean;
  branch?: string;
  files: GitFileChange[];
  diff: string;
}

export interface WorktreeInfo {
  path: string;
  head?: string;
  branch?: string;
  isMain: boolean;
}

export interface ResourceItem {
  kind: "extension" | "skill" | "package" | "prompt";
  name: string;
  path: string;
  scope: "user" | "project";
}

export interface ForkPoint {
  entryId: string;
  text: string;
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
  isError?: boolean;
  running: boolean;
  startedAt?: number;
  finishedAt?: number;
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
  timestamp: number;
}

export interface Toast {
  id: string;
  message: string;
  kind: "info" | "warning" | "error";
}

export type ConnectionState = "disconnected" | "starting" | "running" | "exited";
