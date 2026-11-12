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
} from "@qianji/protocol";

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

export function isRpcMethodNotFound(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === ErrorCode.MethodNotFound
  );
}

export interface HarnessCallOptions {
  timeoutMs?: number;
}

export interface ConnectHarnessOptions {
  connectTimeoutMs?: number;
  defaultCallTimeoutMs?: number;
}

export interface HarnessConnection {
  readonly host: InitializeResult;
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: HarnessCallOptions,
  ): Promise<T>;
  /** Called with every notification the host sends; returns the unsubscribe. */
  onNotification(listener: (method: string, params: unknown) => void): () => void;
  /** Called once when the socket closes, whichever side closed it. */
  onClose(listener: () => void): void;
  close(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

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
  options?: ConnectHarnessOptions,
): Promise<HarnessConnection> {
  const connectTimeoutMs = options?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const defaultCallTimeoutMs = options?.defaultCallTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(rpcUrl(endpoint.baseUrl), clientSubprotocols(endpoint.token));
    const pending = new Map<number, Pending>();
    const listeners = new Set<(method: string, params: unknown) => void>();
    const closeListeners = new Set<() => void>();
    let nextId = 0;
    let opened = false;
    let settledHandshake = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;

    const clearConnectTimer = () => {
      if (connectTimer !== undefined) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
    };

    const rejectHandshake = (error: unknown) => {
      if (settledHandshake) return;
      settledHandshake = true;
      clearConnectTimer();
      reject(error);
    };

    const resolveHandshake = (connection: HarnessConnection) => {
      if (settledHandshake) return;
      settledHandshake = true;
      clearConnectTimer();
      resolve(connection);
    };

    if (connectTimeoutMs > 0) {
      connectTimer = setTimeout(() => {
        if (settledHandshake) return;
        const timeoutErr = new Error(`Harness handshake timed out after ${connectTimeoutMs}ms`);
        failAll(timeoutErr);
        rejectHandshake(timeoutErr);
        try {
          socket.close();
        } catch {
          // Ignore close errors on half-open sockets.
        }
      }, connectTimeoutMs);
    }

    const failAll = (error: Error) => {
      for (const request of pending.values()) {
        if (request.timer !== undefined) clearTimeout(request.timer);
        request.reject(error);
      }
      pending.clear();
    };

    const call = <T>(
      method: string,
      params?: Record<string, unknown>,
      callOptions?: HarnessCallOptions,
    ): Promise<T> => {
      if (socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("Harness connection is closed"));
      }
      const id = ++nextId;
      const timeoutMs = callOptions?.timeoutMs ?? defaultCallTimeoutMs;
      return new Promise<T>((done, fail) => {
        const timer = timeoutMs > 0
          ? setTimeout(() => {
              const entry = pending.get(id);
              if (!entry) return;
              pending.delete(id);
              entry.reject(
                new HarnessRpcError({
                  code: ErrorCode.Aborted,
                  message: `RPC "${method}" timed out after ${timeoutMs}ms`,
                }),
              );
            }, timeoutMs)
          : undefined;
        pending.set(id, { resolve: done as (value: unknown) => void, reject: fail, timer });
        socket.send(
          JSON.stringify(
            params === undefined
              ? { jsonrpc: "2.0", id, method }
              : { jsonrpc: "2.0", id, method, params },
          ),
        );
      });
    };

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const decoded = decodeMessage(event.data);
      if (!decoded.ok) return;
      const message = decoded.message;
      if (isNotification(message)) {
        for (const listener of [...listeners]) {
          try {
            listener(message.method, message.params);
          } catch (error) {
            console.error("[harnessClient] notification listener error:", error);
          }
        }
        return;
      }
      if (!isResponse(message) || typeof message.id !== "number") return;
      const request = pending.get(message.id);
      if (request === undefined) return;
      pending.delete(message.id);
      if (request.timer !== undefined) clearTimeout(request.timer);
      if ("error" in message) request.reject(new HarnessRpcError(message.error));
      else request.resolve(message.result);
    });

    // A refused handshake reports `error`, then `close`; the first one settles.
    const refused = () => {
      if (!opened) rejectHandshake(new Error("Harness Host refused the connection"));
    };
    socket.addEventListener("error", refused);
    socket.addEventListener("close", () => {
      clearConnectTimer();
      failAll(new HarnessRpcError({ code: ErrorCode.Aborted, message: "Harness connection closed" }));
      refused();
      const snapshot = [...closeListeners];
      closeListeners.clear();
      for (const listener of snapshot) {
        try {
          listener();
        } catch (error) {
          console.error("[harnessClient] close listener error:", error);
        }
      }
    });

    socket.addEventListener("open", () => {
      opened = true;
      call<InitializeResult>(
        "initialize",
        { protocolVersion: PROTOCOL_VERSION, client },
        { timeoutMs: connectTimeoutMs },
      )
        .then((host) => {
          resolveHandshake({
            host,
            call,
            onNotification(listener) {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            onClose(listener) {
              if (socket.readyState === WebSocket.CLOSED) {
                try {
                  listener();
                } catch (error) {
                  console.error("[harnessClient] close listener error:", error);
                }
              } else {
                closeListeners.add(listener);
              }
            },
            close: () => socket.close(),
          });
        })
        .catch((error: unknown) => {
          socket.close();
          rejectHandshake(error);
        });
    });
  });
}
