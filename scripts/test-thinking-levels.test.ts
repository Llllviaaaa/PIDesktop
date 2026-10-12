import assert from "node:assert/strict";
import { effectiveThinkingLevel, resolveThinkingLevels, thinkingLabel } from "../src/lib/thinkingLevels";
import type { ModelInfo } from "../src/types";
import { test } from "vitest";

const reasoningModel: ModelInfo = { id: "claude-opus", name: "Claude Opus", provider: "anthropic", reasoning: true };
const plainModel: ModelInfo = { id: "grok-4.5", name: "Grok 4.5", provider: "grok", reasoning: false };

test("thinking levels follow Pi's list and hide for non-reasoning models", () => {
  assert.deepEqual(resolveThinkingLevels(["off", "low", "high"], plainModel), ["off", "low", "high"]);
  assert.deepEqual(resolveThinkingLevels(["off"], reasoningModel), []);
  assert.deepEqual(resolveThinkingLevels([], plainModel), []);
  assert.deepEqual(resolveThinkingLevels([], null), []);
  assert.deepEqual(resolveThinkingLevels([], reasoningModel), ["off", "minimal", "low", "medium", "high"]);
});

test("a stored level outside the offered list is not displayed", () => {
  assert.equal(effectiveThinkingLevel("medium", []), null);
  assert.equal(effectiveThinkingLevel("xhigh", ["off", "high"]), null);
  assert.equal(effectiveThinkingLevel("high", ["off", "high"]), "high");
  assert.equal(thinkingLabel("medium"), "中");
  assert.equal(thinkingLabel("custom"), "custom");
});
