import assert from "node:assert/strict";
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
console.log("Pi tool-call reducer tests passed");
