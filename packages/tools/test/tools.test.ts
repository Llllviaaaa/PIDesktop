import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { Tools, argumentProblem, textOutput, type ToolEnv, type ToolOutput } from "../src/index.ts";

async function setup() {
  const ctx = new Context();
  await ctx.plugin(Tools);
  ctx.tools.register<{ text: string }>({
    name: "shout",
    description: "Upper-case text",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: ({ text }) => textOutput(text.toUpperCase()),
  });
  ctx.tools.register({
    name: "boom",
    description: "Throws",
    parameters: { type: "object" },
    execute: () => {
      throw new Error("kaput");
    },
  });
  return ctx;
}

const env = (): ToolEnv => ({ sessionId: "s", cwd: "/w", signal: new AbortController().signal });
const firstText = (output: ToolOutput) => (output.content[0]?.type === "text" ? output.content[0].text : "");

describe("tools", () => {
  it("checks required arguments and top-level types", () => {
    const parameters = { type: "object" as const, properties: { a: { type: "string" }, n: { type: "integer" } }, required: ["a"] };
    expect(argumentProblem(parameters, { a: "x", n: 2 })).toBeUndefined();
    expect(argumentProblem(parameters, {})).toBe('missing required argument "a"');
    expect(argumentProblem(parameters, { a: "x", n: 1.5 })).toBe('argument "n" must be an integer');
    expect(argumentProblem(parameters, { __invalidJson: "{" })).toBe("the arguments were not valid JSON");
  });

  it("runs a tool through the pipeline and reports the result", async () => {
    const ctx = await setup();
    const results: string[] = [];
    ctx.on("tools/result", (call, _env, output) => void results.push(`${call.name}:${firstText(output)}`));
    ctx.on("tools/execute", async (call, _env, next) => {
      const output = await next();
      return call.name === "shout" ? { ...output, content: [{ type: "text", text: `${firstText(output)}!` }] } : output;
    });
    const output = await ctx.tools.execute({ id: "1", name: "shout", args: { text: "hi" } }, env());
    expect(output).toEqual({ content: [{ type: "text", text: "HI!" }] });
    expect(results).toEqual(["shout:HI!"]);
    expect(ctx.tools.schemas().map((schema) => schema.name)).toEqual(["boom", "shout"]);
  });

  it("lets pre-execute listeners deny or rewrite a call", async () => {
    const ctx = await setup();
    ctx.on("tools/pre-execute", async (call) => {
      if (call.args.text === "secret") return { deny: true, reason: "no secrets" };
      call.args.text = `${String(call.args.text)} (checked)`;
      return undefined;
    });
    expect(await ctx.tools.execute({ id: "1", name: "shout", args: { text: "secret" } }, env())).toEqual(textOutput("Denied: no secrets", true));
    expect(firstText(await ctx.tools.execute({ id: "2", name: "shout", args: { text: "ok" } }, env()))).toBe("OK (CHECKED)");
  });

  it("turns unknown tools, bad arguments and throws into error results", async () => {
    const ctx = await setup();
    expect(await ctx.tools.execute({ id: "1", name: "nope", args: {} }, env())).toEqual(textOutput('Unknown tool "nope".', true));
    expect(firstText(await ctx.tools.execute({ id: "2", name: "shout", args: {} }, env()))).toContain("missing required argument");
    expect(await ctx.tools.execute({ id: "3", name: "boom", args: {} }, env())).toEqual(textOutput("boom failed: kaput", true));
  });

  it("refuses duplicate names and unregisters with the disposer", async () => {
    const ctx = await setup();
    expect(() => ctx.tools.register({ name: "shout", description: "", parameters: { type: "object" }, execute: () => textOutput("") })).toThrow("already registered");
    const dispose = ctx.tools.register({ name: "temp", description: "", parameters: { type: "object" }, execute: () => textOutput("") });
    dispose();
    expect(ctx.tools.get("temp")).toBeUndefined();
  });
});

describe("per-session restrictions", () => {
  it("hides and refuses tools outside a session's allow list until disposed", async () => {
    const ctx = await setup();
    const dispose = ctx.tools.restrict("child", ["shout"]);
    expect(ctx.tools.schemas("child").map((schema) => schema.name)).toEqual(["shout"]);
    expect(ctx.tools.schemas().map((schema) => schema.name)).toEqual(["boom", "shout"]);
    const childEnv = { ...env(), sessionId: "child" };
    expect(await ctx.tools.execute({ id: "1", name: "boom", args: {} }, childEnv)).toEqual(textOutput('Unknown tool "boom".', true));
    dispose();
    expect(ctx.tools.schemas("child").map((schema) => schema.name)).toEqual(["boom", "shout"]);
  });

  it("tells the tool which call it is executing", async () => {
    const ctx = await setup();
    let seen: string | undefined;
    ctx.tools.register({ name: "who", description: "", parameters: { type: "object" }, execute: (_args, callEnv) => {
      seen = callEnv.callId;
      return textOutput("");
    } });
    await ctx.tools.execute({ id: "call-7", name: "who", args: {} }, env());
    expect(seen).toBe("call-7");
  });
});
