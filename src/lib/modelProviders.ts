import type { ProviderModelSummary, ProviderSummary } from "./harnessProviders";
import type { ModelInfo, ModelProviderModel, ModelThinkingLevel } from "../types";

export type ProviderGroupId = "connected" | "disconnected";

export interface ProviderGroup {
  id: ProviderGroupId;
  label: string;
  providers: ProviderSummary[];
}

export const PROVIDER_APIS = [
  ["openai-completions", "OpenAI Chat Completions"],
  ["openai-responses", "OpenAI Responses"],
  ["anthropic-messages", "Anthropic Messages"],
  ["google-generative-ai", "Google Generative AI (Gemini)"],
] as const;

export function requiresBaseUrl(api: string): boolean {
  return api === "" || api === "openai-completions";
}

export function defaultBaseUrlPlaceholder(api: string): string {
  switch (api) {
    case "openai-responses":
      return "默认 https://api.openai.com/v1（留空使用官方地址）";
    case "anthropic-messages":
      return "默认 https://api.anthropic.com（留空使用官方地址）";
    case "google-generative-ai":
      return "默认 https://generativelanguage.googleapis.com/v1beta（留空使用官方地址）";
    default:
      return "https://api.example.com/v1";
  }
}

export function modelKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/** Providers the user defined in the Host's providers.json, which the page can edit and delete. */
export function isCustomProvider(provider: ProviderSummary, configIds: ReadonlySet<string>): boolean {
  return configIds.has(provider.id);
}

export function groupProviders(providers: readonly ProviderSummary[], query = ""): ProviderGroup[] {
  const needle = query.trim().toLowerCase();
  const matches = (provider: ProviderSummary) => !needle
    || provider.name.toLowerCase().includes(needle)
    || provider.id.toLowerCase().includes(needle)
    || provider.models.some((model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle));
  const groups: Record<ProviderGroupId, ProviderSummary[]> = { connected: [], disconnected: [] };
  for (const provider of providers) {
    if (matches(provider)) groups[provider.configured ? "connected" : "disconnected"].push(provider);
  }
  const labels: Record<ProviderGroupId, string> = { connected: "已连接", disconnected: "未连接" };
  return (Object.keys(groups) as ProviderGroupId[])
    .filter((id) => groups[id].length > 0)
    .map((id) => ({ id, label: labels[id], providers: groups[id] }));
}

/** Short Chinese description of where a connected provider's credential comes from. */
export function credentialSourceText(provider: ProviderSummary): string {
  switch (provider.keySource) {
    case "stored":
      return "API 密钥 · 加密保存在本机";
    case "environment":
      return "环境变量中的密钥";
    default:
      return "未连接";
  }
}

/** Only a key saved here can be removed here; a `$VARIABLE` reference stays the user's. */
export function canDisconnect(provider: ProviderSummary): boolean {
  return provider.keySource === "stored";
}

export function formatTokenCount(value: number | null | undefined): string {
  if (!value) return "";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

export function formatCost(cost: { input: number; output: number } | null): string {
  if (!cost || (!cost.input && !cost.output)) return "";
  const price = (value: number) => `$${Number(value.toFixed(2))}`;
  return `${price(cost.input)} / ${price(cost.output)}`;
}

/** Full request URL Pi will call for a base URL, so users can catch a missing or doubled /v1. */
export function endpointPreview(api: string, baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) return "";
  switch (api) {
    case "openai-completions":
      return `${base}/chat/completions`;
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
      return `${base}/responses`;
    case "anthropic-messages":
      return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
    case "google-generative-ai":
      return `${base}/models/{model}:streamGenerateContent`;
    case "mistral-conversations":
      return `${base}/conversations`;
    default:
      return base;
  }
}

