/**
 * Golden tests of the loop: each scenario runs against a scripted provider
 * and compares the resulting session log with test/golden/<name>.jsonl.
 */
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBusyError, type AgentDelta } from "@qianji/agent";
import { LlmService } from "@qianji/llm";
import { COMPACTION_PREFIX, Sessions, type Session } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { ScriptedProvider, errorReply, goldenLog, textReply, toolReply, useScriptedProvider, type ScriptedOptions, type ScriptedReply } from "@qianji/testkit";
import { Tools, textOutput } from "@qianji/tools";
import { AgentLoop, COMPACTION_REQUEST, shrinkForSummary, type AgentLoopConfig } from "../src/index.ts";

interface Harness {
  ctx: Context;
  provider: ScriptedProvider;
  session: Session;
  deltas: AgentDelta[];
  /** Resolves the pending `slow` tool call. */
  release: () => void;
  /** Settles once a `slow` call has started. */
  slowStarted: Promise<void>;
}

let current: Context | undefined;

afterEach(async () => {
  await current?.fiber.dispose();
  current = undefined;
});

async function setup(replies: ScriptedReply[], options: { scripted?: ScriptedOptions; loop?: AgentLoopConfig } = {}): Promise<Harness> {
  const ctx = new Context();
  current = ctx;
  await ctx.plugin(LlmService, { maxAttempts: 1, baseDelayMs: 0 });
  await ctx.plugin(Sessions);
  await ctx.plugin(Tools);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(AgentLoop, options.loop ?? {});
  const provider = new ScriptedProvider(replies, options.scripted);
  useScriptedProvider(ctx, provider);
  ctx.systemPrompt.section("test", () => "You are under test.");

  let release = () => {};
  let started = () => {};
  const slowStarted = new Promise<void>((resolve) => { started = resolve; });
  ctx.tools.register<{ text: string }>({
    name: "echo",
    description: "Echo text back",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: ({ text }) => textOutput(text),
  });
  ctx.tools.register({
    name: "slow",
    description: "Wait until released or aborted",
    parameters: { type: "object", properties: {} },
    execute: (_args, env) => new Promise((resolve) => {
      started();
      release = () => resolve(textOutput("released"));
      env.signal.addEventListener("abort", () => resolve(textOutput("aborted", true)), { once: true });
    }),
  });

  const session = ctx.sessions.create({ cwd: "/work" });
  session.append("model", { provider: "scripted", model: "test-model" });
  const deltas: AgentDelta[] = [];
  ctx.on("session/delta", (from, _seq, delta) => {
    if (from === session) deltas.push(delta as AgentDelta);
  });
  return { ctx, provider, session, deltas, release: () => release(), slowStarted };
}

const text = (value: string) => [{ type: "text" as const, text: value }];

function waitForDelta(harness: Harness, match: (delta: AgentDelta) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const dispose = harness.ctx.on("session/delta", (from, _seq, delta) => {
      if (from === harness.session && match(delta as AgentDelta)) {
        dispose();
        resolve();
      }
    });
  });
}

async function run(harness: Harness, prompt: string): Promise<void> {
  harness.ctx.agents.prompt(harness.session, text(prompt));
  await harness.ctx.agents.idle(harness.session.id);
}

const golden = (name: string) => `./golden/${name}.jsonl`;

