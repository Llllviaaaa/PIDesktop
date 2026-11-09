/**
 * LLM adapter for OpenAI-compatible Chat Completions endpoints
 * (`POST {baseUrl}/chat/completions` with `stream: true`). One plugin serves
 * every configured provider of this kind: OpenAI, DeepSeek, OpenRouter,
 * Ollama, vLLM and the like differ only in base URL, key and models.
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
  type LlmProtocolSpec,
  type LlmRequest,
  type Message,
  type ModelInfo,
  type SecretRef,
  type StreamChunk,
} from "@pid/llm";

export const name = "pid-llm-openai-compat";
export const inject = ["llm", "credentials"];

export interface ProviderConfig {
  id: string;
  name?: string;
  /** Up to and including the version path, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  apiKey?: SecretRef;
  /** Extra request headers, e.g. OpenRouter's `HTTP-Referer`. */
  headers?: Record<string, string>;
  /** Send `reasoning_effort` when a request asks for an effort. */
  reasoningEffort?: boolean;
  /** Configured models; their metadata wins over what `/models` reports. */
  models?: ModelInfo[];
}

export interface Config {
  providers?: ProviderConfig[];
}

type WireMessage = Record<string, unknown>;

function toWireMessages(system: string | undefined, messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = system ? [{ role: "system", content: system }] : [];
  for (const message of messages) {
    if (message.role === "user") {
      const onlyText = message.content.every((block) => block.type === "text");
      wire.push({
        role: "user",
        content: onlyText
          ? message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
          : message.content.map((block) => block.type === "text"
            ? { type: "text", text: block.text }
            : { type: "image_url", image_url: { url: `data:${block.mimeType};base64,${block.data}` } }),
      });
    } else if (message.role === "assistant") {
      // Reasoning is not sent back: DeepSeek rejects reasoning_content in input.
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      const calls = message.content.flatMap((block) => (block.type === "tool-call"
        ? [{ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.arguments) } }]
        : []));
      wire.push({ role: "assistant", content: text === "" && calls.length > 0 ? null : text, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
    } else {
      const text = message.content.map((block) => (block.type === "text" ? block.text : "[image omitted]")).join("\n");
      wire.push({ role: "tool", tool_call_id: message.callId, content: text });
    }
  }
  return wire;
}

function effortValue(effort: Effort | undefined): string | undefined {
  return effort === undefined || effort === "off" ? undefined : effort;
}

const KNOWN_REASONING_EFFORT_MODEL_RE = /^(?:o1|o3|o4|gpt-5|grok-(?:3-mini|4))(?:$|[-._/])/i;

/**
 * Whether `reasoning_effort` should be sent for `modelId`.
 * Explicit `provider.reasoningEffort` (`true` / `false`) always wins; otherwise
 * auto-enable for configured reasoning models and known OpenAI/xAI reasoning families
 * while avoiding DeepSeek's native endpoint where `deepseek-reasoner` omits it.
 */
export function supportsReasoningEffort(
  modelId: string,
  provider: ProviderConfig,
  unsupportedModels?: ReadonlySet<string>,
): boolean {
  if (provider.reasoningEffort === true) return true;
  if (provider.reasoningEffort === false) return false;
  if (unsupportedModels?.has(modelId)) return false;
  if (/^deepseek-reasoner$/i.test(modelId) || /api\.deepseek\.com/i.test(provider.baseUrl)) return false;
  const configured = provider.models?.find((item) => item.id === modelId);
  if (configured?.reasoning === true || (configured?.thinkingLevel !== undefined && configured.thinkingLevel !== "off")) {
    return true;
  }
  return KNOWN_REASONING_EFFORT_MODEL_RE.test(modelId);
}

export function buildRequestBody(
  request: LlmRequest,
  provider: ProviderConfig,
  unsupportedReasoningModels?: ReadonlySet<string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toWireMessages(request.system, request.messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  const effort = effortValue(request.effort);
  if (effort !== undefined && supportsReasoningEffort(request.model, provider, unsupportedReasoningModels)) {
    body.reasoning_effort = effort;
  }
  return body;
}

const FINISH_REASONS: Record<string, FinishReason> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool-use",
  function_call: "tool-use",
  content_filter: "refusal",
};

interface WireDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
}

interface WireChunk {
  choices?: Array<{ delta?: WireDelta; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_cache_hit_tokens?: number;
  } | null;
  error?: { message?: string; code?: unknown };
}

