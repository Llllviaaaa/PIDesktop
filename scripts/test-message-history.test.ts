/**
 * The transcript from a Host session log and from live events
 * (src/lib/transcript.ts): long logs stay linear, durations come from the
 * log, and streamed text and thinking reach the store.
 * Run: npx vitest run test-message-history.test.ts
 */
import type { PersistedEvent } from "@pid/protocol";
import { historyToUi } from "../src/lib/transcript.ts";
import { useAppStore } from "../src/store/index.ts";
import { test } from "vitest";

const at = (ms: number) => new Date(ms).toISOString();

test("message history", async () => {
  function assert(condition: unknown, message: string): void {
    if (!condition) throw new Error(message);
  }

  const messageCount = 5_000;
  const log: PersistedEvent[] = [];
  let seq = 0;
  for (let index = 0; index < messageCount; index += 1) {
    log.push({
      seq: ++seq,
      ts: at(index + 1),
      type: "assistant",
      data: {
        content: [
          { type: "text", text: `message-${index}` },
          { type: "tool-call", id: `call-${index}`, name: "read", arguments: { index } },
        ],
        model: { provider: "test", model: "test-model" },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stop: "tool-use",
      },
    });
  }
  // Results arrive after all calls, which is the worst case for scanning.
  for (let index = 0; index < messageCount; index += 1) {
    log.push({ seq: ++seq, ts: at(messageCount + index + 1), type: "tool-result", data: { callId: `call-${index}`, name: "read", content: [{ type: "text", text: `result-${index}` }], isError: false } });
  }

  const startedAt = performance.now();
  const converted = historyToUi(log);
  const elapsedMs = performance.now() - startedAt;

  assert(converted.length === messageCount, `expected ${messageCount} UI messages, got ${converted.length}`);
  assert(converted[0].toolCalls?.[0].result === "result-0", "first tool result was not attached");
  assert(converted[0].toolCalls?.[0].startedAt === 1, "tool start time was not restored");
  assert(converted[0].toolCalls?.[0].finishedAt === messageCount + 1, "tool finish time was not restored");
  assert(converted[messageCount - 1].toolCalls?.[0].result === `result-${messageCount - 1}`, "last tool result was not attached");
  assert(elapsedMs < 1_500, `long-session conversion took ${elapsedMs.toFixed(1)}ms`);

  // A reply's duration runs from the user message that started its turn; its seq is the fork point.
  const timed = historyToUi([
    { seq: 1, ts: "2026-08-17T01:00:00.000Z", type: "user", data: { content: [{ type: "text", text: "test" }] } },
    { seq: 2, ts: "2026-08-17T01:00:13.000Z", type: "assistant", data: { content: [{ type: "thinking", text: "done" }, { type: "text", text: "ok" }], model: { provider: "test", model: "m" }, usage: {}, stop: "stop" } },
  ]);
  assert(timed[1].durationMs === 13_000, "session duration was not restored");
  assert(timed[0].entryId === "1", "a user message did not carry its fork point");
  assert(timed[1].thinking === "done", "thinking was not restored");

  // Streamed deltas reach the store, coalesced.
  Object.assign(globalThis, { window: globalThis });
  useAppStore.setState({ runtimeId: "stream-test", messages: [], isStreaming: true });
  const handle = useAppStore.getState().handleEvent;
  handle("stream-test", { type: "assistant-start" });
  handle("stream-test", { type: "assistant-delta", text: "Hello ", thinking: "" });
  handle("stream-test", { type: "assistant-delta", text: "stream", thinking: "" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(useAppStore.getState().messages.at(-1)?.content === "Hello stream", "text deltas were not streamed");

  handle("stream-test", { type: "assistant-delta", text: "", thinking: "Reasoning " });
  handle("stream-test", { type: "assistant-delta", text: "", thinking: "stream" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(useAppStore.getState().messages.at(-1)?.thinking === "Reasoning stream", "thinking deltas were not streamed");

  // The finished reply replaces the streamed one; thinking it did not repeat is kept.
  handle("stream-test", {
    type: "assistant",
    message: { id: "host-9", role: "assistant", content: "Hello stream", isStreaming: false, timestamp: 1, toolCalls: [{ id: "call-1", name: "read", args: { path: "README.md" }, running: false }] },
  });
  const finished = useAppStore.getState().messages;
  assert(finished.length === 1, "the finished reply was added beside the streamed one");
  assert(finished[0].thinking === "Reasoning stream", "a finished reply without thinking dropped the streamed thinking");
  assert(finished[0].isStreaming === false && finished[0].toolCalls?.[0]?.name === "read", "the finished reply was not applied");

  console.log(`message-history: ${messageCount} messages converted in ${elapsedMs.toFixed(1)}ms; streaming passed`);
});
