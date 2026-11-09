import type { LlmErrorInfo, LlmErrorKind } from "./types.ts";

export class LlmError extends Error implements LlmErrorInfo {
  readonly kind: LlmErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  /** Seconds the provider asked us to wait, from Retry-After. */
  readonly retryAfter?: number;

  constructor(info: LlmErrorInfo & { retryAfter?: number }) {
    super(info.message);
    this.name = "LlmError";
    this.kind = info.kind;
    this.status = info.status;
    this.retryable = info.retryable;
    this.retryAfter = info.retryAfter;
  }

  toInfo(): LlmErrorInfo {
    return this.status === undefined
      ? { kind: this.kind, message: this.message, retryable: this.retryable }
      : { kind: this.kind, message: this.message, status: this.status, retryable: this.retryable };
  }
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, (date - Date.now()) / 1000);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pull a readable message out of a provider's JSON or HTML error body, or fall back to raw text. */
export function messageFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.error?.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON
  }
  const trimmed = body.trim();
  if (/^(?:<!doctype\s+html|<html\b|<head\b|<!--)/i.test(trimmed) || /<title[^>]*>[\s\S]*?<\/title>/i.test(trimmed)) {
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(trimmed);
    const title = titleMatch?.[1] ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, " ")) : "";
    if (title !== "") return title.slice(0, 240);
    const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(trimmed);
    const heading = h1Match?.[1] ? decodeHtmlEntities(h1Match[1].replace(/<[^>]+>/g, " ")) : "";
    if (heading !== "") return heading.slice(0, 240);
    const stripped = decodeHtmlEntities(
      trimmed
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<(?:script|style)[^>]*>[\s\S]*?<\/(?:script|style)>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    );
    return stripped.slice(0, 240);
  }
  return trimmed.slice(0, 500);
}

/** Classify a non-2xx HTTP response the way every adapter should. */
export async function errorFromResponse(response: Response, provider: string): Promise<LlmError> {
  const body = await response.text().catch(() => "");
  const detail = messageFromBody(body) || response.statusText;
  const status = response.status;
  const message = `${provider} returned HTTP ${status}${detail ? `: ${detail}` : ""}`;
  const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
  if (status === 401 || status === 403) return new LlmError({ kind: "auth", message, status, retryable: false });
  if (status === 429) return new LlmError({ kind: "rate-limit", message, status, retryable: true, retryAfter });
  if (status === 529 || status === 503) return new LlmError({ kind: "overloaded", message, status, retryable: true, retryAfter });
  if (status === 413 || /context.{0,20}(length|window)|too many tokens|prompt is too long/i.test(detail)) {
    return new LlmError({ kind: "context-length", message, status, retryable: false });
  }
  // HTTP 524 is Cloudflare's Origin Timeout (~100-125s wait for TTFB); blindly retrying multiplies into an 8-minute freeze.
  if (status === 524) return new LlmError({ kind: "server", message, status, retryable: false });
  if (status >= 500) return new LlmError({ kind: "server", message, status, retryable: true, retryAfter });
  if (status >= 400) return new LlmError({ kind: "invalid-request", message, status, retryable: false });
  return new LlmError({ kind: "unknown", message, status, retryable: false });
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "SocketClosed",
  "ConnectionRefused",
]);

const NETWORK_MESSAGE_RE =
  /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET)\b|socket connection was closed|ended the stream|stream ended before|premature close|other side closed|fetch failed|network error|terminated/i;

function cleanFetchMessage(raw: string): string {
  return raw
    .replace(/\s*For more information,\s*pass\s*`?verbose:\s*true`?\s*in the second argument to fetch\(\)\.?/gi, "")
    .trim();
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string" && direct !== "") return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null) {
    const nested = (cause as { code?: unknown }).code;
    if (typeof nested === "string" && nested !== "") return nested;
  }
  return undefined;
}

/** Turn anything thrown while calling a provider into an LlmError. */
export function toLlmError(error: unknown, signal?: AbortSignal): LlmError {
  if (error instanceof LlmError) return error;
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return new LlmError({ kind: "aborted", message: "Request aborted", retryable: false });
  }
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = cleanFetchMessage(rawMessage) || rawMessage;
  const code = errorCodeOf(error);
  // fetch rejects with a TypeError in Node/Bun, or an Error carrying a socket/transport code or stream-drop message.
  if (
    error instanceof TypeError
    || (code !== undefined && NETWORK_ERROR_CODES.has(code))
    || NETWORK_MESSAGE_RE.test(rawMessage)
  ) {
    return new LlmError({ kind: "network", message, retryable: true });
  }
  return new LlmError({ kind: "unknown", message, retryable: false });
}