/** Translate the provider's SSE stream into StreamChunks. Exported for the tests. */
export async function* translateStream(events: AsyncIterable<{ data: string }>, providerId: string): AsyncGenerator<StreamChunk> {
  let next = 0;
  let thinkingIndex: number | undefined;
  let textIndex: number | undefined;
  const toolIndex = new Map<number, number>();
  let reason: FinishReason | undefined;
  let sawDone = false;

  for await (const event of events) {
    if (event.data === "[DONE]") {
      sawDone = true;
      break;
    }
    let chunk: WireChunk;
    try {
      chunk = JSON.parse(event.data) as WireChunk;
    } catch {
      throw new LlmError({ kind: "unknown", message: `${providerId} sent malformed stream data`, retryable: false });
    }
    if (chunk.error !== undefined) {
      throw new LlmError({ kind: "server", message: `${providerId}: ${chunk.error.message ?? "stream error"}`, retryable: true });
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      const thinking = delta.reasoning_content ?? delta.reasoning;
      if (typeof thinking === "string" && thinking !== "") {
        thinkingIndex ??= next++;
        yield { type: "thinking-delta", index: thinkingIndex, text: thinking };
      }
      if (typeof delta.content === "string" && delta.content !== "") {
        textIndex ??= next++;
        yield { type: "text-delta", index: textIndex, text: delta.content };
      }
      for (const call of delta.tool_calls ?? []) {
        const wireIndex = call.index ?? 0;
        let index = toolIndex.get(wireIndex);
        if (index === undefined) {
          index = next++;
          toolIndex.set(wireIndex, index);
          yield { type: "tool-call-start", index, id: call.id ?? `call_${index}`, name: call.function?.name ?? "" };
        }
        const args = call.function?.arguments;
        if (typeof args === "string" && args !== "") yield { type: "tool-call-delta", index, argumentsDelta: args };
      }
      if (typeof choice.finish_reason === "string") reason = FINISH_REASONS[choice.finish_reason] ?? "stop";
    }
    if (chunk.usage) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens ?? 0;
      const reasoning = chunk.usage.completion_tokens_details?.reasoning_tokens;
      yield {
        type: "usage",
        usage: {
          inputTokens: Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached),
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: cached,
          ...(typeof reasoning === "number" && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
        },
      };
    }
  }
  if (!sawDone && reason === undefined) {
    throw new LlmError({
      kind: "network",
      message: `${providerId}: upstream stream ended before completion`,
      retryable: true,
    });
  }
  yield { type: "finish", reason: reason ?? (toolIndex.size > 0 ? "tool-use" : "stop") };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function parsePerMillionPrice(perToken: unknown): number | undefined {
  const num = typeof perToken === "number" ? perToken : typeof perToken === "string" ? Number(perToken) : NaN;
  if (!Number.isFinite(num) || num < 0) return undefined;
  return Math.round(num * 1_000_000 * 10_000) / 10_000;
}

function parseDiscoveredModel(raw: Record<string, unknown>): ModelInfo[] {
  if (typeof raw.id !== "string" || raw.id.trim() === "") return [];
  const id = raw.id;
  const info: ModelInfo = { id };

  const displayName = typeof raw.name === "string" ? raw.name.trim() : typeof raw.display_name === "string" ? raw.display_name.trim() : "";
  if (displayName !== "" && displayName !== id) info.name = displayName;

  const topProvider = typeof raw.top_provider === "object" && raw.top_provider !== null ? (raw.top_provider as Record<string, unknown>) : undefined;
  const contextWindow =
    positiveInt(raw.context_length)
    ?? positiveInt(raw.context_window)
    ?? positiveInt(raw.max_model_len)
    ?? positiveInt(raw.max_input_tokens)
    ?? positiveInt(topProvider?.context_length);
  if (contextWindow !== undefined) info.contextWindow = contextWindow;

  const maxOutputTokens =
    positiveInt(raw.max_completion_tokens)
    ?? positiveInt(raw.max_output_tokens)
    ?? positiveInt(topProvider?.max_completion_tokens);
  if (maxOutputTokens !== undefined) info.maxOutputTokens = maxOutputTokens;

  const capabilities = typeof raw.capabilities === "object" && raw.capabilities !== null ? (raw.capabilities as Record<string, unknown>) : undefined;
  const supportedParams = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : undefined;
  if (
    raw.reasoning === true
    || raw.thinking === true
    || raw.supports_reasoning === true
    || capabilities?.reasoning === true
    || capabilities?.thinking === true
    || (supportedParams !== undefined && supportedParams.some((p) => p === "reasoning" || p === "include_reasoning" || p === "reasoning_effort"))
  ) {
    info.reasoning = true;
  }

  const rawEffort = typeof raw.thinking_level === "string"
    ? raw.thinking_level.toLowerCase()
    : typeof raw.reasoning_effort === "string"
      ? raw.reasoning_effort.toLowerCase()
      : "";
  if (rawEffort === "off" || rawEffort === "low" || rawEffort === "medium" || rawEffort === "high" || rawEffort === "max") {
    info.thinkingLevel = rawEffort;
    if (rawEffort !== "off") info.reasoning = true;
  }

  const arch = typeof raw.architecture === "object" && raw.architecture !== null ? (raw.architecture as Record<string, unknown>) : undefined;
  const inputModalities = Array.isArray(arch?.input_modalities) ? arch.input_modalities : undefined;
  const modality = typeof arch?.modality === "string" ? arch.modality : "";
  if (
    raw.vision === true
    || raw.supports_vision === true
    || raw.multimodal === true
    || capabilities?.vision === true
    || (inputModalities !== undefined && inputModalities.includes("image"))
    || modality.includes("image")
  ) {
    info.input = ["text", "image"];
  }

  const pricing = typeof raw.pricing === "object" && raw.pricing !== null ? (raw.pricing as Record<string, unknown>) : undefined;
  if (pricing !== undefined) {
    const inputPrice = parsePerMillionPrice(pricing.prompt);
    const outputPrice = parsePerMillionPrice(pricing.completion);
    if (inputPrice !== undefined && outputPrice !== undefined && (inputPrice > 0 || outputPrice > 0)) {
      info.cost = { input: inputPrice, output: outputPrice };
    }
  }

  return [info];
}

