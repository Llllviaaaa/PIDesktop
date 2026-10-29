/**
 * The `update_plan` tool (ADR 0009): the model keeps a visible step list for
 * multi-step work. The plan is a `custom` event of namespace `pid-plan`, so
 * it follows the session branch; each change also goes out live as a
 * `{ type: "plan", plan }` delta for the UI.
 */
import type { Context } from "@deepseek-ai/cordis";
import { latestCustom, type Session } from "@pid/session";
import { textOutput, type ToolDefinition } from "@pid/tools";
import { validatePlanState, type PlanItemStatus, type PlanState } from "./core.ts";

export * from "./core.ts";

export const name = "pid-plan";
export const inject = ["sessions", "tools"];
export const NAMESPACE = "pid-plan";

const EMPTY: PlanState = { explanation: "", items: [] };

/** The session's plan on its current branch; an unreadable one counts as empty. */
export function planOf(session: Session): PlanState {
  const stored = latestCustom<PlanState>(session.events, NAMESPACE);
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

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(planTool(ctx)), `${name}: update_plan`);
}
