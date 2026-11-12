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
  type LlmProtocolSpec,
  type LlmRequest,
  type Message,
  type ModelInfo,
  type SecretRef,
  type StreamChunk,
} from "@qianji/llm";

export const name = "qianji-llm-anthropic";
export const inject = ["llm", "credentials"];

export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
/** The Messages API requires max_tokens; used when neither request nor model sets one. */
const DEFAULT_MAX_TOKENS = 8_192;
/**
 * The default for Claude 4.6 and later, whose adaptive thinking shares max_tokens
 * with the answer. Requests stream, so a high cap costs nothing until it is used.
 */
const ADAPTIVE_DEFAULT_MAX_TOKENS = 64_000;
const THINKING_BUDGET: Record<string, number> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 24_576,
  xhigh: 32_768,
  max: 64_000,
  auto: 16_384,
};

export function resolveThinkingBudget(effort: Effort): number {
  const normalized = effort.trim().toLowerCase();
  if (normalized in THINKING_BUDGET) return THINKING_BUDGET[normalized] as number;
  const numericMatch = /^(?:budget:)?(\d+)(k)?$/.exec(normalized);
  if (numericMatch) {
    const base = Number(numericMatch[1]);
    const tokens = numericMatch[2] ? base * 1_024 : base;
    if (Number.isFinite(tokens) && tokens > 0) return Math.max(1_024, Math.round(tokens));
  }
  return THINKING_BUDGET.medium as number;
}

/**
 * How a model takes thinking parameters, by Anthropic's per-model rules:
 *
 * - `budget`: `thinking: {type: "enabled", budget_tokens}`. Claude 4.5 and older,
 *   and every id that is not a Claude id (gateways that speak this API implement
 *   that shape).
 * - `adaptive`: Claude 4.6 to 4.x. `thinking: {type: "adaptive"}` with
 *   `output_config.effort`; `budget_tokens` is deprecated on 4.6 and rejected from
 *   4.7. Leaving `thinking` out runs without thinking.
 * - `always-on`: Claude 5 and later (Opus, Sonnet, Haiku, Fable, Mythos). Thinking
 *   always runs and `budget_tokens` is rejected, so effort is the only control.
 *
 * From 4.7 on, thinking text comes back empty unless `display: "summarized"` asks
 * for it, and sampling parameters such as `temperature` are rejected.
 */
export interface ThinkingStyle {
  mode: "budget" | "adaptive" | "always-on";
  /** The `output_config.effort` levels the model accepts. */
  efforts: readonly string[];
  /** Ask for summarized thinking text, which is otherwise omitted. */
  summarize: boolean;
  /** Whether `temperature` may be sent. */
  temperature: boolean;
}

const EFFORTS_4_6 = ["low", "medium", "high", "max"] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Claude's version in tenths (`claude-opus-4-6` is 46, `claude-fable-5` is 50), or
 * undefined for an id that is not a Claude id. Accepts dated, platform-prefixed and
 * dotted forms: `claude-sonnet-4-5-20250929`, `us.anthropic.claude-opus-4-6-v1:0`,
 * `claude-opus-4-5@20251101`, `anthropic/claude-opus-4.5`, `claude-3-5-haiku-latest`.
 */
export function claudeVersion(modelId: string): number | undefined {
  const id = modelId.toLowerCase();
  const match = /claude-[a-z]+-(\d+)(?:[-.](\d)(?!\d))?/.exec(id) ?? /claude-(\d+)(?:-(\d)(?!\d))?-[a-z]/.exec(id);
  if (match === null) return undefined;
  return Number(match[1]) * 10 + (match[2] === undefined ? 0 : Number(match[2]));
}

export function thinkingStyle(modelId: string): ThinkingStyle {
  const version = claudeVersion(modelId);
  if (version === undefined || version < 46) return { mode: "budget", efforts: [], summarize: false, temperature: true };
  if (version < 47) return { mode: "adaptive", efforts: EFFORTS_4_6, summarize: false, temperature: true };
  if (version < 50) return { mode: "adaptive", efforts: EFFORTS, summarize: true, temperature: false };
  return { mode: "always-on", efforts: EFFORTS, summarize: true, temperature: false };
}

/**
 * The `output_config.effort` for an effort setting on an adaptive model, or
 * undefined to leave the model's default. Budgets map to the level whose budget
 * (see THINKING_BUDGET) covers them; `xhigh` falls back to `high` where it is missing.
 */
export function resolveAdaptiveEffort(effort: Effort, efforts: readonly string[]): string | undefined {
  const normalized = effort.trim().toLowerCase();
  let level: string | undefined;
  if (normalized === "minimal") level = "low";
  else if (EFFORTS.some((candidate) => candidate === normalized)) level = normalized;
  else if (/^(?:budget:)?\d+k?$/.test(normalized)) {
    const tokens = resolveThinkingBudget(normalized);
    level = tokens <= 2_048 ? "low" : tokens <= 8_192 ? "medium" : tokens <= 24_576 ? "high" : tokens <= 32_768 ? "xhigh" : "max";
  }
  if (level === undefined) return undefined;
  if (efforts.includes(level)) return level;
  return level === "xhigh" && efforts.includes("high") ? "high" : undefined;
}

