/**
 * Native LLM adapter for the OpenAI Responses API (`POST {baseUrl}/responses`
 * with `stream: true`). Supports reasoning effort + reasoning summary deltas,
 * exact `reasoningTokens` (`output_tokens_details.reasoning_tokens`), prompt
 * cache read metrics (`input_tokens_details.cached_tokens`), and function calls.
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

export const name = "pid-llm-openai-responses";
export const inject = ["llm", "credentials"];

export const DEFAULT_OPENAI_RESPONSES_BASE_URL = "https://api.openai.com/v1";

export interface ProviderConfig {
  id: string;
  name?: string;
  /** Up to and including `/v1`; defaults to `https://api.openai.com/v1`. */
  baseUrl?: string;
  apiKey?: SecretRef;
  headers?: Record<string, string>;
  models?: ModelInfo[];
}

export interface Config {
  providers?: ProviderConfig[];
}

type ResponsesInputItem = Record<string, unknown>;

export function normalizeResponsesBaseUrl(raw?: string): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (trimmed === "") return DEFAULT_OPENAI_RESPONSES_BASE_URL;
  if (/^https?:\/\/api\.openai\.com$/i.test(trimmed)) return `${trimmed}/v1`;
  return trimmed;
}

function effortValue(effort: Effort | undefined): Exclude<Effort, "off"> | undefined {
  return effort === undefined || effort === "off" ? undefined : effort;
}

