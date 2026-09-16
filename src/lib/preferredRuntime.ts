import type { AppSettings, ModelInfo } from "../types";

export function preferredModelFromSettings(
  settings: AppSettings | null | undefined,
  catalog: ModelInfo[] = [],
): ModelInfo | null {
  const modelId = settings?.model?.trim() ?? "";
  if (!modelId) return null;
  const provider = settings?.provider?.trim() ?? "";
  const byProvider = provider
    ? catalog.find((model) => model.id === modelId && model.provider === provider)
    : undefined;
  return byProvider ?? catalog.find((model) => model.id === modelId) ?? null;
}

export function settingsWithPreferredModel(settings: AppSettings, model: ModelInfo): AppSettings {
  if (settings.provider === model.provider && settings.model === model.id) return settings;
  return { ...settings, provider: model.provider, model: model.id };
}

export function settingsWithPreferredThinking(settings: AppSettings, thinkingLevel: string): AppSettings {
  const level = thinkingLevel.trim();
  if (!level || settings.thinkingLevel === level) return settings;
  return { ...settings, thinkingLevel: level };
}

export function shouldApplyPreferredModel(
  current: ModelInfo | null | undefined,
  preferred: ModelInfo | null | undefined,
): preferred is ModelInfo {
  if (!preferred) return false;
  return !current || current.provider !== preferred.provider || current.id !== preferred.id;
}

export function shouldApplyPreferredThinking(
  current: string | null | undefined,
  preferred: string | null | undefined,
): preferred is string {
  const level = preferred?.trim() ?? "";
  if (!level) return false;
  return (current ?? "") !== level;
}
