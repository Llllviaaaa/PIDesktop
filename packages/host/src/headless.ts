/**
 * Headless runs: one prompt, no window, no RPC.
 *
 * Usage: pid-harness run [--data-dir <dir>] [--cwd <dir>] [--model <provider>/<model>]
 *                        [--effort off|low|medium|high] [--permission <mode>] [--session <id>]
 *                        [--json] <prompt...>
 *
 * The reply streams to stdout and tool activity to stderr; with `--json`
 * stdout gets each persisted session event as one JSON line instead. The
 * session is saved like any other, so `--session <id>` continues it. Exits 0
 * when the run finished normally, 1 otherwise. Ctrl+C aborts the run.
 *
 * Nobody can answer a confirmation here, so a tool call that needs one is
 * denied. The permission mode is `--permission`, else harness.json's
 * `defaultPermission`, else `workspace-write`: file changes inside the
 * working directory go through, shell commands need `full-access` or an
 * allow-listed prefix.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Logger, type Exporter } from "@deepseek-ai/cordis";
import type { Effort } from "@pid/llm";
import type { AgentDelta, RunOutcome } from "@pid/agent";
import type { PermissionMode } from "@pid/permissions";
import { agentPlugins } from "./agent-plugins.ts";
import { readHarnessConfig } from "./harness-config.ts";
import { createHost } from "./host.ts";
import { readDefaultModel } from "./providers.ts";

export interface HeadlessOptions {
  dataDir: string;
  cwd: string;
  model?: { provider: string; model: string };
  effort?: Effort;
  permission?: PermissionMode;
  sessionId?: string;
  json: boolean;
  prompt: string;
}

const EFFORTS = ["off", "low", "medium", "high"];
const PERMISSIONS = ["read-only", "ask", "workspace-write", "full-access"];

export function parseHeadlessOptions(argv: readonly string[], cwd = process.cwd()): HeadlessOptions {
  const options: HeadlessOptions = { dataDir: join(homedir(), ".pid"), cwd, json: false, prompt: "" };
  const words: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === "--data-dir") options.dataDir = resolve(value());
    else if (flag === "--cwd") options.cwd = resolve(value());
    else if (flag === "--session") options.sessionId = value();
    else if (flag === "--json") options.json = true;
    else if (flag === "--model") {
      const spec = value();
      const slash = spec.indexOf("/");
      if (slash <= 0 || slash === spec.length - 1) throw new Error("--model must be <provider>/<model>");
      options.model = { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
    } else if (flag === "--effort") {
      const effort = value();
      if (!EFFORTS.includes(effort)) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
      options.effort = effort as Effort;
    } else if (flag === "--permission") {
      const permission = value();
      if (!PERMISSIONS.includes(permission)) throw new Error(`--permission must be one of ${PERMISSIONS.join(", ")}`);
      options.permission = permission as PermissionMode;
    } else if (flag === "--") {
      words.push(...argv.slice(index + 1));
      break;
    } else if (flag.startsWith("--")) {
      throw new Error(`unknown argument ${flag}`);
    } else {
      words.push(flag);
    }
  }
  options.prompt = words.join(" ").trim();
  if (options.prompt === "") throw new Error("a prompt is required");
  return options;
}

function clip(text: string, max = 200): string {
  const line = text.replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Run one prompt to completion; resolves to the process exit code. */
export async function runHeadless(argv: readonly string[], out: NodeJS.WritableStream = process.stdout, err: NodeJS.WritableStream = process.stderr): Promise<number> {
  let options: HeadlessOptions;
  try {
    options = parseHeadlessOptions(argv);
  } catch (error) {
    err.write(`pid-harness run: ${(error as Error).message}\n`);
    return 2;
  }

  const { config, problems } = readHarnessConfig(join(options.dataDir, "harness.json"));
  const permission = options.permission ?? config.permissions.defaultPermission ?? "workspace-write";
  const host = createHost({ version: "headless", dataDir: options.dataDir, plugins: agentPlugins(options.dataDir, { config, permission }) });
  for (const problem of problems) err.write(`[warn] ${problem}
`);
  const exporter: Exporter = {
    colors: false,
    export(message) {
      if (message.type === "warn" || message.type === "error") err.write(`[${message.type}] ${Logger.format(exporter, message)}\n`);
    },
  };
  host.ctx.logger.exporter(exporter);
  await host.start();
  const { ctx } = host;
  try {
    let session = options.sessionId === undefined ? undefined : await ctx.sessions.get(options.sessionId);
    if (options.sessionId !== undefined && session === undefined) {
      err.write(`pid-harness run: no session ${options.sessionId}\n`);
      return 2;
    }
    session ??= ctx.sessions.create({ cwd: options.cwd });
    const model = options.model ?? (session.state().model === undefined ? readDefaultModel(join(options.dataDir, "providers.json")) : undefined);
    if (model !== undefined) session.append("model", model);
    if (options.effort !== undefined) session.append("effort", { effort: options.effort });
    if (session.state().model === undefined) {
      err.write("pid-harness run: no model; pass --model <provider>/<model> or set defaultModel in providers.json\n");
      return 2;
    }

    const target = session;
    let outcome = "error" as RunOutcome;
    let atLineStart = true;
    ctx.on("session/delta", (from, _liveSeq, raw) => {
      if (from !== target) return;
      const delta = raw as AgentDelta;
      if (delta.type === "agent-end") outcome = delta.outcome;
      if (options.json) return;
      if (delta.type === "llm-chunk" && delta.chunk.type === "text-delta") {
        out.write(delta.chunk.text);
        atLineStart = delta.chunk.text.endsWith("\n");
      } else if (delta.type === "compaction-start") {
        err.write("[compacting context]\n");
      }
    });
    ctx.on("session/event", (from, event) => {
      if (from !== target) return;
      if (options.json) {
        out.write(`${JSON.stringify(event)}\n`);
        return;
      }
      if (!atLineStart && (event.type === "assistant" || event.type === "tool-call")) {
        out.write("\n");
        atLineStart = true;
      }
      if (event.type === "tool-call") err.write(`▸ ${event.data.name} ${clip(JSON.stringify(event.data.args))}\n`);
      else if (event.type === "tool-result" && event.data.isError) {
        const text = event.data.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ");
        err.write(`  ✗ ${clip(text)}\n`);
      } else if (event.type === "assistant" && event.data.error !== undefined) {
        err.write(`[model error] ${event.data.error.message}\n`);
      }
    });

    const onInterrupt = () => void ctx.agents.abort(target.id);
    process.once("SIGINT", onInterrupt);
    try {
      ctx.agents.prompt(target, [{ type: "text", text: options.prompt }]);
      await ctx.agents.idle(target.id);
    } finally {
      process.removeListener("SIGINT", onInterrupt);
    }
    if (!options.json && !atLineStart) out.write("\n");
    err.write(`[session ${target.id}: ${outcome}]\n`);
    return outcome === "done" ? 0 : 1;
  } finally {
    await host.stop();
  }
}
