import { Context, Service } from "@deepseek-ai/cordis";
import type { SecretRef } from "./credentials.ts";
import { LlmError, toLlmError } from "./errors.ts";
import type { Effort, FinishReason, LlmErrorInfo, LlmRequest, ModelInfo, ProviderInfo, StreamChunk, Usage } from "./types.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    llm: LlmService;
  }

  interface Events {
    /**
     * Middleware around every model call. A listener may change `request` in
     * place before calling `next()`, and may wrap the stream `next()` returns.
     */
    "llm/request"(request: LlmRequest, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>;
    /** One call finished (after any retries), with what it cost. */
    "llm/response"(response: LlmResponseInfo): void;
    /** Fired whenever an LLM wire-protocol plugin registers or unregisters on `ctx.llm`. */
    "llm/protocols-changed"(): void;
  }
}

export interface LlmAdapter {
  /**
   * Stream one call. Either yield a `finish` chunk or throw; the service turns
   * a throw into `finish { reason: "error" }`. Must stop when `signal` aborts.
   */
  stream(request: LlmRequest, signal: AbortSignal): AsyncIterable<StreamChunk>;
  /** The models the provider advertises, merged with any configured ones. */
  listModels?(signal?: AbortSignal): Promise<ModelInfo[]>;
}

export interface LlmProtocolProviderInput {
  id: string;
  name?: string;
  baseUrl?: string;
  apiKey?: SecretRef;
  headers?: Record<string, string>;
  reasoningEffort?: boolean;
  models?: ModelInfo[];
}

export interface LlmProtocolSpec {
  requiresBaseUrl?: boolean;
  defaultBaseUrl?: string;
  normalizeBaseUrl?: (baseUrl?: string) => string;
  createAdapter(ctx: Context, provider: LlmProtocolProviderInput): LlmAdapter;
}

export interface LlmResponseInfo {
  provider: string;
  model: string;
  usage: Usage;
  reason: FinishReason;
  error?: LlmErrorInfo;
  attempts: number;
  durationMs: number;
}

export interface LlmServiceConfig {
  /** Total tries for a call when retryable errors occur (default 5). */
  maxAttempts?: number;
  /** First retry delay; doubles per retry. A provider's Retry-After wins. */
  baseDelayMs?: number;
  /** Skip automatic retries when a pre-TTFB attempt hung with zero output for at least this long (default 45_000 ms). */
  maxRetryableAttemptMs?: number;
  /** Step down reasoning `effort` on retry when an active stream ran at least this long before dropping (default 60_000 ms). */
  longStreamStepDownMs?: number;
}

const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_MAX_RETRYABLE_ATTEMPT_MS = 45_000;
const DEFAULT_LONG_STREAM_STEP_DOWN_MS = 60_000;

function stepDownEffort(effort: Effort | undefined): Effort | undefined {
  if (effort === "high") return "medium";
  if (effort === "medium") return "low";
  return undefined;
}

