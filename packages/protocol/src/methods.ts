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
  /** The adapter's wire protocol: `openai-compat` or `anthropic`. */
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

export interface ModelSummary {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
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

export interface SessionInfo {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  archived: boolean;
  lastSeq: number;
  forkedFrom?: { sessionId: string; seq: number };
  parent?: { sessionId: string; callId: string };
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
