import assert from "node:assert/strict";
import { computerFromResult } from "../src/lib/piMessages";
import { updateToolCall } from "../src/lib/piToolCalls";
import type { UiMessage } from "../src/types";

const base: UiMessage[] = [{ id: "assistant-1", role: "assistant", content: "", toolCalls: [] }];
const started = updateToolCall(base, "call-1", (call) => ({ ...call, running: true }), "read", { path: "a.ts" });
assert.equal(started[0].toolCalls?.[0].name, "read");
assert.equal(started[0].toolCalls?.[0].args.path, "a.ts");
assert.notEqual(started, base);

const finished = updateToolCall(started, "call-1", (call) => ({ ...call, running: false, result: "done" }));
assert.equal(finished[0].toolCalls?.length, 1);
assert.equal(finished[0].toolCalls?.[0].running, false);
assert.equal(finished[0].toolCalls?.[0].result, "done");

const computer = computerFromResult({
  content: [{ type: "image", data: "png", mimeType: "image/png" }],
  details: {
    action: "observe",
    width: 3000,
    height: 2000,
    left: -1000,
    top: 0,
    imageWidth: 1500,
    imageHeight: 1000,
    scaleX: 2,
    scaleY: 2,
    captureBackend: "gdi",
    frameId: "frame-1",
    stable: true,
    windowTitle: "Demo",
    elements: [{
      ref: "uia:1:42.1",
      role: "button",
      name: "Run",
      bounds: { x: 10, y: 20, width: 80, height: 24 },
      enabled: true,
      focused: false,
      focusable: true,
      patterns: ["invoke"],
    }],
  },
}, null);
assert.equal(computer?.width, 3000, "legacy desktop dimensions should remain available");
assert.equal(computer?.imageWidth, 1500, "scaled image dimensions should be retained");
assert.equal(computer?.elements?.[0]?.ref, "uia:1:42.1", "semantic element refs should be retained");
console.log("Pi tool-call reducer tests passed");
