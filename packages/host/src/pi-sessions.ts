/**
 * The one-time import of Pi's sessions (P6b, docs/REFACTOR_V2_P6.md 3.2):
 * `import.piSessions` converts each Pi session file under the given roots
 * into a session of this host, which can then be continued. The Pi files are
 * only read.
 *
 * A Pi session is a tree (each entry names its parent); only the branch the
 * session ended on is imported, the conversation as Pi last showed it. With
 * `dryRun` nothing is imported and `pending` counts the files left to do;
 * `markPrompted` records that the user was offered the import, so the
 * desktop asks once. What
 * has no counterpart here (bookmarks, extension state, usage notices, context
 * edits, extension messages) is left out and counted in the report.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { AssistantContent, Effort, FinishReason, ToolResultContent, Usage, UserContent } from "@pid/llm";
import type { ModelRef, SessionEvent } from "@pid/session";
import { ErrorCode, type PiImportReport } from "@pid/protocol";
import { RpcError } from "./rpc.ts";

export const name = "pid-pi-sessions";
export const inject = ["rpc", "sessions"];

export interface Config {
  /** Where imported files are recorded (shared with the provider import). */
  stateFile: string;
}

type Json = Record<string, unknown>;
type Draft = { type: SessionEvent["type"]; ts: string; data: unknown };

export interface PiConversion {
  id: string;
  cwd: string;
  createdAt: string;
  events: SessionEvent[];
  /** Entry kinds left out, with how often. */
  skipped: Record<string, number>;
}

function effortOf(level: unknown): Effort {
  if (level === "off") return "off";
  if (level === "minimal" || level === "low") return "low";
  if (level === "high" || level === "xhigh") return "high";
  return "medium";
}

function stopOf(reason: unknown): FinishReason {
  if (reason === "length") return "length";
  if (reason === "toolUse") return "tool-use";
  if (reason === "error") return "error";
  if (reason === "aborted") return "aborted";
  return "stop";
}

function usageOf(value: unknown): Usage {
  const usage = (value ?? {}) as Json;
  const count = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  return { inputTokens: count("input"), outputTokens: count("output"), cacheReadTokens: count("cacheRead"), cacheWriteTokens: count("cacheWrite") };
}

function blocks(content: unknown): Json[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Json[]) : [];
}

function userContent(content: unknown): UserContent[] {
  return blocks(content).flatMap((block): UserContent[] => {
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") return [{ type: "image", data: block.data, mimeType: block.mimeType }];
    return [];
  });
}

function assistantContent(content: unknown): AssistantContent[] {
  return blocks(content).flatMap((block): AssistantContent[] => {
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type === "thinking") {
      const signature = typeof block.thinkingSignature === "string" ? block.thinkingSignature : undefined;
      if (block.redacted === true) return signature === undefined ? [] : [{ type: "thinking", text: "", redacted: signature }];
      return [{ type: "thinking", text: typeof block.thinking === "string" ? block.thinking : "", ...(signature === undefined ? {} : { signature }) }];
    }
    if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
      const args = typeof block.arguments === "object" && block.arguments !== null ? (block.arguments as Record<string, unknown>) : {};
      return [{ type: "tool-call", id: block.id, name: block.name, arguments: args }];
    }
    return [];
  });
}

/** The entries from the root to the session's last entry, following each entry's parent. */
function currentBranch(entries: Json[]): Json[] {
  const byId = new Map(entries.filter((entry) => typeof entry.id === "string").map((entry) => [entry.id as string, entry]));
  const branch: Json[] = [];
  const seen = new Set<string>();
  let entry = entries.at(-1);
  while (entry !== undefined && typeof entry.id === "string" && !seen.has(entry.id)) {
    seen.add(entry.id);
    branch.unshift(entry);
    entry = typeof entry.parentId === "string" ? byId.get(entry.parentId) : undefined;
  }
  return branch;
}

