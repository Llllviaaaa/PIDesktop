/**
 * The agent interface (ADR 0003, 0008): what a run looks like from outside.
 * The only implementation is `@pid/agent-loop`; everything else extends a
 * run through these events, never by changing the loop.
 */
import type { StreamChunk, UserContent } from "@pid/llm";
import type { EventOf, Session } from "@pid/session";

declare module "@deepseek-ai/cordis" {
  interface Context {
    agents: Agents;
  }

  interface Events {
    /** A run is starting, before its first model call. */
    "agent/before-start"(session: Session): Promise<void> | void;
    /** Before each model call of a run; `turn` counts from 1. */
    "agent/turn-start"(session: Session, turn: number): Promise<void> | void;
    /** After a model call and the tools it asked for. */
    "agent/turn-end"(session: Session, turn: number): Promise<void> | void;
    /** The run ended and its queues are empty. */
    "agent/settled"(session: Session, outcome: RunOutcome): Promise<void>;
  }
}

/** How a run ended. */
export type RunOutcome = "done" | "aborted" | "error" | "max-turns";

/** Live progress of a run, sent as `session/delta`; never persisted. */
export type AgentDelta =
  | { type: "agent-start" }
  | { type: "agent-end"; outcome: RunOutcome }
  | { type: "turn-start"; turn: number }
  | { type: "llm-start"; provider: string; model: string }
  | { type: "llm-chunk"; chunk: StreamChunk }
  | { type: "tool-start"; callId: string; name: string }
  | { type: "tool-end"; callId: string; isError: boolean }
  | { type: "queue"; steer: number; followUp: number }
  | { type: "compaction-start" }
  | { type: "compaction-end"; ok: boolean };

/** What a client that subscribes mid-run needs to catch up on live state. */
export interface AgentStatus {
  running: boolean;
  /** The chunks of the model call in progress, in order. */
  streaming: StreamChunk[];
  runningTools: Array<{ callId: string; name: string }>;
  queue: { steer: number; followUp: number };
}

export class AgentBusyError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} is running`);
    this.name = "AgentBusyError";
  }
}

export class NoModelError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} has no model; set one first`);
    this.name = "NoModelError";
  }
}

export interface Agents {
  /** Append `content` as a user message and start a run. Throws AgentBusyError while one is running. */
  prompt(session: Session, content: UserContent[]): EventOf<"user">;
  /** Deliver `content` after the current tool calls finish; starts a run when idle. */
  steer(session: Session, content: UserContent[]): EventOf<"user"> | undefined;
  /** Deliver `content` once the run would otherwise stop; starts a run when idle. */
  followUp(session: Session, content: UserContent[]): EventOf<"user"> | undefined;
  /** Stop the run, if any, and resolve once it has settled. Queued messages are dropped. */
  abort(sessionId: string): Promise<void>;
  /** Summarize the older part of the context. Throws AgentBusyError while running. */
  compact(session: Session, signal?: AbortSignal): Promise<EventOf<"compaction"> | undefined>;
  status(sessionId: string): AgentStatus;
  /** Resolves when the session has no run. */
  idle(sessionId: string): Promise<void>;
}
