/**
 * Test helpers for the harness packages: a scripted LLM provider whose
 * replies are written as stream chunks, and the golden-log normalization the
 * loop tests compare against `test/golden/*.jsonl`.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { LlmAdapter, LlmErrorInfo, LlmRequest, StreamChunk, Usage } from "@pid/llm";
import type { Session } from "@pid/session";

/** One scripted model call: its chunks, or a function of the request that returns them. */
export type ScriptedReply = StreamChunk[] | ((request: LlmRequest) => StreamChunk[]);

export interface ScriptedOptions {
  /** Wait this long before each chunk, so tests can act mid-stream. */
  chunkDelayMs?: number;
}

const USAGE: Usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A text reply that ends the turn. */
export function textReply(text: string, usage: Partial<Usage> = USAGE): StreamChunk[] {
  return [
    { type: "text-delta", index: 0, text },
    { type: "usage", usage },
    { type: "finish", reason: "stop" },
  ];
}

/** A reply that calls tools, optionally after some text. */
export function toolReply(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>, text?: string): StreamChunk[] {
  const offset = text === undefined ? 0 : 1;
  return [
    ...(text === undefined ? [] : [{ type: "text-delta" as const, index: 0, text }]),
    ...calls.flatMap((call, index): StreamChunk[] => [
      { type: "tool-call-start", index: index + offset, id: call.id, name: call.name },
      { type: "tool-call-delta", index: index + offset, argumentsDelta: JSON.stringify(call.args) },
    ]),
    { type: "usage", usage: USAGE },
    { type: "finish", reason: "tool-use" },
  ];
}

/** A call that fails before any output. */
export function errorReply(error: LlmErrorInfo): StreamChunk[] {
  return [{ type: "finish", reason: "error", error }];
}

/** Answers each call with the next scripted reply and records the requests. */
export class ScriptedProvider implements LlmAdapter {
  readonly requests: LlmRequest[] = [];
  private readonly replies: ScriptedReply[] = [];

  constructor(replies: ScriptedReply[] = [], private readonly options: ScriptedOptions = {}) {
    this.replies.push(...replies);
  }

  push(...replies: ScriptedReply[]): void {
    this.replies.push(...replies);
  }

  get remaining(): number {
    return this.replies.length;
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    this.requests.push(structuredClone(request));
    const next = this.replies.shift();
    if (next === undefined) throw new Error(`No scripted reply left for call ${this.requests.length}`);
    const chunks = typeof next === "function" ? next(request) : next;
    for (const chunk of chunks) {
      if (this.options.chunkDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, this.options.chunkDelayMs));
      if (signal.aborted) {
        yield { type: "finish", reason: "aborted" };
        return;
      }
      yield chunk;
    }
  }
}

/** Register `provider` with the context's `llm` service under `id`. */
export function useScriptedProvider(ctx: Context, provider: ScriptedProvider, id = "scripted"): void {
  ctx.effect(() => ctx.llm.registerAdapter({ id, name: id, api: "scripted", baseUrl: "" }, provider), `testkit: ${id}`);
}

/**
 * The session log as JSONL with timestamps blanked, for golden files.
 * `replace` rewrites run-specific strings (temp paths) to stable tokens.
 */
export function goldenLog(session: Session, replace: Record<string, string> = {}): string {
  let text = session.events.map((event) => JSON.stringify({ ...event, ts: "<ts>" })).join("\n") + "\n";
  for (const [from, to] of Object.entries(replace)) {
    text = text.split(from).join(to).split(JSON.stringify(from).slice(1, -1)).join(to);
  }
  return text;
}
