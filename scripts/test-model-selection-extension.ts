import assert from "node:assert/strict";
import modelGuard from "../src-tauri/resources/pidesktop-guard.ts";

type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;

const handlers = new Map<string, Handler>();
const messages: Array<{
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
}> = [];

modelGuard({
  on(event: string, handler: Handler) {
    handlers.set(event, handler);
  },
  sendMessage(message: (typeof messages)[number]) {
    messages.push(message);
  },
} as never);

const modelSelect = handlers.get("model_select");
assert.ok(modelSelect, "model_select handler should be registered");

await modelSelect({
  source: "restore",
  model: { provider: "example", id: "old-model", name: "Old Model" },
}, {});
assert.equal(messages.length, 0, "restoring a session must not add model metadata");

await modelSelect({
  source: "set",
  model: { provider: "google", id: "gemini-test", name: "Gemini Test" },
}, {});

assert.equal(messages.length, 1);
assert.equal(messages[0].customType, "pidesktop-model-selection");
assert.equal(messages[0].display, false, "runtime metadata must stay hidden in the transcript");
assert.match(messages[0].content, /google/);
assert.match(messages[0].content, /gemini-test/);

console.log("model-selection-extension: all assertions passed");
