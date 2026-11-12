import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Tools, textOutput, type ToolEnv, type ToolOutput } from "@qianji/tools";
import * as guards from "../src/index.ts";

let root: Context | undefined;

afterEach(async () => {
  await root?.fiber.dispose();
  root = undefined;
});

async function setup(config: guards.Config): Promise<Context> {
  root = new Context();
  await root.plugin(Tools);
  await root.plugin(guards, config);
  return root;
}

const env = (signal = new AbortController().signal): ToolEnv => ({ sessionId: "s1", cwd: "/work", signal });
const text = (output: ToolOutput) => output.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("tool deadlines (ADR 0020)", () => {
  it("stops a call that outlives the deadline, even when the tool ignores the signal", async () => {
    const ctx = await setup({ defaultTimeoutMs: 50, repeatThresholds: [] });
    let seen: AbortSignal | undefined;
    ctx.tools.register({
      name: "hang",
      description: "Never returns",
      parameters: { type: "object", properties: {} },
      execute: (_args, callEnv) => {
        seen = callEnv.signal;
        return new Promise<ToolOutput>(() => {});
      },
    });
    const started = Date.now();
    const output = await ctx.tools.execute({ id: "c1", name: "hang", args: {} }, env());
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(output.isError).toBe(true);
    expect(text(output)).toContain("hang did not finish within 0 seconds and was stopped");
    expect(seen?.aborted).toBe(true);
  });

  it("uses the tool's own timeoutMs, and 0 means no limit", async () => {
    const ctx = await setup({ defaultTimeoutMs: 30, repeatThresholds: [] });
    ctx.tools.register({
      name: "patient",
      description: "Takes 80 ms",
      parameters: { type: "object", properties: {} },
      timeoutMs: 0,
      execute: async () => {
        await sleep(80);
        return textOutput("finished");
      },
    });
    ctx.tools.register({
      name: "generous",
      description: "Takes 80 ms within its own 1 s limit",
      parameters: { type: "object", properties: {} },
      timeoutMs: 1_000,
      execute: async () => {
        await sleep(80);
        return textOutput("finished too");
      },
    });
    expect(text(await ctx.tools.execute({ id: "c1", name: "patient", args: {} }, env()))).toBe("finished");
    expect(text(await ctx.tools.execute({ id: "c2", name: "generous", args: {} }, env()))).toBe("finished too");
  });

  it("keeps one call's deadline out of the parallel calls that share its env", async () => {
    const ctx = await setup({ defaultTimeoutMs: 40, repeatThresholds: [] });
    let quickSignal: AbortSignal | undefined;
    ctx.tools.register({ name: "hang", description: "Never returns", parameters: { type: "object", properties: {} }, execute: () => new Promise<ToolOutput>(() => {}) });
    ctx.tools.register({
      name: "steady",
      description: "Takes 120 ms, no limit",
      parameters: { type: "object", properties: {} },
      timeoutMs: 0,
      execute: async (_args, callEnv) => {
        quickSignal = callEnv.signal;
        await sleep(120);
        return textOutput(callEnv.signal.aborted ? "aborted" : "ok");
      },
    });
    const shared = env();
    const [hung, steady] = await Promise.all([
      ctx.tools.execute({ id: "c1", name: "hang", args: {} }, shared),
      ctx.tools.execute({ id: "c2", name: "steady", args: {} }, shared),
    ]);
    expect(hung.isError).toBe(true);
    expect(text(steady)).toBe("ok");
    expect(quickSignal?.aborted).toBe(false);
    expect(shared.signal.aborted).toBe(false);
  });

  it("passes the caller's abort through to the tool", async () => {
    const ctx = await setup({ defaultTimeoutMs: 60_000, repeatThresholds: [] });
    ctx.tools.register({
      name: "wait",
      description: "Returns when aborted",
      parameters: { type: "object", properties: {} },
      execute: (_args, callEnv) => new Promise<ToolOutput>((resolve) => {
        callEnv.signal.addEventListener("abort", () => resolve(textOutput("saw abort", true)), { once: true });
      }),
    });
    const controller = new AbortController();
    const pending = ctx.tools.execute({ id: "c1", name: "wait", args: {} }, env(controller.signal));
    await sleep(10);
    controller.abort();
    expect(text(await pending)).toBe("saw abort");
  });
});

describe("repeated calls (ADR 0020)", () => {
  async function echoContext(): Promise<Context> {
    const ctx = await setup({});
    ctx.tools.register<{ path: string; depth?: number }>({
      name: "look",
      description: "Echo",
      parameters: { type: "object", properties: { path: { type: "string" }, depth: { type: "number" } }, required: ["path"] },
      execute: ({ path }) => textOutput(`looked at ${path}`),
    });
    return ctx;
  }

  it("adds a note at the 3rd, 5th and 8th identical call in a row", async () => {
    const ctx = await echoContext();
    const notes: number[] = [];
    for (let count = 1; count <= 9; count += 1) {
      // Key order must not matter.
      const args = count % 2 === 0 ? { path: "a.ts", depth: 1 } : { depth: 1, path: "a.ts" };
      const output = await ctx.tools.execute({ id: `c${count}`, name: "look", args }, env());
      if (text(output).includes("times in a row")) notes.push(count);
      if (count === 8) expect(text(output)).toContain("Stop repeating it");
    }
    expect(notes).toEqual([3, 5, 8]);
  });

  it("starts counting again after a different call, and counts each session apart", async () => {
    const ctx = await echoContext();
    const call = (id: string, path: string, sessionId = "s1") => ctx.tools.execute({ id, name: "look", args: { path } }, { ...env(), sessionId });
    await call("1", "a.ts");
    await call("2", "a.ts");
    await call("3", "b.ts");
    expect(text(await call("4", "a.ts"))).not.toContain("in a row");
    await call("5", "a.ts", "s2");
    expect(text(await call("6", "a.ts"))).not.toContain("in a row");
    expect(text(await call("7", "a.ts"))).toContain("3 times in a row");
  });

  it("canonicalizes arguments and forgets the least recently active sessions", () => {
    expect(guards.canonicalJson({ b: [1, { d: 2, c: 3 }], a: null })).toBe('{"a":null,"b":[1,{"c":3,"d":2}]}');
    const tracker = new guards.RepeatTracker(2);
    const call = { id: "x", name: "look", args: { path: "a" } };
    tracker.record("s1", call);
    tracker.record("s2", call);
    tracker.record("s3", call);
    expect(tracker.record("s1", call)).toBe(1);
    expect(tracker.record("s3", call)).toBe(2);
  });
});
