/**
 * Loads the model providers from `<dataDir>/providers.json` into the LLM
 * adapters and answers `provider.list` and `model.list` (ADR 0007).
 *
 * ```json
 * { "providers": [
 *   { "api": "openai-compat", "id": "deepseek", "baseUrl": "https://api.deepseek.com", "apiKey": { "env": "DEEPSEEK_API_KEY" } },
 *   { "api": "anthropic", "id": "anthropic", "apiKey": { "secret": "anthropic" } }
 * ], "defaultModel": { "provider": "deepseek", "model": "deepseek-chat" } }
 * ```
 *
 * A missing file means no providers. A malformed entry is skipped with a
 * warning, so one typo does not take every provider down.
 */
import { readFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import { LlmError, isSecretRef, type ModelInfo, type ModelPricing, type SecretRef } from "@pid/llm";
import * as anthropic from "@pid/llm-anthropic";
import * as gemini from "@pid/llm-gemini";
import * as openaiCompat from "@pid/llm-openai-compat";
import * as openaiResponses from "@pid/llm-openai-responses";
import "@pid/pricing";
import { ErrorCode, type ModelListResult, type ProviderListResult } from "@pid/protocol";
import { RpcError } from "./rpc.ts";

export const name = "pid-providers";
export const inject = ["llm", "credentials"];

export interface Config {
  /** The providers file. */
  file: string;
}

export const APIS = ["openai-compat", "openai-responses", "anthropic", "gemini"] as const;
export type Api = (typeof APIS)[number];

export interface ProviderEntry {
  api: Api;
  id: string;
  name?: string;
  baseUrl?: string;
  apiKey?: SecretRef;
  headers?: Record<string, string>;
  reasoningEffort?: boolean;
  models?: ModelInfo[];
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === "string");
}

function isValidCost(cost: unknown): cost is ModelPricing {
  if (typeof cost !== "object" || cost === null || Array.isArray(cost)) return false;
  const record = cost as Record<string, unknown>;
  const okNum = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!okNum(record.input) || !okNum(record.output)) return false;
  if (record.cacheRead !== undefined && !okNum(record.cacheRead)) return false;
  if (record.cacheWrite !== undefined && !okNum(record.cacheWrite)) return false;
  return true;
}

/** Why `value` is not a usable provider entry, or undefined when it is. */
export function entryProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not an object";
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(entry.id)) return "id must be letters, digits, '.', '_' or '-'";
  if (!APIS.includes(entry.api as Api)) return `api must be one of ${APIS.join(", ")}`;
  if (entry.api === "openai-compat" && typeof entry.baseUrl !== "string") return "openai-compat needs a baseUrl";
  if (entry.baseUrl !== undefined && (typeof entry.baseUrl !== "string" || !/^https?:\/\//.test(entry.baseUrl))) return "baseUrl must be an http(s) URL";
  if (entry.apiKey !== undefined && !isSecretRef(entry.apiKey)) return "apiKey must be { env }, { secret } or { value }";
  if (entry.headers !== undefined && !isStringRecord(entry.headers)) return "headers must map names to strings";
  if (entry.models !== undefined) {
    if (!Array.isArray(entry.models) || !entry.models.every((model) => typeof (model as { id?: unknown })?.id === "string")) {
      return "models must be a list of { id, ... }";
    }
    if (!entry.models.every((model) => (model as { cost?: unknown }).cost === undefined || isValidCost((model as { cost?: unknown }).cost))) {
      return "model.cost must have finite non-negative { input, output }";
    }
  }
  return undefined;
}

/** The providers file's `defaultModel` ({ provider, model }), when it has a valid one. */
export function readDefaultModel(file: string): { provider: string; model: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  const value = (parsed as { defaultModel?: { provider?: unknown; model?: unknown } } | null)?.defaultModel;
  return typeof value?.provider === "string" && typeof value.model === "string" ? { provider: value.provider, model: value.model } : undefined;
}

/** Read the providers file; returns the usable entries and a note per skipped one. */
export function readProviders(file: string): { entries: ProviderEntry[]; problems: string[] } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], problems: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], problems: [`${file} is not valid JSON`] };
  }
  const list = (parsed as { providers?: unknown })?.providers;
  if (!Array.isArray(list)) return { entries: [], problems: [`${file} has no "providers" list`] };
  const entries: ProviderEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  list.forEach((value, index) => {
    const problem = entryProblem(value) ?? (seen.has((value as ProviderEntry).id) ? "duplicate id" : undefined);
    if (problem !== undefined) {
      problems.push(`providers[${index}]: ${problem}`);
      return;
    }
    seen.add((value as ProviderEntry).id);
    entries.push(value as ProviderEntry);
  });
  return { entries, problems };
}

