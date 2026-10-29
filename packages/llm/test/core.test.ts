import { describe, expect, it } from "vitest";
import { BlockAssembler, LlmError, errorFromResponse, parseSse, toLlmError, type StreamChunk } from "../src/index.ts";

async function* bytes(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part);
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

describe("parseSse", () => {
  it("reads events, names, multi-line data and comments", async () => {
    const events = await collect(parseSse(bytes(": comment\n", "event: a\ndata: one\ndata: two\n\n", "data:{\"x\":1}\n\n")));
    expect(events).toEqual([{ event: "a", data: "one\ntwo" }, { data: "{\"x\":1}" }]);
  });

  it("handles CRLF and CR line ends split across chunks", async () => {
    const events = await collect(parseSse(bytes("data: a\r", "\n\r\ndata: b\r\r", "data: c")));
    expect(events).toEqual([{ data: "a" }, { data: "b" }, { data: "c" }]);
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const encoded = new TextEncoder().encode("data: 你好\n\n");
    async function* split(): AsyncGenerator<Uint8Array> {
      yield encoded.subarray(0, 8);
      yield encoded.subarray(8);
    }
    expect(await collect(parseSse(split()))).toEqual([{ data: "你好" }]);
  });
});

describe("BlockAssembler", () => {
  it("assembles text, thinking and tool calls in block order", () => {
    const assembler = new BlockAssembler();
    const chunks: StreamChunk[] = [
      { type: "usage", usage: { inputTokens: 10, outputTokens: 1 } },
      { type: "thinking-delta", index: 0, text: "hm" },
      { type: "thinking-signature", index: 0, signature: "sig" },
      { type: "tool-call-start", index: 2, id: "t1", name: "read" },
      { type: "text-delta", index: 1, text: "Hi" },
      { type: "tool-call-delta", index: 2, argumentsDelta: "{\"path\":" },
      { type: "tool-call-delta", index: 2, argumentsDelta: "\"a\"}" },
      { type: "usage", usage: { outputTokens: 9 } },
      { type: "finish", reason: "tool-use" },
    ];
    for (const chunk of chunks) assembler.push(chunk);
    expect(assembler.result()).toEqual({
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "hm", signature: "sig" },
          { type: "text", text: "Hi" },
          { type: "tool-call", id: "t1", name: "read", arguments: { path: "a" } },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 },
      reason: "tool-use",
    });
  });

  it("keeps malformed tool arguments for the loop to report", () => {
    const assembler = new BlockAssembler();
    assembler.push({ type: "tool-call-start", index: 0, id: "t", name: "x" });
    assembler.push({ type: "tool-call-delta", index: 0, argumentsDelta: "{oops" });
    assembler.push({ type: "finish", reason: "tool-use" });
    expect(assembler.result().message.content[0]).toEqual({ type: "tool-call", id: "t", name: "x", arguments: { __invalidJson: "{oops" } });
  });

  it("reports a stream that never finished as an error", () => {
    const result = new BlockAssembler().result();
    expect(result.reason).toBe("error");
    expect(result.error?.retryable).toBe(true);
  });
});

describe("errors", () => {
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });

  it("classifies HTTP statuses", async () => {
    expect((await errorFromResponse(response(401, { error: { message: "bad key" } }), "p")).kind).toBe("auth");
    const limited = await errorFromResponse(response(429, {}, { "retry-after": "7" }), "p");
    expect([limited.kind, limited.retryable, limited.retryAfter]).toEqual(["rate-limit", true, 7]);
    expect((await errorFromResponse(response(529, {}), "p")).kind).toBe("overloaded");
    expect((await errorFromResponse(response(400, { error: { message: "prompt is too long: 300000 tokens" } }), "p")).kind).toBe("context-length");
    expect((await errorFromResponse(response(400, { error: "bad" }), "p")).retryable).toBe(false);
    const server = await errorFromResponse(response(502, { message: "upstream" }), "p");
    expect([server.kind, server.retryable, server.message]).toEqual(["server", true, "p returned HTTP 502: upstream"]);
  });

  it("classifies thrown errors", () => {
    expect(toLlmError(new TypeError("fetch failed")).kind).toBe("network");
    const aborted = new AbortController();
    aborted.abort();
    expect(toLlmError(new Error("x"), aborted.signal).kind).toBe("aborted");
    const known = new LlmError({ kind: "auth", message: "m", retryable: false });
    expect(toLlmError(known)).toBe(known);
  });
});
