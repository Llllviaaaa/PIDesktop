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
  providers: ProviderConfig[];
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

export function buildRequestBody(request: LlmRequest, provider: ProviderConfig): Record<string, unknown> {
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
  if (provider.reasoningEffort === true && effort !== undefined) body.reasoning_effort = effort;
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

  for await (const event of events) {
    if (event.data === "[DONE]") break;
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
      yield {
        type: "usage",
        usage: {
          inputTokens: Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached),
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: cached,
        },
      };
    }
  }
  yield { type: "finish", reason: reason ?? (toolIndex.size > 0 ? "tool-use" : "stop") };
}

export class OpenAiCompatAdapter implements LlmAdapter {
  constructor(private readonly ctx: Context, private readonly provider: ProviderConfig) {}

  private async headers(): Promise<Record<string, string>> {
    const key = await this.ctx.credentials.resolve(this.provider.apiKey);
    return { ...(key === undefined ? {} : { authorization: `Bearer ${key}` }), ...this.provider.headers };
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const events = postSse(
      joinUrl(this.provider.baseUrl, "chat/completions"),
      await this.headers(),
      buildRequestBody(request, this.provider),
      signal,
      this.provider.id,
    );
    yield* translateStream(events, this.provider.id);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const configured = this.provider.models ?? [];
    let discovered: ModelInfo[] = [];
    try {
      const body = await getJson(joinUrl(this.provider.baseUrl, "models"), await this.headers(), this.provider.id, signal) as { data?: Array<{ id?: unknown }> };
      discovered = (body.data ?? []).flatMap((model) => (typeof model.id === "string" ? [{ id: model.id }] : []));
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
      { id: provider.id, name: provider.name ?? provider.id, api: "openai-compat", baseUrl: provider.baseUrl },
      new OpenAiCompatAdapter(ctx, provider),
    ), `${name}: ${provider.id}`);
  }
}
