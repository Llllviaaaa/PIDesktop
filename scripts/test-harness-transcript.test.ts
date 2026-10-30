// The Harness Host's session logs as the transcript's messages, and its live
// progress as transcript events (src/lib/transcript.ts, src/lib/hostSessions.ts),
// checked against the agent loop's golden logs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PersistedEvent } from "@pid/protocol";
import { effortForLevel, forkPointsOf, sessionTreeOf } from "../src/lib/hostSessions";
import { TranscriptTranslator, currentBranch, historyToUi, planWidgetLines } from "../src/lib/transcript";

const golden = (name: string): PersistedEvent[] => readFileSync(join(import.meta.dirname, "..", "packages", "agent-loop", "test", "golden", `${name}.jsonl`), "utf8")
  .trim()
  .split("\n")
  .map((line) => ({ ...JSON.parse(line), ts: "2026-10-29T00:00:00.000Z" }));

describe("session logs as transcript messages", () => {
  it("map users, and assistants with their tool calls and results", () => {
    const messages = historyToUi(golden("parallel-tools"));
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages[0]).toMatchObject({ role: "user", content: "Echo twice", entryId: "2", timestamp: Date.parse("2026-10-29T00:00:00.000Z") });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "Let me check.", model: "test-model", usage: { input: 10, output: 5, totalTokens: 15 }, isError: false });
    expect(messages[1].toolCalls?.map((call) => [call.id, call.name, call.args, call.running, call.isError])).toEqual([
      ["call-1", "echo", { text: "one" }, false, false],
      ["call-2", "echo", { text: "two" }, false, false],
      ["call-3", "missing", {}, false, true],
    ]);
  });

  it("show compactions, errors and aborts", () => {
    const compacted = historyToUi(golden("context-length"));
    expect(compacted.map((message) => message.role)).toEqual(["user", "notice", "assistant"]);
    expect(compacted[1]).toMatchObject({ noticeKind: "compaction" });
    expect(historyToUi(golden("provider-error"))[1]).toMatchObject({ role: "assistant", isError: true, content: "bad key" });
    expect(historyToUi(golden("abort-stream"))[1]).toMatchObject({ isError: true, content: "Partial" });
  });

  it("follow rewinds", () => {
    const events: PersistedEvent[] = [
      { seq: 1, ts: "t", type: "user", data: { content: [{ type: "text", text: "a" }] } },
      { seq: 2, ts: "t", type: "user", data: { content: [{ type: "text", text: "b" }] } },
      { seq: 3, ts: "t", type: "rewind", data: { toSeq: 1 } },
      { seq: 4, ts: "t", type: "user", data: { content: [{ type: "text", text: "c" }] } },
    ];
    expect(currentBranch(events).map((event) => event.seq)).toEqual([1, 4]);
  });
});

describe("live progress as transcript events", () => {
  it("streams a run with a tool call", () => {
    const translator = new TranscriptTranslator();
    const events = [
      ...translator.delta({ type: "agent-start" }),
      ...translator.delta({ type: "llm-start", provider: "p", model: "m" }),
      ...translator.delta({ type: "llm-chunk", chunk: { type: "text-delta", index: 0, text: "Reading" } }),
      ...translator.delta({ type: "llm-chunk", chunk: { type: "tool-call-start", index: 1, id: "c1", name: "read" } }),
      ...translator.delta({ type: "llm-chunk", chunk: { type: "tool-call-delta", index: 1, argumentsDelta: "{\"path\":" } }),
      ...translator.delta({ type: "llm-chunk", chunk: { type: "tool-call-delta", index: 1, argumentsDelta: "\"a.ts\"}" } }),
      ...translator.delta({ type: "llm-chunk", chunk: { type: "finish", reason: "tool-use" } }),
      ...translator.event({ seq: 3, ts: "t", type: "tool-call", data: { callId: "c1", name: "read", args: { path: "a.ts" } } }),
      ...translator.event({ seq: 4, ts: "t", type: "tool-result", data: { callId: "c1", name: "read", content: [{ type: "text", text: "x" }], isError: false } }),
      ...translator.delta({ type: "agent-end", outcome: "done" }),
    ];
    expect(events.map((event) => event.type)).toEqual([
      "turn-start", "assistant-start", "assistant-delta", "assistant-tool-calls", "tool-start", "tool-end", "turn-end",
    ]);
    expect(events.find((event) => event.type === "assistant-tool-calls")).toMatchObject({ calls: [{ id: "c1", name: "read", args: { path: "a.ts" }, running: true }] });
    expect(events.find((event) => event.type === "tool-end")).toMatchObject({ callId: "c1", result: { text: "x", isError: false } });
  });

  it("shows the plan as the plan widget's lines, the queue as counts, and maps thinking levels", () => {
    const translator = new TranscriptTranslator();
    const plan = { items: [{ text: "Read", status: "completed" }, { text: "Fix", status: "in_progress" }] };
    expect(translator.delta({ type: "plan", plan })).toEqual([{ type: "plan", lines: ["计划 1/2", "[x] Read", "[>] Fix"] }]);
    expect(planWidgetLines({ items: [] })).toEqual([]);
    expect(translator.delta({ type: "queue", steer: 2, followUp: 0 })).toEqual([{ type: "queue", steering: 2, followUp: 0 }]);
    expect(["off", "minimal", "medium", "xhigh"].map(effortForLevel)).toEqual(["off", "low", "medium", "high"]);
  });
});

describe("fork points and the session tree", () => {
  const events: PersistedEvent[] = [
    { seq: 1, ts: "t", type: "model", data: { provider: "p", model: "m" } },
    { seq: 2, ts: "t", type: "user", data: { content: [{ type: "text", text: "first" }] } },
    { seq: 3, ts: "t", type: "assistant", data: { content: [{ type: "text", text: "A" }] } },
    { seq: 4, ts: "t", type: "user", data: { content: [{ type: "text", text: "second" }] } },
    { seq: 5, ts: "t", type: "assistant", data: { content: [{ type: "text", text: "B" }] } },
    { seq: 6, ts: "t", type: "rewind", data: { toSeq: 3 } },
    { seq: 7, ts: "t", type: "user", data: { content: [{ type: "text", text: "again" }] } },
  ];

  it("offer the current branch's user messages as fork points", () => {
    expect(forkPointsOf(events)).toEqual([{ entryId: "2", text: "first" }, { entryId: "7", text: "again" }]);
  });

  it("keep rewound messages as a side branch of the tree", () => {
    const { tree, leafId } = sessionTreeOf(events);
    expect(leafId).toBe("7");
    const ids = (nodes: typeof tree): unknown[] => nodes.map((node) => [node.entry.id, ids(node.children)]);
    expect(ids(tree)).toEqual([["2", [["3", [["4", [["5", []]]], ["7", []]]]]]]);
    expect(tree[0]?.entry).toMatchObject({ type: "message", parentId: null, message: { role: "user" } });
  });
});
