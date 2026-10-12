import type { ModelInfo } from "../types";

export const THINKING_LABELS: Record<string, string> = {
  off: "关闭",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

/** Pi's default ladder for reasoning models; used before a runtime has reported its own list. */
const DEFAULT_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high"];

export function thinkingLabel(level: string): string {
  return THINKING_LABELS[level] || level;
}

/**
 * Levels the picker should offer for the current model.
 *
 * - Pi's reported list wins, but a bare `["off"]` means the model cannot reason → nothing to pick.
 * - No list yet (new-task page, no runtime) → derive from the model's `reasoning` flag.
 * - An empty result hides the thinking control entirely.
 */
export function resolveThinkingLevels(reported: readonly string[], model: ModelInfo | null | undefined): string[] {
  if (reported.length) return reported.some((level) => level !== "off") ? [...reported] : [];
  return model?.reasoning ? [...DEFAULT_REASONING_LEVELS] : [];
}

/** The level to display, or null when the stored one is not selectable for this model. */
export function effectiveThinkingLevel(current: string, levels: readonly string[]): string | null {
  return levels.includes(current) ? current : null;
}