/** One Pi session file as this host's events; throws on a file that is not a Pi session. */
export function convertPiSession(text: string): PiConversion {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Json);
  const header = lines[0];
  if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") throw new Error("not a Pi session file");
  const skipped: Record<string, number> = {};
  const skip = (kind: string) => void (skipped[kind] = (skipped[kind] ?? 0) + 1);

  const drafts: Draft[] = [];
  /** The number of the first event each entry produced, for compactions. */
  const firstSeqOf = new Map<string, number>();
  let model: ModelRef | undefined;
  const emit = (type: Draft["type"], ts: string, data: unknown) => void drafts.push({ type, ts, data });

  for (const entry of currentBranch(lines.slice(1))) {
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : String(header.timestamp);
    if (typeof entry.id === "string") firstSeqOf.set(entry.id, drafts.length + 1);
    switch (entry.type) {
      case "message": {
        const message = (entry.message ?? {}) as Json;
        if (message.role === "user") {
          const content = userContent(message.content);
          if (content.length > 0) emit("user", ts, { content });
        } else if (message.role === "assistant") {
          const ref = { provider: String(message.provider ?? "unknown"), model: String(message.model ?? "unknown") };
          if (model?.provider !== ref.provider || model.model !== ref.model) {
            model = ref;
            emit("model", ts, ref);
          }
          const content = assistantContent(message.content);
          const stop = stopOf(message.stopReason);
          emit("assistant", ts, {
            content,
            model: ref,
            usage: usageOf(message.usage),
            stop,
            ...(stop === "error" ? { error: { kind: "unknown", message: typeof message.errorMessage === "string" ? message.errorMessage : "The model call failed", retryable: false } } : {}),
          });
          for (const block of content) {
            if (block.type === "tool-call") emit("tool-call", ts, { callId: block.id, name: block.name, args: block.arguments });
          }
        } else if (message.role === "toolResult") {
          const content: ToolResultContent[] = userContent(message.content);
          emit("tool-result", ts, { callId: String(message.toolCallId), name: String(message.toolName), content, isError: message.isError === true });
        } else if (message.role === "bashExecution") {
          if (message.excludeFromContext === true) skip("bash (not in context)");
          else {
            const exit = typeof message.exitCode === "number" && message.exitCode !== 0 ? `\nExit code ${message.exitCode}` : "";
            emit("user", ts, { content: [{ type: "text", text: `Ran \`${String(message.command)}\`\n\`\`\`\n${String(message.output ?? "")}\n\`\`\`${exit}` }] });
          }
        } else skip(`message:${String(message.role)}`);
        break;
      }
      case "model_change":
        model = { provider: String(entry.provider), model: String(entry.modelId) };
        emit("model", ts, model);
        break;
      case "thinking_level_change":
        emit("effort", ts, { effort: effortOf(entry.thinkingLevel) });
        break;
      case "compaction": {
        const kept = typeof entry.firstKeptEntryId === "string" ? firstSeqOf.get(entry.firstKeptEntryId) : undefined;
        emit("compaction", ts, { throughSeq: kept === undefined ? drafts.length : kept - 1, summary: String(entry.summary ?? "") });
        break;
      }
      case "branch_summary":
        emit("custom", ts, { ns: "pi-import", data: { branchSummary: String(entry.summary ?? "") } });
        break;
      case "session_info":
        if (typeof entry.name === "string" && entry.name.trim() !== "") emit("label", ts, { title: entry.name.trim() });
        break;
      default:
        skip(String(entry.type));
    }
  }
  return {
    id: header.id,
    cwd: header.cwd,
    createdAt: typeof header.timestamp === "string" ? header.timestamp : new Date().toISOString(),
    events: drafts.map((draft, index) => ({ seq: index + 1, ...draft }) as SessionEvent),
    skipped,
  };
}

/** Pi session files under `root`, as Pi's own session list finds them. */
export function piSessionFiles(root: string, depth = 0): string[] {
  if (depth > 5 || root.endsWith(".trash") || !existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return piSessionFiles(path, depth + 1);
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
  });
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path;
}

function readState(file: string): Json {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
  } catch {
    return {};
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.rpc.method("import.piSessions", async (params): Promise<PiImportReport> => {
    const p = (params ?? {}) as Json;
    if (p.roots !== undefined && (!Array.isArray(p.roots) || !p.roots.every((root) => typeof root === "string"))) {
      throw new RpcError(ErrorCode.InvalidParams, "roots must be a list of directories");
    }
    const roots = ((p.roots as string[] | undefined) ?? []).map((root) => root.trim()).filter((root) => root !== "");
    const scanned = (roots.length > 0 ? roots : [join(homedir(), ".pi", "agent", "sessions")]).map((root) => resolve(expandHome(root)));
    const files = [...new Set(scanned.flatMap((root) => piSessionFiles(root)))];

    const state = readState(config.stateFile);
    const done = { ...((state.sessions ?? {}) as Record<string, unknown>) };
    const prompted = state.prompted === true || p.markPrompted === true;
    const pending = files.filter((file) => done[file] === undefined).length;
    if (p.dryRun === true) {
      if (prompted !== (state.prompted === true)) writeFileSync(config.stateFile, `${JSON.stringify({ ...state, prompted }, null, 2)}\n`);
      return { pending, prompted, imported: 0, skipped: files.length - pending, failed: 0, problems: [] };
    }
    const report: PiImportReport = { pending: 0, prompted, imported: 0, skipped: 0, failed: 0, problems: [] };
    const left: Record<string, number> = {};
    for (const [index, file] of files.entries()) {
      ctx.rpc.broadcast("import/progress", { done: index, total: files.length });
      if (done[file] !== undefined) {
        report.skipped += 1;
        continue;
      }
      try {
        const converted = convertPiSession(readFileSync(file, "utf8"));
        if (!converted.events.some((event) => event.type === "user")) {
          report.skipped += 1;
          continue;
        }
        const session = ctx.sessions.create({
          cwd: converted.cwd,
          createdAt: converted.createdAt,
          importedFrom: { format: "pi", file, id: converted.id },
          events: converted.events,
        });
        done[file] = { sessionId: session.id, mtimeMs: statSync(file).mtimeMs };
        report.imported += 1;
        for (const [kind, count] of Object.entries(converted.skipped)) left[kind] = (left[kind] ?? 0) + count;
      } catch (error) {
        report.failed += 1;
        report.problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    ctx.rpc.broadcast("import/progress", { done: files.length, total: files.length });
    writeFileSync(config.stateFile, `${JSON.stringify({ ...readState(config.stateFile), prompted, sessions: done }, null, 2)}\n`);
    for (const [kind, count] of Object.entries(left)) report.problems.push(`left out ${count} ${kind} entr${count === 1 ? "y" : "ies"}`);
    return report;
  }), "import.piSessions");
}
