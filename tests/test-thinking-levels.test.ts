import assert from "node:assert/strict";
import {
  customThinkingLevelsForModel,
  effectiveThinkingLevel,
  fallbackThinkingLevel,
  normalizeThinkingLevelId,
  preferredThinkingLevelForModel,
  resolveThinkingLevels,
  thinkingLabel,
  withModelCustomThinkingLevels,
  withModelThinkingLevel,
} from "../src/lib/thinkingLevels";
import { inferModelThinkingLevels } from "../src/lib/modelProviders";
import type { AppSettings, ModelInfo } from "../src/types";
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

test("thinking levels and custom tiers stay isolated per provider/model", () => {
  const baseSettings = {
    provider: "sub2api",
    model: "grok-4.7",
    thinkingLevel: "medium",
    customThinkingLevels: ["legacy-tier"],
  } as AppSettings;

  // Legacy customThinkingLevels only fall back on the matching default model, never leaking to other models.
  assert.deepEqual(customThinkingLevelsForModel(baseSettings, "sub2api", "grok-4.7"), ["legacy-tier"]);
  assert.deepEqual(customThinkingLevelsForModel(baseSettings, "openai", "o4-mini"), []);

  const withGrokCustom = withModelCustomThinkingLevels(baseSettings, "sub2api", "grok-4.7", ["ultra", "16384"]);
  assert.deepEqual(customThinkingLevelsForModel(withGrokCustom, "sub2api", "grok-4.7"), ["ultra", "16384"]);
  assert.deepEqual(customThinkingLevelsForModel(withGrokCustom, "openai", "o4-mini"), []);
  assert.deepEqual(withGrokCustom.customThinkingLevels, []);

  const withLevels = withModelThinkingLevel(
    withModelThinkingLevel(withGrokCustom, "sub2api", "grok-4.7", "ultra"),
    "openai",
    "o4-mini",
    "low",
  );
  // Default model's thinkingLevel stays synced with sub2api/grok-4.7, while openai/o4-mini keeps its own "low".
  assert.equal(withLevels.thinkingLevel, "ultra");
  assert.equal(
    preferredThinkingLevelForModel(
      { id: "grok-4.7", reasoning: true },
      withLevels,
      "sub2api",
      inferModelThinkingLevels("grok-4.7", true),
    ),
    "ultra",
  );
  assert.equal(
    preferredThinkingLevelForModel(
      { id: "o4-mini", reasoning: true },
      withLevels,
      "openai",
      inferModelThinkingLevels("o4-mini", true),
    ),
    "low",
  );
  assert.equal(
    preferredThinkingLevelForModel(
      { id: "gpt-4.1", reasoning: false },
      withLevels,
      "openai",
      inferModelThinkingLevels("gpt-4.1", false),
    ),
    "off",
  );
});
