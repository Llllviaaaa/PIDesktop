/**
 * The `delegate_task` tool (ADR 0010): run up to eight independent tasks as
 * subagents. Each is a child session of the calling one (its header names the
 * parent session and tool call, ADR 0004), restricted to read tools (plus
 * edit and write for `workspace-write`), run by the same loop in the same
 * process. The parent's log only gets the tool result with each child's
 * final answer; progress goes out live as a `{ type: "subagents" }` delta.
 */
import type { Context } from "@deepseek-ai/cordis";
import "@pid/agent";
import type { Session } from "@pid/session";
import { textOutput, type ToolDefinition, type ToolEnv } from "@pid/tools";
import { normalizeSubagentTasks, subagentPrompt, type SubagentPermission, type SubagentRole, type SubagentTask } from "./core.ts";

export * from "./core.ts";

export const name = "pid-subagents";
export const inject = ["sessions", "tools", "agents"];

export interface Config {
  /** Model for subagents; defaults to the parent session's. */
  model?: { provider: string; model: string };
  effort?: "off" | "low" | "medium" | "high";
  /** Subagents running at once, 1..4. Default 3. */
  concurrency?: number;
}

export const READ_TOOLS = ["read", "grep", "find", "ls"] as const;
export const WRITE_TOOLS = ["edit", "write"] as const;

export interface SubagentResult extends SubagentTask {
  sessionId: string;
  ok: boolean;
  output: string;
  error: string;
}

type Status = "queued" | "running" | "completed" | "failed";

function finalText(session: Session): string {
  const last = session.events.findLast((event) => event.type === "assistant");
  if (last?.type !== "assistant") return "";
  return last.data.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T, index);
    }
  }));
  return results;
}

/** Run one task in a child session of `parent` and wait for it to settle. */
export async function runSubagent(ctx: Context, parent: Session, task: SubagentTask, permission: SubagentPermission, env: ToolEnv, config: Config): Promise<SubagentResult> {
  const model = config.model ?? parent.state().model;
  const child = ctx.sessions.create({ cwd: parent.header.cwd, parent: { sessionId: parent.id, callId: env.callId ?? "" } });
  const base = { ...task, sessionId: child.id };
  if (model === undefined) return { ...base, ok: false, output: "", error: "The parent session has no model" };
  child.append("model", model);
  if (config.effort !== undefined) child.append("effort", { effort: config.effort });
  child.append("label", { title: `${task.label} (${task.role})` });
  const permissions = ctx.get("permissions") as { set(session: Session, change: { permission: string; agentMode: string }): number } | undefined;
  permissions?.set(child, { permission: permission, agentMode: "agent" });
  const unrestrict = ctx.tools.restrict(child.id, permission === "workspace-write" ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS);
  const abort = () => void ctx.agents.abort(child.id);
  env.signal.addEventListener("abort", abort, { once: true });
  try {
    if (env.signal.aborted) return { ...base, ok: false, output: "", error: "Aborted" };
    let outcome = "error";
    const off = ctx.on("agent/settled", async (session, result) => {
      if (session === child) outcome = result;
    });
    try {
      ctx.agents.prompt(child, [{ type: "text", text: subagentPrompt(task) }]);
      await ctx.agents.idle(child.id);
    } finally {
      off();
    }
    const output = finalText(child);
    if (outcome === "done" && output !== "") return { ...base, ok: true, output, error: "" };
    const error = outcome === "done" ? "Subagent returned no assistant text" : `Subagent ended: ${outcome}`;
    return { ...base, ok: false, output, error };
  } finally {
    env.signal.removeEventListener("abort", abort);
    unrestrict();
  }
}

export function delegateTool(ctx: Context, config: Config): ToolDefinition<{ task?: string; role?: SubagentRole; tasks?: Array<Partial<SubagentTask>>; permission?: SubagentPermission }> {
  const concurrency = Math.max(1, Math.min(4, config.concurrency ?? 3));
  return {
    name: "delegate_task",
    description: [
      "Run one isolated subagent or up to eight independent subagents in parallel; each gets a fresh context and returns its final answer.",
      "Use it only when an isolated context or independent parallel investigation materially helps.",
      "Default to read-only. Request workspace-write only for a worker that must implement changes (it can read, edit and write, but not run commands).",
      "Parallel tasks must be independent and self-contained. Synthesize their outputs before acting.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "One delegated task" },
        role: { type: "string", enum: ["explorer", "planner", "reviewer", "worker"] },
        tasks: {
          type: "array",
          maxItems: 8,
          description: "Independent tasks to run in parallel",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short display label" },
              task: { type: "string", description: "Self-contained delegated task" },
              role: { type: "string", enum: ["explorer", "planner", "reviewer", "worker"] },
            },
            required: ["task"],
          },
        },
        permission: { type: "string", enum: ["read-only", "workspace-write"] },
      },
    },
    async execute({ task, role, tasks: many, permission: requested }, env) {
      const parent = await ctx.sessions.get(env.sessionId);
      if (parent === undefined) return textOutput("No session to delegate from.", true);
      const raw = many?.length ? many : task ? [{ label: role ?? "subagent", task, role: role ?? "explorer" }] : [];
      let tasks: SubagentTask[];
      try {
        tasks = normalizeSubagentTasks(raw);
      } catch (error) {
        return textOutput((error as Error).message, true);
      }
      const permission: SubagentPermission = requested === "workspace-write" ? "workspace-write" : "read-only";
      const statuses: Status[] = tasks.map(() => "queued");
      const sessions: Array<string | undefined> = tasks.map(() => undefined);
      const publish = () => parent.delta({
        type: "subagents",
        callId: env.callId,
        permission,
        tasks: tasks.map((item, index) => ({ ...item, status: statuses[index], sessionId: sessions[index] })),
      });
      const results = await mapWithConcurrency(tasks, concurrency, async (item, index) => {
        statuses[index] = "running";
        publish();
        const result = await runSubagent(ctx, parent, item, permission, env, config);
        sessions[index] = result.sessionId;
        statuses[index] = result.ok ? "completed" : "failed";
        publish();
        return result;
      });
      const successful = results.filter((result) => result.ok).length;
      const text = results
        .map((result) => `### ${result.label} (${result.role}) - ${result.ok ? "completed" : "failed"}\n\n${result.ok ? result.output : result.error}`)
        .join("\n\n---\n\n");
      return {
        content: [{ type: "text", text: `${successful}/${results.length} subagents completed.\n\n${text}` }],
        isError: successful === 0,
        details: { permission, results },
      };
    },
  };
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(() => ctx.tools.register(delegateTool(ctx, config)), `${name}: delegate_task`);
}
