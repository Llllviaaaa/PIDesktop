import type { AppSettings, ModelInfo } from "../types";

export type ThinkingSettingsSlice = Pick<
  AppSettings,
  "provider" | "model" | "thinkingLevel" | "customThinkingLevels" | "modelThinkingLevels" | "modelCustomThinkingLevels"
>;

export function modelThinkingKey(provider: string, modelId: string): string {
  return `${provider.trim()}/${modelId.trim()}`;
}

export const THINKING_LABELS: Record<string, string> = {
  off: "关闭",
  none: "无",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  auto: "自动",
};

export const STANDARD_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
] as const;

/** Default ladder for reasoning models before a model or runtime declares a narrower/wider list. */
const DEFAULT_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high"];

const EFFORT_LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const VALID_LEVEL_RE = /^[a-zA-Z0-9._:-]{1,48}$/;

export function normalizeThinkingLevelId(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || !VALID_LEVEL_RE.test(trimmed)) return null;
  return trimmed;
}

export function thinkingLabel(level: string): string {
  const known = THINKING_LABELS[level];
  if (known !== undefined) return known;
  const budgetMatch = /^budget:(\d+k?)$/i.exec(level.trim());
  if (budgetMatch?.[1]) return `预算 ${budgetMatch[1]}`;
  return level;
}

