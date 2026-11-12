import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { Credentials, LlmService, assemble, type LlmRequest } from "@qianji/llm";
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

  it("reads Claude's version from dated, prefixed and dotted model ids", () => {
    expect(adapter.claudeVersion("claude-opus-4-6")).toBe(46);
    expect(adapter.claudeVersion("claude-sonnet-4-5-20250929")).toBe(45);
    expect(adapter.claudeVersion("claude-opus-4-20250514")).toBe(40);
    expect(adapter.claudeVersion("us.anthropic.claude-opus-4-6-v1:0")).toBe(46);
    expect(adapter.claudeVersion("claude-opus-4-5@20251101")).toBe(45);
    expect(adapter.claudeVersion("anthropic/claude-opus-4.5")).toBe(45);
    expect(adapter.claudeVersion("claude-3-5-haiku-latest")).toBe(35);
    expect(adapter.claudeVersion("claude-3-opus-20240229")).toBe(30);
    expect(adapter.claudeVersion("claude-fable-5")).toBe(50);
    expect(adapter.claudeVersion("claude-opus-5-5")).toBe(55);
    expect(adapter.claudeVersion("deepseek-chat")).toBeUndefined();
    expect(adapter.claudeVersion("glm-4.6")).toBeUndefined();
  });

  it("keeps budget thinking for Claude 4.5 and older and for gateway models", () => {
    for (const model of ["claude-sonnet-4-5", "claude-3-7-sonnet-latest", "deepseek-chat", "MiniMax-M2"]) {
      const body = adapter.buildRequestBody({ ...request, model, effort: "medium" });
      expect(body.thinking, model).toEqual({ type: "enabled", budget_tokens: 8_192 });
      expect(body.output_config, model).toBeUndefined();
    }
  });

  it("uses adaptive thinking and effort on Claude 5, where thinking cannot be turned off", () => {
    const high = adapter.buildRequestBody({ ...request, model: "claude-opus-5-5", effort: "high", temperature: 0.5 });
    expect(high.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(high.output_config).toEqual({ effort: "high" });
    expect(high.temperature).toBeUndefined();
    expect(high.max_tokens).toBe(64_000);

    for (const effort of ["off", undefined] as const) {
      const quiet = adapter.buildRequestBody({ ...request, model: "claude-fable-5-2", ...(effort === undefined ? {} : { effort }), temperature: 0.5 });
      expect(quiet.thinking, String(effort)).toBeUndefined();
      expect(quiet.output_config, String(effort)).toEqual({ effort: "low" });
      expect(quiet.temperature, String(effort)).toBeUndefined();
    }

    expect(adapter.buildRequestBody({ ...request, model: "claude-haiku-5-5", effort: "minimal" }).output_config).toEqual({ effort: "low" });
    expect(adapter.buildRequestBody({ ...request, model: "claude-sonnet-5-5", effort: "auto" }).output_config).toBeUndefined();
    expect(adapter.buildRequestBody({ ...request, model: "claude-opus-5-5", effort: "budget:30k" }).output_config).toEqual({ effort: "xhigh" });
    expect(adapter.buildRequestBody({ ...request, model: "claude-opus-5-5", effort: "high", maxTokens: 4_000 }).max_tokens).toBe(4_000);
  });

  it("uses adaptive thinking on Claude 4.6 to 4.8, where leaving it out turns it off", () => {
    const opus48 = adapter.buildRequestBody({ ...request, model: "claude-opus-4-8", effort: "xhigh" });
    expect(opus48.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(opus48.output_config).toEqual({ effort: "xhigh" });
    const opus48Off = adapter.buildRequestBody({ ...request, model: "claude-opus-4-8", effort: "off", temperature: 0.5 });
    expect(opus48Off.thinking).toBeUndefined();
    expect(opus48Off.output_config).toBeUndefined();
    expect(opus48Off.temperature).toBeUndefined();

    // 4.6 returns summarized thinking by default, has no xhigh, and still takes a temperature.
    const sonnet46 = adapter.buildRequestBody({ ...request, model: "claude-sonnet-4-6", effort: "xhigh" });
    expect(sonnet46.thinking).toEqual({ type: "adaptive" });
    expect(sonnet46.output_config).toEqual({ effort: "high" });
    expect(adapter.buildRequestBody({ ...request, model: "claude-sonnet-4-6", temperature: 0.5 }).temperature).toBe(0.5);
  });

  it("puts cache breakpoints on the static prefix and the conversation tail of session requests", () => {
    const body = adapter.buildRequestBody({ ...request, model: "claude-opus-5-5", sessionId: "s1" });
    expect(body.system).toEqual([{ type: "text", text: "Be brief.", cache_control: { type: "ephemeral" } }]);
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages.at(-1)?.content.at(-1)).toMatchObject({ type: "tool_result", tool_use_id: "toolu_b", cache_control: { type: "ephemeral" } });
    // At most 4 breakpoints are allowed; these requests use two.
    expect(JSON.stringify(body).split("cache_control").length - 1).toBe(2);

    // Without a system prompt the tool definitions end the static prefix.
    const noSystem = adapter.buildRequestBody({ ...request, system: undefined, sessionId: "s1" });
    expect((noSystem.tools as Array<Record<string, unknown>>).at(-1)?.cache_control).toEqual({ type: "ephemeral" });

    // Thinking blocks cannot carry a breakpoint; the last earlier block that can gets it.
    const endsInThinking = adapter.buildRequestBody({
      ...request,
      sessionId: "s1",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "thinking", text: "done", signature: "sig" }] },
      ],
    });
    const tail = (endsInThinking.messages as Array<{ content: Array<Record<string, unknown>> }>).at(-1)?.content;
    expect(tail?.[0]).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });
    expect(tail?.[1]?.cache_control).toBeUndefined();
  });

  it("leaves one-off requests uncached", () => {
    const body = adapter.buildRequestBody({ ...request, model: "claude-opus-5-5" });
    expect(body.system).toBe("Be brief.");
    expect(JSON.stringify(body)).not.toContain("cache_control");
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
    server.reply({ sse: cut }, { sse: cut }, { sse: cut }, { sse: cut }, { sse: cut });
    const result = await assemble(ctx.llm.stream(request));
    expect(result.error).toMatchObject({ kind: "network", retryable: true });
    expect(server.requests).toHaveLength(5);
  });

  it("lists models with display names", async () => {
    const { ctx, server } = await setup();
    server.reply({ status: 200, json: { data: [{ id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5", type: "model" }] } });
    expect(await ctx.llm.listModels("anthropic")).toEqual([{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }]);
    expect(server.requests[0].path).toBe("/v1/models?limit=1000");
  });
});
