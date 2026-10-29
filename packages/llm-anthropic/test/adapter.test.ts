import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { Credentials, LlmService, assemble, type LlmRequest } from "@pid/llm";
import { sseFixture, startFakeProvider, type FakeProvider } from "../../llm/test/fake-server.ts";
import * as adapter from "../src/index.ts";

let root: Context | undefined;
let server: FakeProvider | undefined;

afterEach(async () => {
  await root?.fiber.dispose();
  await server?.close();
  root = undefined;
  server = undefined;
});

async function setup(provider: Partial<adapter.ProviderConfig> = {}): Promise<{ ctx: Context; server: FakeProvider }> {
  server = await startFakeProvider();
  root = new Context();
  await root.plugin(Credentials);
  await root.plugin(LlmService, { baseDelayMs: 0 });
  await root.plugin(adapter, { providers: [{ id: "anthropic", baseUrl: server.baseUrl, apiKey: { value: "sk-ant-test" }, ...provider }] });
  return { ctx: root, server };
}

const fixture = (name: string) => sseFixture(new URL(`./fixtures/${name}`, import.meta.url));

const request: LlmRequest = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  system: "Be brief.",
  messages: [
    { role: "user", content: [{ type: "text", text: "read a.ts and b.ts" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "two reads", signature: "sig-1" },
        { type: "thinking", text: "from another provider" },
        { type: "tool-call", id: "toolu_a", name: "read", arguments: { path: "a.ts" } },
        { type: "tool-call", id: "toolu_b", name: "read", arguments: { path: "b.ts" } },
      ],
    },
    { role: "tool-result", callId: "toolu_a", content: [{ type: "text", text: "A" }], isError: false },
    { role: "tool-result", callId: "toolu_b", content: [{ type: "text", text: "missing" }], isError: true },
  ],
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
};

describe("anthropic adapter", () => {
  it("sends the Messages API request with merged tool results", async () => {
    const { ctx, server } = await setup();
    server.reply({ sse: fixture("text.sse") });
    await assemble(ctx.llm.stream(request));

    const [sent] = server.requests;
    expect(sent.path).toBe("/v1/messages");
    expect(sent.headers["x-api-key"]).toBe("sk-ant-test");
    expect(sent.headers["anthropic-version"]).toBe(adapter.ANTHROPIC_VERSION);
    expect(sent.body).toEqual({
      model: "claude-sonnet-4-5",
      stream: true,
      system: "Be brief.",
      max_tokens: 8192,
      tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "read a.ts and b.ts" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "two reads", signature: "sig-1" },
            { type: "tool_use", id: "toolu_a", name: "read", input: { path: "a.ts" } },
            { type: "tool_use", id: "toolu_b", name: "read", input: { path: "b.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_a", is_error: false, content: [{ type: "text", text: "A" }] },
            { type: "tool_result", tool_use_id: "toolu_b", is_error: true, content: [{ type: "text", text: "missing" }] },
          ],
        },
      ],
    });
  });

  it("enables thinking with a budget below max_tokens and drops temperature", () => {
    const body = adapter.buildRequestBody({ ...request, effort: "high", maxTokens: 4_000, temperature: 0.5 });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 24_576 });
    expect(body.max_tokens as number).toBeGreaterThan(24_576);
    expect(body.temperature).toBeUndefined();
    expect(adapter.buildRequestBody({ ...request, temperature: 0.5 }).temperature).toBe(0.5);
    expect(adapter.buildRequestBody(request, { id: "m", maxOutputTokens: 64_000 }).max_tokens).toBe(64_000);
  });

  it("translates thinking with its signature, text, tool use and usage", async () => {
    const { ctx, server } = await setup();
    server.reply({ sse: fixture("thinking-tool.sse") });
    const result = await assemble(ctx.llm.stream(request));
    expect(result).toEqual({
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "Need to read the file.", signature: "EqQBCgIYAhIM" },
          { type: "text", text: "Let me look." },
          { type: "tool-call", id: "toolu_01", name: "read", arguments: { path: "a.ts" } },
        ],
      },
      usage: { inputTokens: 50, outputTokens: 87, cacheReadTokens: 400, cacheWriteTokens: 10 },
      reason: "tool-use",
    });
  });

  it("retries an overloaded stream error, then succeeds", async () => {
    const { ctx, server } = await setup();
    server.reply({ sse: fixture("overloaded.sse") }, { sse: fixture("text.sse") });
    const result = await assemble(ctx.llm.stream(request));
    expect(result.reason).toBe("stop");
    expect(result.message.content).toEqual([{ type: "text", text: "Hi." }]);
    expect(server.requests).toHaveLength(2);
  });

  it("treats a stream cut before message_stop as a retryable network error", async () => {
    const { ctx, server } = await setup();
    const cut = fixture("text.sse").split("event: message_stop")[0];
    server.reply({ sse: cut }, { sse: cut }, { sse: cut });
    const result = await assemble(ctx.llm.stream(request));
    expect(result.error).toMatchObject({ kind: "network", retryable: true });
  });

  it("lists models with display names", async () => {
    const { ctx, server } = await setup();
    server.reply({ status: 200, json: { data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", type: "model" }] } });
    expect(await ctx.llm.listModels("anthropic")).toEqual([{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }]);
    expect(server.requests[0].path).toBe("/v1/models?limit=1000");
  });
});
