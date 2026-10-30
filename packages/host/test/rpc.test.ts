import { afterEach, describe, expect, it } from "vitest";
import { Logger, type Context, type Exporter } from "@deepseek-ai/cordis";
import { ErrorCode, PROTOCOL_VERSION, clientSubprotocols } from "@pid/protocol";
import WebSocket from "ws";
import { RpcError, RpcGateway, WebServer, createHost, type Host } from "../src/index.ts";

const token = Buffer.alloc(32, 7).toString("base64url");
const pageOrigin = "http://tauri.localhost";
let host: Host | undefined;

afterEach(async () => {
  await host?.stop();
  host = undefined;
});

async function startHost(plugins: Array<readonly [unknown, unknown?]> = []): Promise<number> {
  host = createHost({
    version: "9.9.9-test",
    dataDir: "unused",
    plugins: [
      [WebServer, { pageOrigins: [pageOrigin] }],
      [RpcGateway, { token }],
      ...(plugins as never[]),
    ],
  });
  await host.start();
  return host.ctx.webServer.listen(0);
}

interface Client {
  socket: WebSocket;
  call(method: string, params?: unknown): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>;
  notifications: Array<{ method: string; params?: unknown }>;
}

function connect(port: number, protocols = clientSubprotocols(token), origin?: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, protocols, origin === undefined ? {} : { origin });
    const pending = new Map<number, (message: never) => void>();
    const notifications: Client["notifications"] = [];
    let next = 0;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (typeof message.id === "number" && pending.has(message.id)) {
        pending.get(message.id)?.(message as never);
        pending.delete(message.id);
      } else if ("method" in message) {
        notifications.push(message);
      }
    });
    socket.once("open", () => resolve({
      socket,
      notifications,
      call(method, params) {
        const id = ++next;
        return new Promise((done) => {
          pending.set(id, done as never);
          socket.send(JSON.stringify(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }));
        });
      },
    }));
    socket.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    socket.once("error", reject);
  });
}

const initialize = { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" } };

describe("RPC gateway", () => {
  it("refuses an upgrade without the right token", async () => {
    const port = await startHost();
    await expect(connect(port, clientSubprotocols(Buffer.alloc(32, 1).toString("base64url")))).rejects.toThrow("HTTP 401");
    await expect(connect(port, ["pid.v1"])).rejects.toThrow("HTTP 401");
  });

  it("refuses an upgrade from a foreign page", async () => {
    const port = await startHost();
    await expect(connect(port, clientSubprotocols(token), "https://evil.example")).rejects.toThrow();
  });

  it("accepts Pi Desktop's page origin", async () => {
    const port = await startHost();
    const client = await connect(port, clientSubprotocols(token), pageOrigin);
    expect(client.socket.protocol).toBe("pid.v1");
    client.socket.close();
  });

  it("answers nothing but initialize until the connection is initialized", async () => {
    const port = await startHost();
    const client = await connect(port);
    expect((await client.call("host.ping")).error?.code).toBe(ErrorCode.NotInitialized);

    const init = await client.call("initialize", initialize);
    expect(init.result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      host: { version: "9.9.9-test" },
      capabilities: { methods: expect.arrayContaining(["initialize", "host.info", "host.ping"]) },
    });
    expect((await client.call("host.ping")).result).toEqual({ pong: true });
    expect((await client.call("host.info")).result).toMatchObject({ version: "9.9.9-test", protocolVersion: PROTOCOL_VERSION });
    expect((await client.call("no.such.method")).error?.code).toBe(ErrorCode.MethodNotFound);
    client.socket.close();
  });

  it("rejects an incompatible protocol major and malformed initialize params", async () => {
    const port = await startHost();
    const client = await connect(port);
    expect((await client.call("initialize", { ...initialize, protocolVersion: "2.0" })).error?.code).toBe(ErrorCode.UnsupportedVersion);
    expect((await client.call("initialize", { protocolVersion: "1.0" })).error?.code).toBe(ErrorCode.InvalidParams);
    client.socket.close();
  });

  it("answers parse errors and binary frames", async () => {
    const port = await startHost();
    const client = await connect(port);
    const reply = new Promise<string>((resolve) => client.socket.once("message", (data) => resolve(data.toString())));
    client.socket.send("{nope");
    expect(JSON.parse(await reply).error.code).toBe(ErrorCode.ParseError);
    client.socket.close();
  });

  it("runs plugin methods, maps RpcError, and unregisters them with the plugin", async () => {
    const plugin = Object.assign((ctx: Context) => {
      ctx.effect(() => ctx.rpc.method("test.echo", (params) => params));
      ctx.effect(() => ctx.rpc.method("test.busy", () => {
        throw new RpcError(ErrorCode.SessionBusy, "busy", { sessionId: "s" });
      }));
      ctx.effect(() => ctx.rpc.method("test.crash", () => {
        throw new Error("secret detail");
      }));
    }, { inject: ["rpc"] });
    const port = await startHost();
    // Every call is traced: an id, the method, how it ended and how long it took.
    const traced: string[] = [];
    const exporter: Exporter = { levels: { default: 3 }, export: (message) => void traced.push(`${message.type} ${Logger.format(exporter, message)}`) };
    host?.ctx.logger.exporter(exporter);
    const fiber = host?.ctx.plugin(plugin);
    await fiber;
    const client = await connect(port);
    await client.call("initialize", initialize);

    expect((await client.call("test.echo", { a: 1 })).result).toEqual({ a: 1 });
    expect((await client.call("test.busy")).error).toEqual({ code: ErrorCode.SessionBusy, message: "busy", data: { sessionId: "s" } });
    expect((await client.call("test.crash")).error).toEqual({ code: ErrorCode.InternalError, message: "Internal error" });
    expect(traced).toEqual([
      expect.stringMatching(/^debug 1 test\.echo ok \d+ms$/),
      expect.stringMatching(/^debug 2 test\.busy error -?\d+ \d+ms: busy$/),
      expect.stringMatching(/^error 3 test\.crash failed \d+ms: Error: secret detail/),
    ]);

    await fiber?.dispose();
    expect((await client.call("test.echo", {})).error?.code).toBe(ErrorCode.MethodNotFound);
    client.socket.close();
  });

  it("broadcasts notifications to initialized connections only", async () => {
    const port = await startHost();
    const ready = await connect(port);
    const fresh = await connect(port);
    await ready.call("initialize", initialize);
    host?.ctx.rpc.broadcast("session/event", { seq: 1 });
    await ready.call("host.ping");
    await fresh.call("host.ping");
    expect(ready.notifications).toEqual([{ jsonrpc: "2.0", method: "session/event", params: { seq: 1 } }]);
    expect(fresh.notifications).toEqual([]);
    ready.socket.close();
    fresh.socket.close();
  });

  it("refuses to register a method twice or to take over initialize", async () => {
    await startHost();
    const rpc = host?.ctx.rpc;
    const dispose = rpc?.method("test.once", () => null);
    expect(() => rpc?.method("test.once", () => null)).toThrow("already registered");
    expect(() => rpc?.method("initialize", () => null)).toThrow();
    dispose?.();
    expect(() => rpc?.method("test.once", () => null)).not.toThrow();
  });
});
