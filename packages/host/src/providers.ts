/**
 * Loads the model providers from `<dataDir>/providers.json` into the open
 * `ctx.llm` protocol registry (`registerProtocol`) and answers `provider.list`
 * and `model.list` (ADR 0007).
 *
 * Protocols (`openai-compat`, `openai-responses`, `anthropic`, `gemini`, or
 * custom third-party wire protocols) are independent plugins; `providers`
 * dynamically binds entries in `providers.json` to whatever protocols are
 * currently active on `ctx.llm`, re-binding automatically whenever protocols
 * mount or unmount (`llm/protocols-changed`).
 */
import { readFileSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import { LlmError, isSecretRef, type LlmProtocolSpec, type ModelInfo, type ModelPricing, type SecretRef } from "@pid/llm";
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
  /** Optional revision token so PluginManager reloads when `providers.json` changes. */
  revision?: string;
  /**
   * When false (set by `PluginManager`), `providers` relies strictly on active
   * protocol plugins on `ctx.llm`. Defaults to true for standalone tests that
   * mount `providers` directly without `PluginManager`.
   */
  autoRegisterBuiltinProtocols?: boolean;
}

export const APIS = ["openai-compat", "openai-responses", "anthropic", "gemini"] as const;
export type BuiltinApi = (typeof APIS)[number];
export type Api = BuiltinApi | (string & {});

export const BUILTIN_PROTOCOL_SPECS: ReadonlyMap<string, LlmProtocolSpec> = new Map<string, LlmProtocolSpec>([
  ["openai-compat", openaiCompat.protocolSpec],
  ["openai-responses", openaiResponses.protocolSpec],
  ["anthropic", anthropic.protocolSpec],
  ["gemini", gemini.protocolSpec],
]);

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

/**
 * Why `value` is not a usable provider entry, or undefined when it is.
 * Accepts optional `protocols` map so dynamically installed protocol plugins
 * validate cleanly alongside the built-in protocols.
 */
export function entryProblem(
  value: unknown,
  protocols: ReadonlyMap<string, LlmProtocolSpec> = BUILTIN_PROTOCOL_SPECS,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not an object";
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(entry.id)) return "id must be letters, digits, '.', '_' or '-'";
  const api = typeof entry.api === "string" ? entry.api : "";
  const spec = protocols.get(api);
  if (spec === undefined) {
    return `api must be one of ${[...protocols.keys()].join(", ")}`;
  }
  if (spec.requiresBaseUrl === true && typeof entry.baseUrl !== "string") {
    return `${api} needs a baseUrl`;
  }
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

/** Build the effective protocol map combining active `ctx.llm` protocols with fallback specs when requested. */
export function resolveActiveProtocolMap(ctx?: Context, includeBuiltinFallback = true): Map<string, LlmProtocolSpec> {
  const map = new Map<string, LlmProtocolSpec>();
  if (includeBuiltinFallback) {
    for (const [k, v] of BUILTIN_PROTOCOL_SPECS) map.set(k, v);
  }
  const llm = ctx?.get("llm");
  if (llm !== undefined) {
    for (const api of llm.listProtocols()) {
      const spec = llm.getProtocol(api);
      if (spec !== undefined) map.set(api, spec);
    }
  }
  return map;
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
export function readProviders(
  file: string,
  protocols: ReadonlyMap<string, LlmProtocolSpec> = BUILTIN_PROTOCOL_SPECS,
): { entries: ProviderEntry[]; problems: string[] } {
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
    const problem = entryProblem(value, protocols) ?? (seen.has((value as ProviderEntry).id) ? "duplicate id" : undefined);
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
  if (config.autoRegisterBuiltinProtocols !== false && ctx.llm.listProtocols().length === 0) {
    for (const [api, spec] of BUILTIN_PROTOCOL_SPECS) {
      ctx.effect(() => ctx.llm.registerProtocol(api, spec), `${name}: fallback-protocol:${api}`);
    }
  }

  let adapterDisposers: Array<() => void> = [];
  let keys = new Map<string, SecretRef | undefined>();
  let customModels = new Map<string, Map<string, ModelPricing>>();
  let configuredModels = new Map<string, ModelInfo[]>();

  const clearAdapters = () => {
    for (const dispose of adapterDisposers) dispose();
    adapterDisposers = [];
  };

  const rebindProviders = () => {
    clearAdapters();
    const activeProtocols = resolveActiveProtocolMap(ctx, false);
    // Validate syntax against union of active + builtin specs so disabled protocols log a gentle skip instead of "invalid api"
    const validationSpecs = resolveActiveProtocolMap(ctx, true);
    const { entries, problems } = readProviders(config.file, validationSpecs);
    for (const problem of problems) ctx.logger("providers").warn("skipped %s", problem);

    keys = new Map(entries.map((entry) => [entry.id, entry.apiKey]));
    customModels = new Map<string, Map<string, ModelPricing>>();
    configuredModels = new Map<string, ModelInfo[]>();

    for (const entry of entries) {
      if (entry.models !== undefined && entry.models.length > 0) {
        configuredModels.set(entry.id, entry.models.map((model) => ({ ...model })));
      }
      const forProvider = new Map<string, ModelPricing>();
      for (const model of entry.models ?? []) {
        if (model.cost !== undefined) forProvider.set(model.id, model.cost);
      }
      if (forProvider.size > 0) customModels.set(entry.id, forProvider);

      if (!activeProtocols.has(entry.api)) {
        ctx.logger("providers").info("provider %s waiting for protocol plugin %s", entry.id, entry.api);
        continue;
      }
      const instantiated = ctx.llm.instantiateProtocolAdapter(entry.api, entry, ctx);
      if (instantiated !== undefined) {
        adapterDisposers.push(ctx.llm.registerAdapter(instantiated.info, instantiated.adapter));
      }
    }
  };

  ctx.effect(() => {
    rebindProviders();
    const off = ctx.on("llm/protocols-changed", () => rebindProviders());
    return () => {
      off();
      clearAdapters();
    };
  }, "providers: dynamic protocol bindings");

  ctx.inject(["pricing"], (pricingCtx) => {
    pricingCtx.effect(() => {
      pricingCtx.pricing.setCustomPricing((providerId, modelId) => customModels.get(providerId)?.get(modelId));
      return () => {
        pricingCtx.pricing.setCustomPricing(undefined);
      };
    }, "providers: custom model pricing");
  });

  // The RPC methods start once a gateway is there; a headless run has none.
  ctx.inject(["rpc"], (innerCtx) => {
    innerCtx.effect(() => innerCtx.rpc.method("provider.list", (): ProviderListResult => ({
      providers: innerCtx.llm.listProviders().map((provider) => ({
        ...provider,
        keySource: innerCtx.credentials.describe(keys.get(provider.id)),
      })),
    })), "providers: provider.list");

    innerCtx.effect(() => innerCtx.rpc.method("model.list", async (params, call): Promise<ModelListResult> => {
      const provider = (params as { provider?: unknown } | undefined)?.provider;
      if (typeof provider !== "string") throw new RpcError(ErrorCode.InvalidParams, "model.list needs { provider }");
      if (!innerCtx.llm.listProviders().some((item) => item.id === provider)) {
        throw new RpcError(ErrorCode.InvalidParams, `Unknown provider ${provider}`);
      }
      try {
        // Strictly honor explicitly selected models in providers.json; only query remote `/models`
        // when a provider entry has no configured `models` list.
        const explicit = configuredModels.get(provider);
        const rawModels = explicit !== undefined
          ? explicit
          : await innerCtx.llm.listModels(provider, call.signal);
        const pricing = innerCtx.get("pricing");
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
