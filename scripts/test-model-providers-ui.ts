import assert from "node:assert/strict";
import {
  buildModelCatalog,
  canDisconnect,
  credentialSourceText,
  DEFAULT_CONTEXT_WINDOW,
  endpointPreview,
  enrichModel,
  filterHiddenModels,
  formatCost,
  formatTokenCount,
  groupProviders,
  guessCapabilities,
  isCustomProvider,
  matchCatalogModel,
  modelKey,
  normalizeModelId,
  providerMonogram,
  slugifyProviderId,
} from "../src/lib/modelProviders";
import type { ProviderSummary } from "../src/lib/providerService";
import type { ModelInfo } from "../src/types";

function provider(patch: Partial<ProviderSummary> & { id: string }): ProviderSummary {
  return {
    name: patch.id,
    oauthMethod: null,
    apiKeyMethod: "API key",
    configured: false,
    authType: null,
    source: null,
    sourceLabel: null,
    builtin: true,
    baseUrl: "",
    models: [],
    ...patch,
  };
}

const providers = [
  provider({ id: "anthropic", name: "Anthropic", oauthMethod: "Claude Pro/Max", configured: true, authType: "oauth", source: "stored" }),
  provider({ id: "openai-codex", name: "OpenAI Codex", oauthMethod: "ChatGPT Plus/Pro", apiKeyMethod: null }),
  provider({ id: "deepseek", name: "DeepSeek", models: [{ id: "deepseek-reasoner", name: "DeepSeek Reasoner", reasoning: true, input: ["text"], contextWindow: 64000, maxTokens: 8000, cost: null }] }),
  provider({ id: "grok", name: "grok", builtin: false, configured: true, authType: "api_key", source: "models_json_key" }),
  provider({ id: "my-proxy", name: "My Proxy", builtin: false }),
  provider({ id: "llama.cpp", name: "llama.cpp", builtin: false }),
];
const modelsJson = new Set(["grok", "my-proxy"]);

const groups = groupProviders(providers, modelsJson);
assert.deepEqual(groups.map((group) => group.id), ["connected", "subscription", "apiKey", "custom"]);
assert.deepEqual(groups[0].providers.map((item) => item.id), ["anthropic", "grok"]);
assert.deepEqual(groups[1].providers.map((item) => item.id), ["openai-codex"]);
assert.deepEqual(groups[2].providers.map((item) => item.id), ["deepseek"]);
assert.deepEqual(groups[3].providers.map((item) => item.id), ["my-proxy", "llama.cpp"], "local and custom providers stay findable");
assert.deepEqual(groupProviders(providers, modelsJson, "reasoner").flatMap((group) => group.providers.map((item) => item.id)), ["deepseek"], "search matches model IDs");
assert.deepEqual(groupProviders(providers, modelsJson, "zzz"), []);

assert.equal(isCustomProvider(providers[3], modelsJson), true);
assert.equal(isCustomProvider(providers[0], new Set(["anthropic"])), false, "a models.json override of a builtin is not custom");

assert.equal(credentialSourceText(providers[0]), "订阅账号登录");
assert.equal(credentialSourceText(provider({ id: "x", configured: true, authType: "api_key", source: "stored" })), "API 密钥 · 保存在 auth.json");
assert.equal(credentialSourceText(provider({ id: "x", configured: true, source: "environment", sourceLabel: "OPENAI_API_KEY" })), "环境变量 OPENAI_API_KEY");
assert.equal(credentialSourceText(providers[3]), "models.json 中的密钥");
assert.equal(credentialSourceText(providers[1]), "未连接");
assert.equal(canDisconnect(providers[0]), true);
assert.equal(canDisconnect(providers[3]), false, "models.json keys are edited, not logged out");

assert.equal(formatTokenCount(1_000_000), "1M");
assert.equal(formatTokenCount(1_048_576), "1M");
assert.equal(formatTokenCount(200_000), "200K");
assert.equal(formatTokenCount(null), "");
assert.equal(formatCost({ input: 3, output: 15 }), "$3 / $15");
assert.equal(formatCost({ input: 0, output: 0 }), "");

assert.equal(endpointPreview("openai-completions", "https://api.example.com/v1/"), "https://api.example.com/v1/chat/completions");
assert.equal(endpointPreview("anthropic-messages", "https://proxy.example.com"), "https://proxy.example.com/v1/messages");
assert.equal(endpointPreview("anthropic-messages", "https://proxy.example.com/v1"), "https://proxy.example.com/v1/messages");
assert.equal(endpointPreview("openai-responses", "https://api.example.com/v1"), "https://api.example.com/v1/responses");
assert.equal(endpointPreview("openai-completions", "  "), "");

assert.equal(slugifyProviderId("My Local Ollama!"), "my-local-ollama");
assert.equal(slugifyProviderId("  --Zhipu GLM--  "), "zhipu-glm");
assert.equal(slugifyProviderId("智谱"), "");