export function apply(ctx: Context, config: Config): void {
  const { entries, problems } = readProviders(config.file);
  for (const problem of problems) ctx.logger("providers").warn("skipped %s", problem);

  const byApi = (api: Api) => entries.filter((entry) => entry.api === api);
  ctx.plugin(openaiCompat, {
    providers: byApi("openai-compat").map(({ api: _api, baseUrl, ...rest }) => ({ ...rest, baseUrl: baseUrl ?? "" })),
  });
  ctx.plugin(openaiResponses, {
    providers: byApi("openai-responses").map(({ api: _api, reasoningEffort: _effort, ...rest }) => rest),
  });
  ctx.plugin(anthropic, {
    providers: byApi("anthropic").map(({ api: _api, reasoningEffort: _effort, ...rest }) => rest),
  });
  ctx.plugin(gemini, {
    providers: byApi("gemini").map(({ api: _api, reasoningEffort: _effort, ...rest }) => rest),
  });

  const customModels = new Map<string, Map<string, ModelPricing>>();
  for (const entry of entries) {
    const forProvider = new Map<string, ModelPricing>();
    for (const model of entry.models ?? []) {
      if (model.cost !== undefined) forProvider.set(model.id, model.cost);
    }
    if (forProvider.size > 0) customModels.set(entry.id, forProvider);
  }
  ctx.effect(() => {
    const pricing = ctx.get("pricing");
    if (pricing === undefined) return () => {};
    pricing.setCustomPricing((providerId, modelId) => customModels.get(providerId)?.get(modelId));
    return () => pricing.setCustomPricing(undefined);
  }, "providers: custom pricing");

  const keys = new Map(entries.map((entry) => [entry.id, entry.apiKey]));
  // The RPC methods start once a gateway is there; a headless run has none.
  ctx.inject(["rpc"], (ctx) => {
    ctx.effect(() => ctx.rpc.method("provider.list", (): ProviderListResult => ({
      providers: ctx.llm.listProviders().map((provider) => ({ ...provider, keySource: ctx.credentials.describe(keys.get(provider.id)) })),
    })), "providers: provider.list");

    ctx.effect(() => ctx.rpc.method("model.list", async (params, call): Promise<ModelListResult> => {
      const provider = (params as { provider?: unknown } | undefined)?.provider;
      if (typeof provider !== "string") throw new RpcError(ErrorCode.InvalidParams, "model.list needs { provider }");
      if (!ctx.llm.listProviders().some((item) => item.id === provider)) {
        throw new RpcError(ErrorCode.InvalidParams, `Unknown provider ${provider}`);
      }
      try {
        const rawModels = await ctx.llm.listModels(provider, call.signal);
        const pricing = ctx.get("pricing");
        const models = pricing === undefined
          ? rawModels
          : rawModels.map((model) => {
              if (model.cost !== undefined) return model;
              const resolved = pricing.resolvePricing(provider, model.id);
              return resolved === undefined ? model : { ...model, cost: resolved };
            });
        return { models };
      } catch (error) {
        if (error instanceof LlmError) throw new RpcError(ErrorCode.ProviderError, error.message, error.toInfo());
        throw error;
      }
    }), "providers: model.list");
  });
}
