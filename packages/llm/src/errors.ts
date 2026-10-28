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

/** Pull a readable message out of a provider's JSON error body, or fall back to the raw text. */
function messageFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.error?.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON
  }
  return body.trim().slice(0, 500);
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
  if (status >= 500) return new LlmError({ kind: "server", message, status, retryable: true, retryAfter });
  if (status >= 400) return new LlmError({ kind: "invalid-request", message, status, retryable: false });
  return new LlmError({ kind: "unknown", message, status, retryable: false });
}

/** Turn anything thrown while calling a provider into an LlmError. */
export function toLlmError(error: unknown, signal?: AbortSignal): LlmError {
  if (error instanceof LlmError) return error;
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    return new LlmError({ kind: "aborted", message: "Request aborted", retryable: false });
  }
  const message = error instanceof Error ? error.message : String(error);
  // fetch rejects with a TypeError for connection failures.
  if (error instanceof TypeError) return new LlmError({ kind: "network", message, retryable: true });
  return new LlmError({ kind: "unknown", message, retryable: false });
}
