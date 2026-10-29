import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import {
  Credentials,
  LlmError,
  LlmService,
  assemble,
  isSecretRef,
  type LlmAdapter,
  type LlmRequest,
  type LlmResponseInfo,
  type StreamChunk,
} from "../src/index.ts";

let root: Context | undefined;

afterEach(async () => {
  await root?.fiber.dispose();
  root = undefined;
});

async function setup(): Promise<Context> {
  root = new Context();
  await root.plugin(Credentials);
  await root.plugin(LlmService, { maxAttempts: 3, baseDelayMs: 0 });
  return root;
}

const request: LlmRequest = { provider: "fake", model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
const info = { id: "fake", name: "Fake", api: "test", baseUrl: "http://fake" };

/** An adapter whose n-th call runs the n-th script; calls past the end reuse the last. */
function scripted(...scripts: Array<(signal: AbortSignal) => AsyncGenerator<StreamChunk>>): LlmAdapter & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    stream(req, signal) {
      calls.push(req);
      return scripts[Math.min(calls.length - 1, scripts.length - 1)](signal);
    },
  };
}

async function* ok(): AsyncGenerator<StreamChunk> {
  yield { type: "usage", usage: { inputTokens: 3 } };
  yield { type: "text-delta", index: 0, text: "hello" };
  yield { type: "usage", usage: { outputTokens: 2 } };
  yield { type: "finish", reason: "stop" };
}

async function* throws(error: LlmError): AsyncGenerator<StreamChunk> {
  yield* [];
  throw error;
}

const overloaded = new LlmError({ kind: "overloaded", message: "busy", retryable: true });

describe("LlmService", () => {
  it("streams through the adapter and reports the response", async () => {
    const ctx = await setup();
    const adapter = scripted(ok);
    ctx.llm.registerAdapter(info, adapter);
    const responses: LlmResponseInfo[] = [];
    ctx.on("llm/response", (response) => void responses.push(response));

    const result = await assemble(ctx.llm.stream(request));
    expect(result.message.content).toEqual([{ type: "text", text: "hello" }]);
    expect(responses).toEqual([expect.objectContaining({
      provider: "fake",
      model: "m",
      reason: "stop",
      attempts: 1,
      usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })]);
    expect(ctx.llm.listProviders()).toEqual([info]);
  });

  it("answers an unknown provider with an error finish", async () => {
    const ctx = await setup();
    const chunks = [];
    for await (const chunk of ctx.llm.stream({ ...request, provider: "nope" })) chunks.push(chunk);
    expect(chunks).toEqual([{ type: "finish", reason: "error", error: expect.objectContaining({ kind: "invalid-request" }) }]);
  });

  it("retries a retryable failure that came before any content", async () => {
    const ctx = await setup();
    const adapter = scripted(() => throws(overloaded), ok);
    ctx.llm.registerAdapter(info, adapter);
    const result = await assemble(ctx.llm.stream(request));
    expect(result.reason).toBe("stop");
    expect(adapter.calls).toHaveLength(2);
  });

  it("retries an error finish from the adapter as well as a throw", async () => {
    const ctx = await setup();
    async function* errorFinish(): AsyncGenerator<StreamChunk> {
      yield { type: "finish", reason: "error", error: overloaded.toInfo() };
    }
    const adapter = scripted(errorFinish, ok);
    ctx.llm.registerAdapter(info, adapter);
    expect((await assemble(ctx.llm.stream(request))).reason).toBe("stop");
  });

  it("gives up after maxAttempts", async () => {
    const ctx = await setup();
    const adapter = scripted(() => throws(overloaded));
    ctx.llm.registerAdapter(info, adapter);
    const result = await assemble(ctx.llm.stream(request));
    expect(result.reason).toBe("error");
    expect(result.error?.kind).toBe("overloaded");
    expect(adapter.calls).toHaveLength(3);
  });

  it("does not retry non-retryable errors or failures after content", async () => {
    const ctx = await setup();
    const auth = scripted(() => throws(new LlmError({ kind: "auth", message: "no", retryable: false })));
    ctx.llm.registerAdapter(info, auth);
    expect((await assemble(ctx.llm.stream(request))).error?.kind).toBe("auth");
    expect(auth.calls).toHaveLength(1);

    async function* halfThenFail(): AsyncGenerator<StreamChunk> {
      yield { type: "text-delta", index: 0, text: "par" };
      throw overloaded;
    }
    const half = scripted(halfThenFail);
    ctx.llm.registerAdapter({ ...info, id: "half" }, half);
    const result = await assemble(ctx.llm.stream({ ...request, provider: "half" }));
    expect(result.reason).toBe("error");
    expect(result.message.content).toEqual([{ type: "text", text: "par" }]);
    expect(half.calls).toHaveLength(1);
  });

  it("finishes as aborted when the signal fires", async () => {
    const ctx = await setup();
    const controller = new AbortController();
    async function* slow(signal: AbortSignal): AsyncGenerator<StreamChunk> {
      yield { type: "text-delta", index: 0, text: "a" };
      controller.abort();
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
    }
    ctx.llm.registerAdapter(info, scripted(slow));
    const result = await assemble(ctx.llm.stream(request, controller.signal));
    expect(result.reason).toBe("aborted");
  });

  it("runs llm/request middleware around the call", async () => {
    const ctx = await setup();
    const adapter = scripted(ok);
    ctx.llm.registerAdapter(info, adapter);
    ctx.on("llm/request", (req, next) => {
      req.system = "injected";
      const inner = next();
      return (async function* () {
        for await (const chunk of inner) {
          yield chunk.type === "text-delta" ? { ...chunk, text: chunk.text.toUpperCase() } : chunk;
        }
      })();
    });
    const result = await assemble(ctx.llm.stream(request));
    expect(adapter.calls[0].system).toBe("injected");
    expect(request.system).toBeUndefined();
    expect(result.message.content).toEqual([{ type: "text", text: "HELLO" }]);
  });

  it("unregisters an adapter with its disposer and refuses duplicates", async () => {
    const ctx = await setup();
    const dispose = ctx.llm.registerAdapter(info, scripted(ok));
    expect(() => ctx.llm.registerAdapter(info, scripted(ok))).toThrow("already registered");
    dispose();
    expect(ctx.llm.listProviders()).toEqual([]);
  });
});

describe("Credentials", () => {
  it("resolves value, env and store refs", async () => {
    const ctx = await setup();
    process.env.PID_TEST_SECRET = "from-env";
    try {
      expect(await ctx.credentials.resolve({ value: "v" })).toBe("v");
      expect(await ctx.credentials.resolve({ env: "PID_TEST_SECRET" })).toBe("from-env");
      expect(await ctx.credentials.resolve({ env: "PID_TEST_MISSING" })).toBeUndefined();
      expect(await ctx.credentials.resolve(undefined)).toBeUndefined();
      await expect(ctx.credentials.resolve({ secret: "id" })).rejects.toThrow("No secret store");
      const dispose = ctx.credentials.registerStore(async (id) => `stored:${id}`);
      expect(await ctx.credentials.resolve({ secret: "id" })).toBe("stored:id");
      dispose();
    } finally {
      delete process.env.PID_TEST_SECRET;
    }
  });

  it("recognizes refs and describes them without the secret", async () => {
    const ctx = await setup();
    expect(isSecretRef({ env: "X" })).toBe(true);
    expect(isSecretRef({ env: "X", value: "y" })).toBe(false);
    expect(isSecretRef({ key: "x" })).toBe(false);
    expect(ctx.credentials.describe({ value: "sk-secret" })).not.toContain("sk-secret");
  });
});
