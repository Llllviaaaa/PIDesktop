/**
 * Model metadata as the desktop shows it (re-used by harnessRuntime.ts): a
 * Host `model.list` entry with the reasoning profile and thinking levels
 * filled in where the provider does not report them.
 */
import type { ModelListResult, ProviderListResult } from "@qianji/protocol";
import type { ModelInfo } from "../types";
import { HARNESS_THINKING_LEVELS } from "./hostSessions";
import { guessModelProfile, inferModelThinkingLevels } from "./modelProviders";

/** The thinking levels to offer for `model`; undefined means no model is chosen yet, null none at all. */
export function thinkingLevelsFor(model?: ModelInfo | null): string[] {
  if (model === undefined) return [...HARNESS_THINKING_LEVELS];
  if (model === null) return [];
  if (model.thinkingLevels && model.thinkingLevels.length > 0) {
    return model.thinkingLevels.includes("off")
      ? [...model.thinkingLevels]
      : ["off", ...model.thinkingLevels];
  }
  if (model.reasoning === false) return ["off"];
  if (model.reasoning === true) return inferModelThinkingLevels(model.id, true);
  const inferred = inferModelThinkingLevels(model.id);
  return inferred.length > 0 ? inferred : ["off"];
}

/** One `model.list` entry of `provider` as ModelInfo. */
export function toModelInfo(provider: ProviderListResult["providers"][number], model: ModelListResult["models"][number]): ModelInfo {
  const inferredProfile = model.reasoning === undefined ? guessModelProfile(model.id) : null;
  const reasoning = model.reasoning ?? (inferredProfile?.reasoning ? true : undefined);
  const thinkingLevel = model.thinkingLevel ?? (reasoning ? inferredProfile?.thinkingLevel : undefined);
  const rawLevels = model.thinkingLevels && model.thinkingLevels.length > 0
    ? model.thinkingLevels
    : reasoning
      ? inferModelThinkingLevels(model.id, true)
      : undefined;
  const thinkingLevels = rawLevels && thinkingLevel && thinkingLevel !== "off" && !rawLevels.includes(thinkingLevel)
    ? [...rawLevels, thinkingLevel]
    : rawLevels;
  return {
    id: model.id,
    name: model.name ?? model.id,
    provider: provider.id,
    api: provider.api,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(thinkingLevels === undefined || thinkingLevels.length === 0 ? {} : { thinkingLevels }),
    ...(model.input === undefined ? {} : { input: model.input }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxOutputTokens === undefined ? {} : { maxTokens: model.maxOutputTokens }),
    ...(model.cost === undefined ? {} : { cost: { ...model.cost } }),
  };
}
