/**
 * The model settings page on the Harness engine (docs/adr/0014): the Host's
 * providers.json in the shapes the page already renders. Pi's API names map
 * onto the Host's two adapters; built-in providers and OAuth logins are Pi's
 * and have no Host counterpart, so every Host provider is a custom one.
 */
import type { ModelListResult, ModelSummary } from "@pid/protocol";
import type { ProviderModelSummary, ProviderSummary } from "../../src-tauri/resources/pidesktop-providers-core";
import type { ModelProviderCheckResult, ModelProviderConfig, ModelProviderInput, ModelProviderModel } from "../types";
import { harnessRuntimes } from "./harnessRuntime";

type HostApi = "openai-compat" | "anthropic";

interface HostProviderConfig {
  api: HostApi;
  id: string;
  name?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  models?: ModelSummary[];
  keySource: "none" | "stored" | "environment";
}

const PI_API: Record<HostApi, string> = { "openai-compat": "openai-completions", anthropic: "anthropic-messages" };

/** Pi's API name as the Host's adapter; the others are not supported on the harness yet. */
export function hostApi(api: string): HostApi {
  if (api === "" || api === "openai-completions") return "openai-compat";
  if (api === "anthropic-messages") return "anthropic";
  throw new Error(`Harness 引擎暂不支持 ${api} 协议，请改用 OpenAI 兼容或 Anthropic`);
}

function modelFromHost(model: ModelSummary): ModelProviderModel {
  return {
    id: model.id,
    name: model.name ?? model.id,
    reasoning: model.reasoning === true,
    input: model.input ?? ["text"],
    contextWindow: model.contextWindow ?? null,
    maxTokens: model.maxOutputTokens ?? null,
  };
}

function modelToHost(model: ModelProviderModel): ModelSummary {
  return {
    id: model.id,
    ...(model.name && model.name !== model.id ? { name: model.name } : {}),
    reasoning: model.reasoning,
    input: model.input.filter((kind): kind is "text" | "image" => kind === "text" || kind === "image"),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens ? { maxOutputTokens: model.maxTokens } : {}),
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
  const configured = new Map((provider.models ?? []).map((model) => [model.id, model]));
  const all = [...configured.values(), ...models.filter((model) => !configured.has(model.id))];
  return {
    id: provider.id,
    name: provider.name ?? provider.id,
    oauthMethod: null,
    apiKeyMethod: null,
    configured: provider.keySource !== "none",
    authType: null,
    source: null,
    sourceLabel: provider.keySource === "environment" ? "环境变量" : provider.keySource === "stored" ? "已保存的密钥" : null,
    builtin: false,
    baseUrl: provider.baseUrl ?? "",
    models: all.map((model): ProviderModelSummary => ({
      id: model.id,
      name: model.name ?? model.id,
      reasoning: model.reasoning === true,
      input: model.input ?? ["text"],
      contextWindow: model.contextWindow ?? null,
      maxTokens: model.maxOutputTokens ?? null,
      cost: null,
    })),
  };
}

async function hostConfigs(): Promise<HostProviderConfig[]> {
  return (await harnessRuntimes.call<{ providers: HostProviderConfig[] }>("provider.configs")).providers;
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
  delete: async (id: string): Promise<void> => {
    await harnessRuntimes.call("provider.delete", { id });
  },
  check: async (id: string): Promise<ModelProviderCheckResult> => {
    try {
      const { models } = await harnessRuntimes.call<ModelListResult>("model.list", { provider: id });
      return { ok: true, message: `连接正常，${models.length} 个模型` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
};
