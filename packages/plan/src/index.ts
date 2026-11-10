/**
 * The `update_plan` tool (ADR 0009): the model keeps a visible step list for
 * multi-step work. The plan is a `custom` event of namespace `pid-plan`, so
 * it follows the session branch; each change also goes out live as a
 * `{ type: "plan", plan }` delta for the UI.
 */
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/commands";
import { ErrorCode, type PlanGetResult } from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import { latestCustom, type Session } from "@qianji/session";
import { textOutput, type ToolDefinition } from "@qianji/tools";
import { validatePlanState, type PlanItemStatus, type PlanState } from "./core.ts";

export * from "./core.ts";

export const name = "qianji-plan";
export const inject = ["sessions", "tools"];
export const NAMESPACE = "qianji-plan";
export const LEGACY_NAMESPACE = "pid-plan";

const EMPTY: PlanState = { explanation: "", items: [] };

/** The session's plan on its current branch; an unreadable one counts as empty. */
export function planOf(session: Session): PlanState {
  const stored = latestCustom<PlanState>(session.events, [NAMESPACE, LEGACY_NAMESPACE]);
  if (stored === undefined) return EMPTY;
  try {
    return validatePlanState({ explanation: stored.explanation ?? "", items: stored.items ?? [] });
  } catch {
    return EMPTY;
  }
}

export function setPlan(session: Session, plan: PlanState): PlanState {
  const valid = validatePlanState(plan);
  session.append("custom", { ns: NAMESPACE, data: valid });
  session.delta({ type: "plan", plan: valid });
  return valid;
}

export function planTool(ctx: Context): ToolDefinition<{ explanation?: string; items: Array<{ id: string; text: string; status: PlanItemStatus }> }> {
  return {
    name: "update_plan",
    description: [
      "Create or replace the current session plan and its step statuses.",
      "Use it for work with several meaningful steps and keep statuses current as work progresses: exactly one in_progress step while executing; mark finished steps completed before advancing.",
      "Do not use a plan for a single trivial action. An empty list clears the plan.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        explanation: { type: "string", description: "Why the plan changed" },
        items: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable short id for this step" },
              text: { type: "string", description: "Concrete, verifiable step" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
    async execute({ explanation, items }, env) {
      const session = await ctx.sessions.get(env.sessionId);
      if (session === undefined) return textOutput("No session to keep a plan in.", true);
      const plan = setPlan(session, { explanation: explanation ?? "", items });
      const completed = plan.items.filter((item) => item.status === "completed").length;
      return {
        content: [{ type: "text", text: plan.items.length > 0 ? `Plan updated: ${completed}/${plan.items.length} steps completed.` : "Plan cleared." }],
        details: plan,
      };
    },
  };
}

export function formatPlanMarkdown(plan: PlanState): string {
  if (plan.items.length === 0) return "当前会话暂无执行计划。";
  const marker = (status: PlanItemStatus) => (status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : "[ ]");
  const lines = ["### 当前任务计划", ""];
  if (plan.explanation.trim()) {
    lines.push(plan.explanation.trim(), "");
  }
  for (const item of plan.items) {
    lines.push(`- \`${marker(item.status)}\` ${item.text}`);
  }
  return lines.join("\n");
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(planTool(ctx)), `${name}: update_plan`);
  ctx.inject(["commands"], (inner) => {
    inner.effect(() => inner.commands.register({
      name: "plan",
      description: "查看当前会话的任务计划（传入 clear 清空计划）",
      argsHint: "[clear]",
      source: "plan",
      async execute(rawArgs, env) {
        if (!env.sessionId) return { output: "当前会话尚未开始，暂无任务计划。" };
        const session = await inner.sessions.get(env.sessionId);
        if (session === undefined) return { output: "找不到当前会话。", isError: true };
        if (rawArgs.trim().toLowerCase() === "clear") {
          setPlan(session, { explanation: "", items: [] });
          return { output: "已清空当前会话的任务计划。" };
        }
        return { output: formatPlanMarkdown(planOf(session)) };
      },
    }), `${name}: /plan`);
  });
  ctx.inject(["rpc"], (rpcCtx) => {
    rpcCtx.effect(
      () => rpcCtx.rpc.method("plan.get", async (params): Promise<PlanGetResult> => {
        const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
        if (typeof p.sessionId !== "string") throw new RpcError(ErrorCode.InvalidParams, "sessionId must be a string");
        const target = await rpcCtx.sessions.get(p.sessionId);
        if (target === undefined) throw new RpcError(ErrorCode.SessionNotFound, `No session ${p.sessionId}`);
        return { plan: planOf(target) };
      }),
      `${name}: plan.get`,
    );
  });
}