export function slugifyProviderId(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Hide models the user switched off, but never the model that is currently selected. */
export function filterHiddenModels(models: readonly ModelInfo[], hidden: readonly string[] | undefined, current: ModelInfo | null): ModelInfo[] {
  if (!hidden?.length) return [...models];
  const hiddenKeys = new Set(hidden);
  return models.filter((model) => !hiddenKeys.has(modelKey(model.provider, model.id))
    || (current !== null && current.provider === model.provider && current.id === model.id));
}

/** Stable hue per provider for the monogram avatar. */
export function providerHue(providerId: string): number {
  let hash = 0;
  for (const character of providerId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function providerMonogram(name: string): string {
  const letters = name.replace(/[^A-Za-z0-9一-鿿]/g, "");
  return (letters[0] ?? "?").toUpperCase();
}

/** Where a custom model's capabilities came from, shown so users know what to double-check. */
export type CapabilitySource = "api" | "catalog" | "guess" | "default";

export interface CatalogMatch {
  providerId: string;
  model: ProviderModelSummary;
}

export type ModelCatalog = ReadonlyMap<string, CatalogMatch>;

export interface EnrichedModel {
  model: ModelProviderModel;
  source: CapabilitySource;
  match?: CatalogMatch;
}

/** Defaults Pi uses for custom models that declare nothing. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

// Providers that publish their own models; their catalog entries win ties over resellers.
const FIRST_PARTY = new Set(["anthropic", "openai", "google", "xai", "deepseek", "mistral", "moonshotai", "zai", "minimax", "xiaomi", "qwen-token-plan"]);
const VARIANT_SUFFIX = /-(latest|preview|exp|experimental|high|medium|low|minimal|max|thinking|non-thinking|nothinking|think|instruct|chat|fast|turbo)$/;
const DATE_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$/;

/** Canonical form for comparing model IDs across providers and relays. */
export function normalizeModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^models\//, "")
    // keep the last path segment: "vendor/model" and "models/vendor/model" become "model"
    .replace(/^.*\//, "")
    .replace(/:[^:]*$/, "")
    .replace(/[._\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function catalogScore(entry: CatalogMatch): number {
  return (entry.model.contextWindow ? 2 : 0) + (entry.model.maxTokens ? 1 : 0) + (FIRST_PARTY.has(entry.providerId) ? 1 : 0);
}

/** Index the providers' model lists by normalized model ID, keeping the most complete entry per ID. */
export function buildModelCatalog(providers: readonly ProviderSummary[]): ModelCatalog {
  const catalog = new Map<string, CatalogMatch>();
  for (const provider of providers) {
    for (const model of provider.models) {
      const key = normalizeModelId(model.id);
      if (!key) continue;
      const entry = { providerId: provider.id, model };
      const current = catalog.get(key);
      if (!current || catalogScore(entry) > catalogScore(current)) catalog.set(key, entry);
    }
  }
  return catalog;
}

export function matchCatalogModel(catalog: ModelCatalog, modelId: string): CatalogMatch | undefined {
  let key = normalizeModelId(modelId);
  if (!key) return undefined;
  // Exact, then without date stamps and effort/variant suffixes relays append.
  for (let attempt = 0; attempt < 4; attempt++) {
    const found = catalog.get(key);
    if (found) return found;
    const shorter = key.replace(DATE_SUFFIX, "").replace(VARIANT_SUFFIX, "");
    if (shorter === key) break;
    key = shorter;
  }
  // Longest catalog ID that the requested ID extends at a "-" boundary, e.g. gpt-4o-mini-2024 → gpt-4o-mini.
  let best: CatalogMatch | undefined;
  let bestLength = 0;
  for (const [candidate, entry] of catalog) {
    if (candidate.length > bestLength && candidate.length >= 5 && /\d/.test(candidate) && key.startsWith(`${candidate}-`)) {
      best = entry;
      bestLength = candidate.length;
    }
  }
  return best;
}

export interface GuessedModelProfile {
  reasoning: boolean;
  image: boolean;
  contextWindow: number | null;
  maxTokens: number | null;
  thinkingLevel: ModelThinkingLevel;
}

function detectExplicitEffortSuffix(normalizedId: string): ModelThinkingLevel | null {
  if (/-(non-thinking|nothinking)$/.test(normalizedId)) return "off";
  if (/-(minimal|low)$/.test(normalizedId)) return "low";
  if (/-medium$/.test(normalizedId)) return "medium";
  if (/-(high|xhigh)$/.test(normalizedId)) return "high";
  if (/-max$/.test(normalizedId)) return "max";
  return null;
}

/** Rich capability & limit heuristics for 2025–2026 mainstream models when catalog has no match. */
export function guessModelProfile(modelId: string): GuessedModelProfile {
  const id = normalizeModelId(modelId);
  const suffixEffort = detectExplicitEffortSuffix(id);

  let reasoning = /(^|-)(o[134]|r1|qwq|qvq|reasoner|reasoning|thinking|think)(-|$)/.test(id)
    || /^(gpt-5|claude-(opus|sonnet|haiku)-4|claude-3-7|gemini-(2-5|[3-9])|grok-(3-mini|[4-9])|deepseek-(r|v3-[1-9])|qwen3|glm-4-[5-9]|glm-[5-9]|kimi-k2-thinking|kimi-thinking|minimax-m[1-9]|doubao-(seed|1-5-thinking))/.test(id);
  if (suffixEffort === "off") reasoning = false;
  else if (suffixEffort !== null) reasoning = true;

  // Note: o3-mini / o1-mini are text-only, whereas o3 / o4-mini / gpt-5 / gpt-4.1 / gpt-4o / claude / gemini support vision.
  const isTextOnlyOReasoning = /^o[13]-mini(-|$)/.test(id);
  const image = !isTextOnlyOReasoning && (
    /(^|-)(vision|vl|omni|4o|llava|pixtral|minicpm-v|gpt-4-1|gpt-5|qvq)(-|$)/.test(id)
    || /^(o3|o4-mini|claude|gemini|grok-(2-vision|[4-9])|llama-4|qwen[\d-]*vl|glm-[\d-]*v|kimi-thinking|kimi-k2-thinking|doubao-seed)/.test(id)
  );

  let contextWindow: number | null = null;
  let maxTokens: number | null = null;

  if (/^gemini-(1-5|2|3)/.test(id)) {
    contextWindow = 1_048_576;
    maxTokens = /^gemini-(2-5|[3-9])/.test(id) ? 65_536 : 8_192;
  } else if (/^gpt-4-1/.test(id)) {
    contextWindow = 1_000_000;
    maxTokens = 32_768;
  } else if (/^minimax-m1/.test(id)) {
    contextWindow = 1_000_000;
    maxTokens = 32_768;
  } else if (/^gpt-5/.test(id)) {
    contextWindow = 400_000;
    maxTokens = 32_768;
  } else if (/^(kimi-k2|grok-4|doubao-(seed|1-5))/.test(id)) {
    contextWindow = 256_000;
    maxTokens = 32_768;
  } else if (/^(claude-|o[134](-|$)|minimax-m2)/.test(id)) {
    contextWindow = 200_000;
    maxTokens = /^(o[134]|claude-(opus|sonnet)-4)/.test(id) ? 32_768 : 16_384;
  } else if (/^(deepseek-(r1|reasoner|v3|chat)|qwen3|qwq|glm-4-[5-9]|glm-[5-9]|grok-3)/.test(id)) {
    contextWindow = 128_000;
    maxTokens = reasoning ? 16_384 : 8_192;
  }

  let thinkingLevel: ModelThinkingLevel = "off";
  if (reasoning) {
    if (suffixEffort && suffixEffort !== "off") {
      thinkingLevel = suffixEffort;
    } else if (/^(o3($|-pro)|claude-opus-4|gemini-(2-5-pro|3)|deepseek-(r1|reasoner)|grok-4|kimi.*thinking)/.test(id)) {
      thinkingLevel = "high";
    } else if (/^(claude-haiku-4|gemini-2-5-flash-lite)/.test(id)) {
      thinkingLevel = "low";
    } else {
      thinkingLevel = "medium";
    }
  }

  return { reasoning, image, contextWindow, maxTokens, thinkingLevel };
}

/** Name-based guesses in the spirit of other clients; only used when the catalog has no match. */
export function guessCapabilities(modelId: string): { reasoning: boolean; image: boolean } {
  const { reasoning, image } = guessModelProfile(modelId);
  return { reasoning, image };
}

/**
 * Fill a custom model's capabilities: explicit API metadata first, then Pi's builtin catalog,
 * then name-based guesses, then Pi's custom-model defaults.
 */
export function enrichModel(model: ModelProviderModel, catalog: ModelCatalog): EnrichedModel {
  const hasImage = model.input.includes("image");
  const fromApi = Boolean(model.contextWindow || model.maxTokens || model.reasoning || hasImage);
  const match = matchCatalogModel(catalog, model.id);
  const profile = guessModelProfile(model.id);
  // A catalog match is authoritative; name-based guesses only fill in when there is none.
  const known = match
    ? {
        reasoning: match.model.reasoning,
        image: match.model.input.includes("image"),
        contextWindow: match.model.contextWindow,
        maxTokens: match.model.maxTokens,
        thinkingLevel: match.model.thinkingLevel ?? null,
      }
    : profile;
  const suffixEffort = detectExplicitEffortSuffix(normalizeModelId(model.id));
  const reasoning = suffixEffort === "off"
    ? false
    : (model.reasoning || known.reasoning || suffixEffort !== null);
  const image = hasImage || known.image;
  const contextWindow = model.contextWindow || known.contextWindow || DEFAULT_CONTEXT_WINDOW;
  const maxTokens = model.maxTokens || known.maxTokens || DEFAULT_MAX_TOKENS;
  const thinkingLevel: ModelThinkingLevel = !reasoning
    ? "off"
    : (model.thinkingLevel && model.thinkingLevel !== "off")
      ? model.thinkingLevel
      : (suffixEffort && suffixEffort !== "off")
        ? suffixEffort
        : (known.thinkingLevel && known.thinkingLevel !== "off")
          ? known.thinkingLevel
          : profile.thinkingLevel !== "off"
            ? profile.thinkingLevel
            : "medium";
  const hasProfileGuess = Boolean(profile.reasoning || profile.image || profile.contextWindow);
  const source: CapabilitySource = fromApi && model.contextWindow ? "api"
    : match ? "catalog"
      : hasProfileGuess ? "guess" : "default";
  return {
    model: {
      ...model,
      reasoning,
      thinkingLevel,
      input: image ? ["text", "image"] : ["text"],
      contextWindow,
      maxTokens,
      ...(model.cost ? { cost: model.cost } : match?.model.cost ? { cost: { ...match.model.cost } } : {}),
    },
    source,
    match,
  };
}
