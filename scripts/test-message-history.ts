/**
 * Guards the long-session conversion path against quadratic tool-result lookup.
 * Run: npx --yes tsx scripts/test-message-history.ts
 */
import { attachForkPointsToUi, messagesToUi } from "../src/lib/piMessages.ts";
import { usePiStore } from "../src/store.ts";
import type { AgentMessage, ForkPoint, SessionMessageTiming, UiMessage } from "../src/types.ts";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const messageCount = 5_000;
const history: AgentMessage[] = [];

for (let index = 0; index < messageCount; index += 1) {
  history.push({
    role: "assistant",
    provider: "test",
    model: "test-model",
    stopReason: "toolUse",
    timestamp: index + 1,
    content: [
      { type: "text", text: `message-${index}` },
      { type: "toolCall", id: `call-${index}`, name: "read", arguments: { index } },
    ],
  });
}

// Results arrive after all calls, which is the worst case for reverse scanning.
for (let index = 0; index < messageCount; index += 1) {
  history.push({
    role: "toolResult",
    toolCallId: `call-${index}`,
    toolName: "read",
    content: [{ type: "text", text: `result-${index}` }],
    isError: false,
    timestamp: messageCount + index + 1,
  });
}

const startedAt = performance.now();
const converted = messagesToUi(history);
const elapsedMs = performance.now() - startedAt;

assert(converted.length === messageCount, `expected ${messageCount} UI messages, got ${converted.length}`);
assert(converted[0].toolCalls?.[0].result === "result-0", "first tool result was not attached");
assert(converted[0].toolCalls?.[0].startedAt === 1, "tool start time was not restored");
assert(converted[0].toolCalls?.[0].finishedAt === messageCount + 1, "tool finish time was not restored");
assert(
  converted[messageCount - 1].toolCalls?.[0].result === `result-${messageCount - 1}`,
  "last tool result was not attached",
);
assert(elapsedMs < 1_500, `long-session conversion took ${elapsedMs.toFixed(1)}ms`);

const timedHistory: AgentMessage[] = [
  { role: "user", content: "test", timestamp: 10 },
  {
    role: "assistant",
    provider: "test",
    model: "test-model",
    stopReason: "stop",
    timestamp: 11,
    content: [{ type: "thinking", thinking: "done" }, { type: "text", text: "ok" }],
  },
];
const timings: SessionMessageTiming[] = [
  { role: "user", messageTimestamp: 10, entryTimestamp: "2026-08-17T01:00:00.000Z" },
  { role: "assistant", messageTimestamp: 11, entryTimestamp: "2026-08-17T01:00:13.000Z" },
];
assert(messagesToUi(timedHistory, timings)[1].durationMs === 13_000, "session duration was not restored");

const repeatedMessages: UiMessage[] = [
  { id: "user-1", role: "user", content: "repeat", timestamp: 1 },
  { id: "assistant-1", role: "assistant", content: "first", timestamp: 2 },
  { id: "user-2", role: "user", content: "repeat", timestamp: 3 },
];
const repeatedPoints: ForkPoint[] = [
  { entryId: "entry-1", text: "repeat" },
  { entryId: "entry-2", text: "repeat" },
];
const hydrated = attachForkPointsToUi(repeatedMessages, repeatedPoints);
assert(hydrated[0].entryId === "entry-1", "first repeated message did not keep its fork identity");
assert(hydrated[2].entryId === "entry-2", "second repeated message did not keep its fork identity");

// Pi 0.84 RPC omits the cumulative message from message_update and sends deltas only.
Object.assign(globalThis, { window: globalThis });
const streamingMessage = {
  role: "assistant" as const,
  provider: "test",
  model: "test-model",
  stopReason: "pending" as const,
  timestamp: Date.now(),
  content: [],
};
usePiStore.setState({ runtimeId: "stream-test", messages: [], isStreaming: true });
usePiStore.getState().handleEvent("stream-test", { type: "message_start", message: streamingMessage });
usePiStore.getState().handleEvent("stream-test", {
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello " },
});
usePiStore.getState().handleEvent("stream-test", {
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "stream" },
});
await new Promise((resolve) => setTimeout(resolve, 50));
assert(usePiStore.getState().messages.at(-1)?.content === "Hello stream", "delta-only RPC updates were not streamed");

usePiStore.getState().handleEvent("stream-test", {
  type: "message_update",
  assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "Reasoning " },
});
usePiStore.getState().handleEvent("stream-test", {
  type: "message_update",
  assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "stream" },
});
await new Promise((resolve) => setTimeout(resolve, 50));
assert(
  usePiStore.getState().messages.at(-1)?.thinking === "Reasoning stream",
  "thinking deltas were not streamed",
);

usePiStore.getState().handleEvent("stream-test", {
  type: "message_end",
  message: {
    ...streamingMessage,
    stopReason: "stop",
    content: [
      { type: "text", text: "Hello stream" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
    ],
  },
});
assert(
  usePiStore.getState().messages.at(-1)?.thinking === "Reasoning stream",
  "message_end without thinking blocks dropped streamed thinking",
);

usePiStore.setState({ runtimeId: "stream-test", messages: [], isStreaming: true });
usePiStore.getState().handleEvent("stream-test", { type: "message_start", message: streamingMessage });
usePiStore.getState().handleEvent("stream-test", {
  type: "message_update",
  assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Final thought" },
});
await new Promise((resolve) => setTimeout(resolve, 50));
assert(
  usePiStore.getState().messages.at(-1)?.thinking === "Final thought",
  "thinking_end content was not applied",
);

console.log(`message-history: ${messageCount} messages converted in ${elapsedMs.toFixed(1)}ms; text/thinking streaming passed`);
