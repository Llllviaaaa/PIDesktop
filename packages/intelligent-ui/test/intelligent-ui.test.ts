import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { Commands } from "@qianji/commands";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { Tools } from "@qianji/tools";
import * as intelligentUi from "../src/index.ts";

async function bootTestHost() {
  const ctx = new Context();
  ctx.plugin(Sessions);
  ctx.plugin(Tools);
  ctx.plugin(Commands);
  ctx.plugin(SystemPrompt);
  const uiFiber = ctx.plugin(intelligentUi);
  await new Promise((resolve) => setImmediate(resolve));
  return { ctx, uiFiber };
}

describe("@qianji/intelligent-ui", () => {
  it("registers render_ui & update_ui tools, injects system prompt instructions, and tracks version history across session branches", async () => {
    const { ctx, uiFiber } = await bootTestHost();
    const session = ctx.sessions.create({ cwd: "D:/repo" });
    const signal = new AbortController().signal;

    const toolNames = ctx.tools.schemas(session.id).map((item) => item.name);
    expect(toolNames).toContain("render_ui");
    expect(toolNames).toContain("update_ui");

    const promptText = await ctx.systemPrompt.build({
      sessionId: session.id,
      cwd: "D:/repo",
      model: { provider: "deepseek", model: "deepseek-chat" },
      tools: ctx.tools.schemas(session.id),
    });
    expect(promptText).toContain("Interactive UI (Intelligent UI)");
    expect(promptText).toContain("render_ui");

    // v1 via render_ui (declarative)
    const v1Result = await ctx.tools.execute(
      {
        id: "call-1",
        name: "render_ui",
        args: {
          id: "Loan Calculator",
          title: "复利收益计算器",
          subtitle: "支持实时滑块调节",
          engine: "declarative",
          spec: {
            state: { principal: 100, rate: 5, years: 10 },
            blocks: [
              {
                type: "controls",
                items: [{ key: "rate", label: "年化收益率", kind: "slider", min: 1, max: 15, step: 0.5, unit: "%" }],
              },
              {
                type: "stats",
                items: [{ label: "期末本息", formula: "principal * Math.pow(1 + rate / 100, years)", suffix: " 万", decimals: 2 }],
              },
            ],
          },
        },
      },
      { sessionId: session.id, cwd: "D:/repo", signal },
    );
    expect(v1Result.isError).toBeUndefined();
    expect(v1Result.details).toMatchObject({
      id: "loan-calculator",
      version: 1,
      title: "复利收益计算器",
      engine: "declarative",
    });

    const seqAfterV1 = session.events.at(-1)?.seq ?? 0;

    // v2 via update_ui (patching state + title)
    const v2Result = await ctx.tools.execute(
      {
        id: "call-2",
        name: "update_ui",
        args: {
          id: "loan-calculator",
          subtitle: "已更新默认期限为 20 年",
          state: { years: 20 },
        },
      },
      { sessionId: session.id, cwd: "D:/repo", signal },
    );
    expect(v2Result.isError).toBeUndefined();
    expect(v2Result.details).toMatchObject({
      id: "loan-calculator",
      version: 2,
      title: "复利收益计算器",
      subtitle: "已更新默认期限为 20 年",
      spec: {
        state: { principal: 100, rate: 5, years: 20 },
      },
    });

    const allVersions = intelligentUi.widgetsOf(session).get("loan-calculator");
    expect(allVersions?.map((item) => item.version)).toEqual([1, 2]);

    // /ui list command summarizes active widgets
    const listCmd = await ctx.commands.run("ui", "", { sessionId: session.id, cwd: "D:/repo", signal });
    expect(listCmd.output).toContain("复利收益计算器");
    expect(listCmd.output).toContain("v2");

    // /ui <prompt> expands into a render_ui prompt
    const promptCmd = await ctx.commands.run("ui", "排序算法可视化", { sessionId: session.id, cwd: "D:/repo", signal });
    expect(promptCmd.prompt).toContain("render_ui");
    expect(promptCmd.prompt).toContain("排序算法可视化");

    // Rewinding session branch drops v2 cleanly
    session.append("rewind", { toSeq: seqAfterV1 });
    const rewoundVersions = intelligentUi.widgetsOf(session).get("loan-calculator");
    expect(rewoundVersions?.map((item) => item.version)).toEqual([1]);

    // Disposing plugin unregisters tools and system prompt section cleanly
    await uiFiber.dispose();
    expect(ctx.tools.schemas(session.id).map((item) => item.name)).not.toContain("render_ui");
    const afterDisposePrompt = await ctx.systemPrompt.build({
      sessionId: session.id,
      cwd: "D:/repo",
      model: { provider: "deepseek", model: "deepseek-chat" },
      tools: ctx.tools.schemas(session.id),
    });
    expect(afterDisposePrompt).not.toContain("Interactive UI (Intelligent UI)");
  });

  it("supports sandboxed html engine and rejects invalid payloads gracefully", async () => {
    const { ctx } = await bootTestHost();
    const session = ctx.sessions.create({ cwd: "D:/repo" });
    const signal = new AbortController().signal;

    const htmlResult = await ctx.tools.execute(
      {
        id: "call-html",
        name: "render_ui",
        args: {
          id: "pendulum-sim",
          title: "单摆物理模拟",
          engine: "html",
          html: "<div id='app'><canvas width='300' height='180'></canvas></div>",
        },
      },
      { sessionId: session.id, cwd: "D:/repo", signal },
    );
    expect(htmlResult.isError).toBeUndefined();
    expect(htmlResult.details).toMatchObject({
      id: "pendulum-sim",
      version: 1,
      engine: "html",
    });

    const badResult = await ctx.tools.execute(
      {
        id: "call-bad",
        name: "render_ui",
        args: {
          id: "broken",
          title: "空组件",
          engine: "declarative",
        },
      },
      { sessionId: session.id, cwd: "D:/repo", signal },
    );
    expect(badResult.isError).toBe(true);
    expect(badResult.content[0]).toMatchObject({ type: "text" });
  });
});
