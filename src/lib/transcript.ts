/**
 * The conversation as the Harness Host records and streams it, in the
 * `UiMessage`s the transcript renders (P6d-2, docs/adr/0014).
 *
 * A session's log (`PersistedEvent`s, ADR 0004) becomes the transcript with
 * `historyToUi`; while a task runs, `TranscriptTranslator` turns the Host's
 * notifications into `TranscriptEvent`s and the reducers below apply them.
 * Everything here is pure or a small per-runtime translator, so it is tested
 * against the agent loop's golden logs.
 */
import type { LiveDelta, PersistedEvent } from "@pid/protocol";
import type { ExtensionUIRequest, ImageContent, UiMessage, UiToolCall, Usage } from "../types";

/** What a running task reports, in the transcript's terms. */
export type TranscriptEvent =
  | { type: "turn-start" }
  | { type: "turn-end" }
  | { type: "user"; message: UiMessage }
  | { type: "assistant-start" }
  | { type: "assistant-delta"; text: string; thinking: string }
  | { type: "assistant-tool-calls"; calls: UiToolCall[] }
  | { type: "assistant"; message: UiMessage }
  | { type: "tool-start"; callId: string; name: string; args: Record<string, unknown> }
  | { type: "tool-end"; callId: string; name: string; result: ToolResult }
  | { type: "queue"; steering: number; followUp: number }
  | { type: "compaction-start" }
  | { type: "compaction-end"; failed: boolean }
  | { type: "plan"; lines: string[] }
  | { type: "ui-request"; request: ExtensionUIRequest };

/** A finished tool call: its text, any images, and whether it failed. */
export interface ToolResult {
  text?: string;
  images?: ImageContent[];
  isError: boolean;
  finishedAt: number;
}

type Block = { type: string; [key: string]: unknown };

const timestampOf = (event: PersistedEvent): number => {
  const parsed = Date.parse(event.ts);
  return Number.isFinite(parsed) ? parsed : 0;
};

const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);

function textOf(blocks: Block[]): string {
  return blocks.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("");
}

function imagesOf(blocks: Block[]): ImageContent[] | undefined {
  const images = blocks.flatMap((block): ImageContent[] => (
    block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"
      ? [{ type: "image", data: block.data, mimeType: block.mimeType }]
      : []
  ));
  return images.length > 0 ? images : undefined;
}

/** The Host's token counts as the transcript's usage. The Host does not price calls. */
function usageOf(value: unknown): Usage {
  const usage = (value ?? {}) as Record<string, unknown>;
  const n = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  const input = n("inputTokens");
  const output = n("outputTokens");
  const cacheRead = n("cacheReadTokens");
  const cacheWrite = n("cacheWriteTokens");
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite };
}

/** A user message; its `entryId` is the event's seq, which rewind and fork take. */
export function userMessageOf(event: PersistedEvent): UiMessage {
  const blocks = blocksOf((event.data as { content?: unknown }).content);
  return {
    id: `host-${event.seq}`,
    entryId: String(event.seq),
    role: "user",
    content: textOf(blocks),
    images: imagesOf(blocks),
    timestamp: timestampOf(event),
  };
}

/** A finished model reply, with the tool calls it asked for (not run yet). */
export function assistantMessageOf(event: PersistedEvent, durationMs?: number): UiMessage {
  const data = event.data as { content?: unknown; model?: { model?: string }; usage?: unknown; stop?: string; error?: { message?: string } };
  const blocks = blocksOf(data.content);
  const thinking = blocks.flatMap((block) => (block.type === "thinking" && typeof block.text === "string" ? [block.text] : [])).join("");
  const timestamp = timestampOf(event);
  const toolCalls = blocks.flatMap((block): UiToolCall[] => (
    block.type === "tool-call" && typeof block.id === "string" && typeof block.name === "string"
      ? [{ id: block.id, name: block.name, args: (block.arguments ?? {}) as Record<string, unknown>, running: false, startedAt: timestamp }]
      : []
  ));
  return {
    id: `host-${event.seq}`,
    role: "assistant",
    content: textOf(blocks) || data.error?.message || "",
    thinking: thinking || undefined,
    model: data.model?.model,
    usage: usageOf(data.usage),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    isStreaming: false,
    isError: data.stop === "error" || data.stop === "aborted",
    durationMs,
    timestamp,
  };
}

/** A tool's result, for the call it answers. */
export function toolResultOf(event: PersistedEvent): { callId: string; name: string; result: ToolResult } {
  const data = event.data as { callId?: string; name?: string; content?: unknown; isError?: boolean };
  const blocks = blocksOf(data.content);
  return {
    callId: data.callId ?? "",
    name: data.name ?? "",
    result: { text: textOf(blocks) || undefined, images: imagesOf(blocks), isError: data.isError === true, finishedAt: timestampOf(event) },
  };
}