export class OpenAiCompatAdapter implements LlmAdapter {
  private readonly unsupportedReasoningModels = new Set<string>();

  constructor(private readonly ctx: Context, private readonly provider: ProviderConfig) {}

  private async headers(request?: LlmRequest): Promise<Record<string, string>> {
    const key = await this.ctx.credentials.resolve(this.provider.apiKey);
    const sessionHeaders: Record<string, string> = {};
    if (request?.sessionId) {
      sessionHeaders["x-session-id"] = request.sessionId;
      if (/grok/i.test(request.model)) {
        sessionHeaders["x-grok-conv-id"] = request.sessionId;
      }
    }
    return {
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      ...sessionHeaders,
      ...this.provider.headers,
    };
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const headers = await this.headers(request);
    const body = buildRequestBody(request, this.provider, this.unsupportedReasoningModels);
    try {
      const events = postSse(
        joinUrl(this.provider.baseUrl, "chat/completions"),
        headers,
        body,
        signal,
        this.provider.id,
      );
      yield* translateStream(events, this.provider.id);
    } catch (error) {
      // If an OpenAI-compat proxy rejects auto-inferred `reasoning_effort`, remember and retry once cleanly without it.
      if (
        this.provider.reasoningEffort === undefined
        && "reasoning_effort" in body
        && error instanceof LlmError
        && error.status === 400
        && /reasoning_effort/i.test(error.message)
        && !signal.aborted
      ) {
        this.unsupportedReasoningModels.add(request.model);
        const fallbackBody = buildRequestBody(request, this.provider, this.unsupportedReasoningModels);
        const retryEvents = postSse(
          joinUrl(this.provider.baseUrl, "chat/completions"),
          headers,
          fallbackBody,
          signal,
          this.provider.id,
        );
        yield* translateStream(retryEvents, this.provider.id);
        return;
      }
      throw error;
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const configured = this.provider.models ?? [];
    let discovered: ModelInfo[] = [];
    try {
      const body = await getJson(joinUrl(this.provider.baseUrl, "models"), await this.headers(), this.provider.id, signal) as { data?: Array<Record<string, unknown>> };
      discovered = (body.data ?? []).flatMap((model) => (typeof model === "object" && model !== null ? parseDiscoveredModel(model) : []));
    } catch (error) {
      if (configured.length === 0) throw error;
    }
    const byId = new Map(discovered.map((model) => [model.id, model]));
    for (const model of configured) byId.set(model.id, { ...byId.get(model.id), ...model });
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

export const protocolSpec: LlmProtocolSpec = {
  requiresBaseUrl: true,
  normalizeBaseUrl: (baseUrl) => baseUrl ?? "",
  createAdapter: (ctx, provider) =>
    new OpenAiCompatAdapter(ctx, {
      ...provider,
      baseUrl: provider.baseUrl ?? "",
    }),
};

export function apply(ctx: Context, config?: Config): void {
  ctx.effect(() => ctx.llm.registerProtocol("openai-compat", protocolSpec), `${name}: protocol`);
  for (const provider of config?.providers ?? []) {
    ctx.effect(() => ctx.llm.registerAdapter(
      { id: provider.id, name: provider.name ?? provider.id, api: "openai-compat", baseUrl: provider.baseUrl },
      new OpenAiCompatAdapter(ctx, provider),
    ), `${name}: ${provider.id}`);
  }
}
