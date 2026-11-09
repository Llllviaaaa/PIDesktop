import type { ModelInfo } from "../types";

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
