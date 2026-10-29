import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { Sessions } from "@pid/session";
import { Tools } from "@pid/tools";
import * as plan from "../src/index.ts";
import { planOf } from "../src/index.ts";

describe("update_plan", () => {
  it("stores the plan in the session, follows rewinds and streams it", async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Tools);
    await ctx.plugin(plan);
    const session = ctx.sessions.create({ cwd: "/w" });
    const live: unknown[] = [];
    ctx.on("session/delta", (_session, _seq, delta) => void live.push(delta));
    const env = { sessionId: session.id, cwd: "/w", signal: new AbortController().signal };
    const items = [
      { id: "a", text: "Read code", status: "completed" },
      { id: "b", text: "Fix bug", status: "in_progress" },
    ];

    const output = await ctx.tools.execute({ id: "1", name: "update_plan", args: { items } }, env);
    expect(output.content).toEqual([{ type: "text", text: "Plan updated: 1/2 steps completed." }]);
    expect(planOf(session)).toEqual({ explanation: "", items });
    expect(live).toEqual([{ type: "plan", plan: { explanation: "", items } }]);

    const invalid = await ctx.tools.execute({ id: "2", name: "update_plan", args: { items: [...items, { id: "c", text: "Two active", status: "in_progress" }] } }, env);
    expect(invalid.isError).toBe(true);
    expect(planOf(session).items).toHaveLength(2);

    session.append("rewind", { toSeq: 0 });
    expect(planOf(session)).toEqual({ explanation: "", items: [] });
  });
});