/** The events on the current branch: each `rewind` drops what came after its `toSeq` (ADR 0004). */
export function currentBranch(events: readonly PersistedEvent[]): PersistedEvent[] {
  let branch: PersistedEvent[] = [];
  for (const event of events) {
    if (event.type === "rewind") {
      const toSeq = (event.data as { toSeq?: number }).toSeq ?? 0;
      branch = branch.filter((kept) => kept.seq <= toSeq);
    } else {
      branch.push(event);
    }
  }
  return branch;
}

/**
 * The transcript of a session log. A reply's duration runs from the user
 * message that started its turn; a compaction shows as a notice where it
 * happened, and the messages before it stay visible.
 */
export function historyToUi(events: readonly PersistedEvent[]): UiMessage[] {
  const messages: UiMessage[] = [];
  // The calls are built here, so they can be finished in place: a long log stays linear.
  const calls = new Map<string, UiToolCall>();
  let turnStartedAt: number | null = null;
  for (const event of currentBranch(events)) {
    if (event.type === "user") {
      const message = userMessageOf(event);
      turnStartedAt = message.timestamp;
      messages.push(message);
    } else if (event.type === "assistant") {
      const at = timestampOf(event);
      const message = assistantMessageOf(event, turnStartedAt !== null && at > turnStartedAt ? at - turnStartedAt : undefined);
      for (const call of message.toolCalls ?? []) calls.set(call.id, call);
      messages.push(message);
    } else if (event.type === "tool-result") {
      const { callId, result } = toolResultOf(event);
      const call = calls.get(callId);
      if (call !== undefined) Object.assign(call, { running: false, result: result.text, images: result.images, isError: result.isError, finishedAt: result.finishedAt });
    } else if (event.type === "compaction") {
      const summary = (event.data as { summary?: string }).summary ?? "";
      messages.push({ id: `host-${event.seq}`, role: "notice", noticeKind: "compaction", content: `Context compacted\n\n${summary}`, timestamp: timestampOf(event) });
    }
  }
  return messages;
}

/** Replace the message with id `id` by `incoming` (keeping the id), or append it. */
export function replaceOrAppend(messages: UiMessage[], id: string | undefined, incoming: UiMessage): UiMessage[] {
  const index = id === undefined ? -1 : messages.findIndex((message) => message.id === id);
  if (index < 0) return [...messages, incoming];
  const next = [...messages];
  next[index] = { ...incoming, id: next[index].id };
  return next;
}

const lastStreamingAssistant = (messages: UiMessage[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") return messages[index].isStreaming ? index : -1;
  }
  return -1;
};

/** Start the reply being streamed, unless one already is. */
export function startAssistant(messages: UiMessage[], now = Date.now()): UiMessage[] {
  if (lastStreamingAssistant(messages) >= 0) return messages;
  return [...messages, { id: `stream-${now}`, role: "assistant", content: "", isStreaming: true, timestamp: now }];
}

/** Add streamed text, thinking and announced tool calls to the reply being streamed. */
export function streamAssistant(messages: UiMessage[], delta: { text?: string; thinking?: string; toolCalls?: UiToolCall[] }, now = Date.now()): UiMessage[] {
  const started = startAssistant(messages, now);
  const index = lastStreamingAssistant(started);
  const previous = started[index];
  const calls = new Map((previous.toolCalls ?? []).map((call) => [call.id, call]));
  for (const call of delta.toolCalls ?? []) calls.set(call.id, { ...calls.get(call.id), ...call });
  const next = [...started];
  next[index] = {
    ...previous,
    content: previous.content + (delta.text ?? ""),
    thinking: `${previous.thinking ?? ""}${delta.thinking ?? ""}` || undefined,
    toolCalls: calls.size > 0 ? [...calls.values()] : undefined,
    isStreaming: true,
  };
  return next;
}

/**
 * The finished reply replaces the one being streamed, keeping its id and
 * what its tool calls have done so far; without one it is appended.
 */
export function completeAssistant(messages: UiMessage[], message: UiMessage): UiMessage[] {
  const index = lastStreamingAssistant(messages);
  if (index < 0) return [...messages, message];
  const previous = messages[index];
  const before = new Map((previous.toolCalls ?? []).map((call) => [call.id, call]));
  const toolCalls = message.toolCalls?.map((call) => ({ ...call, ...before.get(call.id), args: call.args })) ?? previous.toolCalls;
  const next = [...messages];
  next[index] = { ...previous, ...message, id: previous.id, thinking: message.thinking || previous.thinking, toolCalls };
  return next;
}

