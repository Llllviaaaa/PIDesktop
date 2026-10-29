// The Harness Host's session logs as the transcript's messages, and its live
// progress as the Pi events the store handles (src/lib/harnessTranscript.ts),
// checked against the agent loop's golden logs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PersistedEvent } from "@pid/protocol";
import { HarnessEventTranslator, currentBranch, effortForLevel, planWidgetLines, toAgentMessages } from "../src/lib/harnessTranscript";

const golden = (name: string): PersistedEvent[] => readFileSync(join(import.meta.dirname, "..", "packages", "agent-loop", "test", "golden", `${name}.jsonl`), "utf8")
  .trim()
  .split("\n")
  .map((line) => ({ ...JSON.parse(line), ts: "2026-10-29T00:00:00.000Z" }));

describe("session logs as transcript messages", () => {
  it("map users, assistants with tool calls, and tool results", () => {
    const messages = toAgentMessages(golden("parallel-tools"));
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "toolResult", "assistant"]);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      provider: "scripted",
      model: "test-model",
      stopReason: "toolUse",
      usage: { input: 10, output: 5, totalTokens: 15 },
      content: [
        { type: "text", text: "Let me check." },
        { type: "toolCall", id: "call-1", name: "echo", arguments: { text: "one" } },
        { type: "toolCall", id: "call-2", name: "echo", arguments: { text: "two" } },
        { type: "toolCall", id: "call-3", name: "missing", arguments: {} },
      ],
    });
    expect(messages[4]).toMatchObject({ role: "toolResult", toolCallId: "call-3", toolName: "missing", isError: true });
    expect(messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "Echo twice" }], timestamp: Date.parse("2026-10-29T00:00:00.000Z") });
  });

  it("show compactions, errors and aborts the way Pi's transcript does", () => {
    expect(toAgentMessages(golden("context-length")).map((message) => message.role)).toEqual(["user", "compactionSummary", "assistant"]);
    expect(toAgentMessages(golden("provider-error"))[1]).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "bad key", content: [] });
    expect(toAgentMessages(golden("abort-stream"))[1]).toMatchObject({ stopReason: "aborted", content: [{ type: "text", text: "Partial" }] });
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

describe("live progress as Pi events", () => {
  it("streams a run with a tool call", () => {
    const translator = new HarnessEventTranslator(() => ({ provider: "p", model: "m" }));
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
    expect(events.map((event) => (event.type === "message_update" ? `update:${event.assistantMessageEvent.type}` : event.type))).toEqual([
      "agent_start", "message_start", "update:text_delta", "update:toolcall_end", "tool_execution_start", "tool_execution_end", "message_end", "agent_end", "agent_settled",
    ]);
    const toolCall = events.find((event) => event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end");
    expect(toolCall).toMatchObject({ assistantMessageEvent: { toolCall: { id: "c1", name: "read", arguments: { path: "a.ts" } } } });
  });

  it("shows the plan as Pi's plan widget and maps thinking levels", () => {
    const translator = new HarnessEventTranslator(() => undefined);
    const plan = { items: [{ text: "Read", status: "completed" }, { text: "Fix", status: "in_progress" }] };
    expect(translator.delta({ type: "plan", plan })).toEqual([
      { type: "extension_ui_request", id: "harness-plan", method: "setWidget", widgetKey: "pidesktop-plan", widgetLines: ["计划 1/2", "[x] Read", "[>] Fix"] },
    ]);
    expect(planWidgetLines({ items: [] })).toEqual([]);
    expect(translator.delta({ type: "queue", steer: 2, followUp: 0 })).toEqual([{ type: "queue_update", steering: ["", ""], followUp: [] }]);
    expect(["off", "minimal", "medium", "xhigh"].map(effortForLevel)).toEqual(["off", "low", "medium", "high"]);
  });
});
