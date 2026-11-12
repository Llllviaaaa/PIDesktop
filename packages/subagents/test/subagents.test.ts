import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop } from "@qianji/agent-loop";
import { LlmService, type LlmRequest } from "@qianji/llm";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { ScriptedProvider, textReply, toolReply, useScriptedProvider } from "@qianji/testkit";
import { Tools, textOutput } from "@qianji/tools";
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

describe("structured subagent results", () => {
  const schema = {
    type: "object",
    properties: {
      files: { type: "array", items: { type: "string" }, minItems: 1 },
      risk: { type: "string", enum: ["low", "high"] },
    },
    required: ["files", "risk"],
    additionalProperties: false,
  };
  const lastUserText = (request: LlmRequest): string => {
    const last = request.messages.findLast((message) => message.role === "user");
    const block = last?.role === "user" ? last.content[0] : undefined;
    return block?.type === "text" ? block.text : "";
  };
  const outputText = (output: Awaited<ReturnType<Context["tools"]["execute"]>>) => (output.content[0]?.type === "text" ? output.content[0].text : "");

  it("asks for JSON matching the schema and returns it as data", async () => {
    const prompts: string[] = [];
    const { ctx: c, parent } = await setup((request) => {
      prompts.push(lastUserText(request));
      return textReply('```json\n{"files": ["a.ts"], "risk": "low"}\n```');
    });
    const output = await c.tools.execute({ id: "call-1", name: "delegate_task", args: { task: "list risky files", outputSchema: schema } }, env(parent.id));
    expect(output.isError).toBe(false);
    expect(prompts[0]).toContain("matches this JSON Schema");
    expect(prompts[0]).toContain('"additionalProperties": false');
    expect(outputText(output)).toContain('```json\n{\n  "files": [\n    "a.ts"\n  ],\n  "risk": "low"\n}\n```');
    const details = output.details as { results: Array<{ structured?: unknown }> };
    expect(details.results[0]?.structured).toEqual({ files: ["a.ts"], risk: "low" });
  });

  it("gives the subagent one chance to fix a reply that does not fit", async () => {
    const prompts: string[] = [];
    const { ctx: c, parent } = await setup((request) => {
      prompts.push(lastUserText(request));
      return textReply(prompts.length === 1 ? "The risky file is a.ts." : '{"files": ["a.ts"], "risk": "high"}');
    });
    const output = await c.tools.execute({ id: "call-1", name: "delegate_task", args: { task: "list risky files", outputSchema: schema } }, env(parent.id));
    expect(output.isError).toBe(false);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("was not valid JSON");
    expect((output.details as { results: Array<{ structured?: unknown }> }).results[0]?.structured).toEqual({ files: ["a.ts"], risk: "high" });
  });

  it("fails the task when the corrected reply still does not fit", async () => {
    const { ctx: c, parent } = await setup(() => textReply('{"files": [], "risk": "medium"}'));
    const output = await c.tools.execute({ id: "call-1", name: "delegate_task", args: { task: "list risky files", outputSchema: schema } }, env(parent.id));
    expect(output.isError).toBe(true);
    expect(outputText(output)).toContain("Structured result rejected: it did not match the schema: $.files should have at least 1 items");
  });

  it("rejects an outputSchema that is not an object", async () => {
    const { ctx: c, parent } = await setup(() => textReply("x"));
    const output = await c.tools.execute({ id: "call-1", name: "delegate_task", args: { task: "x", outputSchema: ["nope"] } }, env(parent.id));
    expect(output.isError).toBe(true);
  });

  it("checks the schema subset tools use", () => {
    expect(subagents.schemaProblem(schema, { files: ["a"], risk: "low" })).toBeUndefined();
    expect(subagents.schemaProblem(schema, { files: ["a"] })).toBe("$.risk is missing");
    expect(subagents.schemaProblem(schema, { files: [1], risk: "low" })).toBe("$.files[0] should be string, not integer");
    expect(subagents.schemaProblem(schema, { files: ["a"], risk: "low", extra: true })).toBe("$.extra is not allowed");
    expect(subagents.schemaProblem({ type: ["number", "null"] }, null)).toBeUndefined();
    expect(subagents.schemaProblem({ type: "number" }, 3)).toBeUndefined();
    expect(subagents.schemaProblem({ type: "integer" }, 2.5)).toBe("$ should be integer, not number");
    expect(subagents.schemaProblem({ const: "x" }, "y")).toBe('$ should be "x"');
    expect(subagents.parseJsonAnswer("  ```\n[1, 2]\n```  ")).toEqual({ ok: true, value: [1, 2] });
    expect(subagents.parseJsonAnswer("")).toEqual({ ok: false, error: "the reply was empty" });
  });
});