/** Change the tool call `callId`, adding it to the last reply when no message has it yet. */
export function updateToolCall(messages: UiMessage[], callId: string, update: (call: UiToolCall) => UiToolCall, name = "tool", args: Record<string, unknown> = {}): UiMessage[] {
  let found = false;
  const next = messages.map((message) => {
    if (!message.toolCalls?.some((call) => call.id === callId)) return message;
    found = true;
    return { ...message, toolCalls: message.toolCalls.map((call) => (call.id === callId ? update(call) : call)) };
  });
  if (found) return next;
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index].role !== "assistant") continue;
    next[index] = { ...next[index], toolCalls: [...(next[index].toolCalls ?? []), update({ id: callId, name, args, running: true })] };
    break;
  }
  return next;
}

export function startToolCall(messages: UiMessage[], callId: string, name: string, args: Record<string, unknown>, now = Date.now()): UiMessage[] {
  return updateToolCall(messages, callId, (call) => ({ ...call, name, args, running: true, startedAt: call.startedAt ?? now }), name, args);
}

export function endToolCall(messages: UiMessage[], callId: string, name: string, result: ToolResult): UiMessage[] {
  return updateToolCall(messages, callId, (call) => ({
    ...call,
    running: false,
    result: result.text,
    images: result.images,
    isError: result.isError,
    finishedAt: result.finishedAt,
  }), name);
}

export interface PlanInfo {
  items: Array<{ text: string; status: string }>;
}

/** The plan widget's lines, in the format the conversation's plan view reads. */
export function planWidgetLines(plan: PlanInfo): string[] {
  if (plan.items.length === 0) return [];
  const completed = plan.items.filter((item) => item.status === "completed").length;
  return [
    `计划 ${completed}/${plan.items.length}`,
    ...plan.items.map((item) => `${item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]"} ${item.text}`),
  ];
}

/**
 * Turns one runtime's Host notifications into transcript events. Stateful
 * only for the model call in progress: a tool call streams in pieces and
 * the transcript shows it once its arguments are complete.
 */
export class TranscriptTranslator {
  private toolCalls = new Map<number, { id: string; name: string; json: string }>();

  event(event: PersistedEvent): TranscriptEvent[] {
    switch (event.type) {
      case "user":
        return [{ type: "user", message: userMessageOf(event) }];
      case "assistant":
        this.toolCalls.clear();
        return [{ type: "assistant", message: assistantMessageOf(event) }];
      case "tool-call": {
        const data = event.data as { callId: string; name: string; args?: Record<string, unknown> };
        return [{ type: "tool-start", callId: data.callId, name: data.name, args: data.args ?? {} }];
      }
      case "tool-result":
        return [{ type: "tool-end", ...toolResultOf(event) }];
      default:
        return [];
    }
  }

  delta(delta: LiveDelta): TranscriptEvent[] {
    switch (delta.type) {
      case "agent-start":
        return [{ type: "turn-start" }];
      case "agent-end":
        return [{ type: "turn-end" }];
      case "llm-start":
        this.toolCalls.clear();
        return [{ type: "assistant-start" }];
      case "llm-chunk":
        return this.chunk((delta.chunk ?? {}) as Block);
      case "queue":
        return [{ type: "queue", steering: count(delta.steer), followUp: count(delta.followUp) }];
      case "compaction-start":
        return [{ type: "compaction-start" }];
      case "compaction-end":
        return [{ type: "compaction-end", failed: delta.ok === false }];
      case "plan":
        return [{ type: "plan", lines: planWidgetLines((delta.plan ?? { items: [] }) as PlanInfo) }];
      default:
        return [];
    }
  }

  private chunk(chunk: Block): TranscriptEvent[] {
    switch (chunk.type) {
      case "text-delta":
        return [{ type: "assistant-delta", text: String(chunk.text ?? ""), thinking: "" }];
      case "thinking-delta":
        return [{ type: "assistant-delta", text: "", thinking: String(chunk.text ?? "") }];
      case "tool-call-start":
        this.toolCalls.set(Number(chunk.index), { id: String(chunk.id), name: String(chunk.name), json: "" });
        return [];
      case "tool-call-delta": {
        const call = this.toolCalls.get(Number(chunk.index));
        if (call !== undefined) call.json += String(chunk.argumentsDelta ?? "");
        return [];
      }
      case "finish": {
        if (this.toolCalls.size === 0) return [];
        const calls = [...this.toolCalls.values()].map((call): UiToolCall => ({ id: call.id, name: call.name, args: parseArguments(call.json), running: true }));
        return [{ type: "assistant-tool-calls", calls }];
      }
      default:
        return [];
    }
  }
}

const count = (value: unknown): number => (typeof value === "number" ? value : 0);

function parseArguments(json: string): Record<string, unknown> {
  if (json.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
