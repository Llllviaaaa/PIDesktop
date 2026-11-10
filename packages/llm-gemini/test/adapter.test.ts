import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Credentials, LlmService, assemble } from "@qianji/llm";
import * as gemini from "../src/index.ts";

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
  return `http://127.0.0.1:${address.port}/v1beta`;
}

describe("@qianji/llm-gemini adapter", () => {
  it("builds Gemini contents with thinkingConfig, inlineData, sanitized tool schemas, and functionResponse names", () => {
    const body = gemini.buildRequestBody(
      {
        provider: "google",
        model: "gemini-2.5-pro",
        system: "Be concise.",
        effort: "medium",
        maxTokens: 4096,
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            parameters: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              additionalProperties: false,
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Inspect image and file" },
              { type: "image", mimeType: "image/png", data: "YWJj" },
            ],
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", text: "Need read_file", signature: "sig-123" },
              { type: "tool-call", id: "call-1", name: "read_file", arguments: { path: "README.md" } },
            ],
          },
          {
            role: "tool-result",
            callId: "call-1",
            isError: false,
            content: [{ type: "text", text: "# Hello" }],
          },
        ],
      },
      { id: "gemini-2.5-pro", reasoning: true },
    );

    expect(body.systemInstruction).toEqual({ parts: [{ text: "Be concise." }] });
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 4096,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 },
    });
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      },
    ]);
    expect(body.contents).toEqual([
      {
        role: "user",
        parts: [{ text: "Inspect image and file" }, { inlineData: { mimeType: "image/png", data: "YWJj" } }],
      },
      {
        role: "model",
        parts: [
          { text: "Need read_file", thought: true, thoughtSignature: "sig-123" },
          { functionCall: { id: "call-1", name: "read_file", args: { path: "README.md" } } },
        ],
      },
      {
        role: "user",
        parts: [{ functionResponse: { id: "call-1", name: "read_file", response: { output: "# Hello" } } }],
      },
    ]);
  });

  it("streams thoughts, function calls, cached tokens, and reasoningTokens, and discovers /models", async () => {
    let seenKey = "";
    let seenUrl = "";
    const baseUrl = await openMockServer((req, res) => {
      seenKey = String(req.headers["x-goog-api-key"] ?? "");
      seenUrl = req.url ?? "";
      if (seenUrl.startsWith("/v1beta/models?")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            models: [
              {
                name: "models/gemini-2.5-pro",
                displayName: "Gemini 2.5 Pro",
                inputTokenLimit: 1_048_576,
                outputTokenLimit: 65_536,
                thinking: true,
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/text-embedding-004",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
          }),
        );
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      const frames = [
        {
          candidates: [
            {
              content: {
                parts: [{ text: "Let me check git status.", thought: true, thoughtSignature: "sig-abc" }],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { id: "fc-1", name: "bash", args: { command: "git status" } } }],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 120,
            cachedContentTokenCount: 20,
            candidatesTokenCount: 30,
            thoughtsTokenCount: 45,
          },
        },
      ];
      for (const frame of frames) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      res.end();
    });

    ctx = new Context();
    await ctx.plugin(Credentials);
    await ctx.plugin(LlmService);
    await ctx.plugin(gemini, {
      providers: [{ id: "google", baseUrl, apiKey: { value: "AIza-test-key" } }],
    });

    const models = await ctx.llm.listModels("google");
    expect(seenKey).toBe("AIza-test-key");
    expect(models).toEqual([
      {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        reasoning: true,
        input: ["text", "image"],
      },
    ]);

    const assembled = await assemble(
      ctx.llm.stream({
        provider: "google",
        model: "models/gemini-2.5-pro",
        messages: [{ role: "user", content: [{ type: "text", text: "status?" }] }],
      }),
    );
    expect(seenUrl).toBe("/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse");
    expect(assembled.reason).toBe("tool-use");
    expect(assembled.message.content).toEqual([
      { type: "thinking", text: "Let me check git status.", signature: "sig-abc" },
      { type: "tool-call", id: "fc-1", name: "bash", arguments: { command: "git status" } },
    ]);
    expect(assembled.usage).toEqual({
      inputTokens: 100,
      outputTokens: 75,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      reasoningTokens: 45,
    });
  });
});