export function mergeThinkingLevels(base: readonly string[], custom?: readonly string[] | null): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of base) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  if (result.some((lvl) => lvl !== "off") && custom && custom.length > 0) {
    for (const raw of custom) {
      const normalized = normalizeThinkingLevelId(raw);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

/**
 * Levels the picker should offer for the current model.
 *
 * - Per-model `model.thinkingLevels` (from `/models` discovery, `providers.json`, or family inference) wins first.
 * - Otherwise runtime-reported `reported` list wins, while a bare `["off"]` means non-reasoning → `[]`.
 * - When neither is present yet, derive from `model.reasoning`.
 * - User-defined `customLevels` are appended whenever the model supports reasoning.
 */
export function resolveThinkingLevels(
  reported: readonly string[],
  model: ModelInfo | null | undefined,
  customLevels?: readonly string[] | null,
): string[] {
  if (model?.thinkingLevels && model.thinkingLevels.length > 0) {
    const withOff = model.thinkingLevels.includes("off")
      ? [...model.thinkingLevels]
      : ["off", ...model.thinkingLevels];
    if (!withOff.some((level) => level !== "off")) return [];
    return mergeThinkingLevels(withOff, customLevels);
  }
  if (reported.length) {
    return reported.some((level) => level !== "off")
      ? mergeThinkingLevels(reported, customLevels)
      : [];
  }
  return model?.reasoning ? mergeThinkingLevels(DEFAULT_REASONING_LEVELS, customLevels) : [];
}

/** The level to display, or null when the stored one is not selectable for this model. */
export function effectiveThinkingLevel(current: string, levels: readonly string[]): string | null {
  return levels.includes(current) ? current : null;
}

/**
 * Resolve `raw` against `available` levels: returns `raw` directly when supported,
 * or steps smoothly to the nearest supported reasoning tier when switching to a
 * model with a narrower effort ladder (e.g. `"max"` -> `"high"`).
 */
export function fallbackThinkingLevel(raw: string | null | undefined, available: readonly string[]): string | null {
  if (!raw || available.length === 0) return null;
  if (available.includes(raw)) return raw;
  const normalized = raw.trim().toLowerCase();
  if (available.includes(normalized)) return normalized;
  const index = EFFORT_LADDER.indexOf(normalized as (typeof EFFORT_LADDER)[number]);
  if (index > 0) {
    for (let down = index - 1; down >= 1; down -= 1) {
      const candidate = EFFORT_LADDER[down];
      if (candidate && available.includes(candidate)) return candidate;
    }
    for (let up = index + 1; up < EFFORT_LADDER.length; up += 1) {
      const candidate = EFFORT_LADDER[up];
      if (candidate && available.includes(candidate)) return candidate;
    }
  }
  for (const fallback of ["high", "medium", "low", "minimal"]) {
    if (available.includes(fallback)) return fallback;
  }
  return available.find((lvl) => lvl !== "off") ?? null;
}

function sanitizeCustomLevelList(rawList: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of rawList) {
    const normalized = normalizeThinkingLevelId(raw);
    if (!normalized || normalized === "off" || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Custom thinking levels defined specifically for `provider/model`.
 * Falls back to legacy global `customThinkingLevels` ONLY for the currently configured default model
 * before that model has its own entry in `modelCustomThinkingLevels`, so custom tiers never leak across models.
 */
export function customThinkingLevelsForModel(
  settings: Partial<ThinkingSettingsSlice> | null | undefined,
  provider?: string | null,
  modelId?: string | null,
): string[] {
  const p = provider?.trim();
  const m = modelId?.trim();
  if (!settings || !p || !m) return [];
  const key = modelThinkingKey(p, m);
  const perModel = settings.modelCustomThinkingLevels?.[key];
  if (Array.isArray(perModel)) {
    return sanitizeCustomLevelList(perModel);
  }
  if (
    settings.provider === p
    && settings.model === m
    && Array.isArray(settings.customThinkingLevels)
    && settings.customThinkingLevels.length > 0
  ) {
    return sanitizeCustomLevelList(settings.customThinkingLevels);
  }
  return [];
}

/**
 * Preferred thinking level for a specific model (`provider/model`), respecting:
 * 1. Non-reasoning models -> `"off"`
 * 2. Per-model user preference in `settings.modelThinkingLevels[provider/model]`
 * 3. Model's own `thinkingLevel` from `providers.json` or catalog
 * 4. Legacy `settings.thinkingLevel` when `provider/model` matches `settings.provider/model`
 * 5. Nearest supported default (`"medium"`)
 */
export function preferredThinkingLevelForModel(
  model: {
    provider?: string;
    id: string;
    reasoning?: boolean;
    thinkingLevel?: string | null;
    thinkingLevels?: readonly string[] | null;
  } | null | undefined,
  settings: Partial<ThinkingSettingsSlice> | null | undefined,
  providerOverride?: string,
  reportedLevels: readonly string[] = [],
): string {
  if (!model || model.reasoning === false) return "off";
  const provider = (providerOverride ?? model.provider ?? "").trim();
  const custom = customThinkingLevelsForModel(settings, provider, model.id);
  const available = resolveThinkingLevels(
    reportedLevels,
    {
      id: model.id,
      name: model.id,
      provider,
      reasoning: model.reasoning ?? true,
      ...(model.thinkingLevels && model.thinkingLevels.length > 0 ? { thinkingLevels: [...model.thinkingLevels] } : {}),
    },
    custom,
  );
  if (available.length === 0) return "off";

  const saved = provider ? settings?.modelThinkingLevels?.[modelThinkingKey(provider, model.id)]?.trim() : undefined;
  if (saved) {
    return fallbackThinkingLevel(saved, available) ?? saved;
  }
  const modelDefault = model.thinkingLevel?.trim();
  if (modelDefault && modelDefault !== "off") {
    return fallbackThinkingLevel(modelDefault, available) ?? modelDefault;
  }
  if (provider && settings?.provider === provider && settings?.model === model.id && settings?.thinkingLevel?.trim()) {
    return fallbackThinkingLevel(settings.thinkingLevel, available) ?? "medium";
  }
  return fallbackThinkingLevel("medium", available) ?? "medium";
}

export function withModelThinkingLevel(
  settings: AppSettings,
  provider: string,
  modelId: string,
  level: string,
  alsoSetDefaultModel = false,
): AppSettings {
  const p = provider.trim();
  const m = modelId.trim();
  if (!p || !m) {
    return { ...settings, thinkingLevel: level };
  }
  const key = modelThinkingKey(p, m);
  const nextMap = { ...(settings.modelThinkingLevels ?? {}), [key]: level };
  const isDefaultModel = alsoSetDefaultModel || (settings.provider === p && settings.model === m);
  return {
    ...settings,
    ...(alsoSetDefaultModel ? { provider: p, model: m } : {}),
    ...(isDefaultModel ? { thinkingLevel: level } : {}),
    modelThinkingLevels: nextMap,
  };
}

export function withModelCustomThinkingLevels(
  settings: AppSettings,
  provider: string,
  modelId: string,
  levels: readonly string[],
): AppSettings {
  const p = provider.trim();
  const m = modelId.trim();
  if (!p || !m) return settings;
  const key = modelThinkingKey(p, m);
  const cleaned = sanitizeCustomLevelList(levels);
  const nextCustomMap = { ...(settings.modelCustomThinkingLevels ?? {}), [key]: cleaned };
  const clearLegacy = settings.provider === p && settings.model === m && (settings.customThinkingLevels?.length ?? 0) > 0;
  return {
    ...settings,
    ...(clearLegacy ? { customThinkingLevels: [] } : {}),
    modelCustomThinkingLevels: nextCustomMap,
  };
}
