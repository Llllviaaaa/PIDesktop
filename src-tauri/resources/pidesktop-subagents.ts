import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  normalizeSubagentTasks,
  subagentPrompt,
  type SubagentPermission,
  type SubagentTask,
} from "./pidesktop-subagents-core.ts";

const MAX_OUTPUT = 64 * 1024;
const TaskSchema = Type.Object({
  label: Type.Optional(Type.String({ description: "Short display label" })),
  task: Type.String({ description: "Self-contained delegated task" }),
  role: Type.Optional(StringEnum(["explorer", "planner", "reviewer", "worker"] as const)),
});
const DelegateSchema = Type.Object({
  task: Type.Optional(Type.String({ description: "One delegated task" })),
  role: Type.Optional(StringEnum(["explorer", "planner", "reviewer", "worker"] as const)),
  tasks: Type.Optional(Type.Array(TaskSchema, { maxItems: 8, description: "Independent tasks to run in parallel" })),
  permission: Type.Optional(StringEnum(["read-only", "workspace-write"] as const, { default: "read-only" })),
});

interface ChildResult {
  label: string;
  role: string;
  task: string;
  ok: boolean;
  output: string;
  error: string;
}

function invocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const executable = path.basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

function finalAssistantText(events: string): string {
  let final = "";
  for (const line of events.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } };
      if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
      const text = event.message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
      if (text.trim()) final = text.trim();
    } catch {
      // Ignore non-protocol output from child startup.
    }
  }
  return final;
}

async function runChild(
  task: SubagentTask,
  permission: SubagentPermission,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<ChildResult> {
  const guard = process.env.PIDESKTOP_GUARD_EXTENSION;
  if (!guard) return { ...task, ok: false, output: "", error: "Pi Desktop guard extension is unavailable" };
  const tools = permission === "workspace-write" ? "read,grep,find,ls,edit,write" : "read,grep,find,ls";
  const args = ["--mode", "json", "--print", "--no-session", "--no-extensions", "-e", guard, "--tools", tools];
  const provider = process.env.PIDESKTOP_SUBAGENT_PROVIDER;
  const model = process.env.PIDESKTOP_SUBAGENT_MODEL;
  const thinking = process.env.PIDESKTOP_SUBAGENT_THINKING;
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  args.push(subagentPrompt(task));
  const childInvocation = invocation(args);

  return new Promise((resolve) => {
    const child = spawn(childInvocation.command, childInvocation.args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PIDESKTOP_PERMISSION_MODE: permission,
        PIDESKTOP_AGENT_MODE: "agent",
        PIDESKTOP_WORKSPACE_ROOT: cwd,
      },
    });
    let stdout = "";
    let stderr = "";
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const value = chunk.toString("utf8");
      if (target === "stdout" && stdout.length < MAX_OUTPUT) stdout += value.slice(0, MAX_OUTPUT - stdout.length);
      if (target === "stderr" && stderr.length < MAX_OUTPUT) stderr += value.slice(0, MAX_OUTPUT - stderr.length);
    };
    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => resolve({ ...task, ok: false, output: "", error: error.message }));
    child.on("close", (code) => {
      const output = finalAssistantText(stdout);
      resolve({
        ...task,
        ok: code === 0 && Boolean(output),
        output,
        error: code === 0 ? (output ? "" : "Subagent returned no assistant text") : stderr.trim() || `Subagent exited with code ${code}`,
      });
    });
    const abort = () => child.kill();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

export default function (pi: ExtensionAPI) {
  const concurrency = Math.max(1, Math.min(4, Number(process.env.PIDESKTOP_SUBAGENT_CONCURRENCY) || 3));
  pi.registerTool({
    name: "delegate_task",
    label: "Delegate task",
    description: "Run one isolated Pi subagent or up to eight independent subagents in parallel.",
    promptSnippet: "Delegate independent exploration, planning, review, or implementation to isolated local agents",
    promptGuidelines: [
      "Use delegate_task only when an isolated context or independent parallel investigation materially helps.",
      "Default to read-only. Request workspace-write only for a worker that must implement changes.",
      "Parallel tasks must be independent and self-contained. Synthesize their outputs before acting.",
    ],
    parameters: DelegateSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const rawTasks = params.tasks?.length
        ? params.tasks
        : params.task
          ? [{ label: params.role || "subagent", task: params.task, role: params.role || "explorer" }]
          : [];
      const tasks = normalizeSubagentTasks(rawTasks);
      const permission: SubagentPermission = params.permission === "workspace-write" ? "workspace-write" : "read-only";
      let done = 0;
      const results = await mapWithConcurrency(tasks, concurrency, async (task) => {
        const result = await runChild(task, permission, ctx.cwd, signal);
        done += 1;
        onUpdate?.({
          content: [{ type: "text", text: `Subagents: ${done}/${tasks.length} finished` }],
          details: { permission, completed: done, total: tasks.length },
        });
        return result;
      });
      const successful = results.filter((result) => result.ok).length;
      const text = results.map((result) => `### ${result.label} (${result.role}) - ${result.ok ? "completed" : "failed"}\n\n${result.ok ? result.output : result.error}`).join("\n\n---\n\n");
      return {
        content: [{ type: "text" as const, text: `${successful}/${results.length} subagents completed.\n\n${text}` }],
        details: { permission, results },
        isError: successful === 0,
      };
    },
  });
}
