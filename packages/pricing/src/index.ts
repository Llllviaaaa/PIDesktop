/**
 * Local token pricing catalog and session cost estimator (`@pid/pricing`).
 *
 * Prices are expressed in USD per 1,000,000 tokens (`input`, `output`,
 * `cacheRead`, `cacheWrite`). Custom model prices configured in `providers.json`
 * take precedence over the built-in catalog. Note that `reasoningTokens` are a
 * subset of `outputTokens` across OpenAI, Anthropic, Gemini, and DeepSeek, so
 * cost calculation bills `outputTokens` once at the output rate.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import type { LlmResponseInfo, ModelPricing, Usage } from "@pid/llm";
import type { SessionSummary } from "@pid/session";

declare module "@deepseek-ai/cordis" {
  interface Context {
    pricing: Pricing;
  }

  interface Events {
    "pricing/recorded"(record: PricingCallRecord): void;
  }
}

export interface PricingCallRecord {
  provider: string;
  model: string;
  usage: Usage;
  costUsd: number;
}

export interface PricingConfig {
  /** Optional provider-level custom model pricing supplier (e.g. from `providers.json`). */
  customPricing?: (provider: string, model: string) => ModelPricing | undefined;
}

/** Built-in USD rates per 1M tokens for common frontier & coding models. */
export const BUILTIN_MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  // OpenAI GPT-5 / GPT-4.1 / GPT-4o / o-series
  "gpt-5-4": { input: 2.5, output: 15, cacheRead: 0.25 },
  "gpt-5-2": { input: 1.75, output: 14, cacheRead: 0.175 },
  "gpt-5-1": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005 },
  "gpt-4-1": { input: 2, output: 8, cacheRead: 0.5 },
  "gpt-4-1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1 },
  "gpt-4-1-nano": { input: 0.1, output: 0.4, cacheRead: 0.025 },
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075 },
  "o3": { input: 2, output: 8, cacheRead: 0.5 },
  "o3-mini": { input: 1.1, output: 4.4, cacheRead: 0.55 },
  "o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.275 },
  "o1": { input: 15, output: 60, cacheRead: 7.5 },
  "o1-mini": { input: 1.1, output: 4.4, cacheRead: 0.55 },

  // Anthropic Claude 4.x / 3.x
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-7-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-5-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },

  // Google Gemini 3.x / 2.5 / 2.0
  "gemini-3-1-pro": { input: 2, output: 12, cacheRead: 0.2 },
  "gemini-3-pro": { input: 2, output: 12, cacheRead: 0.2 },
  "gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05 },
  "gemini-2-5-pro": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gemini-2-5-flash": { input: 0.3, output: 2.5, cacheRead: 0.03 },
  "gemini-2-5-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.01 },
  "gemini-2-0-flash": { input: 0.1, output: 0.4, cacheRead: 0.025 },

  // DeepSeek / Qwen / GLM / Kimi
  "deepseek-chat": { input: 0.27, output: 1.1, cacheRead: 0.07 },
  "deepseek-v3": { input: 0.27, output: 1.1, cacheRead: 0.07 },
  "deepseek-reasoner": { input: 0.55, output: 2.19, cacheRead: 0.14 },
  "deepseek-r1": { input: 0.55, output: 2.19, cacheRead: 0.14 },
  "qwen3-coder-plus": { input: 1, output: 4, cacheRead: 0.2 },
  "kimi-k2": { input: 0.6, output: 2.5, cacheRead: 0.15 },
  "glm-4-5": { input: 0.6, output: 2.2, cacheRead: 0.11 },
};

const DATE_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$/;
const VARIANT_SUFFIX = /-(latest|preview|exp|experimental|high|medium|low|minimal|max|thinking|non-thinking|nothinking|instruct|turbo)$/;

export function normalizePricingModelId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^models\//, "")
    .replace(/^.*\//, "")
    .replace(/:[^:]*$/, "")
    .replace(/[._\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function lookupBuiltinPricing(modelId: string): ModelPricing | undefined {
  let key = normalizePricingModelId(modelId);
  if (key === "") return undefined;
  for (let step = 0; step < 4; step += 1) {
    const exact = BUILTIN_MODEL_PRICING[key];
    if (exact !== undefined) return exact;
    const stripped = key.replace(DATE_SUFFIX, "").replace(VARIANT_SUFFIX, "");
    if (stripped === key) break;
    key = stripped;
  }
  let bestKey = "";
  let bestPrice: ModelPricing | undefined;
  for (const [candidate, price] of Object.entries(BUILTIN_MODEL_PRICING)) {
    if (candidate.length > bestKey.length && key.startsWith(`${candidate}-`)) {
      bestKey = candidate;
      bestPrice = price;
    }
  }
  return bestPrice;
}

export function estimateUsageCost(usage: Usage, pricing: ModelPricing | undefined): number {
  if (pricing === undefined) return 0;
  const cacheReadRate = pricing.cacheRead ?? pricing.input * 0.1;
  const cacheWriteRate = pricing.cacheWrite ?? pricing.input * 1.25;
  const totalMillion =
    usage.inputTokens * pricing.input
    + usage.outputTokens * pricing.output
    + usage.cacheReadTokens * cacheReadRate
    + usage.cacheWriteTokens * cacheWriteRate;
  return Math.max(0, totalMillion / 1_000_000);
}

export class Pricing extends Service {
  private customLookup: ((provider: string, model: string) => ModelPricing | undefined) | undefined;
  private liveTotalUsd = 0;

  constructor(ctx: Context, config: PricingConfig = {}) {
    super(ctx, "pricing");
    this.customLookup = config.customPricing;

    ctx.on("llm/response", (response: LlmResponseInfo) => {
      const costUsd = this.estimateCallCost(response.provider, response.model, response.usage);
      this.liveTotalUsd += costUsd;
      if (costUsd > 0) {
        ctx.emit("pricing/recorded", {
          provider: response.provider,
          model: response.model,
          usage: { ...response.usage },
          costUsd,
        });
      }
    });
  }

  setCustomPricing(lookup: ((provider: string, model: string) => ModelPricing | undefined) | undefined): void {
    this.customLookup = lookup;
  }

  resolvePricing(provider: string, model: string): ModelPricing | undefined {
    const custom = this.customLookup?.(provider, model);
    if (custom !== undefined) return custom;
    return lookupBuiltinPricing(model);
  }

  estimateCallCost(provider: string, model: string, usage: Usage): number {
    return estimateUsageCost(usage, this.resolvePricing(provider, model));
  }

  estimateSessionCost(summary: SessionSummary): number {
    if (summary.modelUsage !== undefined && summary.modelUsage.length > 0) {
      let total = 0;
      for (const bucket of summary.modelUsage) {
        total += this.estimateCallCost(bucket.provider, bucket.model, bucket.usage);
      }
      return total;
    }
    return 0;
  }

  get sessionRuntimeTotalUsd(): number {
    return this.liveTotalUsd;
  }
}
