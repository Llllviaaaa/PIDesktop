import type { ProviderModelSummary, ProviderSummary } from "./providerService";
import type { ModelInfo, ModelProviderModel } from "../types";

export type ProviderGroupId = "connected" | "subscription" | "apiKey" | "custom";

export interface ProviderGroup {
  id: ProviderGroupId;
  label: string;
  providers: ProviderSummary[];
}

export const PROVIDER_APIS = [
  ["openai-completions", "OpenAI Chat Completions"],
  ["openai-responses", "OpenAI Responses"],
  ["anthropic-messages", "Anthropic Messages"],
  ["google-generative-ai", "Google Generative AI"],
  ["mistral-conversations", "Mistral Conversations"],
  ["azure-openai-responses", "Azure OpenAI Responses"],
  ["openai-codex-responses", "OpenAI Codex Responses"],
  ["google-vertex", "Google Vertex AI"],
  ["bedrock-converse-stream", "Amazon Bedrock Converse"],
] as const;

export function modelKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/** Providers defined by the user in models.json rather than shipped with Pi. */
export function isCustomProvider(provider: ProviderSummary, modelsJsonIds: ReadonlySet<string>): boolean {
  return !provider.builtin && modelsJsonIds.has(provider.id);
}

export function groupProviders(
  providers: readonly ProviderSummary[],
  modelsJsonIds: ReadonlySet<string>,
  query = "",
): ProviderGroup[] {
  const needle = query.trim().toLowerCase();
  const matches = (provider: ProviderSummary) => !needle
    || provider.name.toLowerCase().includes(needle)
    || provider.id.toLowerCase().includes(needle)
    || provider.models.some((model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle));
  const groups: Record<ProviderGroupId, ProviderSummary[]> = { connected: [], subscription: [], apiKey: [], custom: [] };
  for (const provider of providers) {
    if (!matches(provider)) continue;
    if (provider.configured) groups.connected.push(provider);
    else if (isCustomProvider(provider, modelsJsonIds) || !provider.builtin) groups.custom.push(provider);
    else if (provider.oauthMethod) groups.subscription.push(provider);
    else groups.apiKey.push(provider);
  }
  const labels: Record<ProviderGroupId, string> = { connected: "已连接", subscription: "订阅登录", apiKey: "API 密钥", custom: "本地与自定义" };
  return (Object.keys(groups) as ProviderGroupId[])
    .filter((id) => groups[id].length > 0)
    .map((id) => ({ id, label: labels[id], providers: groups[id] }));
}

/** Short Chinese description of where a connected provider's credential comes from. */
export function credentialSourceText(provider: ProviderSummary): string {
  if (!provider.configured) return "未连接";
  switch (provider.source) {
    case "stored":
      return provider.authType === "oauth" ? "订阅账号登录" : "API 密钥 · 保存在 auth.json";
    case "environment":
      return provider.sourceLabel ? `环境变量 ${provider.sourceLabel}` : "环境变量";
    case "models_json_key":
      return "models.json 中的密钥";
    case "models_json_command":
      return "models.json 中的命令";
    case "runtime":
      return "运行时密钥";
    case "fallback":
      return "无需密钥";
    default:
      return provider.sourceLabel || "已连接";
  }
}

/** Only credentials saved by login can be removed from here; env vars and models.json stay user-owned. */
export function canDisconnect(provider: ProviderSummary): boolean {
  return provider.configured && provider.source === "stored";
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
    .split("/")
    .pop()!
    .replace(/:[^:]*$/, "")
    .replace(/[._\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function catalogScore(entry: CatalogMatch): number {
  return (entry.model.contextWindow ? 2 : 0) + (entry.model.maxTokens ? 1 : 0) + (FIRST_PARTY.has(entry.providerId) ? 1 : 0);
}

/** Index Pi's builtin catalogs by normalized model ID, keeping the most complete entry per ID. */
export function buildModelCatalog(providers: readonly ProviderSummary[]): ModelCatalog {
  const catalog = new Map<string, CatalogMatch>();
  for (const provider of providers) {
    if (!provider.builtin) continue;
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

/** Name-based guesses in the spirit of other clients; only used when the catalog has no match. */
export function guessCapabilities(modelId: string): { reasoning: boolean; image: boolean } {
  const id = normalizeModelId(modelId);
  const reasoning = /(^|-)(o[134]|r1|qwq|reasoner|reasoning|thinking|think)(-|$)/.test(id)
    || /^(gpt-5|claude-(opus|sonnet)-4|claude-3-7|gemini-(2-5|[3-9])|grok-(3-mini|[4-9])|deepseek-(r|v3-[1-9])|qwen3|glm-4-[5-9]|glm-[5-9]|kimi-k2|minimax-m[1-9])/.test(id);
  const image = /(^|-)(vision|vl|omni|4o|llava|pixtral|minicpm-v|gpt-4-1|gpt-5)(-|$)/.test(id)
    || /^(claude|gemini|grok-(2-vision|4)|llama-4|qwen[\d-]*vl|glm-[\d-]*v)/.test(id);
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
  const guess = match ? null : guessCapabilities(model.id);
  const reasoning = model.reasoning || (match ? match.model.reasoning : guess!.reasoning);
  const image = hasImage || (match ? match.model.input.includes("image") : guess!.image);
  const contextWindow = model.contextWindow || match?.model.contextWindow || DEFAULT_CONTEXT_WINDOW;
  const maxTokens = model.maxTokens || match?.model.maxTokens || DEFAULT_MAX_TOKENS;
  const source: CapabilitySource = fromApi && model.contextWindow ? "api"
    : match ? "catalog"
      : guess!.reasoning || guess!.image ? "guess" : "default";
  return {
    model: { ...model, reasoning, input: image ? ["text", "image"] : ["text"], contextWindow, maxTokens },
    source,
    match,
  };
}