const models: ModelInfo[] = [
  { id: "a", name: "A", provider: "p" },
  { id: "b", name: "B", provider: "p" },
  { id: "c", name: "C", provider: "q" },
];
assert.deepEqual(filterHiddenModels(models, undefined, null).map((model) => model.id), ["a", "b", "c"]);
assert.deepEqual(filterHiddenModels(models, [modelKey("p", "b"), modelKey("q", "c")], null).map((model) => model.id), ["a"]);
assert.deepEqual(filterHiddenModels(models, [modelKey("p", "b"), modelKey("q", "c")], models[1]).map((model) => model.id), ["a", "b"], "the selected model stays visible");

assert.equal(providerMonogram("OpenAI Codex"), "O");
assert.equal(providerMonogram("llama.cpp"), "L");
assert.equal(providerMonogram("智谱"), "智");


// Capability enrichment for models fetched from custom endpoints.
const summary = (id: string, patch: Partial<{ reasoning: boolean; input: string[]; contextWindow: number | null; maxTokens: number | null }> = {}) => ({
  id, name: id, reasoning: false, input: ["text"], contextWindow: null, maxTokens: null, cost: null, ...patch,
});
const catalog = buildModelCatalog([
  provider({ id: "anthropic", models: [summary("claude-sonnet-4-5", { reasoning: true, input: ["text", "image"], contextWindow: 200_000, maxTokens: 64_000 })] }),
  provider({ id: "openrouter", models: [summary("anthropic/claude-sonnet-4.5", { reasoning: true, input: ["text", "image"] })] }),
  provider({ id: "google", models: [summary("gemini-3.8-flash", { reasoning: true, input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 65_536 })] }),
  provider({ id: "openai", models: [summary("gpt-4o-mini", { input: ["text", "image"], contextWindow: 128_000, maxTokens: 16_384 })] }),
  provider({ id: "deepseek", models: [summary("deepseek-reasoner", { reasoning: true, contextWindow: 128_000, maxTokens: 64_000 })] }),
  provider({ id: "grok", builtin: false, models: [summary("claude-sonnet-4-5", { contextWindow: 1 })] }),
]);

assert.equal(normalizeModelId("anthropic/claude-sonnet-4.5"), "claude-sonnet-4-5");
assert.equal(normalizeModelId("models/gemini-3.8-flash"), "gemini-3-8-flash");
assert.equal(normalizeModelId("qwen3-coder:30b"), "qwen3-coder");
assert.equal(matchCatalogModel(catalog, "claude-sonnet-4.5")?.providerId, "anthropic", "first-party entry with limits wins over resellers");
assert.equal(matchCatalogModel(catalog, "claude-sonnet-4-5-20250929")?.model.id, "claude-sonnet-4-5", "date stamps are ignored");
assert.equal(matchCatalogModel(catalog, "gemini-3.8-flash-high")?.model.id, "gemini-3.8-flash", "effort variants map to the base model");
assert.equal(matchCatalogModel(catalog, "gpt-4o-mini-search-preview")?.model.id, "gpt-4o-mini", "longest catalog prefix at a boundary");
assert.equal(matchCatalogModel(catalog, "gpt-4o"), undefined, "no partial-token prefix matches");
assert.equal(matchCatalogModel(catalog, "my-private-model"), undefined);

const fromCatalog = enrichModel({ id: "claude-sonnet-4.5", name: "claude-sonnet-4.5", reasoning: false, input: ["text"] }, catalog);
assert.equal(fromCatalog.source, "catalog");
assert.deepEqual([fromCatalog.model.reasoning, fromCatalog.model.input, fromCatalog.model.contextWindow, fromCatalog.model.maxTokens], [true, ["text", "image"], 200_000, 64_000]);
assert.equal(fromCatalog.model.name, "claude-sonnet-4.5", "the relay display name is kept");

const fromApi = enrichModel({ id: "claude-sonnet-4.5", name: "Sonnet", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: null }, catalog);
assert.equal(fromApi.source, "api");
assert.equal(fromApi.model.contextWindow, 100_000, "explicit API limits are not overwritten");
assert.equal(fromApi.model.maxTokens, 64_000, "missing API fields are filled from the catalog");

const guessed = enrichModel({ id: "qwen2.5-vl-72b-instruct", name: "qwen2.5-vl-72b-instruct", reasoning: false, input: ["text"] }, catalog);
assert.deepEqual([guessed.source, guessed.model.input, guessed.model.contextWindow], ["guess", ["text", "image"], DEFAULT_CONTEXT_WINDOW]);
const plain = enrichModel({ id: "my-private-model", name: "my-private-model", reasoning: false, input: ["text"] }, catalog);
assert.deepEqual([plain.source, plain.model.reasoning, plain.model.input, plain.model.contextWindow], ["default", false, ["text"], DEFAULT_CONTEXT_WINDOW]);

assert.deepEqual(guessCapabilities("deepseek-r1-distill-qwen-32b"), { reasoning: true, image: false });
assert.deepEqual(guessCapabilities("gpt-4o-2024-11-20"), { reasoning: false, image: true });
assert.deepEqual(guessCapabilities("o3-mini"), { reasoning: true, image: false });
assert.deepEqual(guessCapabilities("llama-3.1-8b-instruct"), { reasoning: false, image: false });

console.log("model providers UI tests passed");