describe("agent loop", () => {
  it("answers a prompt with text", async () => {
    const harness = await setup([textReply("Hello!")]);
    await run(harness, "Hi");
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("text-reply"));
    expect(harness.deltas.map((delta) => delta.type)).toEqual([
      "agent-start", "turn-start", "llm-start", "llm-chunk", "llm-chunk", "llm-chunk", "agent-end",
    ]);
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
    const [request] = harness.provider.requests;
    expect(request?.system).toBe("You are under test.");
    expect(request?.tools?.map((tool) => tool.name)).toEqual(["echo", "slow"]);
  });

  it("runs requested tools in parallel and appends results in call order", async () => {
    const harness = await setup([
      toolReply([
        { id: "call-1", name: "echo", args: { text: "one" } },
        { id: "call-2", name: "echo", args: { text: "two" } },
        { id: "call-3", name: "missing", args: {} },
      ], "Let me check."),
      textReply("Both said hi."),
    ]);
    await run(harness, "Echo twice");
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("parallel-tools"));
    const second = harness.provider.requests[1];
    expect(second?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool-result", "tool-result", "tool-result"]);
  });

  it("reports invalid tool arguments to the model instead of running the tool", async () => {
    const harness = await setup([
      toolReply([{ id: "call-1", name: "echo", args: { text: 42 } }]),
      textReply("Sorry."),
    ]);
    await run(harness, "Echo a number");
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("invalid-arguments"));
  });

  it("delivers a steering message after the running tools finish", async () => {
    const harness = await setup([
      toolReply([{ id: "call-1", name: "slow", args: {} }]),
      textReply("Changed course."),
    ]);
    harness.ctx.agents.prompt(harness.session, text("Start"));
    await harness.slowStarted;
    expect(harness.ctx.agents.steer(harness.session, text("Actually, stop"))).toBeUndefined();
    expect(harness.ctx.agents.status(harness.session.id)).toMatchObject({ running: true, runningTools: [{ callId: "call-1", name: "slow" }], queue: { steer: 1, followUp: 0 } });
    harness.release();
    await harness.ctx.agents.idle(harness.session.id);
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("steer"));
  });

  it("delivers a follow-up once the model would stop", async () => {
    const harness = await setup([textReply("First."), textReply("Second.")], { scripted: { chunkDelayMs: 5 } });
    harness.ctx.agents.prompt(harness.session, text("One"));
    harness.ctx.agents.followUp(harness.session, text("Two"));
    await harness.ctx.agents.idle(harness.session.id);
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("follow-up"));
  });

  it("starts a run when steered or followed up while idle", async () => {
    const harness = await setup([textReply("Ok.")]);
    expect(harness.ctx.agents.followUp(harness.session, text("Hello"))?.seq).toBe(2);
    await harness.ctx.agents.idle(harness.session.id);
    expect(harness.session.lastSeq).toBe(3);
  });

  it("refuses a second prompt while running", async () => {
    const harness = await setup([textReply("Slow.")], { scripted: { chunkDelayMs: 5 } });
    harness.ctx.agents.prompt(harness.session, text("One"));
    expect(() => harness.ctx.agents.prompt(harness.session, text("Two"))).toThrow(AgentBusyError);
    await harness.ctx.agents.idle(harness.session.id);
  });

  it("keeps the partial reply when aborted mid-stream", async () => {
    const harness = await setup([[
      { type: "text-delta", index: 0, text: "Partial" },
      { type: "text-delta", index: 0, text: " never" },
      { type: "tool-call-start", index: 1, id: "call-1", name: "echo" },
      { type: "finish", reason: "tool-use" },
    ]], { scripted: { chunkDelayMs: 5 } });
    const firstChunk = waitForDelta(harness, (delta) => delta.type === "llm-chunk");
    harness.ctx.agents.prompt(harness.session, text("Go"));
    await firstChunk;
    await harness.ctx.agents.abort(harness.session.id);
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("abort-stream"));
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "aborted" });
  });

  it("stops running tools when aborted", async () => {
    const harness = await setup([toolReply([{ id: "call-1", name: "slow", args: {} }])]);
    harness.ctx.agents.prompt(harness.session, text("Start"));
    await harness.slowStarted;
    await harness.ctx.agents.abort(harness.session.id);
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("abort-tool"));
  });

  it("records a provider error and stops", async () => {
    const harness = await setup([errorReply({ kind: "auth", message: "bad key", status: 401, retryable: false })]);
    await run(harness, "Hi");
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("provider-error"));
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "error" });
  });

  it("compacts and retries once when the context is too long", async () => {
    const harness = await setup([
      errorReply({ kind: "context-length", message: "too long", status: 400, retryable: false }),
      textReply("The user said hi."),
      textReply("Hello again."),
    ]);
    await run(harness, "Hi");
    await expect(goldenLog(harness.session)).toMatchFileSnapshot(golden("context-length"));
    const [, summaryCall, retry] = harness.provider.requests;
    expect(summaryCall?.tools).toBeUndefined();
    expect(summaryCall?.messages.at(-1)).toEqual({ role: "user", content: text(COMPACTION_REQUEST) });
    expect(retry?.messages).toEqual([{ role: "user", content: text(`${COMPACTION_PREFIX}The user said hi.`) }]);
  });

  it("compacts on request, keeping the latest turn", async () => {
    const harness = await setup([textReply("One."), textReply("Two."), textReply("Summary of one.")]);
    await run(harness, "First");
    await run(harness, "Second");
    const event = await harness.ctx.agents.compact(harness.session);
    expect(event?.data).toEqual({ throughSeq: 3, summary: "Summary of one." });
    expect(harness.session.state().messages).toEqual([
      { role: "user", content: text(`${COMPACTION_PREFIX}Summary of one.`) },
      { role: "user", content: text("Second") },
      { role: "assistant", content: text("Two.") },
    ]);
  });

  it("compacts early once a call used most of the model's context window, keeping the new prompt", async () => {
    const harness = await setup([
      textReply("One.", { inputTokens: 85_000, outputTokens: 5 }),
      textReply("Summary of one."),
      textReply("Two."),
    ]);
    let lookups = 0;
    Object.assign(harness.provider, {
      listModels: async () => {
        lookups += 1;
        return [{ id: "test-model", contextWindow: 100_000 }];
      },
    });
    await run(harness, "First");
    await run(harness, "Second");
    const [, summaryCall, answer] = harness.provider.requests;
    expect(summaryCall?.messages.at(-1)).toEqual({ role: "user", content: text(COMPACTION_REQUEST) });
    expect(summaryCall?.messages.some((message) => JSON.stringify(message).includes("Second"))).toBe(false);
    expect(answer?.messages).toEqual([
      { role: "user", content: text(`${COMPACTION_PREFIX}Summary of one.`) },
      { role: "user", content: text("Second") },
    ]);
    // The window is looked up once and remembered.
    expect(lookups).toBe(1);
  });

  it("does not compact early when the window is unknown or the ratio is off", async () => {
    const unknown = await setup([textReply("One.", { inputTokens: 1_000_000, outputTokens: 5 }), textReply("Two.")]);
    await run(unknown, "First");
    await run(unknown, "Second");
    expect(unknown.provider.requests).toHaveLength(2);

    const off = await setup([textReply("One.", { inputTokens: 85_000, outputTokens: 5 }), textReply("Two.")], { loop: { compactAtContextRatio: 0 } });
    Object.assign(off.provider, { listModels: async () => [{ id: "test-model", contextWindow: 100_000 }] });
    await run(off, "First");
    await run(off, "Second");
    expect(off.provider.requests).toHaveLength(2);

    // A small context is never compacted, so its window is not even looked up.
    const small = await setup([textReply("One."), textReply("Two.")]);
    let lookups = 0;
    Object.assign(small.provider, { listModels: async () => { lookups += 1; return [{ id: "test-model", contextWindow: 100 }]; } });
    await run(small, "First");
    await run(small, "Second");
    expect(small.provider.requests).toHaveLength(2);
    expect(lookups).toBe(0);
  });

  it("clips the history further when even the summary request is too long", async () => {
    const tooLong = errorReply({ kind: "context-length", message: "too long", status: 400, retryable: false });
    const huge = "x".repeat(50_000);
    const harness = await setup([
      toolReply([{ id: "call-1", name: "echo", args: { text: huge } }]),
      tooLong,
      tooLong,
      textReply("Summary."),
      textReply("Done."),
    ]);
    await run(harness, "Go");
    const [, , verbatim, clipped, retry] = harness.provider.requests;
    const size = (request: typeof verbatim) => JSON.stringify(request?.messages ?? []).length;
    expect(size(verbatim)).toBeGreaterThan(100_000);
    expect(size(clipped)).toBeLessThan(30_000);
    expect(JSON.stringify(clipped?.messages)).toContain("characters omitted");
    expect(retry?.messages).toEqual([{ role: "user", content: text(`${COMPACTION_PREFIX}Summary.`) }]);
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "done" });
  });

  it("shrinks long text, tool arguments and images for a summary, but not the model's own text", () => {
    const long = "a".repeat(5_000);
    const shrunk = shrinkForSummary([
      { role: "user", content: [{ type: "text", text: long }, { type: "image", mimeType: "image/png", data: "AAAA" }] },
      { role: "assistant", content: [{ type: "text", text: long }, { type: "tool-call", id: "c", name: "write", arguments: { path: "a.ts", content: long, edits: [{ newText: long }] } }] },
      { role: "tool-result", callId: "c", content: [{ type: "text", text: "short" }], isError: false },
    ], 1_000);
    expect(shrunk[0]?.content).toEqual([
      { type: "text", text: `${"a".repeat(500)}\n[… 4000 characters omitted …]\n${"a".repeat(500)}` },
      { type: "text", text: "[image omitted]" },
    ]);
    const assistant = shrunk[1]?.content;
    expect(assistant?.[0]).toEqual({ type: "text", text: long });
    expect(JSON.stringify(assistant?.[1]).length).toBeLessThan(3_000);
    expect(assistant?.[1]).toMatchObject({ type: "tool-call", arguments: { path: "a.ts" } });
    expect(shrunk[2]?.content).toEqual([{ type: "text", text: "short" }]);
  });

  it("stops after the turn limit", async () => {
    const harness = await setup([
      toolReply([{ id: "call-1", name: "echo", args: { text: "a" } }]),
      toolReply([{ id: "call-2", name: "echo", args: { text: "b" } }]),
    ], { loop: { maxTurns: 2 } });
    await run(harness, "Loop");
    expect(harness.deltas.at(-1)).toEqual({ type: "agent-end", outcome: "max-turns" });
    expect(harness.provider.remaining).toBe(0);
  });

  it("fires the lifecycle events in order", async () => {
    const harness = await setup([toolReply([{ id: "call-1", name: "echo", args: { text: "a" } }]), textReply("Done.")]);
    const seen: string[] = [];
    harness.ctx.on("agent/before-start", () => void seen.push("before-start"));
    harness.ctx.on("agent/turn-start", (_session, turn) => void seen.push(`turn-start ${turn}`));
    harness.ctx.on("agent/turn-end", (_session, turn) => void seen.push(`turn-end ${turn}`));
    harness.ctx.on("agent/settled", async (_session, outcome) => void seen.push(`settled ${outcome}`));
    harness.ctx.on("tools/pre-execute", (call) => (call.name === "echo" ? { deny: true, reason: "not today" } : undefined));
    await run(harness, "Go");
    expect(seen).toEqual(["before-start", "turn-start 1", "turn-end 1", "turn-start 2", "turn-end 2", "settled done"]);
    const result = harness.session.events.find((event) => event.type === "tool-result");
    expect(result?.data).toMatchObject({ isError: true, content: text("Denied: not today") });
  });
});