function toResponsesInput(messages: Message[]): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      input.push({
        role: "user",
        content: message.content.map((block) =>
          block.type === "text"
            ? { type: "input_text", text: block.text }
            : { type: "input_image", image_url: `data:${block.mimeType};base64,${block.data}` },
        ),
      });
      continue;
    }

    if (message.role === "assistant") {
      const textParts = message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text" && block.text !== "")
        .map((block) => ({ type: "output_text", text: block.text }));
      if (textParts.length > 0) {
        input.push({ role: "assistant", content: textParts });
      }
      for (const block of message.content) {
        if (block.type === "tool-call") {
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          });
        }
      }
      continue;
    }

    const outputText = message.content
      .map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`))
      .join("\n");
    input.push({
      type: "function_call_output",
      call_id: message.callId,
      output: outputText,
    });
  }
  return input;
}

export function buildRequestBody(request: LlmRequest, model?: ModelInfo): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    input: toResponsesInput(request.messages),
    stream: true,
  };
  if (request.system && request.system.trim() !== "") {
    body.instructions = request.system;
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
  const maxOutputTokens = request.maxTokens ?? model?.maxOutputTokens;
  if (maxOutputTokens !== undefined) body.max_output_tokens = maxOutputTokens;

  const effort = effortValue(request.effort);
  if (effort !== undefined) {
    body.reasoning = { effort, summary: "auto" };
  } else if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  return body;
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface ResponsesOutputItem {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface ResponsesWireEvent {
  type?: string;
  output_index?: number;
  item_id?: string;
  delta?: string;
  item?: ResponsesOutputItem;
  response?: {
    status?: string;
    incomplete_details?: { reason?: string } | null;
    usage?: ResponsesUsage | null;
    error?: { code?: string; message?: string } | null;
  };
  error?: { code?: string; message?: string; type?: string };
}

function extractUsageChunk(usage: ResponsesUsage | null | undefined): StreamChunk | undefined {
  if (!usage) return undefined;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;
  return {
    type: "usage",
    usage: {
      inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: cached,
      ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    },
  };
}

/** Translate OpenAI `/v1/responses` SSE events into canonical StreamChunks. */
export async function* translateStream(
  events: AsyncIterable<{ event?: string; data: string }>,
  providerId: string,
): AsyncGenerator<StreamChunk> {
  let next = 0;
  let thinkingIndex: number | undefined;
  let textIndex: number | undefined;
  const toolByOutputIndex = new Map<number, { blockIndex: number; streamedArgs: boolean }>();
  const toolByItemId = new Map<string, { blockIndex: number; streamedArgs: boolean }>();
  let reason: FinishReason | undefined;

  for await (const sse of events) {
    if (sse.data === "[DONE]" || sse.data.trim() === "") continue;
    let payload: ResponsesWireEvent;
    try {
      payload = JSON.parse(sse.data) as ResponsesWireEvent;
    } catch {
      throw new LlmError({
        kind: "unknown",
        message: `${providerId} sent malformed Responses stream JSON`,
        retryable: false,
      });
    }

    const eventType = payload.type ?? sse.event ?? "";

    if (eventType === "error" || payload.error !== undefined) {
      const code = payload.error?.code ?? payload.error?.type ?? "";
      const retryable = code === "rate_limit_exceeded" || code === "server_error";
      throw new LlmError({
        kind: code === "rate_limit_exceeded" ? "rate-limit" : retryable ? "server" : "invalid-request",
        message: `${providerId}: ${payload.error?.message ?? "stream error"}`,
        retryable,
      });
    }

    switch (eventType) {
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (typeof payload.delta === "string" && payload.delta !== "") {
          thinkingIndex ??= next++;
          yield { type: "thinking-delta", index: thinkingIndex, text: payload.delta };
        }
        break;

      case "response.output_text.delta":
        if (typeof payload.delta === "string" && payload.delta !== "") {
          textIndex ??= next++;
          yield { type: "text-delta", index: textIndex, text: payload.delta };
        }
        break;

      case "response.output_item.added": {
        const item = payload.item;
        if (item?.type === "function_call") {
          const blockIndex = next++;
          const callId = item.call_id ?? item.id ?? `call_${blockIndex}`;
          const state = { blockIndex, streamedArgs: false };
          if (typeof payload.output_index === "number") toolByOutputIndex.set(payload.output_index, state);
          if (typeof item.id === "string") toolByItemId.set(item.id, state);
          yield { type: "tool-call-start", index: blockIndex, id: callId, name: item.name ?? "" };
          if (typeof item.arguments === "string" && item.arguments !== "") {
            state.streamedArgs = true;
            yield { type: "tool-call-delta", index: blockIndex, argumentsDelta: item.arguments };
          }
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        const state =
          (typeof payload.output_index === "number" ? toolByOutputIndex.get(payload.output_index) : undefined)
          ?? (typeof payload.item_id === "string" ? toolByItemId.get(payload.item_id) : undefined);
        if (state !== undefined && typeof payload.delta === "string" && payload.delta !== "") {
          state.streamedArgs = true;
          yield { type: "tool-call-delta", index: state.blockIndex, argumentsDelta: payload.delta };
        }
        break;
      }

      case "response.output_item.done": {
        const item = payload.item;
        if (item?.type === "function_call") {
          let state =
            (typeof payload.output_index === "number" ? toolByOutputIndex.get(payload.output_index) : undefined)
            ?? (typeof item.id === "string" ? toolByItemId.get(item.id) : undefined);
          if (state === undefined) {
            const blockIndex = next++;
            const callId = item.call_id ?? item.id ?? `call_${blockIndex}`;
            state = { blockIndex, streamedArgs: false };
            if (typeof payload.output_index === "number") toolByOutputIndex.set(payload.output_index, state);
            if (typeof item.id === "string") toolByItemId.set(item.id, state);
            yield { type: "tool-call-start", index: blockIndex, id: callId, name: item.name ?? "" };
          }
          if (!state.streamedArgs && typeof item.arguments === "string" && item.arguments !== "") {
            state.streamedArgs = true;
            yield { type: "tool-call-delta", index: state.blockIndex, argumentsDelta: item.arguments };
          }
        }
        break;
      }

      case "response.completed":
      case "response.incomplete": {
        const usageChunk = extractUsageChunk(payload.response?.usage);
        if (usageChunk !== undefined) yield usageChunk;
        if (eventType === "response.incomplete" || payload.response?.status === "incomplete") {
          const incompleteReason = payload.response?.incomplete_details?.reason;
          reason = incompleteReason === "content_filter" ? "refusal" : "length";
        } else {
          reason = "stop";
        }
        break;
      }

      case "response.failed": {
        const err = payload.response?.error;
        const code = err?.code ?? "";
        throw new LlmError({
          kind: code === "rate_limit_exceeded" ? "rate-limit" : "server",
          message: `${providerId}: ${err?.message ?? "response failed"}`,
          retryable: code === "rate_limit_exceeded" || code === "server_error",
        });
      }

      default:
        break;
    }
  }

  const hasToolCalls = toolByOutputIndex.size > 0 || toolByItemId.size > 0;
  yield { type: "finish", reason: hasToolCalls ? "tool-use" : (reason ?? "stop") };
}

export class OpenAiResponsesAdapter implements LlmAdapter {
  private readonly baseUrl: string;

  constructor(private readonly ctx: Context, private readonly provider: ProviderConfig) {
    this.baseUrl = normalizeResponsesBaseUrl(provider.baseUrl);
  }

  private async headers(): Promise<Record<string, string>> {
    const key = await this.ctx.credentials.resolve(this.provider.apiKey);
    return {
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
      ...this.provider.headers,
    };
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const model = this.provider.models?.find((candidate) => candidate.id === request.model);
    const events = postSse(
      joinUrl(this.baseUrl, "responses"),
      await this.headers(),
      buildRequestBody(request, model),
      signal,
      this.provider.id,
    );
    yield* translateStream(events, this.provider.id);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const configured = this.provider.models ?? [];
    let discovered: ModelInfo[] = [];
    try {
      const body = (await getJson(joinUrl(this.baseUrl, "models"), await this.headers(), this.provider.id, signal)) as {
        data?: Array<{ id?: unknown }>;
      };
      discovered = (body.data ?? []).flatMap((model) => (typeof model.id === "string" ? [{ id: model.id }] : []));
    } catch (error) {
      if (configured.length === 0) throw error;
    }
    const byId = new Map(discovered.map((model) => [model.id, model]));
    for (const model of configured) byId.set(model.id, { ...byId.get(model.id), ...model });
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

export const protocolSpec: LlmProtocolSpec = {
  defaultBaseUrl: DEFAULT_OPENAI_RESPONSES_BASE_URL,
  normalizeBaseUrl: normalizeResponsesBaseUrl,
  createAdapter: (ctx, provider) => new OpenAiResponsesAdapter(ctx, provider),
};

export function apply(ctx: Context, config?: Config): void {
  ctx.effect(() => ctx.llm.registerProtocol("openai-responses", protocolSpec), `${name}: protocol`);
  for (const provider of config?.providers ?? []) {
    ctx.effect(
      () =>
        ctx.llm.registerAdapter(
          {
            id: provider.id,
            name: provider.name ?? provider.id,
            api: "openai-responses",
            baseUrl: normalizeResponsesBaseUrl(provider.baseUrl),
          },
          new OpenAiResponsesAdapter(ctx, provider),
        ),
      `${name}: ${provider.id}`,
    );
  }
}
