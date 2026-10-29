/**
 * The session log format (ADR 0004): a header line, then one event per line.
 * A session is append-only; the LLM context and the transcript are derived
 * from the events, never stored.
 */
import type { AssistantContent, Effort, FinishReason, LlmErrorInfo, ToolResultContent, Usage, UserContent } from "@pid/llm";

export const SESSION_FORMAT = "pid.session";
export const SESSION_FORMAT_VERSION = 1;

export interface SessionHeader {
  format: typeof SESSION_FORMAT;
  version: number;
  id: string;
  createdAt: string;
  cwd: string;
  forkedFrom?: { sessionId: string; seq: number };
  parent?: { sessionId: string; callId: string };
}

export interface ModelRef {
  provider: string;
  model: string;
}

/** The `data` of each v1 event type. */
export interface SessionEventData {
  user: { content: UserContent[] };
  assistant: {
    content: AssistantContent[];
    model: ModelRef;
    usage: Usage;
    stop: FinishReason;
    error?: LlmErrorInfo;
  };
  /** A tool call is about to run with these (possibly rewritten) arguments. */
  "tool-call": { callId: string; name: string; args: Record<string, unknown> };
  "tool-result": { callId: string; name: string; content: ToolResultContent[]; isError: boolean };
  model: ModelRef;
  effort: { effort: Effort };
  /** Derive `throughSeq` and everything before it from `summary` instead. */
  compaction: { throughSeq: number; summary: string };
  /** Continue the current branch from `toSeq`; later events stay in the file. */
  rewind: { toSeq: number; reason?: string };
  label: { title?: string; archived?: boolean };
  /** Plugin-private data; `ns` is the plugin name. Readers skip unknown `ns`. */
  custom: { ns: string; data: unknown };
}

export type SessionEventType = keyof SessionEventData;

export type SessionEvent = {
  [K in SessionEventType]: { seq: number; ts: string; type: K; data: SessionEventData[K] };
}[SessionEventType];

export type EventOf<K extends SessionEventType> = Extract<SessionEvent, { type: K }>;

export const SESSION_EVENT_TYPES: readonly SessionEventType[] = [
  "user", "assistant", "tool-call", "tool-result", "model", "effort", "compaction", "rewind", "label", "custom",
];

export function isSessionEventType(type: unknown): type is SessionEventType {
  return SESSION_EVENT_TYPES.includes(type as SessionEventType);
}

/** What a session list shows, kept cheap to compute from a log. */
export interface SessionSummary {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  archived: boolean;
  lastSeq: number;
  forkedFrom?: SessionHeader["forkedFrom"];
  parent?: SessionHeader["parent"];
}
