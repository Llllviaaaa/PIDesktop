import assert from "node:assert/strict";
import {
  effectiveThinkingLevel,
  fallbackThinkingLevel,
  normalizeThinkingLevelId,
  resolveThinkingLevels,
  thinkingLabel,
} from "../src/lib/thinkingLevels";
import { inferModelThinkingLevels } from "../src/lib/modelProviders";
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

test("dynamic model thinkingLevels and user customThinkingLevels merge cleanly", () => {
  const dynamicModel: ModelInfo = {
    id: "grok-4.7",
    name: "Grok 4.7",
    provider: "xai",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
  };
  assert.deepEqual(
    resolveThinkingLevels(["off", "low", "medium", "high"], dynamicModel, ["ultra", "16384", "high"]),
    ["off", "low", "medium", "high", "xhigh", "ultra", "16384"],
  );
  // Custom levels never force a thinking selector onto a non-reasoning model.
  assert.deepEqual(resolveThinkingLevels(["off"], plainModel, ["ultra", "16384"]), []);
  assert.equal(normalizeThinkingLevelId("  XHigh "), "xhigh");
  assert.equal(normalizeThinkingLevelId("budget:32k"), "budget:32k");
  assert.equal(normalizeThinkingLevelId("bad value!"), null);
  assert.equal(fallbackThinkingLevel("max", ["off", "low", "medium", "high"]), "high");
  assert.equal(fallbackThinkingLevel("ultra", ["off", "low", "medium", "ultra"]), "ultra");
  assert.deepEqual(inferModelThinkingLevels("gpt-5.4", true), ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(inferModelThinkingLevels("gemini-2.5-pro", true), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "auto",
  ]);
});

test("a stored level outside the offered list is not displayed", () => {
  assert.equal(effectiveThinkingLevel("medium", []), null);
  assert.equal(effectiveThinkingLevel("xhigh", ["off", "high"]), null);
  assert.equal(effectiveThinkingLevel("high", ["off", "high"]), "high");
  assert.equal(thinkingLabel("medium"), "中");
  assert.equal(thinkingLabel("xhigh"), "极高");
  assert.equal(thinkingLabel("budget:16k"), "预算 16k");
  assert.equal(thinkingLabel("custom"), "custom");
});
