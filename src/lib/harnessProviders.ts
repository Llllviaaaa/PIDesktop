/**
 * The model settings page on the Harness Host (docs/adr/0014): the Host's
 * providers.json in the shapes the page already renders. Pi's API names map
 * onto the Host's four native adapters (`openai-compat`, `openai-responses`,
 * `anthropic`, and `gemini`).
 */
import type { ModelListResult, ModelSummary } from "@pid/protocol";
import type {
  ModelProviderCheckResult,
  ModelProviderConfig,
  ModelProviderInput,
  ModelProviderModel,
  ModelThinkingLevel,
} from "../types";
import { harnessRuntimes, isRpcMethodNotFound } from "./harnessRuntime";

type HostApi = "openai-compat" | "openai-responses" | "anthropic" | "gemini";

interface HostProviderConfig {
  api: HostApi;
  id: string;
  name?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  models?: ModelSummary[];
  keySource: "none" | "stored" | "environment";
}

const PI_API: Record<HostApi, string> = {
  "openai-compat": "openai-completions",
  "openai-responses": "openai-responses",
  anthropic: "anthropic-messages",
  gemini: "google-generative-ai",
};

/** Pi's API name as the Host's adapter. */
export function hostApi(api: string): HostApi {
  if (api === "" || api === "openai-completions") return "openai-compat";
  if (api === "openai-responses") return "openai-responses";
  if (api === "anthropic-messages") return "anthropic";
  if (api === "google-generative-ai") return "gemini";
  throw new Error(`Harness 引擎暂不支持 ${api} 协议，请改用 OpenAI、Anthropic 或 Gemini`);
}

function modelFromHost(model: ModelSummary): ModelProviderModel {
  return {
    id: model.id,
    name: model.name ?? model.id,
    reasoning: model.reasoning === true,
    ...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}),
    ...(model.thinkingLevels && model.thinkingLevels.length > 0 ? { thinkingLevels: [...model.thinkingLevels] } : {}),
    input: model.input ?? ["text"],
    contextWindow: model.contextWindow ?? null,
    maxTokens: model.maxOutputTokens ?? null,
    ...(model.cost ? { cost: { ...model.cost } } : {}),
  };
}

function modelToHost(model: ModelProviderModel): ModelSummary {
  const hasCost = model.cost !== undefined && model.cost !== null
    && Number.isFinite(model.cost.input) && Number.isFinite(model.cost.output)
    && (model.cost.input > 0 || model.cost.output > 0);
  const cleanLevels = model.thinkingLevels
    ?.map((lvl) => lvl.trim())
    .filter((lvl, idx, arr) => lvl !== "" && arr.indexOf(lvl) === idx);
  return {
    id: model.id,
    ...(model.name && model.name !== model.id ? { name: model.name } : {}),
    reasoning: model.reasoning,
    ...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}),
    ...(model.reasoning && cleanLevels && cleanLevels.length > 0 ? { thinkingLevels: cleanLevels } : {}),
    input: model.input.filter((kind): kind is "text" | "image" => kind === "text" || kind === "image"),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens ? { maxOutputTokens: model.maxTokens } : {}),
    ...(hasCost && model.cost ? { cost: { ...model.cost } } : {}),
  };
}

export function configFromHost(provider: HostProviderConfig): ModelProviderConfig {
  return {
    id: provider.id,
    name: provider.name ?? provider.id,
    baseUrl: provider.baseUrl ?? "",
    api: PI_API[provider.api],
    hasApiKey: provider.keySource !== "none",
    apiKeySource: provider.keySource,
    authHeader: false,
    models: (provider.models ?? []).map(modelFromHost),
  };
}

export function draftToHost(input: ModelProviderInput): Record<string, unknown> {
  return {
    ...(input.originalId ? { originalId: input.originalId } : {}),
    id: input.id.trim(),
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim(),
    api: hostApi(input.api),
    apiKey: input.apiKey,
    keepExistingApiKey: input.keepExistingApiKey,
    models: input.models.map(modelToHost),
  };
}

