/**
 * Params and results of the methods the host answers (ADR 0002). Each one is
 * added here when its phase lands; the host checks params at runtime.
 */

export interface HostInfoResult {
  version: string;
  protocolVersion: string;
  startedAt: string;
}

/** A configured model provider, without its secret. */
export interface ProviderSummary {
  id: string;
  name: string;
  /** The adapter's wire protocol: `openai-compat`, `openai-responses`, `anthropic`, or `gemini`. */
  api: string;
  baseUrl: string;
  /**
   * Where the key comes from, for display: "environment variable X", "secret
   * store", ... Not named like a key, so log redaction and secret scanning
   * leave the description alone.
   */
  keySource: string;
}

export interface ProviderListResult {
  providers: ProviderSummary[];
}

export interface ModelListParams {
  provider: string;
}

export interface ModelPricingInfo {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelSummary {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  cost?: ModelPricingInfo;
}

export interface ModelListResult {
  models: ModelSummary[];
}

// Sessions (ADR 0004, 0008). Event payloads are typed loosely here: clients
// must ignore event and delta types they do not know (ADR 0002).

/** User message content: plain text, or text and image blocks. */
export type PromptContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>;

export interface ModelChoice {
  provider: string;
  model: string;
}

export type EffortLevel = "off" | "low" | "medium" | "high";

export interface TokenUsage {
  /** Input tokens not served from the provider's cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Thinking / reasoning tokens (already included in `outputTokens`), when reported. */
  reasoningTokens?: number;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  /** The first user message's text, clipped; a list's label until there is a title. */
  firstMessage?: string;
  archived: boolean;
  lastSeq: number;
  messageCount: number;
  /** Tokens of every model call in the session, rewound ones included. */
  usage: TokenUsage;
  /** Estimated USD cost of the session based on local pricing, when non-zero. */
  estimatedCostUsd?: number;
  forkedFrom?: { sessionId: string; seq: number };
  parent?: { sessionId: string; callId: string };
  /** A side chat of `forkedFrom.sessionId`; session lists leave it out. */
  side?: true;
}

/** One persisted event, as stored in the session log. */
export interface PersistedEvent {
  seq: number;
  ts: string;
  type: string;
  data: unknown;
}

/** Live, unpersisted progress such as a streamed chunk. */
export interface LiveDelta {
  type: string;
  [key: string]: unknown;
}

export interface AgentStatusInfo {
  running: boolean;
  /** Chunks of the model call in progress, in order. */
  streaming: unknown[];
  runningTools: Array<{ callId: string; name: string }>;
  queue: { steer: number; followUp: number };
}

export interface SessionCreateParams {
  /** Absolute path of an existing directory. */
  cwd: string;
  /** Defaults to the providers file's `defaultModel`. */
  model?: ModelChoice;
  effort?: EffortLevel;
}

export interface SessionResult {
  session: SessionInfo;
}

export interface SessionListResult {
  sessions: SessionInfo[];
}

export interface SessionRef {
  sessionId: string;
}

export interface SessionGetResult {
  session: SessionInfo;
  model?: ModelChoice;
  effort?: EffortLevel;
  status: AgentStatusInfo;
}

export interface SessionSubscribeParams extends SessionRef {
  /** Replay persisted events after this seq (default 0: all of them). */
  afterSeq?: number;
}

/**
 * What a subscriber needs to catch up. Notifications for this session follow;
 * one may arrive before this response, so clients apply events by `seq` and
 * deltas by `liveSeq`, ignoring what they already have.
 */
export interface SessionSubscribeResult {
  events: PersistedEvent[];
  status: AgentStatusInfo;
  /** The latest live seq; deltas with a higher one are new. */
  liveSeq: number;
}

export interface SessionPromptParams extends SessionRef {
  content: PromptContent;
}

export interface SessionPromptResult {
  /** Seq of the appended user event; absent when the message was queued. */
  seq?: number;
}

export interface SessionForkParams extends SessionRef {
  /** Copy the current branch up to this seq (default: all of it). */
  seq?: number;
}

export interface SessionRewindParams extends SessionRef {
  toSeq: number;
  reason?: string;
}

export interface SessionRenameParams extends SessionRef {
  title: string;
}

export interface SessionArchiveParams extends SessionRef {
  archived?: boolean;
}

export interface SessionSearchParams {
  query: string;
  cwd?: string;
  includeArchived?: boolean;
  limit?: number;
}

export interface SessionSearchHit {
  session: SessionInfo;
  snippet: string;
}

export interface SessionSearchResult {
  hits: SessionSearchHit[];
}

export interface ModelSetParams extends SessionRef, ModelChoice {}

export interface ModelSetEffortParams extends SessionRef {
  effort: EffortLevel;
}

/** Result of methods that append one event. */
export interface AppendResult {
  seq: number;
}

/** Notification `session/event`. */
export interface SessionEventNotification {
  sessionId: string;
  seq: number;
  event: PersistedEvent;
}

/** Notification `session/delta`. */
export interface SessionDeltaNotification {
  sessionId: string;
  liveSeq: number;
  delta: LiveDelta;
}

// Host-to-user requests (ADR 0002, 0009).

/** Notification `ui/request`. `notify` needs no answer and has no `requestId`. */
export type UiRequestNotification = { requestId?: string; sessionId?: string } & (
  | { kind: "confirm"; title: string; message: string }
  | { kind: "select"; title: string; options: string[] }
  | { kind: "input"; title: string; placeholder?: string }
  | { kind: "notify"; message: string; level: "info" | "warning" | "error" }
);

/** Params of `ui.respond`: `true`/`false` for confirm, an option for select, text for input. */
export interface UiRespondParams {
  requestId: string;
  value: unknown;
}

export interface UiPendingResult {
  requests: UiRequestNotification[];
}

// Feature plugins (ADR 0009).

export type PermissionModeName = "read-only" | "ask" | "workspace-write" | "full-access";
export type AgentModeName = "agent" | "plan" | "ask";

export interface PermissionGetResult {
  permission: PermissionModeName;
  agentMode: AgentModeName;
  /** What tool calls are judged by: read-only unless the agent mode is `agent`. */
  effective: PermissionModeName;
}

export interface PermissionSetParams extends SessionRef {
  permission?: PermissionModeName;
  agentMode?: AgentModeName;
}

export interface PlanInfo {
  explanation: string;
  items: Array<{ id: string; text: string; status: "pending" | "in_progress" | "completed" }>;
}

export interface PlanGetResult {
  plan: PlanInfo;
}

export interface CheckpointListResult {
  checkpoints: Array<{ userSeq: number; root: string; createdAt: string }>;
}

export interface CheckpointParams extends SessionRef {
  /** The user message whose run the checkpoint precedes. */
  userSeq: number;
}

export interface CheckpointDiffResult {
  changed: boolean;
  files: string[];
  indexChanged: boolean;
}

export interface McpServerStatus {
  id: string;
  name: string;
  transport: "stdio" | "http";
  connected: boolean;
  toolCount: number;
  protocolVersion?: string;
  resources: boolean;
  prompts: boolean;
  error?: string;
}

export interface McpStatusResult {
  servers: McpServerStatus[];
}

export interface McpReconnectParams {
  /** Reconnect one configured server by `id`, or all enabled servers when omitted. */
  serverId?: string;
}

export interface McpResourcesParams {
  serverId?: string;
}

export interface McpResourceInfo {
  serverId: string;
  serverName: string;
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourcesResult {
  resources: McpResourceInfo[];
}

export interface McpReadResourceParams {
  serverId: string;
  uri: string;
}

export interface McpReadResourceResult {
  serverId: string;
  uri: string;
  text: string;
}

export interface McpPromptsParams {
  serverId?: string;
}

export interface McpPromptInfo {
  serverId: string;
  serverName: string;
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface McpPromptsResult {
  prompts: McpPromptInfo[];
}

export interface McpGetPromptParams {
  serverId: string;
  name: string;
  arguments?: Record<string, string>;
}

export interface McpGetPromptResult {
  serverId: string;
  name: string;
  markdown: string;
}

/** Notification `mcp/changed`. */
export interface McpChangedNotification {
  servers: McpServerStatus[];
}

/** Token totals and local estimated USD cost over every session. */
export interface UsageSummaryResult {
  sessions: number;
  messages: number;
  usage: TokenUsage;
  totalCostUsd?: number;
}

/** `llm.complete`: one model call without tools or a session. Without `provider` and `model` it uses the default model. */
export interface LlmCompleteParams {
  prompt: string;
  system?: string;
  provider?: string;
  model?: string;
}

export interface LlmCompleteResult {
  text: string;
  model: ModelChoice;
}

// Scheduled tasks (ADR 0011).

export interface ScheduledTaskInfo {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  frequency: "hourly" | "daily" | "weekdays" | "weekly";
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  permissionMode: "read-only" | "ask" | "workspace-write";
  timeoutMinutes?: number;
  model?: ModelChoice;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  lastStatus: string;
  lastMessage: string;
  running: boolean;
}

export interface ScheduledRunInfo {
  id: string;
  taskId: string;
  taskName: string;
  trigger: "scheduled" | "manual";
  status: "running" | "success" | "error" | "cancelled" | "timed-out" | "interrupted";
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  sessionId?: string;
  output: string;
}

export interface ScheduleListResult {
  tasks: ScheduledTaskInfo[];
}

export interface ScheduleRunsResult {
  runs: ScheduledRunInfo[];
}

/** Notification `schedule/task`; `schedule/run` carries a `ScheduledRunInfo`. */
export type ScheduleTaskNotification = { id: string; task: Omit<ScheduledTaskInfo, "running"> } | { id: string; deleted: true };

export interface SessionExportParams extends SessionRef {
  /** Absolute path of the Markdown file to write. */
  destination: string;
}

export interface SessionExportResult {
  path: string;
}

// Dynamic plugins and workspace trust (ADR 0016).

/** Which tier a plugin comes from. `workspace` overrides `user`, which overrides `builtin`. */
export type PluginTier = "builtin" | "user" | "workspace";

/** Runtime lifecycle state of a plugin. */
export type PluginStatus = "active" | "disabled" | "errored" | "untrusted";

/** How an external plugin was installed. */
export type PluginInstallChannel = "local" | "archive" | "git" | "npm";

export interface PluginInstallOrigin {
  channel: PluginInstallChannel;
  /** Original path, package specifier, or repository URL. */
  spec: string;
  installedAt: string;
  updatedAt?: string;
}

export interface PluginInfo {
  /** Stable identifier (for example `plan`, `mcp`, or `@scope/my-plugin`). */
  id: string;
  /** Human-readable title. */
  name: string;
  version: string;
  description?: string;
  tier: PluginTier;
  status: PluginStatus;
  enabled: boolean;
  /** True when a user or workspace plugin replaces a built-in plugin with the same `id`. */
  overridesBuiltin: boolean;
  /** True when this plugin entry can be removed (for example an external plugin or user override). */
  removable: boolean;
  /** True when the plugin declares a host entry. */
  hasHost: boolean;
  /** True when the plugin declares a client UI bundle. */
  hasClient: boolean;
  /** Relative URL path on the Host WebServer (`/plugins/<encodedId>/client.js`) when `hasClient` is true. */
  clientPath?: string;
  /** Content revision hash of the client bundle, when `hasClient` is true; changes trigger UI HMR. */
  clientEtag?: string;
  /** Absolute directory path for `user` and `workspace` plugins. */
  dir?: string;
  /** Workspace root when `tier === "workspace"`. */
  workspace?: string;
  /** File-watch hot reload enabled (external plugins only). */
  watch: boolean;
  /** Installation provenance for `user` plugins installed through the manager. */
  origin?: PluginInstallOrigin;
  /** Current plugin configuration object. */
  config?: Record<string, unknown>;
  /** Optional JSON Schema describing `config` for settings UI rendering. */
  configSchema?: Record<string, unknown>;
  /** Last load or HMR error message when `status === "errored"` or a reload rolled back. */
  error?: string;
}

export interface PluginListParams {
  /** Optional active workspace path so `<workspace>/.pid/plugins` entries are included. */
  workspace?: string;
}

export interface PluginListResult {
  plugins: PluginInfo[];
}

export interface PluginToggleParams {
  id: string;
  workspace?: string;
  watch?: boolean;
}

export interface PluginConfigureParams {
  id: string;
  config: Record<string, unknown>;
  watch?: boolean;
  workspace?: string;
}

export interface PluginReloadParams {
  /** Reload one plugin by `id`, or rescan and reload all plugins when omitted. */
  id?: string;
  workspace?: string;
}

export interface PluginInstallParams {
  channel: PluginInstallChannel;
  /** Local folder/archive path, Git URL (`github:owner/repo` / `https://...`), or npm package spec (`pkg@version`). */
  spec: string;
  /** For `local` channel: link the directory in place (default `true`, enables `watch`) instead of copying it into `<dataDir>/plugins`. */
  link?: boolean;
  /** Enable file watching after install (defaults to `true` for linked `local` plugins, `false` otherwise). */
  watch?: boolean;
}

export interface PluginUpdateParams {
  /** Update one installed `user` plugin by `id`, or all updatable `git`/`npm` plugins when omitted. */
  id?: string;
}

export interface PluginRemoveParams {
  id: string;
  workspace?: string;
}

export interface PluginMutationResult {
  plugin?: PluginInfo;
  plugins: PluginInfo[];
}

export interface PluginClientBundleParams {
  id: string;
  workspace?: string;
  ifNoneMatch?: string;
}

export interface PluginClientBundleResult {
  notModified: boolean;
  etag: string;
  code?: string;
}

/** Notification `plugin/changed`. */
export interface PluginChangedNotification {
  reason: "installed" | "updated" | "removed" | "toggled" | "configured" | "reloaded" | "hmr" | "trust";
  changedIds: string[];
  plugins: PluginInfo[];
}

export interface WorkspaceTrustEntry {
  path: string;
  trustedAt: string;
}

export interface WorkspaceTrustStatusParams {
  workspace?: string;
}

export interface WorkspaceTrustListResult {
  trusted: WorkspaceTrustEntry[];
  /** Present when `workspace` was passed: trust state and whether `.pid/plugins` or `.pid/harness.json` exists. */
  current?: {
    workspace: string;
    trusted: boolean;
    hasProjectPlugins: boolean;
    hasProjectConfig: boolean;
    pluginIds: string[];
  };
}

export interface WorkspaceTrustSetParams {
  workspace: string;
  trusted: boolean;
}

/** Notification `workspace/trustChanged`. */
export interface WorkspaceTrustChangedNotification {
  workspace: string;
  trusted: boolean;
  trustedList: WorkspaceTrustEntry[];
}

// Slash commands (ADR 0002, 0003).

export interface CommandInfo {
  name: string;
  description: string;
  argsHint?: string;
  source: string;
}

export interface CommandListParams {
  cwd?: string;
}

export interface CommandListResult {
  commands: CommandInfo[];
}

export interface CommandRunParams {
  name: string;
  args?: string;
  sessionId?: string;
  cwd?: string;
}

export interface CommandRunResult {
  handled: boolean;
  output?: string;
  prompt?: string;
  clientAction?: "clear" | "compact";
  isError?: boolean;
}

/** Notification `command/changed`. */
export interface CommandChangedNotification {
  reason: string;
}

// Memory 2.0 & Skills Lifecycle (M3).

export type MemoryScope = "user" | "project";

export interface MemoryGetParams {
  scope?: MemoryScope;
  cwd?: string;
}

export interface MemoryGetResult {
  scope: MemoryScope;
  path: string;
  content: string;
  trusted: boolean;
}

export interface MemorySetParams {
  scope?: MemoryScope;
  cwd?: string;
  content: string;
}

export interface MemoryDeleteParams {
  scope?: MemoryScope;
  cwd?: string;
}

export interface MemoryExportParams {
  scope?: MemoryScope;
  cwd?: string;
  destination: string;
}

export interface MemoryExportResult {
  path: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  scope: "user" | "project";
  enabled: boolean;
  trusted: boolean;
}

export interface SkillListParams {
  cwd?: string;
}

export interface SkillListResult {
  skills: SkillInfo[];
}

export interface SkillReadParams {
  path: string;
  cwd?: string;
}

export interface SkillReadResult {
  path: string;
  content: string;
  name: string;
  description: string;
}

export interface SkillCreateParams {
  scope: "user" | "project";
  cwd?: string;
  name: string;
  description: string;
  body?: string;
}

export interface SkillCreateResult {
  skill: SkillInfo;
  content: string;
}

export interface SkillSaveParams {
  path: string;
  cwd?: string;
  content: string;
}

export interface SkillToggleParams {
  path: string;
  cwd?: string;
  enabled: boolean;
}

export interface SkillDeleteParams {
  path: string;
  cwd?: string;
}