const EPHEMERAL = { type: "ephemeral" } as const;
/** Content blocks that may carry `cache_control`; thinking blocks may not. */
const CACHEABLE_BLOCKS = new Set(["text", "image", "tool_use", "tool_result", "document"]);

/** Put a cache breakpoint on the last block that can take one, so the next request reads the history from cache. */
function markConversationTail(messages: WireMessage[]): void {
  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const content = messages[m]?.content ?? [];
    for (let b = content.length - 1; b >= 0; b -= 1) {
      const block = content[b];
      if (block !== undefined && CACHEABLE_BLOCKS.has(String(block.type))) {
        content[b] = { ...block, cache_control: EPHEMERAL };
        return;
      }
    }
  }
}

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
  providers?: ProviderConfig[];
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

/**
 * The Messages API request for `request`.
 *
 * Prompt caching is opt-in on this API. Requests that belong to a session are sent
 * again with a longer history, so they get two breakpoints: one at the end of the
 * static prefix (tools and system prompt) and one on the last block of the
 * conversation. One-off calls such as titles and compaction summaries are not sent
 * again, so they get none; a breakpoint there would only add the cache-write premium.
 */
export function buildRequestBody(request: LlmRequest, model?: ModelInfo): Record<string, unknown> {
  const style = thinkingStyle(request.model);
  let maxTokens = request.maxTokens ?? model?.maxOutputTokens
    ?? (style.mode === "budget" ? DEFAULT_MAX_TOKENS : ADAPTIVE_DEFAULT_MAX_TOKENS);
  const cache = request.sessionId !== undefined;
  const messages = toWireMessages(request.messages);
  if (cache) markConversationTail(messages);
  const body: Record<string, unknown> = { model: request.model, messages, stream: true };
  if (request.system) {
    body.system = cache ? [{ type: "text", text: request.system, cache_control: EPHEMERAL }] : request.system;
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    const tools: WireBlock[] = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    const lastTool = tools.at(-1);
    if (cache && !request.system && lastTool !== undefined) tools[tools.length - 1] = { ...lastTool, cache_control: EPHEMERAL };
    body.tools = tools;
  }

  const effort = request.effort;
  const thinks = effort !== undefined && effort !== "off" && model?.reasoning !== false;
  if (style.mode === "budget") {
    if (thinks) {
      const budget = resolveThinkingBudget(effort);
      // budget_tokens must stay below max_tokens.
      if (maxTokens <= budget) maxTokens = budget + DEFAULT_MAX_TOKENS;
      body.thinking = { type: "enabled", budget_tokens: budget };
    } else if (request.temperature !== undefined) {
      // Extended thinking does not accept a temperature.
      body.temperature = request.temperature;
    }
  } else if (thinks) {
    body.thinking = style.summarize ? { type: "adaptive", display: "summarized" } : { type: "adaptive" };
    const level = resolveAdaptiveEffort(effort, style.efforts);
    if (level !== undefined) body.output_config = { effort: level };
  } else if (style.mode === "always-on") {
    // Thinking cannot be turned off on these models; the lowest effort comes closest.
    body.output_config = { effort: "low" };
  } else if (request.temperature !== undefined && style.temperature) {
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
        data?: Array<{ id?: unknown; display_name?: unknown; max_input_tokens?: unknown; max_tokens?: unknown }>;
      };
      const positive = (value: unknown): value is number => typeof value === "number" && value > 0;
      discovered = (body.data ?? []).flatMap((model) => (typeof model.id === "string"
        ? [{
          id: model.id,
          ...(typeof model.display_name === "string" ? { name: model.display_name } : {}),
          // The context window (ADR 0019 compacts by it) and output cap, where the API reports them.
          ...(positive(model.max_input_tokens) ? { contextWindow: model.max_input_tokens } : {}),
          ...(positive(model.max_tokens) ? { maxOutputTokens: model.max_tokens } : {}),
        }]
        : []));
    } catch (error) {
      if (configured.length === 0) throw error;
    }
    const byId = new Map(discovered.map((model) => [model.id, model]));
    for (const model of configured) byId.set(model.id, { ...byId.get(model.id), ...model });
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

export const protocolSpec: LlmProtocolSpec = {
  defaultBaseUrl: DEFAULT_BASE_URL,
  normalizeBaseUrl: (baseUrl) => baseUrl ?? DEFAULT_BASE_URL,
  createAdapter: (ctx, provider) => new AnthropicAdapter(ctx, provider),
};

export function apply(ctx: Context, config?: Config): void {
  ctx.effect(() => ctx.llm.registerProtocol("anthropic", protocolSpec), `${name}: protocol`);
  for (const provider of config?.providers ?? []) {
    ctx.effect(() => ctx.llm.registerAdapter(
      { id: provider.id, name: provider.name ?? provider.id, api: "anthropic", baseUrl: provider.baseUrl ?? DEFAULT_BASE_URL },
      new AnthropicAdapter(ctx, provider),
    ), `${name}: ${provider.id}`);
  }
}
