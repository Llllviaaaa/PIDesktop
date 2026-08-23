import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  planWidgetLines,
  validatePlanState,
  type PlanState,
} from "./pidesktop-plan-core.ts";

const ENTRY_TYPE = "pidesktop-plan-state";
const WIDGET_KEY = "pidesktop-plan";

const PlanItemSchema = Type.Object({
  id: Type.String({ description: "Stable short id for this step" }),
  text: Type.String({ description: "Concrete, verifiable step" }),
  status: StringEnum(["pending", "in_progress", "completed"] as const),
});

const UpdatePlanSchema = Type.Object({
  explanation: Type.Optional(Type.String({ description: "Why the plan changed" })),
  items: Type.Array(PlanItemSchema, { maxItems: 50 }),
});

export default function (pi: ExtensionAPI) {
  let state: PlanState = { explanation: "", items: [] };

  const show = (ctx: ExtensionContext) => {
    const lines = planWidgetLines(state);
    ctx.ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined);
  };

  const persist = () => pi.appendEntry(ENTRY_TYPE, state);

  pi.registerTool({
    name: "update_plan",
    label: "Update plan",
    description: "Create or replace the current session plan and its step statuses.",
    promptSnippet: "Maintain a visible, persistent plan for multi-step work",
    promptGuidelines: [
      "Use update_plan for work with several meaningful steps, and keep step statuses current as work progresses.",
      "Use exactly one in_progress step while executing. Mark finished steps completed before advancing.",
      "Do not use a plan for a single trivial action. Plan state follows the active session branch.",
    ],
    parameters: UpdatePlanSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      state = validatePlanState({ explanation: params.explanation ?? "", items: params.items });
      persist();
      show(ctx);
      const completed = state.items.filter((item) => item.status === "completed").length;
      return {
        content: [{
          type: "text" as const,
          text: state.items.length > 0
            ? `Plan updated: ${completed}/${state.items.length} steps completed.`
            : "Plan cleared.",
        }],
        details: state,
      };
    },
  });

  pi.registerCommand("pidesktop-plan", {
    description: "Show or clear the current desktop plan",
    handler: async (args, ctx) => {
      if (args.trim().toLowerCase() === "clear") {
        state = { explanation: "", items: [] };
        persist();
        show(ctx);
        ctx.ui.notify("当前计划已清除", "info");
        return;
      }
      const lines = planWidgetLines(state);
      ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "当前没有计划", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const entry = ctx.sessionManager.getEntries()
      .filter((candidate: { type?: string; customType?: string }) => candidate.type === "custom" && candidate.customType === ENTRY_TYPE)
      .pop() as { data?: PlanState } | undefined;
    try {
      state = entry?.data ? validatePlanState(entry.data) : { explanation: "", items: [] };
    } catch {
      state = { explanation: "", items: [] };
    }
    show(ctx);
  });
}
