/**
 * JSON-RPC 2.0 framing: one message per WebSocket text frame, no batches
 * (ADR 0002). Decoding checks the envelope only; each method's params and
 * result are checked where the method is handled.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** JSON-RPC's own codes keep their meaning; ours sit in the server range. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  NotInitialized: -32001,
  UnsupportedVersion: -32002,
  SessionNotFound: -32010,
  SessionBusy: -32011,
  PermissionDenied: -32020,
  ProviderError: -32030,
  Aborted: -32099,
} as const;

export type ErrorCodeName = keyof typeof ErrorCode;

export type DecodeResult =
  | { ok: true; message: JsonRpcMessage }
  | { ok: false; error: JsonRpcErrorObject; id: JsonRpcId | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** Decode one frame. A failure carries the id it could read, so the caller can answer it. */
export function decodeMessage(text: string): DecodeResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, id: null, error: { code: ErrorCode.ParseError, message: "Parse error" } };
  }
  const invalid = (id: JsonRpcId | null, message: string): DecodeResult => ({
    ok: false,
    id,
    error: { code: ErrorCode.InvalidRequest, message },
  });
  if (!isRecord(value)) return invalid(null, "Message must be a JSON object");
  const id = isId(value.id) ? value.id : null;
  if (value.jsonrpc !== "2.0") return invalid(id, "jsonrpc must be \"2.0\"");

  if ("method" in value) {
    if (typeof value.method !== "string" || value.method === "") return invalid(id, "method must be a non-empty string");
    if ("params" in value && !isRecord(value.params) && !Array.isArray(value.params)) {
      return invalid(id, "params must be an object or an array");
    }
    if ("id" in value && !isId(value.id)) return invalid(null, "id must be a string or a number");
    return { ok: true, message: value as unknown as JsonRpcRequest | JsonRpcNotification };
  }

  if ("result" in value === "error" in value) return invalid(id, "A response carries exactly one of result and error");
  if ("error" in value) {
    const error = value.error;
    if (!isRecord(error) || typeof error.code !== "number" || typeof error.message !== "string") {
      return invalid(id, "error must have a numeric code and a string message");
    }
    if (value.id !== null && !isId(value.id)) return invalid(null, "id must be a string, a number or null");
    return { ok: true, message: value as unknown as JsonRpcFailure };
  }
  if (!isId(value.id)) return invalid(null, "id must be a string or a number");
  return { ok: true, message: value as unknown as JsonRpcSuccess };
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !("method" in message);
}

export function success<R>(id: JsonRpcId, result: R): JsonRpcSuccess<R> {
  return { jsonrpc: "2.0", id, result };
}

export function failure(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}
