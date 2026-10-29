/**
 * Derivation rules of ADR 0004. Everything here is a pure function of the
 * event list, so tests can assert on JSONL fixtures directly.
 */
import type { AssistantMessage, Effort, Message, ToolResultMessage } from "@pid/llm";
import type { ModelRef, SessionEvent, SessionHeader, SessionSummary } from "./types.ts";

/** The note a compaction summary is sent to the model under. */
export const COMPACTION_PREFIX = "The conversation so far was compacted. Summary of the earlier part:\n\n";
export const INTERRUPTED_TOOL_RESULT = "The tool call was interrupted before it returned a result.";

/**
 * The events on the current branch, in order: each `rewind` drops the
 * branch's events after its `toSeq`. `rewind` events themselves are left out.
 */
export function currentBranch(events: readonly SessionEvent[]): SessionEvent[] {
  let branch: SessionEvent[] = [];
  for (const event of events) {
    if (event.type === "rewind") {
      const { toSeq } = event.data;
      branch = branch.filter((kept) => kept.seq <= toSeq);
    } else {
      branch.push(event);
    }
  }
  return branch;
}

export interface SessionState {
  messages: Message[];
  model?: ModelRef;
  effort?: Effort;
  title?: string;
  archived: boolean;
  /** Seq of the latest compaction on the branch, if any. */
  compactedThrough?: number;
}

function closeDanglingCalls(messages: Message[], pending: Map<string, string>): void {
  // A call without a result (the host died mid-tool) would make the next
  // request invalid at every provider, so it gets an error result.
  for (const [callId] of pending) {
    messages.push({ role: "tool-result", callId, content: [{ type: "text", text: INTERRUPTED_TOOL_RESULT }], isError: true });
  }
  pending.clear();
}

/** The LLM context and session settings on the current branch. */
export function deriveState(events: readonly SessionEvent[]): SessionState {
  const branch = currentBranch(events);
  const state: SessionState = { messages: [], archived: false };

  let compaction: { throughSeq: number; summary: string; seq: number } | undefined;
  for (const event of branch) {
    if (event.type === "compaction") compaction = { ...event.data, seq: event.seq };
    else if (event.type === "model") state.model = { provider: event.data.provider, model: event.data.model };
    else if (event.type === "effort") state.effort = event.data.effort;
    else if (event.type === "label") {
      if (event.data.title !== undefined) state.title = event.data.title;
      if (event.data.archived !== undefined) state.archived = event.data.archived;
    }
  }

  const messages: Message[] = [];
  if (compaction !== undefined) {
    state.compactedThrough = compaction.seq;
    messages.push({ role: "user", content: [{ type: "text", text: COMPACTION_PREFIX + compaction.summary }] });
  }
  const pending = new Map<string, string>();
  for (const event of branch) {
    if (compaction !== undefined && event.seq <= compaction.throughSeq) continue;
    if (event.type === "user") {
      closeDanglingCalls(messages, pending);
      messages.push({ role: "user", content: event.data.content });
    } else if (event.type === "assistant") {
      closeDanglingCalls(messages, pending);
      // An empty reply (an error before any output) carries nothing to send back.
      if (event.data.content.length === 0) continue;
      const message: AssistantMessage = { role: "assistant", content: event.data.content };
      messages.push(message);
      for (const block of event.data.content) if (block.type === "tool-call") pending.set(block.id, block.name);
    } else if (event.type === "tool-result") {
      if (!pending.delete(event.data.callId)) continue;
      const result: ToolResultMessage = { role: "tool-result", callId: event.data.callId, content: event.data.content, isError: event.data.isError };
      messages.push(result);
    }
  }
  closeDanglingCalls(messages, pending);
  state.messages = messages;
  return state;
}

export function summarize(header: SessionHeader, events: readonly SessionEvent[]): SessionSummary {
  let title: string | undefined;
  let archived = false;
  for (const event of currentBranch(events)) {
    if (event.type !== "label") continue;
    if (event.data.title !== undefined) title = event.data.title;
    if (event.data.archived !== undefined) archived = event.data.archived;
  }
  const last = events.at(-1);
  return {
    id: header.id,
    cwd: header.cwd,
    createdAt: header.createdAt,
    updatedAt: last?.ts ?? header.createdAt,
    ...(title === undefined ? {} : { title }),
    archived,
    lastSeq: last?.seq ?? 0,
    ...(header.forkedFrom === undefined ? {} : { forkedFrom: header.forkedFrom }),
    ...(header.parent === undefined ? {} : { parent: header.parent }),
  };
}

/**
 * The branch up to `atSeq`, renumbered from 1, for a fork. A compaction's
 * `throughSeq` moves to the new number of the last copied event at or before it.
 */
export function forkEvents(events: readonly SessionEvent[], atSeq: number): SessionEvent[] {
  const copied = currentBranch(events).filter((event) => event.seq <= atSeq);
  const renumbered = new Map<number, number>();
  copied.forEach((event, index) => renumbered.set(event.seq, index + 1));
  const newSeqAtOrBefore = (seq: number): number => {
    let found = 0;
    for (const [oldSeq, newSeq] of renumbered) if (oldSeq <= seq) found = newSeq;
    return found;
  };
  return copied.map((event, index) => {
    const seq = index + 1;
    if (event.type === "compaction") {
      return { ...event, seq, data: { ...event.data, throughSeq: newSeqAtOrBefore(event.data.throughSeq) } };
    }
    return { ...event, seq };
  });
}

/**
 * The `throughSeq` of a compaction: the end of the branch, or with
 * `keepLatestTurn` the event before the latest user message (the whole branch
 * when that message is the only turn).
 */
export function compactionPoint(events: readonly SessionEvent[], keepLatestTurn = false): number | undefined {
  const branch = currentBranch(events);
  const lastUser = keepLatestTurn ? branch.findLastIndex((event) => event.type === "user") : -1;
  const earlierTurn = branch.slice(0, Math.max(0, lastUser)).some((event) => event.type === "user");
  if (!earlierTurn) return branch.at(-1)?.seq;
  return branch[lastUser - 1]?.seq;
}

/** The data of the latest `custom` event of `ns` on the current branch: a plugin's session state. */
export function latestCustom<T = unknown>(events: readonly SessionEvent[], ns: string): T | undefined {
  const branch = currentBranch(events);
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const event = branch[index];
    if (event?.type === "custom" && event.data.ns === ns) return event.data.data as T;
  }
  return undefined;
}

/** Every `custom` event of `ns` on the current branch, oldest first. */
export function customEvents(events: readonly SessionEvent[], ns: string): Array<Extract<SessionEvent, { type: "custom" }>> {
  return currentBranch(events).filter((event): event is Extract<SessionEvent, { type: "custom" }> => event.type === "custom" && event.data.ns === ns);
}
