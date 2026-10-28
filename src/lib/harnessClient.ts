import { invoke } from "@tauri-apps/api/core";
import {
  ErrorCode,
  PROTOCOL_VERSION,
  clientSubprotocols,
  decodeMessage,
  isNotification,
  isResponse,
  type InitializeResult,
  type JsonRpcErrorObject,
} from "@pid/protocol";

/** Where the desktop app's Harness Host listens, and the token its RPC gateway expects. */
export interface HarnessEndpoint {
  baseUrl: string;
  token: string;
}

/** Starts the host when it is not running (src-tauri/src/harness_host.rs). */
export function harnessEndpoint(): Promise<HarnessEndpoint> {
  return invoke<HarnessEndpoint>("harness_endpoint");
}

export class HarnessRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcErrorObject) {
    super(error.message);
    this.name = "HarnessRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export interface HarnessConnection {
  readonly host: InitializeResult;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Called with every notification the host sends; returns the unsubscribe. */
  onNotification(listener: (method: string, params: unknown) => void): () => void;
  close(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** The `/rpc` WebSocket URL for a host base URL such as `http://127.0.0.1:1234/`. */
export function rpcUrl(baseUrl: string): string {
  const url = new URL("rpc", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** Open a connection and run `initialize` (docs/adr/0002-client-protocol.md). */
export function connectHarness(
  endpoint: HarnessEndpoint,
  client: { name: string; version: string },
): Promise<HarnessConnection> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(rpcUrl(endpoint.baseUrl), clientSubprotocols(endpoint.token));
    const pending = new Map<number, Pending>();
    const listeners = new Set<(method: string, params: unknown) => void>();
    let nextId = 0;
    let opened = false;

    const failAll = (error: Error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };

    const call = <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Harness connection is closed"));
      const id = ++nextId;
      return new Promise<T>((done, fail) => {
        pending.set(id, { resolve: done as (value: unknown) => void, reject: fail });
        socket.send(JSON.stringify(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }));
      });
    };

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const decoded = decodeMessage(event.data);
      if (!decoded.ok) return;
      const message = decoded.message;
      if (isNotification(message)) {
        for (const listener of listeners) listener(message.method, message.params);
        return;
      }
      if (!isResponse(message) || typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (request === undefined) return;
      pending.delete(message.id);
      if ("error" in message) request.reject(new HarnessRpcError(message.error));
      else request.resolve(message.result);
    });

    // A refused handshake reports `error`, then `close`; the first one settles.
    const refused = () => {
      if (!opened) reject(new Error("Harness Host refused the connection"));
    };
    socket.addEventListener("error", refused);
    socket.addEventListener("close", () => {
      failAll(new HarnessRpcError({ code: ErrorCode.Aborted, message: "Harness connection closed" }));
      refused();
    });

    socket.addEventListener("open", () => {
      opened = true;
      call<InitializeResult>("initialize", { protocolVersion: PROTOCOL_VERSION, client })
        .then((host) => {
          resolve({
            host,
            call,
            onNotification(listener) {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            close: () => socket.close(),
          });
        })
        .catch((error: unknown) => {
          socket.close();
          reject(error);
        });
    });
  });
}
