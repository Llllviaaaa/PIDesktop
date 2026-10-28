import { Context, Service } from "@deepseek-ai/cordis";
import { toLlmError, type LlmError } from "./errors.ts";
import type { FinishReason, LlmErrorInfo, LlmRequest, ModelInfo, ProviderInfo, StreamChunk, Usage } from "./types.ts";

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
  /** Total tries for a call that fails before producing any content. */
  maxAttempts?: number;
  /** First retry delay; doubles per retry. A provider's Retry-After wins. */
  baseDelayMs?: number;
}

const MAX_RETRY_DELAY_MS = 60_000;

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

/** Adapter registry plus the single streaming call surface (ADR 0007). */
export class LlmService extends Service {
  private readonly adapters = new Map<string, { info: ProviderInfo; adapter: LlmAdapter }>();
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(ctx: Context, config: LlmServiceConfig = {}) {
    super(ctx, "llm");
    this.maxAttempts = Math.max(1, config.maxAttempts ?? 3);
    this.baseDelayMs = Math.max(0, config.baseDelayMs ?? 1_000);
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
   * Stream one model call. Failures that happen before any content arrives
   * are retried when the error is retryable; the stream always ends with
   * exactly one `finish` chunk and never throws.
   */
  async *stream(request: LlmRequest, signal: AbortSignal = new AbortController().signal): AsyncGenerator<StreamChunk> {
    const started = Date.now();
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let attempts = 0;
    let finish: Extract<StreamChunk, { type: "finish" }> | undefined;

    const entry = this.adapters.get(request.provider);
    if (entry === undefined) {
      finish = { type: "finish", reason: "error", error: { kind: "invalid-request", message: `Unknown LLM provider ${request.provider}`, retryable: false } };
    }

    while (finish === undefined && entry !== undefined) {
      attempts += 1;
      const attemptRequest: LlmRequest = { ...request, messages: [...request.messages] };
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
          } else {
            producedContent = true;
          }
          yield chunk;
        }
        if (finish === undefined && !signal.aborted) {
          failure = toLlmError(new Error(`${request.provider} ended the stream without finishing`));
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
      if (!errorInfo.retryable || producedContent || attempts >= this.maxAttempts) {
        finish = { type: "finish", reason: "error", error: errorInfo };
        break;
      }
      const retryAfter = failure?.retryAfter;
      const delay = retryAfter !== undefined ? retryAfter * 1000 : this.baseDelayMs * 2 ** (attempts - 1);
      this.ctx.logger("llm").warn("%s/%s attempt %d failed (%s); retrying in %d ms", request.provider, request.model, attempts, errorInfo.message, delay);
      finish = undefined;
      await sleep(Math.min(delay, MAX_RETRY_DELAY_MS), signal);
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
  }
}
