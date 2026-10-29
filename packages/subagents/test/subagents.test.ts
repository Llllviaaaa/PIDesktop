import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop } from "@pid/agent-loop";
import { LlmService, type LlmRequest } from "@pid/llm";
import { Sessions } from "@pid/session";
import { SystemPrompt } from "@pid/system-prompt";
import { ScriptedProvider, textReply, toolReply, useScriptedProvider } from "@pid/testkit";
import { Tools, textOutput } from "@pid/tools";
import * as subagents from "../src/index.ts";

let ctx: Context | undefined;
afterEach(async () => {
  await ctx?.fiber.dispose();
  ctx = undefined;
});

async function setup(reply: (request: LlmRequest) => ReturnType<typeof textReply>) {
  ctx = new Context();
  await ctx.plugin(LlmService, { maxAttempts: 1 });
  await ctx.plugin(Sessions);
  await ctx.plugin(Tools);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(AgentLoop);
  await ctx.plugin(subagents, { concurrency: 2 });
  for (const name of ["read", "grep", "find", "ls", "edit", "write", "bash"]) {
    ctx.tools.register({ name, description: name, parameters: { type: "object" }, execute: () => textOutput(`${name} ran`) });
  }
  const provider = new ScriptedProvider(Array.from({ length: 20 }, () => reply));
  useScriptedProvider(ctx, provider);
  const parent = ctx.sessions.create({ cwd: "/repo" });
  parent.append("model", { provider: "scripted", model: "m" });
  return { ctx, provider, parent };
}

const env = (sessionId: string, signal = new AbortController().signal) => ({ sessionId, cwd: "/repo", signal, callId: "call-1" });

describe("delegate_task", () => {
  it("runs tasks as restricted child sessions and returns their answers", async () => {
    const { ctx: c, provider, parent } = await setup((request) => {
      const prompt = request.messages[0]?.role === "user" && request.messages[0].content[0]?.type === "text" ? request.messages[0].content[0].text : "";
      return textReply(prompt.includes("find the bug") ? "Bug is in a.ts" : "Plan: three steps");
    });
    const live: unknown[] = [];
    c.on("session/delta", (session, _seq, delta) => {
      if (session === parent) live.push(delta);
    });
    const output = await c.tools.execute({
      id: "call-1",
      name: "delegate_task",
      args: { tasks: [{ label: "bug", task: "find the bug" }, { label: "plan", task: "plan the fix", role: "planner" }] },
    }, env(parent.id));

    expect(output.isError).toBe(false);
    const text = output.content[0]?.type === "text" ? output.content[0].text : "";
    expect(text).toContain("2/2 subagents completed.");
    expect(text).toContain("### bug (explorer) - completed\n\nBug is in a.ts");
    expect(text).toContain("### plan (planner) - completed\n\nPlan: three steps");

    const children = (await c.sessions.list()).filter((summary) => summary.parent?.sessionId === parent.id);
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.parent?.callId === "call-1")).toBe(true);
    for (const request of provider.requests) expect(request.tools?.map((tool) => tool.name)).toEqual(["find", "grep", "ls", "read"]);
    expect(live.at(-1)).toMatchObject({ type: "subagents", callId: "call-1", permission: "read-only", tasks: [{ status: "completed" }, { status: "completed" }] });
    // The restriction ends with the run.
    expect(c.tools.schemas(children[0]?.id).map((tool) => tool.name)).toContain("bash");
  });

  it("lets a workspace-write worker edit but never run commands", async () => {
    const { ctx: c, provider, parent } = await setup(() => textReply("Done."));
    await c.tools.execute({ id: "call-1", name: "delegate_task", args: { task: "fix it", role: "worker", permission: "workspace-write" } }, env(parent.id));
    expect(provider.requests[0]?.tools?.map((tool) => tool.name)).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
  });

  it("refuses a call the child cannot see and reports failures", async () => {
    let first = true;
    const { ctx: c, parent } = await setup(() => {
      if (first) {
        first = false;
        return toolReply([{ id: "x", name: "bash", args: {} }]);
      }
      return [{ type: "finish", reason: "error", error: { kind: "server", message: "down", retryable: false } }];
    });
    const output = await c.tools.execute({ id: "call-1", name: "delegate_task", args: { task: "try" } }, env(parent.id));
    expect(output.isError).toBe(true);
    const child = (await c.sessions.list()).find((summary) => summary.parent !== undefined);
    const childSession = await c.sessions.get(child?.id ?? "");
    const result = childSession?.events.find((event) => event.type === "tool-result");
    expect(result?.data).toMatchObject({ isError: true, content: [{ type: "text", text: 'Unknown tool "bash".' }] });
    expect(output.content[0]?.type === "text" ? output.content[0].text : "").toContain("Subagent ended: error");
  });

  it("validates its input", async () => {
    const { ctx: c, parent } = await setup(() => textReply("x"));
    const output = await c.tools.execute({ id: "call-1", name: "delegate_task", args: {} }, env(parent.id));
    expect(output).toEqual(textOutput("At least one delegated task is required", true));
  });
});
