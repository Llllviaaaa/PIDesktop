/**
 * P5c: providers.json edited from the settings page, with typed keys kept
 * in secrets.dat and never in the file.
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Credentials } from "@pid/llm";
import { PROTOCOL_VERSION, clientSubprotocols, ErrorCode } from "@pid/protocol";
import { RpcGateway, WebServer, createHost, type Host } from "../src/index.ts";
import * as providerAdmin from "../src/provider-admin.ts";
import { keyRef } from "../src/provider-admin.ts";
import { readSecretFile, type SecretCodec } from "../src/secrets.ts";

type Json = ReturnType<typeof JSON.parse>;

const token = Buffer.alloc(32, 7).toString("base64url");
const secretId = (provider: string) => `provider/${provider}`;
const codec: SecretCodec = {
  protect: (data) => Buffer.from(data.map((byte) => byte ^ 0x5a)),
  unprotect: (data) => Buffer.from(data.map((byte) => byte ^ 0x5a)),
};

let host: Host | undefined;
let server: Server | undefined;
let dir = "";

afterEach(async () => {
  await host?.stop();
  host = undefined;
  server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function start() {
  dir = mkdtempSync(join(tmpdir(), "pid-provider-admin-"));
  const reloads: number[] = [];
  host = createHost({
    version: "0",
    dataDir: dir,
    plugins: [
      [WebServer, { pageOrigins: [] }],
      [RpcGateway, { token }],
      [Credentials],
      [providerAdmin, { file: join(dir, "providers.json"), secretsFile: join(dir, "secrets.dat"), codec, reload: async () => void reloads.push(1) }],
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
  return { call, reloads };
}

const fileOf = () => JSON.parse(readFileSync(join(dir, "providers.json"), "utf8"));

describe("provider administration", () => {
  it("store a typed key in secrets.dat, and keep, rename and delete it with the provider", async () => {
    const { call, reloads } = await start();
    const saved = await call("provider.save", { provider: { id: "ds", baseUrl: "https://api.example.com/v1", api: "openai-compat", apiKey: "sk-typed", models: [{ id: "m1" }] } });
    expect(saved.result.provider).toMatchObject({ id: "ds", keySource: "stored" });
    expect(readFileSync(join(dir, "providers.json"), "utf8")).not.toContain("sk-typed");
    expect(fileOf().providers[0].apiKey).toEqual({ secret: secretId("ds") });
    expect(readSecretFile(join(dir, "secrets.dat"), codec)).toEqual({ [secretId("ds")]: "sk-typed" });
    expect(reloads).toHaveLength(1);

    const again = await call("provider.save", { provider: { id: "ds", api: "openai-compat", baseUrl: "https://x/v1" } });
    expect(again.error.code).toBe(ErrorCode.InvalidParams);

    await call("provider.save", { provider: { originalId: "ds", id: "deep", baseUrl: "https://api.example.com/v1", api: "openai-compat", apiKey: "", keepExistingApiKey: true } });
    expect(readSecretFile(join(dir, "secrets.dat"), codec)).toEqual({ [secretId("deep")]: "sk-typed" });
    expect((await call("provider.configs")).result.providers).toEqual([{ api: "openai-compat", id: "deep", baseUrl: "https://api.example.com/v1", keySource: "stored" }]);

    await call("provider.save", { provider: { originalId: "deep", id: "deep", baseUrl: "https://api.example.com/v1", api: "openai-compat", apiKey: "$DEEP_KEY" } });
    expect(fileOf().providers[0].apiKey).toEqual({ env: "DEEP_KEY" });
    expect(readSecretFile(join(dir, "secrets.dat"), codec)).toEqual({});

    await call("provider.delete", { id: "deep" });
    expect(fileOf().providers).toEqual([]);
    expect((await call("provider.delete", { id: "deep" })).error.code).toBe(ErrorCode.InvalidParams);
    expect(reloads).toHaveLength(4);
  });

  it("discover models with a typed key without saving anything", async () => {
    const { call } = await start();
    const seen: Array<string | undefined> = [];
    const fake = createServer((request, response) => {
      seen.push(request.headers.authorization);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "b" }, { id: "a" }] }));
    });
    server = fake;
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const address = fake.address() as { port: number };
    const found = await call("provider.discover", { provider: { id: "local", baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-compat", apiKey: "sk-try" } });
    expect(found.result.models).toEqual([{ id: "a" }, { id: "b" }]);
    expect(seen).toEqual(["Bearer sk-try"]);
    expect(existsSync(join(dir, "providers.json"))).toBe(false);
    expect(existsSync(join(dir, "secrets.dat"))).toBe(false);
  });

  it("read $VAR keys as environment references and refuse key commands", () => {
    expect(keyRef("$OPENAI_KEY")).toEqual({ env: "OPENAI_KEY" });
    expect(keyRef("${OPENAI_KEY}")).toEqual({ env: "OPENAI_KEY" });
    expect(keyRef("sk-1")).toBe("secret");
    expect(() => keyRef("!pass show key")).toThrow(/key commands/);
  });
});
