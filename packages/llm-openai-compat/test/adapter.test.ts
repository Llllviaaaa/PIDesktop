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
  await root.plugin(adapter, { providers: [{ id: "compat", baseUrl: `${server.baseUrl}/v1`, apiKey: { value: "sk-test" }, ...provider }] });
  return { ctx: root, server };
}

const fixture = (name: string) => sseFixture(new URL(`./fixtures/${name}`, import.meta.url));

const request: LlmRequest = {
  provider: "compat",
  model: "deepseek-reasoner",
  system: "Be brief.",
  messages: [
    { role: "user", content: [{ type: "text", text: "read a.ts" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "should read" },
        { type: "text", text: "Reading." },
        { type: "tool-call", id: "call_1", name: "read", arguments: { path: "a.ts" } },
      ],
    },
    { role: "tool-result", callId: "call_1", content: [{ type: "text", text: "export {}" }], isError: false },
    { role: "user", content: [{ type: "text", text: "and this" }, { type: "image", mimeType: "image/png", data: "AAAA" }] },
  ],
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
  maxTokens: 1000,
  effort: "high",
};

describe("openai-compat adapter", () => {
  it("sends Chat Completions with the key, tools and translated history", async () => {
    const { ctx, server } = await setup();
    server.reply({ sse: fixture("reasoning-text.sse") });
    await assemble(ctx.llm.stream(request));

    const [sent] = server.requests;
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/v1/chat/completions");
    expect(sent.headers.authorization).toBe("Bearer sk-test");
    expect(sent.body).toEqual({
      model: "deepseek-reasoner",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 1000,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "read a.ts" },
        {
          role: "assistant",
          content: "Reading.",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "export {}" },
        {
          role: "user",
          content: [{ type: "text", text: "and this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
        },
      ],
      tools: [{ type: "function", function: request.tools?.[0] }],
    });
  });

  it("sends reasoning_effort only for providers that opt in", async () => {
    const { ctx, server } = await setup({ reasoningEffort: true, headers: { "HTTP-Referer": "https://pid.example" } });
    server.reply({ sse: fixture("reasoning-text.sse") });
    await assemble(ctx.llm.stream(request));
    expect((server.requests[0].body as Record<string, unknown>).reasoning_effort).toBe("high");
    expect(server.requests[0].headers["http-referer"]).toBe("https://pid.example");
  });

  it("auto-sends reasoning_effort and session affinity headers for configured reasoning models, with graceful 400 fallback", async () => {
    const { ctx, server } = await setup({
      models: [{ id: "grok-4.7", reasoning: true, thinkingLevel: "max" }, { id: "quirky-reasoner", reasoning: true }],
    });
    server.reply({ sse: fixture("reasoning-text.sse") });
    await assemble(ctx.llm.stream({ ...request, model: "grok-4.7", sessionId: "sess-abc" }));
    expect((server.requests[0].body as Record<string, unknown>).reasoning_effort).toBe("high");
    expect(server.requests[0].headers["x-session-id"]).toBe("sess-abc");
    expect(server.requests[0].headers["x-grok-conv-id"]).toBe("sess-abc");

    // If a proxy rejects reasoning_effort with HTTP 400, adapter strips it and succeeds on immediate fallback.
    server.reply({ status: 400, json: { error: { message: "Unrecognized request argument supplied: reasoning_effort" } } });
    server.reply({ sse: fixture("reasoning-text.sse") });
    const fallbackResult = await assemble(ctx.llm.stream({ ...request, model: "quirky-reasoner", sessionId: "sess-abc" }));
    expect(fallbackResult.reason).toBe("stop");
    expect((server.requests[1].body as Record<string, unknown>).reasoning_effort).toBe("high");
    expect((server.requests[2].body as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it("translates DeepSeek reasoning, text and cached usage", async () => {
    const { ctx, server } = await setup();
    server.reply({ sse: fixture("reasoning-text.sse") });
    const result = await assemble(ctx.llm.stream(request));
    expect(result).toEqual({
      message: { role: "assistant", content: [{ type: "thinking", text: "The user wants a greeting." }, { type: "text", text: "Hello there!" }] },
      usage: { inputTokens: 20, outputTokens: 18, cacheReadTokens: 100, cacheWriteTokens: 0 },
      reason: "stop",
    });
  });

  it("assembles parallel tool calls whose arguments arrive interleaved", async () => {
    const { ctx, server } = await setup();
    server.reply({ sse: fixture("parallel-tools.sse") });
    const result = await assemble(ctx.llm.stream({ ...request, model: "gpt-4.1" }));
    expect(result.reason).toBe("tool-use");
    expect(result.message.content).toEqual([
      { type: "tool-call", id: "call_a", name: "read", arguments: { path: "a.ts" } },
      { type: "tool-call", id: "call_b", name: "ls", arguments: {} },
    ]);
    expect(result.usage).toMatchObject({ inputTokens: 44, cacheReadTokens: 256, outputTokens: 40 });
  });

  it("retries a 429 and reports a 401 without retrying", async () => {
    const { ctx, server } = await setup();
    server.reply({ status: 429, json: { error: { message: "slow down" } }, headers: { "retry-after": "0" } }, { sse: fixture("reasoning-text.sse") });
    expect((await assemble(ctx.llm.stream(request))).reason).toBe("stop");
    expect(server.requests).toHaveLength(2);

    server.reply({ status: 401, json: { error: { message: "Invalid API key" } } });
    const denied = await assemble(ctx.llm.stream(request));
    expect(denied.reason).toBe("error");
    expect(denied.error).toMatchObject({ kind: "auth", status: 401, message: expect.stringContaining("Invalid API key") });
    expect(server.requests).toHaveLength(3);
  });

  it("omits the authorization header when no key is configured", async () => {
    const { ctx, server } = await setup({ apiKey: undefined });
    server.reply({ sse: fixture("reasoning-text.sse") });
    await assemble(ctx.llm.stream(request));
    expect(server.requests[0].headers.authorization).toBeUndefined();
  });

  it("lists discovered models merged with configured metadata", async () => {
    const { ctx, server } = await setup({ models: [{ id: "deepseek-chat", contextWindow: 128_000 }, { id: "local-only" }] });
    server.reply({ status: 200, json: { object: "list", data: [{ id: "deepseek-reasoner" }, { id: "deepseek-chat" }] } });
    expect(await ctx.llm.listModels("compat")).toEqual([
      { id: "deepseek-chat", contextWindow: 128_000 },
      { id: "deepseek-reasoner" },
      { id: "local-only" },
    ]);
    expect(server.requests[0].path).toBe("/v1/models");

    server.reply({ status: 404 });
    expect(await ctx.llm.listModels("compat")).toEqual([{ id: "deepseek-chat", contextWindow: 128_000 }, { id: "local-only" }]);

    server.reply({
      status: 200,
      json: {
        object: "list",
        data: [
          {
            id: "google/gemini-2.5-pro",
            name: "Gemini 2.5 Pro",
            context_length: 1_048_576,
            top_provider: { max_completion_tokens: 65_536 },
            supported_parameters: ["tools", "reasoning"],
            thinking_level: "high",
            architecture: { input_modalities: ["text", "image"] },
            pricing: { prompt: "0.00000125", completion: "0.00001" },
          },
        ],
      },
    });
    expect(await ctx.llm.listModels("compat")).toContainEqual({
      id: "google/gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      reasoning: true,
      thinkingLevel: "high",
      input: ["text", "image"],
      cost: { input: 1.25, output: 10 },
    });
  });

  it("extracts completion_tokens_details.reasoning_tokens when reported", async () => {
    const { ctx, server } = await setup();
    server.reply({
      sse: [
        'data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}',
        'data: {"usage":{"prompt_tokens":50,"completion_tokens":30,"completion_tokens_details":{"reasoning_tokens":18}}}',
        "data: [DONE]",
        "",
      ].join("\n\n"),
    });
    const result = await assemble(ctx.llm.stream(request));
    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 18,
    });
  });

  it("treats a truncated SSE stream without finish_reason or [DONE] as a retryable network drop", async () => {
    const { ctx, server } = await setup();
    server.reply(
      {
        sse: 'data: {"choices":[{"delta":{"reasoning_content":"half thought"},"finish_reason":null}]}\n\n',
      },
      { sse: fixture("reasoning-text.sse") },
    );
    const result = await assemble(ctx.llm.stream(request));
    expect(result.reason).toBe("stop");
    expect(result.message.content).toEqual([
      { type: "thinking", text: "The user wants a greeting." },
      { type: "text", text: "Hello there!" },
    ]);
    expect(server.requests).toHaveLength(2);
  });

  it("discovers per-model thinkingLevels from /models and clamps unsupported extended reasoning_effort tiers on 400", async () => {
    const { ctx, server } = await setup({ reasoningEffort: true });
    server.reply({
      status: 200,
      json: {
        data: [
          {
            id: "grok-4.7",
            name: "Grok 4.7",
            default_reasoning_effort: "high",
            supported_reasoning_efforts: ["low", "medium", "high", "xhigh", "ultra"],
          },
        ],
      },
    });

    const models = await ctx.llm.listModels("compat");
    expect(models).toEqual([
      expect.objectContaining({
        id: "grok-4.7",
        reasoning: true,
        thinkingLevel: "high",
        thinkingLevels: ["off", "low", "medium", "high", "xhigh", "ultra"],
      }),
    ]);

    // First attempt sends `reasoning_effort: "xhigh"`, upstream rejects enum value with 400 -> adapter retries clamped to `"high"`.
    server.reply(
      {
        status: 400,
        json: { error: { message: "Invalid value 'xhigh' for reasoning_effort; supported values are low, medium, high" } },
      },
      { sse: fixture("reasoning-text.sse") },
    );
    const result = await assemble(ctx.llm.stream({ ...request, model: "grok-4.7", effort: "xhigh" }));
    expect(result.reason).toBe("stop");
    expect(server.requests.slice(-2).map((req) => (req.body as { reasoning_effort?: string }).reasoning_effort)).toEqual([
      "xhigh",
      "high",
    ]);
  });
});
