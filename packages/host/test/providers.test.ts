import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Credentials, LlmService } from "@pid/llm";
import { ErrorCode } from "@pid/protocol";
import { startFakeProvider, type FakeProvider } from "../../llm/test/fake-server.ts";
import { RpcGateway, WebServer, createHost, type Host } from "../src/index.ts";
import * as providers from "../src/providers.ts";

let host: Host | undefined;
let server: FakeProvider | undefined;
let dir = "";

afterEach(async () => {
  await host?.stop();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
  host = undefined;
  server = undefined;
});

async function startWith(file: unknown): Promise<Host> {
  dir = mkdtempSync(join(tmpdir(), "pid-providers-"));
  const path = join(dir, "providers.json");
  if (file !== undefined) writeFileSync(path, typeof file === "string" ? file : JSON.stringify(file));
  host = createHost({
    version: "0",
    dataDir: dir,
    plugins: [
      [WebServer, { pageOrigins: [] }],
      [RpcGateway, { token: Buffer.alloc(32).toString("base64url") }],
      [Credentials],
      [LlmService],
      [providers, { file: path }],
    ],
  });
  await host.start();
  return host;
}

/** Call a registered RPC method the way the gateway does, without a socket. */
async function call(host: Host, method: string, params?: unknown): Promise<unknown> {
  const handler = (host.ctx.rpc as unknown as { handlers: Map<string, (p: unknown, c: { signal: AbortSignal }) => unknown> }).handlers.get(method);
  if (handler === undefined) throw new Error(`no ${method}`);
  return handler(params, { signal: new AbortController().signal });
}

describe("readProviders", () => {
  it("skips malformed and duplicate entries with a reason", () => {
    dir = mkdtempSync(join(tmpdir(), "pid-providers-"));
    const path = join(dir, "providers.json");
    writeFileSync(path, JSON.stringify({
      providers: [
        { api: "openai-compat", id: "ok", baseUrl: "https://api.example/v1", apiKey: { env: "K" } },
        { api: "openai-compat", id: "no-url" },
        { api: "gemini", id: "unknown-api" },
        { api: "anthropic", id: "bad key", apiKey: "sk-plain" },
        { api: "anthropic", id: "ok" },
        { api: "anthropic", id: "claude", apiKey: { value: "sk" }, models: [{ id: "m" }] },
      ],
    }));
    const { entries, problems } = providers.readProviders(path);
    expect(entries.map((entry) => entry.id)).toEqual(["ok", "claude"]);
    expect(problems).toEqual([
      "providers[1]: openai-compat needs a baseUrl",
      "providers[2]: api must be one of openai-compat, anthropic",
      "providers[3]: id must be letters, digits, '.', '_' or '-'",
      "providers[4]: duplicate id",
    ]);
  });

  it("treats a missing file as no providers and reports broken JSON", () => {
    dir = mkdtempSync(join(tmpdir(), "pid-providers-"));
    expect(providers.readProviders(join(dir, "none.json"))).toEqual({ entries: [], problems: [] });
    writeFileSync(join(dir, "bad.json"), "{");
    expect(providers.readProviders(join(dir, "bad.json")).problems[0]).toMatch(/not valid JSON/);
  });
});

describe("provider RPC methods", () => {
  it("lists providers without their secrets and lists models", async () => {
    server = await startFakeProvider();
    const started = await startWith({
      providers: [
        { api: "openai-compat", id: "deepseek", name: "DeepSeek", baseUrl: `${server.baseUrl}/v1`, apiKey: { value: "sk-secret" } },
        { api: "anthropic", id: "claude", apiKey: { env: "PID_TEST_ANTHROPIC" } },
      ],
    });
    const list = await call(started, "provider.list");
    expect(list).toEqual({
      providers: [
        { id: "deepseek", name: "DeepSeek", api: "openai-compat", baseUrl: `${server.baseUrl}/v1`, keySource: "stored in config" },
        { id: "claude", name: "claude", api: "anthropic", baseUrl: "https://api.anthropic.com", keySource: "environment variable PID_TEST_ANTHROPIC" },
      ],
    });
    expect(JSON.stringify(list)).not.toContain("sk-secret");

    server.reply({ status: 200, json: { data: [{ id: "deepseek-chat" }] } });
    expect(await call(started, "model.list", { provider: "deepseek" })).toEqual({ models: [{ id: "deepseek-chat" }] });
  });

  it("answers bad params and provider failures with RPC errors", async () => {
    server = await startFakeProvider();
    const started = await startWith({ providers: [{ api: "openai-compat", id: "p", baseUrl: `${server.baseUrl}/v1` }] });
    await expect(call(started, "model.list", {})).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await expect(call(started, "model.list", { provider: "nope" })).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    server.reply({ status: 401, json: { error: { message: "bad key" } } });
    await expect(call(started, "model.list", { provider: "p" })).rejects.toMatchObject({
      code: ErrorCode.ProviderError,
      data: expect.objectContaining({ kind: "auth" }),
    });
  });

  it("starts with no providers when the file is missing", async () => {
    const started = await startWith(undefined);
    expect(await call(started, "provider.list")).toEqual({ providers: [] });
  });
});