function resetUsage(usage: Usage): void {
  usage.inputTokens = 0;
  usage.outputTokens = 0;
  usage.cacheReadTokens = 0;
  usage.cacheWriteTokens = 0;
  delete usage.reasoningTokens;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** Adapter and wire-protocol registry plus the single streaming call surface (ADR 0007). */
export class LlmService extends Service {
  private readonly adapters = new Map<string, { info: ProviderInfo; adapter: LlmAdapter }>();
  private readonly protocols = new Map<string, LlmProtocolSpec>();
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxRetryableAttemptMs: number;
  private readonly longStreamStepDownMs: number;

  constructor(ctx: Context, config: LlmServiceConfig = {}) {
    super(ctx, "llm");
    this.maxAttempts = Math.max(1, config.maxAttempts ?? 5);
    this.baseDelayMs = Math.max(0, config.baseDelayMs ?? 1_000);
    this.maxRetryableAttemptMs = Math.max(1_000, config.maxRetryableAttemptMs ?? DEFAULT_MAX_RETRYABLE_ATTEMPT_MS);
    this.longStreamStepDownMs = Math.max(1_000, config.longStreamStepDownMs ?? DEFAULT_LONG_STREAM_STEP_DOWN_MS);
  }

  /** Register a wire-protocol factory (e.g. `"openai-compat"`, `"anthropic"`, or a custom protocol plugin). */
  registerProtocol(api: string, spec: LlmProtocolSpec): () => void {
    const normalized = api.trim();
    if (normalized === "") throw new Error("LLM protocol id must be non-empty");
    this.protocols.set(normalized, spec);
    this.ctx.emit("llm/protocols-changed");
    return () => {
      if (this.protocols.get(normalized) === spec) {
        this.protocols.delete(normalized);
        this.ctx.emit("llm/protocols-changed");
      }
    };
  }

  getProtocol(api: string): LlmProtocolSpec | undefined {
    return this.protocols.get(api);
  }

  listProtocols(): string[] {
    return [...this.protocols.keys()];
  }

  instantiateProtocolAdapter(
    api: string,
    provider: LlmProtocolProviderInput,
    callerCtx?: Context,
  ): { info: ProviderInfo; adapter: LlmAdapter } | undefined {
    const spec = this.protocols.get(api);
    if (spec === undefined) return undefined;
    const baseUrl = spec.normalizeBaseUrl !== undefined
      ? spec.normalizeBaseUrl(provider.baseUrl)
      : (provider.baseUrl ?? spec.defaultBaseUrl ?? "");
    return {
      info: {
        id: provider.id,
        name: provider.name ?? provider.id,
        api,
        baseUrl,
      },
      adapter: spec.createAdapter(callerCtx ?? this.ctx, provider),
    };
  }

  /** Serve `info.id` with `adapter`. Returns the disposer; register it with the plugin's effects. */
  registerAdapter(info: ProviderInfo, adapter: LlmAdapter): () => void {
    if (this.adapters.has(info.id)) throw new Error(`LLM provider ${info.id} is already registered`);
    const entry = { info, adapter };
    this.adapters.set(info.id, entry);
    return () => {
      if (this.adapters.get(info.id) === entry) this.adapters.delete(info.id);
    };
  }

  listProviders(): ProviderInfo[] {
    return [...this.adapters.values()].map(({ info }) => ({ ...info }));
  }

  async listModels(provider: string, signal?: AbortSignal): Promise<ModelInfo[]> {
    const entry = this.adapters.get(provider);
    if (entry === undefined) throw new Error(`Unknown LLM provider ${provider}`);
    return entry.adapter.listModels === undefined ? [] : entry.adapter.listModels(signal);
  }

  /**
   * Stream one model call. Retryable failures (including mid-stream socket
   * resets or truncated SSE streams) emit a `retry` chunk so downstream
   * assemblers/UI discard partial blocks before the next attempt; the stream
   * always ends with exactly one `finish` chunk and never throws.
   */
  async *stream(request: LlmRequest, signal: AbortSignal = new AbortController().signal): AsyncGenerator<StreamChunk> {
    const started = Date.now();
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let attempts = 0;
    let currentEffort: Effort | undefined = request.effort;
    let finish: Extract<StreamChunk, { type: "finish" }> | undefined;

    const entry = this.adapters.get(request.provider);
    if (entry === undefined) {
      finish = { type: "finish", reason: "error", error: { kind: "invalid-request", message: `Unknown LLM provider ${request.provider}`, retryable: false } };
    }

    while (finish === undefined && entry !== undefined) {
      attempts += 1;
      const attemptStarted = Date.now();
      const attemptRequest: LlmRequest = {
        ...request,
        messages: [...request.messages],
        ...(currentEffort === undefined ? {} : { effort: currentEffort }),
      };
      let producedContent = false;
      let failure: LlmError | undefined;
      try {
        const source = this.ctx.waterfall("llm/request", attemptRequest, () => entry.adapter.stream(attemptRequest, signal));
        for await (const chunk of source) {
          if (chunk.type === "finish") {
            finish = chunk;
            break;
          }
          if (chunk.type === "usage") {
            for (const key of Object.keys(chunk.usage) as Array<keyof Usage>) {
              const value = chunk.usage[key];
              if (typeof value === "number") usage[key] = value;
            }
          } else if (chunk.type !== "retry") {
            producedContent = true;
          }
          yield chunk;
        }
        if (finish === undefined && !signal.aborted) {
          failure = new LlmError({
            kind: "network",
            message: `${request.provider} ended the stream before completion`,
            retryable: true,
          });
        }
      } catch (error) {
        failure = toLlmError(error, signal);
      }

      if (signal.aborted) {
        finish = { type: "finish", reason: "aborted" };
        break;
      }
      const errorInfo = failure?.toInfo() ?? (finish?.reason === "error" ? finish.error : undefined);
      if (errorInfo === undefined) break;
      const attemptElapsedMs = Date.now() - attemptStarted;
      if (
        !errorInfo.retryable
        || attempts >= this.maxAttempts
        || (!producedContent && attemptElapsedMs >= this.maxRetryableAttemptMs)
      ) {
        finish = { type: "finish", reason: "error", error: errorInfo };
        break;
      }
      let steppedEffort: Effort | undefined;
      if (producedContent && attemptElapsedMs >= this.longStreamStepDownMs) {
        const lowered = stepDownEffort(currentEffort);
        if (lowered !== undefined) {
          currentEffort = lowered;
          steppedEffort = lowered;
        }
      }
      resetUsage(usage);
      const retryAfter = failure?.retryAfter;
      const rawDelay = retryAfter !== undefined ? retryAfter * 1000 : this.baseDelayMs * 2 ** (attempts - 1);
      const delay = Math.min(rawDelay, MAX_RETRY_DELAY_MS);
      this.ctx.logger("llm").warn(
        "%s/%s attempt %d failed after %dms (%s); retrying in %d ms%s",
        request.provider,
        request.model,
        attempts,
        attemptElapsedMs,
        errorInfo.message,
        delay,
        steppedEffort === undefined ? "" : ` with effort=${steppedEffort}`,
      );
      finish = undefined;
      yield {
        type: "retry",
        attempt: attempts,
        maxAttempts: this.maxAttempts,
        delayMs: delay,
        error: errorInfo,
        ...(steppedEffort === undefined ? {} : { effort: steppedEffort }),
      };
      await sleep(delay, signal);
      if (signal.aborted) finish = { type: "finish", reason: "aborted" };
    }

    const final = finish ?? { type: "finish" as const, reason: "aborted" as const };
    yield final;
    this.ctx.emit("llm/response", {
      provider: request.provider,
      model: request.model,
      usage,
      reason: final.reason,
      ...(final.error === undefined ? {} : { error: final.error }),
      attempts,
      durationMs: Date.now() - started,
    });
    this.ctx.logger("llm").info(
      "%s/%s %s in %d out %d cache %d/%d %dms%s",
      request.provider, request.model, final.reason, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens,
      Date.now() - started, attempts > 1 ? ` after ${attempts} attempts` : "",
    );
  }
}
