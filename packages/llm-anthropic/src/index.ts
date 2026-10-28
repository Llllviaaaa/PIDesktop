/**
 * LLM adapter for the Anthropic Messages API (`POST {baseUrl}/v1/messages`
 * with `stream: true`), and for gateways that speak it.
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  LlmError,
  getJson,
  joinUrl,
  postSse,
  type Effort,
  type FinishReason,
  type LlmAdapter,
  type LlmErrorKind,
  type LlmRequest,
  type Message,
  type ModelInfo,
  type SecretRef,
  type StreamChunk,
} from "@pid/llm";

export const name = "pid-llm-anthropic";
export const inject = ["llm", "credentials"];

export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
/** The Messages API requires max_tokens; used when neither request nor model sets one. */
const DEFAULT_MAX_TOKENS = 8_192;
const THINKING_BUDGET: Record<Exclude<Effort, "off">, number> = { low: 2_048, medium: 8_192, high: 24_576 };

export interface ProviderConfig {
  id: string;
  name?: string;
  /** Without the version path; defaults to https://api.anthropic.com. */
  baseUrl?: string;
  apiKey?: SecretRef;
  headers?: Record<string, string>;
  models?: ModelInfo[];
}

export interface Config {
  providers: ProviderConfig[];
}

type WireBlock = Record<string, unknown>;
type WireMessage = { role: "user" | "assistant"; content: WireBlock[] };

function toWireMessages(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = [];
  const push = (role: WireMessage["role"], blocks: WireBlock[]) => {
    if (blocks.length === 0) return;
    // The API wants alternating roles; tool results ride in user turns.
    const last = wire.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else wire.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === "user") {
      push("user", message.content.map((block) => block.type === "text"
        ? { type: "text", text: block.text }
        : { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }));
    } else if (message.role === "assistant") {
      push("assistant", message.content.flatMap((block): WireBlock[] => {
        if (block.type === "text") return block.text === "" ? [] : [{ type: "text", text: block.text }];
        if (block.type === "tool-call") return [{ type: "tool_use", id: block.id, name: block.name, input: block.arguments }];
        if (block.redacted !== undefined) return [{ type: "redacted_thinking", data: block.redacted }];
        // Thinking without its signature cannot be sent back (it came from another provider).
        return block.signature === undefined ? [] : [{ type: "thinking", thinking: block.text, signature: block.signature }];
      }));
    } else {
      push("user", [{
        type: "tool_result",
        tool_use_id: message.callId,
        is_error: message.isError,
        content: message.content.map((block) => block.type === "text"
          ? { type: "text", text: block.text }
          : { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }),
      }]);
    }
  }
  return wire;
}

export function buildRequestBody(request: LlmRequest, model?: ModelInfo): Record<string, unknown> {
  let maxTokens = request.maxTokens ?? model?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toWireMessages(request.messages),
    stream: true,
  };
  if (request.system) body.system = request.system;
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  }
  if (request.effort !== undefined && request.effort !== "off") {
    const budget = THINKING_BUDGET[request.effort];
    // budget_tokens must stay below max_tokens.
    if (maxTokens <= budget) maxTokens = budget + DEFAULT_MAX_TOKENS;
    body.thinking = { type: "enabled", budget_tokens: budget };
  } else if (request.temperature !== undefined) {
    // Extended thinking does not accept a temperature.
    body.temperature = request.temperature;
  }
  body.max_tokens = maxTokens;
  return body;
}

const STOP_REASONS: Record<string, FinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  pause_turn: "stop",
  max_tokens: "length",
  tool_use: "tool-use",
  refusal: "refusal",
};

const STREAM_ERRORS: Record<string, { kind: LlmErrorKind; retryable: boolean }> = {
  overloaded_error: { kind: "overloaded", retryable: true },
  rate_limit_error: { kind: "rate-limit", retryable: true },
  api_error: { kind: "server", retryable: true },
  authentication_error: { kind: "auth", retryable: false },
  permission_error: { kind: "auth", retryable: false },
  invalid_request_error: { kind: "invalid-request", retryable: false },
};

interface WireEvent {
  type?: string;
  index?: number;
  message?: { usage?: WireUsage };
  content_block?: { type?: string; id?: string; name?: string; text?: string; thinking?: string; data?: string };
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string | null };
  usage?: WireUsage;
  error?: { type?: string; message?: string };
}

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

function usageChunk(usage: WireUsage): StreamChunk {
  const chunk: { type: "usage"; usage: Record<string, number> } = { type: "usage", usage: {} };
  if (usage.input_tokens !== undefined) chunk.usage.inputTokens = usage.input_tokens;
  if (usage.output_tokens !== undefined) chunk.usage.outputTokens = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === "number") chunk.usage.cacheReadTokens = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === "number") chunk.usage.cacheWriteTokens = usage.cache_creation_input_tokens;
  return chunk;
}

