import { describeError } from "../../lib/errors";
import { harnessProviders, type ProviderSummary } from "../../lib/harnessProviders";
import {
  formatTokenCount,
  inferModelThinkingLevels,
  type CapabilitySource,
  type EnrichedModel,
} from "../../lib/modelProviders";
import {
  customThinkingLevelsForModel,
  mergeThinkingLevels,
  preferredThinkingLevelForModel,
  thinkingLabel,
} from "../../lib/thinkingLevels";
import type { BuiltinProviderPreset } from "../ProviderBrandIcon";
import type {
  AppSettings,
  ModelProviderConfig,
  ModelProviderInput,
  ModelThinkingLevel,
} from "../../types";

export type Update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

export interface CheckState {
  providerId: string;
  status: "checking" | "ok" | "error";
  message: string;
}

export type Notice = { kind: "success" | "error"; text: string } | null;

export type AccordionEntry =
  | { kind: "provider"; id: string; provider: ProviderSummary; presetMeta?: BuiltinProviderPreset }
  | { kind: "preset"; id: string; preset: BuiltinProviderPreset };

export const ALL_THINKING_LABELS: Record<string, string> = {
  off: "关",
  none: "无",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  auto: "自动",
};

export const MODEL_THINKING_OPTIONS: ReadonlyArray<readonly [ModelThinkingLevel, string]> = [
  ["off", "不支持思考"],
  ["minimal", "思考 · 最少"],
  ["low", "思考 · 低"],
  ["medium", "思考 · 中"],
  ["high", "思考 · 高"],
  ["xhigh", "思考 · 极高"],
  ["max", "思考 · 最高"],
  ["auto", "思考 · 自动"],
];

export const CONTEXT_WINDOW_PRESETS: ReadonlyArray<readonly [number, string]> = [
  [32_768, "32K"],
  [65_536, "64K"],
  [128_000, "128K"],
  [131_072, "128K (131K)"],
  [200_000, "200K"],
  [256_000, "256K"],
  [400_000, "400K"],
  [1_000_000, "1M"],
  [1_048_576, "1M (1048K)"],
];

export function errorText(error: unknown): string {
  return describeError(error);
}

export function effectiveModelThinking(reasoning: boolean, level?: ModelThinkingLevel | null): ModelThinkingLevel {
  if (!reasoning) return "off";
  if (level && level !== "off") return level;
  return "medium";
}

export function modelTraitBadges(
  reasoning: boolean,
  thinkingLevel: ModelThinkingLevel | null | undefined,
  input: readonly string[],
  contextWindow: number | null | undefined,
): Array<{ key: string; label: string; tone: "ctx" | "think" | "vision" }> {
  const badges: Array<{ key: string; label: string; tone: "ctx" | "think" | "vision" }> = [];
  const ctx = formatTokenCount(contextWindow ?? null);
  if (ctx) badges.push({ key: "ctx", label: `上下文 ${ctx}`, tone: "ctx" });
  if (reasoning) {
    const lvl = effectiveModelThinking(reasoning, thinkingLevel);
    const shortLabel = ALL_THINKING_LABELS[lvl] ?? thinkingLabel(lvl);
    badges.push({ key: "think", label: `思考·${shortLabel}`, tone: "think" });
  }
  if (input.includes("image")) {
    badges.push({ key: "vision", label: "支持图片", tone: "vision" });
  }
  return badges;
}

export async function checkProviderWithElapsed(providerId: string): Promise<{ ok: boolean; message: string }> {
  const started = performance.now();
  const result = await harnessProviders.check(providerId);
  const elapsedSec = ((performance.now() - started) / 1000).toFixed(1);
  return {
    ok: result.ok,
    message: result.ok ? `${result.message} · ${elapsedSec}s` : result.message,
  };
}

export function emptyDraft(): ModelProviderInput {
  return {
    originalId: null,
    id: "",
    name: "",
    baseUrl: "",
    api: "openai-completions",
    apiKey: "",
    keepExistingApiKey: false,
    authHeader: false,
    models: [],
  };
}

export function draftFromConfig(config: ModelProviderConfig, form?: AppSettings): ModelProviderInput {
  return {
    originalId: config.id,
    id: config.id,
    name: config.name === config.id ? "" : config.name,
    baseUrl: config.baseUrl,
    api: config.api || "openai-completions",
    apiKey: "",
    keepExistingApiKey: config.hasApiKey,
    authHeader: config.authHeader,
    models: config.models.map((model) => {
      const resolvedThinking = model.reasoning && form
        ? preferredThinkingLevelForModel(model, form, config.id, inferModelThinkingLevels(model.id, true))
        : model.thinkingLevel;
      const extraCustom = model.reasoning && form
        ? customThinkingLevelsForModel(form, config.id, model.id)
        : [];
      const mergedLevels = model.thinkingLevels && model.thinkingLevels.length > 0
        ? mergeThinkingLevels(model.thinkingLevels, extraCustom)
        : model.thinkingLevels;
      return {
        ...model,
        ...(resolvedThinking ? { thinkingLevel: resolvedThinking } : {}),
        ...(mergedLevels ? { thinkingLevels: mergedLevels } : {}),
        input: [...model.input],
      };
    }),
  };
}

const SOURCE_LABELS: Record<Exclude<CapabilitySource, "api">, { label: string; hint: string }> = {
  catalog: { label: "内置目录", hint: "能力和上下文来自内置目录中的同名模型" },
  guess: { label: "按名称推测", hint: "能力按模型名称自动识别" },
  default: { label: "默认值", hint: "使用默认参数，可点击详情修改" },
};

export function CapabilitySourceTag({ entry }: { entry: EnrichedModel | undefined }) {
  if (!entry || entry.source === "api") return null;
  const { label, hint } = SOURCE_LABELS[entry.source];
  const title = entry.match ? `${hint}：${entry.match.providerId}/${entry.match.model.id}` : hint;
  return <em className={`models-source ${entry.source}`} title={title}>{label}</em>;
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`settings-switch models-switch ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
