import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Credentials, LlmService, assemble } from "@qianji/llm";
import * as openaiResponses from "../src/index.ts";

let server: ReturnType<typeof createServer> | undefined;
let ctx: Context | undefined;

afterEach(async () => {
  await ctx?.fiber.dispose();
  ctx = undefined;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function openMockServer(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("server failed to bind");
  return `http://127.0.0.1:${address.port}/v1`;
}

describe("@qianji/llm-openai-responses adapter", () => {
  it("builds Responses API request payload with reasoning effort, instructions, tools, and function_call_output", () => {
    const body = openaiResponses.buildRequestBody({
      provider: "openai",
      model: "gpt-5.2",
      system: "Follow repository conventions.",
      effort: "high",
      maxTokens: 2048,
      tools: [
        {
          name: "bash",
          description: "Run command",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "Run tests" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking now." },
            { type: "tool-call", id: "call_99", name: "bash", arguments: { command: "npm test" } },
          ],
        },
        {
          role: "tool-result",
          callId: "call_99",
          isError: false,
          content: [{ type: "text", text: "all green" }],
        },
      ],
    });

    expect(body).toEqual({
      model: "gpt-5.2",
      instructions: "Follow repository conventions.",
      stream: true,
      max_output_tokens: 2048,
      reasoning: { effort: "high", summary: "auto" },
      tools: [
        {
          type: "function",
          name: "bash",
          description: "Run command",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
      input: [
        { role: "user", content: [{ type: "input_text", text: "Run tests" }] },
        { role: "assistant", content: [{ type: "output_text", text: "Checking now." }] },
        { type: "function_call", call_id: "call_99", name: "bash", arguments: '{"command":"npm test"}' },
        { type: "function_call_output", call_id: "call_99", output: "all green" },
      ],
    });

    const cachedBody = openaiResponses.buildRequestBody({
      provider: "openai",
      model: "gpt-5.2",
      sessionId: "sess-cache-1",
      messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    });
    expect(cachedBody.prompt_cache_key).toBe("sess-cache-1");
  });

  it("streams reasoning summary deltas, text, function calls, cached tokens, and reasoningTokens", async () => {
    let authHeader = "";
    const baseUrl = await openMockServer((req, res) => {
      authHeader = String(req.headers.authorization ?? "");
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "gpt-5.2" }, { id: "o3" }] }));
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        { type: "response.reasoning_summary_text.delta", delta: "Planning step 1. " },
        { type: "response.reasoning_summary_text.delta", delta: "Calling read_file." },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { id: "fc_item_1", type: "function_call", call_id: "call_abc", name: "read" },
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          delta: '{"path":',
        },
        {
          type: "response.function_call_arguments.delta",
          output_index: 1,
          delta: '"src/App.tsx"}',
        },
        {
          type: "response.completed",
          response: {
            status: "completed",
            usage: {
              input_tokens: 500,
              output_tokens: 180,
              input_tokens_details: { cached_tokens: 200 },
              output_tokens_details: { reasoning_tokens: 110 },
            },
          },
        },
      ];
      for (const item of events) {
        res.write(`event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`);
      }
      res.end();
    });

    ctx = new Context();
    await ctx.plugin(Credentials);
    await ctx.plugin(LlmService);
    await ctx.plugin(openaiResponses, {
      providers: [{ id: "openai", baseUrl, apiKey: { value: "sk-resp-test" } }],
    });

    expect((await ctx.llm.listModels("openai")).map((m) => m.id)).toEqual(["gpt-5.2", "o3"]);
    expect(authHeader).toBe("Bearer sk-resp-test");

    const assembled = await assemble(
      ctx.llm.stream({
        provider: "openai",
        model: "gpt-5.2",
        effort: "medium",
        messages: [{ role: "user", content: [{ type: "text", text: "inspect App.tsx" }] }],
      }),
    );

    expect(assembled.reason).toBe("tool-use");
    expect(assembled.message.content).toEqual([
      { type: "thinking", text: "Planning step 1. Calling read_file." },
      { type: "tool-call", id: "call_abc", name: "read", arguments: { path: "src/App.tsx" } },
    ]);
    expect(assembled.usage).toEqual({
      inputTokens: 300,
      outputTokens: 180,
      cacheReadTokens: 200,
      cacheWriteTokens: 0,
      reasoningTokens: 110,
    });
  });
});