/** Translate the Messages API SSE stream into StreamChunks. Exported for the tests. */
export async function* translateStream(events: AsyncIterable<{ event?: string; data: string }>, providerId: string): AsyncGenerator<StreamChunk> {
  let reason: FinishReason | undefined;
  let stopped = false;
  for await (const sse of events) {
    let event: WireEvent;
    try {
      event = JSON.parse(sse.data) as WireEvent;
    } catch {
      throw new LlmError({ kind: "unknown", message: `${providerId} sent malformed stream data`, retryable: false });
    }
    const index = event.index ?? 0;
    switch (event.type) {
      case "message_start":
        if (event.message?.usage) yield usageChunk(event.message.usage);
        break;
      case "content_block_start": {
        const block = event.content_block ?? {};
        if (block.type === "tool_use") yield { type: "tool-call-start", index, id: block.id ?? `toolu_${index}`, name: block.name ?? "" };
        else if (block.type === "redacted_thinking") yield { type: "thinking-redacted", index, data: block.data ?? "" };
        else if (block.type === "thinking" && block.thinking) yield { type: "thinking-delta", index, text: block.thinking };
        else if (block.type === "text" && block.text) yield { type: "text-delta", index, text: block.text };
        break;
      }
      case "content_block_delta": {
        const delta = event.delta ?? {};
        if (delta.type === "text_delta" && delta.text) yield { type: "text-delta", index, text: delta.text };
        else if (delta.type === "thinking_delta" && delta.thinking) yield { type: "thinking-delta", index, text: delta.thinking };
        else if (delta.type === "signature_delta" && delta.signature) yield { type: "thinking-signature", index, signature: delta.signature };
        else if (delta.type === "input_json_delta" && delta.partial_json) yield { type: "tool-call-delta", index, argumentsDelta: delta.partial_json };
        break;
      }
      case "message_delta":
        if (typeof event.delta?.stop_reason === "string") reason = STOP_REASONS[event.delta.stop_reason] ?? "stop";
        if (event.usage) yield usageChunk(event.usage);
        break;
      case "message_stop":
        stopped = true;
        break;
      case "error": {
        const known = STREAM_ERRORS[event.error?.type ?? ""] ?? { kind: "unknown" as const, retryable: false };
        throw new LlmError({ ...known, message: `${providerId}: ${event.error?.message ?? event.error?.type ?? "stream error"}` });
      }
      default:
        // ping and future event types
        break;
    }
    if (stopped) break;
  }
  if (!stopped) throw new LlmError({ kind: "network", message: `${providerId} closed the stream before message_stop`, retryable: true });
  yield { type: "finish", reason: reason ?? "stop" };
}

export class AnthropicAdapter implements LlmAdapter {
  private readonly baseUrl: string;

  constructor(private readonly ctx: Context, private readonly provider: ProviderConfig) {
    this.baseUrl = provider.baseUrl ?? DEFAULT_BASE_URL;
  }

  private async headers(): Promise<Record<string, string>> {
    const key = await this.ctx.credentials.resolve(this.provider.apiKey);
    return { "anthropic-version": ANTHROPIC_VERSION, ...(key === undefined ? {} : { "x-api-key": key }), ...this.provider.headers };
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const model = this.provider.models?.find((candidate) => candidate.id === request.model);
    const events = postSse(joinUrl(this.baseUrl, "v1/messages"), await this.headers(), buildRequestBody(request, model), signal, this.provider.id);
    yield* translateStream(events, this.provider.id);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const configured = this.provider.models ?? [];
    let discovered: ModelInfo[] = [];
    try {
      const body = await getJson(joinUrl(this.baseUrl, "v1/models?limit=1000"), await this.headers(), this.provider.id, signal) as {
        data?: Array<{ id?: unknown; display_name?: unknown }>;
      };
      discovered = (body.data ?? []).flatMap((model) => (typeof model.id === "string"
        ? [{ id: model.id, ...(typeof model.display_name === "string" ? { name: model.display_name } : {}) }]
        : []));
    } catch (error) {
      if (configured.length === 0) throw error;
    }
    const byId = new Map(discovered.map((model) => [model.id, model]));
    for (const model of configured) byId.set(model.id, { ...byId.get(model.id), ...model });
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

export function apply(ctx: Context, config: Config): void {
  for (const provider of config.providers) {
    ctx.effect(() => ctx.llm.registerAdapter(
      { id: provider.id, name: provider.name ?? provider.id, api: "anthropic", baseUrl: provider.baseUrl ?? DEFAULT_BASE_URL },
      new AnthropicAdapter(ctx, provider),
    ), `${name}: ${provider.id}`);
  }
}
