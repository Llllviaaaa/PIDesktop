/**
 * The RPC gateway (`rpc`): JSON-RPC 2.0 over a WebSocket at `/rpc` (ADR 0002).
 *
 * The client offers `pid.v1` and `pid.token.<token>` in Sec-WebSocket-Protocol;
 * the upgrade is refused unless the token matches the one the desktop app
 * handed this process. Every connection then has to `initialize` before any
 * other method is answered.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Context, Service } from "@deepseek-ai/cordis";
import {
  ErrorCode,
  PROTOCOL_VERSION,
  SUBPROTOCOL,
  decodeMessage,
  failure,
  isCompatibleProtocol,
  isRequest,
  readOfferedSubprotocols,
  success,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcMessage,
} from "@pid/protocol";
import { WebSocket, WebSocketServer } from "ws";
import "./web-server.ts";
import "./host-info.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    rpc: RpcGateway;
  }
}

export const RPC_PATH = "/rpc";

/** An error a method handler throws to answer with a specific code. */
export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

export interface RpcCall {
  /** Aborted when the connection that sent the request closes. */
  signal: AbortSignal;
  /** Send a notification to the connection that sent the request, while it is open. */
  notify(method: string, params?: unknown): void;
}

export type RpcHandler = (params: unknown, call: RpcCall) => unknown;

export interface RpcGatewayConfig {
  token: string;
}

interface Connection {
  socket: WebSocket;
  initialized: boolean;
  closed: AbortController;
}

function notification(method: string, params?: unknown): unknown {
  return params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
}

function sameToken(offered: string, expected: string): boolean {
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isInitializeParams(value: unknown): value is InitializeParams {
  if (typeof value !== "object" || value === null) return false;
  const params = value as Record<string, unknown>;
  const client = params.client as Record<string, unknown> | undefined;
  return typeof params.protocolVersion === "string"
    && typeof client === "object" && client !== null
    && typeof client.name === "string" && typeof client.version === "string";
}

export class RpcGateway extends Service {
  static inject = ["webServer", "hostInfo"];

  private readonly handlers = new Map<string, RpcHandler>();
  private readonly connections = new Set<Connection>();
  private readonly sockets = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });

  constructor(ctx: Context, private readonly config: RpcGatewayConfig) {
    super(ctx, "rpc");
    ctx.effect(() => ctx.webServer.registerUpgrade({
      path: RPC_PATH,
      handler: (req, socket, head) => this.upgrade(req, socket, head),
    }), "rpc: /rpc upgrade route");
    ctx.effect(() => () => {
      for (const connection of this.connections) connection.socket.terminate();
      this.sockets.close();
    }, "rpc: close connections");

    ctx.effect(() => this.method("host.ping", () => ({ pong: true })), "rpc: host.ping");
    ctx.effect(() => this.method("host.info", () => ({
      version: ctx.hostInfo.version,
      protocolVersion: ctx.hostInfo.protocolVersion,
      startedAt: ctx.hostInfo.startedAt.toISOString(),
    })), "rpc: host.info");
  }

  /** Answer `name`. Returns the disposer; register it with the calling plugin's effects. */
  method(name: string, handler: RpcHandler): () => void {
    if (name === "initialize") throw new Error("initialize is answered by the gateway itself");
    if (this.handlers.has(name)) throw new Error(`RPC method ${name} is already registered`);
    this.handlers.set(name, handler);
    return () => {
      if (this.handlers.get(name) === handler) this.handlers.delete(name);
    };
  }

  /** The method names this host answers, `initialize` included. */
  methods(): string[] {
    return ["initialize", ...[...this.handlers.keys()].sort()];
  }

  /** Send a notification to every initialized connection. */
  broadcast(method: string, params?: unknown): void {
    const frame = JSON.stringify(notification(method, params));
    for (const connection of this.connections) {
      if (connection.initialized && connection.socket.readyState === WebSocket.OPEN) connection.socket.send(frame);
    }
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const offered = readOfferedSubprotocols(req.headers["sec-websocket-protocol"]);
    if (!offered.speaksProtocol || offered.token === undefined || !sameToken(offered.token, this.config.token)) {
      // Close both directions once the response is out, as ws does when it
      // refuses a handshake: after a bare end() Node 22's built-in WebSocket
      // kept waiting and never reported the failure.
      socket.once("finish", () => socket.destroy());
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    this.sockets.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  }

  private accept(socket: WebSocket): void {
    const connection: Connection = { socket, initialized: false, closed: new AbortController() };
    this.connections.add(connection);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.send(connection, failure(null, ErrorCode.InvalidRequest, "Frames must be text"));
        return;
      }
      void this.receive(connection, data.toString());
    });
    socket.on("close", () => {
      this.connections.delete(connection);
      connection.closed.abort();
    });
  }

  private async receive(connection: Connection, text: string): Promise<void> {
    const decoded = decodeMessage(text);
    if (!decoded.ok) {
      this.send(connection, failure(decoded.id, decoded.error.code, decoded.error.message));
      return;
    }
    const message: JsonRpcMessage = decoded.message;
    // Notifications and responses from the client carry nothing the host acts on yet.
    if (!isRequest(message)) return;

    if (message.method === "initialize") {
      if (!isInitializeParams(message.params)) {
        this.send(connection, failure(message.id, ErrorCode.InvalidParams, "initialize needs protocolVersion and client"));
        return;
      }
      if (!isCompatibleProtocol(message.params.protocolVersion)) {
        this.send(connection, failure(message.id, ErrorCode.UnsupportedVersion,
          `Host speaks protocol ${PROTOCOL_VERSION}, client ${message.params.protocolVersion}`));
        return;
      }
      connection.initialized = true;
      const result: InitializeResult = {
        protocolVersion: PROTOCOL_VERSION,
        host: { version: this.ctx.hostInfo.version },
        capabilities: { methods: this.methods() },
      };
      this.send(connection, success(message.id, result));
      return;
    }

    if (!connection.initialized) {
      this.send(connection, failure(message.id, ErrorCode.NotInitialized, "Call initialize first"));
      return;
    }
    const handler = this.handlers.get(message.method);
    if (handler === undefined) {
      this.send(connection, failure(message.id, ErrorCode.MethodNotFound, `Unknown method ${message.method}`));
      return;
    }
    try {
      const notify = (method: string, params?: unknown) => this.send(connection, notification(method, params));
      const result = await handler(message.params, { signal: connection.closed.signal, notify });
      this.send(connection, success(message.id, result ?? null));
    } catch (error) {
      if (error instanceof RpcError) {
        this.send(connection, failure(message.id, error.code, error.message, error.data));
      } else {
        this.ctx.logger("rpc").error("%s failed: %s", message.method, error);
        this.send(connection, failure(message.id, ErrorCode.InternalError, "Internal error"));
      }
    }
  }

  private send(connection: Connection, message: unknown): void {
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify(message));
  }
}