export function summaryFromHost(provider: HostProviderConfig, models: ModelSummary[]): ProviderSummary {
  const byDiscovered = new Map(models.map((model) => [model.id, model]));
  const explicitModels = provider.models ?? [];
  const configured = new Map(
    explicitModels.map((model) => {
      const remote = byDiscovered.get(model.id);
      return [model.id, model.cost === undefined && remote?.cost !== undefined ? { ...model, cost: remote.cost } : model];
    }),
  );
  // Strictly keep ONLY explicitly selected models when `provider.models` is configured;
  // fall back to `models` only for unconfigured/auto-discovered entries.
  const all = configured.size > 0 ? [...configured.values()] : models;
  return {
    id: provider.id,
    name: provider.name ?? provider.id,
    configured: provider.keySource !== "none",
    keySource: provider.keySource,
    baseUrl: provider.baseUrl ?? "",
    models: all.map((model): ProviderModelSummary => ({
      id: model.id,
      name: model.name ?? model.id,
      reasoning: model.reasoning === true,
      ...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}),
      ...(model.thinkingLevels && model.thinkingLevels.length > 0 ? { thinkingLevels: [...model.thinkingLevels] } : {}),
      input: model.input ?? ["text"],
      contextWindow: model.contextWindow ?? null,
      maxTokens: model.maxOutputTokens ?? null,
      cost: model.cost ? { input: model.cost.input, output: model.cost.output } : null,
    })),
  };
}

async function hostConfigs(): Promise<HostProviderConfig[]> {
  return (await harnessRuntimes.call<{ providers: HostProviderConfig[] }>("provider.configs")).providers;
}

/** A model as the settings page lists it. */
export interface ProviderModelSummary {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevel?: ModelThinkingLevel;
  thinkingLevels?: string[];
  input: string[];
  contextWindow: number | null;
  maxTokens: number | null;
  cost: { input: number; output: number } | null;
}

/** A provider as the settings page lists it: its models, and where its key comes from. */
export interface ProviderSummary {
  id: string;
  name: string;
  configured: boolean;
  /** A key saved in secrets.dat, a `$VARIABLE` reference, or none. */
  keySource: HostProviderConfig["keySource"];
  baseUrl: string;
  models: ProviderModelSummary[];
}

export const harnessProviders = {
  /** The page's provider list: each provider with its configured and discovered models. */
  async list(): Promise<ProviderSummary[]> {
    const providers = await hostConfigs();
    return Promise.all(providers.map(async (provider) => {
      const models = await harnessRuntimes.call<ModelListResult>("model.list", { provider: provider.id }).then((result) => result.models, () => [] as ModelSummary[]);
      return summaryFromHost(provider, models);
    }));
  },
  configs: async (): Promise<ModelProviderConfig[]> => (await hostConfigs()).map(configFromHost),
  discover: async (input: ModelProviderInput): Promise<ModelProviderModel[]> => (
    (await harnessRuntimes.call<ModelListResult>("provider.discover", { provider: draftToHost(input) })).models.map(modelFromHost)
  ),
  save: async (input: ModelProviderInput): Promise<void> => {
    await harnessRuntimes.call("provider.save", { provider: draftToHost(input) });
  },
  /** Set or, with "", remove a provider's key, keeping the rest of it. */
  setKey: async (id: string, apiKey: string): Promise<void> => {
    const provider = (await hostConfigs()).find((entry) => entry.id === id);
    if (provider === undefined) throw new Error(`没有名为 ${id} 的 provider`);
    const { keySource: _keySource, ...rest } = provider;
    await harnessRuntimes.call("provider.save", { provider: { ...rest, originalId: id, apiKey, keepExistingApiKey: false } });
  },
  delete: async (id: string): Promise<void> => {
    await harnessRuntimes.call("provider.delete", { id });
  },
  check: async (id: string): Promise<ModelProviderCheckResult> => {
    try {
      const { models } = await harnessRuntimes.call<ModelListResult>("provider.check", { id }).catch(async (err) => {
        if (isRpcMethodNotFound(err)) return harnessRuntimes.call<ModelListResult>("model.list", { provider: id });
        throw err;
      });
      return { ok: true, message: `连接正常，服务端响应 ${models.length} 个模型` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
};
