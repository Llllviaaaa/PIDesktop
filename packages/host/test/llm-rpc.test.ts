/**
 * P6a: `llm.complete`, one model call without tools or a session, over the
 * WebSocket.
 */
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { LlmService } from "@pid/llm";
import { ErrorCode, PROTOCOL_VERSION, clientSubprotocols } from "@pid/protocol";
import { ScriptedProvider, errorReply, textReply, useScriptedProvider } from "@pid/testkit";
import { RpcGateway, WebServer, createHost, type Host } from "../src/index.ts";
import * as llmRpc from "../src/llm-rpc.ts";

type Json = ReturnType<typeof JSON.parse>;

const token = Buffer.alloc(32, 9).toString("base64url");
let host: Host | undefined;

afterEach(async () => {
  await host?.stop();
  host = undefined;
});

async function start(provider: ScriptedProvider, defaultModel?: { provider: string; model: string }) {
  host = createHost({
    version: "0",
    dataDir: "unused",
    plugins: [
      [WebServer, { pageOrigins: [] }],
      [RpcGateway, { token }],
      [LlmService, { maxAttempts: 1 }],
      [llmRpc, defaultModel === undefined ? {} : { defaultModel }],
      [{ name: "scripted", inject: ["llm"], apply: (ctx: never) => useScriptedProvider(ctx, provider) }],
    ],
  });
  await host.start();
  const port = await host.ctx.webServer.listen(0);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, clientSubprotocols(token));
  await new Promise((resolve, reject) => socket.once("open", resolve).once("error", reject));
  const pending = new Map<number, (message: Json) => void>();
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  let next = 0;
  const call = (method: string, params?: unknown): Promise<Json> => new Promise((done) => {
    const id = ++next;
    pending.set(id, done);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  await call("initialize", { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" } });
  return { call };
}

describe("llm.complete", () => {
  it("answers one prompt with the default model or the one given", async () => {
    const provider = new ScriptedProvider([textReply("feat: add x"), textReply("fix: y")]);
    const { call } = await start(provider, { provider: "scripted", model: "default" });

    expect((await call("llm.complete", { prompt: "Describe the diff", system: "Be brief" })).result).toEqual({ text: "feat: add x", model: { provider: "scripted", model: "default" } });
    expect(provider.requests[0]).toMatchObject({ model: "default", system: "Be brief", messages: [{ role: "user", content: [{ type: "text", text: "Describe the diff" }] }] });
    expect(provider.requests[0]?.tools).toBeUndefined();

    expect((await call("llm.complete", { prompt: "Again", provider: "scripted", model: "m2" })).result.model).toEqual({ provider: "scripted", model: "m2" });
  });

  it("reports a missing prompt, a missing model and a failed call", async () => {
    const provider = new ScriptedProvider([errorReply({ kind: "auth", message: "bad key", retryable: false })]);
    const withoutDefault = await start(provider);
    expect((await withoutDefault.call("llm.complete", {})).error.code).toBe(ErrorCode.InvalidParams);
    expect((await withoutDefault.call("llm.complete", { prompt: "x" })).error.code).toBe(ErrorCode.InvalidParams);
    const failed = await withoutDefault.call("llm.complete", { prompt: "x", provider: "scripted", model: "m" });
    expect(failed.error).toMatchObject({ code: ErrorCode.ProviderError, message: "bad key" });
  });
});
