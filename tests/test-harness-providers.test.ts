// The settings page's providers on the harness engine (src/lib/harnessProviders.ts):
// the Host's providers.json as the page's shapes, and the form back as a draft.
import { describe, expect, it } from "vitest";
import { configFromHost, draftToHost, hostApi, summaryFromHost } from "../src/lib/harnessProviders";

const host = {
  api: "anthropic" as const,
  id: "claude",
  baseUrl: "https://api.example.com",
  models: [{ id: "big", name: "Big", reasoning: true, thinkingLevel: "high" as const, input: ["text", "image"] as Array<"text" | "image">, contextWindow: 200_000, maxOutputTokens: 32_000 }],
  keySource: "stored" as const,
};

describe("model providers on the harness engine", () => {
  it("map the Host's providers onto the settings page and strictly keep only selected models", () => {
    expect(configFromHost(host)).toEqual({
      id: "claude",
      name: "claude",
      baseUrl: "https://api.example.com",
      api: "anthropic-messages",
      hasApiKey: true,
      apiKeySource: "stored",
      authHeader: false,
      models: [{ id: "big", name: "Big", reasoning: true, thinkingLevel: "high", input: ["text", "image"], contextWindow: 200_000, maxTokens: 32_000 }],
    });
    const summary = summaryFromHost(host, [{ id: "big", cost: { input: 3, output: 15 } }, { id: "small" }]);
    expect(summary).toMatchObject({ id: "claude", configured: true, keySource: "stored" });
    expect(summary.models.map((model) => [model.id, model.name, model.maxTokens, model.thinkingLevel, model.cost])).toEqual([
      ["big", "Big", 32_000, "high", { input: 3, output: 15 }],
    ]);
    // When no explicit models were saved in providers.json, discovered models are shown.
    const discoveredFallback = summaryFromHost({ ...host, models: [] }, [{ id: "big" }, { id: "small" }]);
    expect(discoveredFallback.models.map((model) => model.id)).toEqual(["big", "small"]);
    expect(summaryFromHost({ ...host, keySource: "none" }, [])).toMatchObject({ configured: false, keySource: "none" });
  });

  it("map the form back to a Host draft", () => {
    expect(draftToHost({
      originalId: null,
      id: " local ",
      name: "Local",
      baseUrl: "http://127.0.0.1:1234/v1 ",
      api: "openai-completions",
      apiKey: "$LOCAL_KEY",
      keepExistingApiKey: false,
      authHeader: false,
      models: [{ id: "m", name: "m", reasoning: false, input: ["text", "audio"], contextWindow: null, maxTokens: 4096 }],
    })).toEqual({
      id: "local",
      name: "Local",
      baseUrl: "http://127.0.0.1:1234/v1",
      api: "openai-compat",
      apiKey: "$LOCAL_KEY",
      keepExistingApiKey: false,
      models: [{ id: "m", reasoning: false, input: ["text"], maxOutputTokens: 4096 }],
    });
    expect(hostApi("anthropic-messages")).toBe("anthropic");
    expect(hostApi("google-generative-ai")).toBe("gemini");
    expect(hostApi("openai-responses")).toBe("openai-responses");
    expect(() => hostApi("bedrock-converse-stream")).toThrow(/暂不支持/);
  });
});
