import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import {
  COMPACTION_PREFIX,
  INTERRUPTED_TOOL_RESULT,
  Sessions,
  compactionPoint,
  currentBranch,
  deriveState,
  forkEvents,
  summarize,
  uuidv7,
  type SessionEvent,
} from "../src/index.ts";

let seq = 0;
function ev<T extends SessionEvent["type"]>(type: T, data: Extract<SessionEvent, { type: T }>["data"]): SessionEvent {
  seq += 1;
  return { seq, ts: "t", type, data } as SessionEvent;
}
const text = (value: string) => [{ type: "text" as const, text: value }];
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const model = { provider: "p", model: "m" };
const assistant = (content: Extract<SessionEvent, { type: "assistant" }>["data"]["content"]) =>
  ev("assistant", { content, model, usage, stop: "stop" });

function log(build: () => SessionEvent[]): SessionEvent[] {
  seq = 0;
  return build();
}

describe("derivation", () => {
  it("follows rewinds to the current branch", () => {
    const events = log(() => [
      ev("user", { content: text("a") }),       // 1
      assistant(text("A")),                       // 2
      ev("user", { content: text("b") }),       // 3
      assistant(text("B")),                       // 4
      ev("rewind", { toSeq: 2 }),                 // 5
      ev("user", { content: text("c") }),       // 6
    ]);
    expect(currentBranch(events).map((event) => event.seq)).toEqual([1, 2, 6]);
    expect(deriveState(events).messages).toEqual([
      { role: "user", content: text("a") },
      { role: "assistant", content: text("A") },
      { role: "user", content: text("c") },
    ]);
  });

  it("replaces compacted events with the summary", () => {
    const events = log(() => [
      ev("model", model),
      ev("user", { content: text("old") }),
      assistant(text("OLD")),
      ev("user", { content: text("new") }),
      ev("compaction", { throughSeq: 3, summary: "S" }),
      assistant(text("NEW")),
    ]);
    const state = deriveState(events);
    expect(state.model).toEqual(model);
    expect(state.compactedThrough).toBe(5);
    expect(state.messages).toEqual([
      { role: "user", content: text(`${COMPACTION_PREFIX}S`) },
      { role: "user", content: text("new") },
      { role: "assistant", content: text("NEW") },
    ]);
  });

  it("closes tool calls that never got a result and skips empty replies", () => {
    const events = log(() => [
      ev("user", { content: text("go") }),
      assistant([{ type: "tool-call", id: "c1", name: "read", arguments: {} }]),
      ev("tool-call", { callId: "c1", name: "read", args: {} }),
      assistant([]),
      ev("tool-result", { callId: "stray", name: "x", content: text("ignored"), isError: false }),
    ]);
    expect(deriveState(events).messages).toEqual([
      { role: "user", content: text("go") },
      { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", arguments: {} }] },
      { role: "tool-result", callId: "c1", content: text(INTERRUPTED_TOOL_RESULT), isError: true },
    ]);
  });

  it("tracks effort, title and archive labels", () => {
    const state = deriveState(log(() => [
      ev("effort", { effort: "high" }),
      ev("label", { title: "T" }),
      ev("label", { archived: true }),
    ]));
    expect(state).toMatchObject({ effort: "high", title: "T", archived: true });
  });

  it("forks the branch renumbered, moving compaction points", () => {
    const events = log(() => [
      ev("user", { content: text("x") }),        // 1
      assistant(text("dropped")),                  // 2
      ev("rewind", { toSeq: 1 }),                  // 3
      assistant(text("kept")),                     // 4
      ev("compaction", { throughSeq: 4, summary: "S" }), // 5
      ev("user", { content: text("y") }),        // 6
    ]);
    const forked = forkEvents(events, 5);
    expect(forked.map((event) => [event.seq, event.type])).toEqual([[1, "user"], [2, "assistant"], [3, "compaction"]]);
    expect(forked[2]?.data).toEqual({ throughSeq: 2, summary: "S" });
  });

  it("finds the compaction point", () => {
    const events = log(() => [
      ev("model", model),
      ev("user", { content: text("1") }),
      assistant(text("A")),
      ev("user", { content: text("2") }),
      assistant(text("B")),
    ]);
    expect(compactionPoint(events)).toBe(5);
    expect(compactionPoint(events, true)).toBe(3);
    expect(compactionPoint(events.slice(0, 3), true)).toBe(3);
  });
});

describe("summaries", () => {
  it("count messages and tokens across rewinds and clip the first message", () => {
    const events = log(() => [
      ev("user", { content: text(`  first

 line ${"x".repeat(300)}`) }),
      ev("assistant", { content: text("A"), model, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 }, stop: "stop" }),
      ev("rewind", { toSeq: 1 }),
      ev("assistant", { content: text("B"), model, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 3 }, stop: "stop" }),
    ]);
    const summary = summarize({ format: "pid.session", version: 1, id: "s", createdAt: "c", cwd: "/w" }, events);
    expect(summary.firstMessage).toBe(`first line ${"x".repeat(189)}`);
    expect(summary.messageCount).toBe(3);
    expect(summary.usage).toEqual({ inputTokens: 11, outputTokens: 6, cacheReadTokens: 2, cacheWriteTokens: 3 });
  });
});

describe("sessions service", () => {
  it("appends, emits and forks", async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    const seen: number[] = [];
    ctx.on("session/event", (_session, event) => void seen.push(event.seq));
    const session = ctx.sessions.create({ cwd: "/w" });
    session.append("user", { content: text("hi") });
    session.append("label", { title: "Greeting" });
    expect(seen).toEqual([1, 2]);
    expect(session.summary()).toMatchObject({ id: session.id, cwd: "/w", title: "Greeting", firstMessage: "hi", lastSeq: 2, archived: false, messageCount: 1 });

    const fork = ctx.sessions.fork(session, 1);
    expect(fork.header.forkedFrom).toEqual({ sessionId: session.id, seq: 1 });
    expect(fork.events.map((event) => event.type)).toEqual(["user"]);
    expect(await ctx.sessions.get(fork.id)).toBe(fork);
    expect((await ctx.sessions.list()).map((summary) => summary.id).sort()).toEqual([session.id, fork.id].sort());
    expect(await ctx.sessions.get("nope")).toBeUndefined();
    await ctx.fiber.dispose();
  });

  it("numbers live deltas apart from events", async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    const session = ctx.sessions.create({ cwd: "/w" });
    const live: number[] = [];
    ctx.on("session/delta", (_session, liveSeq) => void live.push(liveSeq));
    session.delta({ type: "a" });
    session.delta({ type: "b" });
    expect(live).toEqual([1, 2]);
    expect(session.lastSeq).toBe(0);
    await ctx.fiber.dispose();
  });

  it("makes time-ordered v7 ids", () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
