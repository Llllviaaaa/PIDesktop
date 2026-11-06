/**
 * Shared JSON-RPC registration contract (`ctx.rpc`).
 *
 * Plugins inject `rpc` (either directly or optionally via `ctx.inject(["rpc"], ...)`)
 * to register and dispose their own JSON-RPC methods and broadcast notifications
 * without coupling to `@pid/host` or a monolithic router.
 */
import type {} from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context {
    rpc: RpcService;
  }
}

/** An error a method handler throws to answer with a specific JSON-RPC error code. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
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

export interface RpcService {
  /** Register a JSON-RPC method; returns a disposer that unregisters it. */
  method(name: string, handler: RpcHandler): () => void;
  /** The method names this host currently answers, `initialize` included. */
  methods(): string[];
  /** Send a JSON-RPC notification to every initialized connection. */
  broadcast(method: string, params?: unknown): void;
}
