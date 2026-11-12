/**
 * Loop hygiene for tool calls (ADR 0020), both on the `tools/execute` waterfall:
 *
 * - **Deadline.** A call runs for at most its tool's `timeoutMs`, or
 *   `defaultTimeoutMs` (10 minutes) when the tool declares none; 0 means no
 *   limit. At the deadline the call's signal is aborted and the model gets a
 *   timeout error at once. That holds even when the tool ignores the signal;
 *   its late result is dropped.
 * - **Repeats.** When a session makes the same call (same tool, same arguments)
 *   several times in a row, the result gets a note saying the outcome will not
 *   change. Notes come only at the counts in `repeatThresholds` (3, 5 and 8 by
 *   default), so the loop is pointed out without a note on every call.
 */
import type { Context } from "@deepseek-ai/cordis";
import { textOutput, type ToolCall, type ToolEnv, type ToolOutput } from "@qianji/tools";

export const name = "qianji-tool-guards";
export const inject = ["tools"];

export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_REPEAT_THRESHOLDS: readonly number[] = [3, 5, 8];
/** Sessions whose last call is remembered; the least recently active ones are forgotten first. */
const TRACKED_SESSIONS = 500;

export interface Config {
  /** Deadline for tools that declare no `timeoutMs`, in milliseconds; 0 turns it off. */
  defaultTimeoutMs?: number;
  /** Consecutive-repeat counts that get a note; empty turns repeat notes off. */
  repeatThresholds?: number[];
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds >= 120 && seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
}

/**
 * Runs `next` with a deadline: `env.signal` is replaced for the duration by
 * one that also aborts at `timeoutMs`.
 */
export async function withDeadline(toolName: string, env: ToolEnv, timeoutMs: number, next: () => Promise<ToolOutput>): Promise<ToolOutput> {
  const upstream = env.signal;
  const controller = new AbortController();
  const forward = () => controller.abort(upstream.reason);
  if (upstream.aborted) controller.abort(upstream.reason);
  else upstream.addEventListener("abort", forward, { once: true });
  env.signal = controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ToolOutput>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`${toolName} timed out`));
      resolve(textOutput(`${toolName} did not finish within ${formatDuration(timeoutMs)} and was stopped. Try a smaller step or a different approach.`, true));
    }, timeoutMs);
  });
  try {
    return await Promise.race([next(), deadline]);
  } finally {
    clearTimeout(timer);
    upstream.removeEventListener("abort", forward);
    env.signal = upstream;
  }
}

/** `value` as JSON with object keys sorted, so a different key order does not hide a repeat. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The last call of each session and how many times in a row it was made. */
export class RepeatTracker {
  private readonly last = new Map<string, { key: string; count: number }>();

  constructor(private readonly limit = TRACKED_SESSIONS) {}

  /** Records `call` and returns how many times in a row `sessionId` has now made it. */
  record(sessionId: string, call: ToolCall): number {
    const key = `${call.name}\u0000${canonicalJson(call.args)}`;
    const previous = this.last.get(sessionId);
    const count = previous?.key === key ? previous.count + 1 : 1;
    // Re-inserting keeps the map ordered from least to most recently active.
    this.last.delete(sessionId);
    this.last.set(sessionId, { key, count });
    if (this.last.size > this.limit) {
      const oldest = this.last.keys().next().value;
      if (oldest !== undefined) this.last.delete(oldest);
    }
    return count;
  }
}

export function repeatNote(toolName: string, count: number, last: boolean): string {
  return last
    ? `[You have now made this exact ${toolName} call ${count} times in a row. Stop repeating it: change the approach, or stop and tell the user what is blocking you.]`
    : `[You have made this exact ${toolName} call ${count} times in a row; its result will not change. Try a different approach.]`;
}

export function apply(ctx: Context, config: Config = {}): void {
  const defaultTimeoutMs = Math.max(0, config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const thresholds = new Set((config.repeatThresholds ?? DEFAULT_REPEAT_THRESHOLDS).filter((count) => Number.isInteger(count) && count >= 2));
  const lastThreshold = Math.max(0, ...thresholds);
  const repeats = new RepeatTracker();

  ctx.on("tools/execute", async (call, env, next) => {
    const count = thresholds.size === 0 ? 0 : repeats.record(env.sessionId, call);
    const timeoutMs = ctx.tools.get(call.name)?.timeoutMs ?? defaultTimeoutMs;
    const output = timeoutMs > 0 ? await withDeadline(call.name, env, timeoutMs, next) : await next();
    if (!thresholds.has(count)) return output;
    return { ...output, content: [...output.content, { type: "text", text: repeatNote(call.name, count, count === lastThreshold) }] };
  });
}
