/**
 * Caps oversized tool output (ADR 0019), on the `tools/execute` waterfall that
 * ADR 0003 reserves for output truncation.
 *
 * Tools that bound their own output (`read`, `bash`, `grep`) stay under the
 * cap. The ones that do not, such as MCP servers, the browser or subagents, could
 * otherwise put any amount of text into the context in a single result and
 * overflow it. A text result longer than `maxChars` keeps its start and end.
 * The full text goes to `<spillDir>/<session>/<call>.txt`, and the model is
 * told where to page through it. Images and `details` pass through unchanged.
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolOutput } from "@qianji/tools";
import "@qianji/tools";

export const name = "qianji-tool-output";
export const inject = ["tools"];

export const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_RETENTION_DAYS = 7;

export interface Config {
  /** Where full outputs are kept; without it, oversized output is only cut. */
  spillDir?: string;
  /** Longest text result passed on whole, in characters. */
  maxChars?: number;
  /** Session folders under `spillDir` older than this are deleted at start. */
  retentionDays?: number;
}

/**
 * `output` with its text cut to `maxChars` when longer. `save` keeps the full
 * text and returns where it went, or undefined when it could not.
 */
export function limitOutput(output: ToolOutput, maxChars: number, save?: (text: string) => string | undefined): ToolOutput {
  const texts = output.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
  const full = texts.join("\n");
  if (full.length <= maxChars) return output;
  const keep = Math.floor(maxChars * 0.4);
  const where = save?.(full);
  const note = where === undefined
    ? `[Output truncated: ${full.length} characters, showing the first ${keep} and the last ${keep}. The full output could not be saved.]`
    : `[Output truncated: ${full.length} characters, showing the first ${keep} and the last ${keep}. The full output is in ${where}; page through it with read (offset, limit) or search it with grep.]`;
  const text = `${full.slice(0, keep)}\n\n${note}\n\n${full.slice(full.length - keep)}`;
  const others = output.content.filter((block) => block.type !== "text");
  return { ...output, content: [{ type: "text", text }, ...others] };
}

const safeName = (value: string): string => value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "_";

/** Deletes session folders under `dir` last written before `cutoff` (ms since the epoch). */
export function pruneSpill(dir: string, cutoff: number): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { recursive: true, force: true });
        removed.push(entry);
      }
    } catch {
      // Gone already or in use; the next start tries again.
    }
  }
  return removed;
}

export function apply(ctx: Context, config: Config = {}): void {
  const maxChars = Math.max(1_000, config.maxChars ?? DEFAULT_MAX_CHARS);
  const { spillDir } = config;
  const logger = ctx.logger("tool-output");
  if (spillDir !== undefined) {
    pruneSpill(spillDir, Date.now() - (config.retentionDays ?? DEFAULT_RETENTION_DAYS) * 86_400_000);
  }

  ctx.on("tools/execute", async (call, env, next) => {
    const output = await next();
    return limitOutput(output, maxChars, spillDir === undefined ? undefined : (text) => {
      const dir = join(spillDir, safeName(env.sessionId));
      const file = join(dir, `${safeName(env.callId ?? call.id)}.txt`);
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, text);
        return file;
      } catch (error) {
        logger.warn("keeping the full output of %s failed: %s", call.name, error);
        return undefined;
      }
    });
  });
}
