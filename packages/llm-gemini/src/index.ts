/**
 * Native LLM adapter for the Google Gemini GenerateContent / StreamGenerateContent API
 * (`POST {baseUrl}/models/{model}:streamGenerateContent?alt=sse`).
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
} from "@qianji/llm";

export const name = "qianji-llm-gemini";
export const inject = ["llm", "credentials"];

export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const THINKING_BUDGET: Record<string, number> = {
  minimal: 512,
  low: 2_048,
  medium: 8_192,
  high: 24_576,
  xhigh: 28_672,
  max: 32_768,
  auto: -1,
};

export function resolveThinkingBudget(effort: Effort): number {
  const normalized = effort.trim().toLowerCase();
  if (normalized in THINKING_BUDGET) return THINKING_BUDGET[normalized] as number;
  const numericMatch = /^(?:budget:)?(-?\d+)(k)?$/.exec(normalized);
  if (numericMatch) {
    const base = Number(numericMatch[1]);
    const tokens = numericMatch[2] ? base * 1_024 : base;
    if (Number.isFinite(tokens) && tokens >= -1) return Math.round(tokens);
  }
  return THINKING_BUDGET.medium as number;
}

export interface ProviderConfig {
  id: string;
  name?: string;
  /** Up to and including `/v1beta` (or bare origin, normalized automatically). */
  baseUrl?: string;
  apiKey?: SecretRef;
  headers?: Record<string, string>;
  models?: ModelInfo[];
}

export interface Config {
  providers?: ProviderConfig[];
}

type GeminiPart = Record<string, unknown>;
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

export function normalizeGeminiBaseUrl(raw?: string): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (trimmed === "") return DEFAULT_GEMINI_BASE_URL;
  // Bare official host without a version path defaults to /v1beta.
  if (/^https?:\/\/generativelanguage\.googleapis\.com$/i.test(trimmed)) {
    return `${trimmed}/v1beta`;
  }
  return trimmed;
}

function cleanModelId(modelId: string): string {
  return modelId.trim().replace(/^models\//, "");
}

/**
 * Strip JSON Schema keywords that Gemini's OpenAPI-subset `parameters` validator rejects
 * (`$schema`, `additionalProperties`, `$defs`).
 */
export function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const record = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "$schema" || key === "additionalProperties" || key === "$defs") continue;
    cleaned[key] = sanitizeGeminiSchema(value);
  }
  return cleaned;
}

function toWireContents(messages: Message[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const callNames = new Map<string, string>();
  const push = (role: GeminiContent["role"], parts: GeminiPart[]) => {
    if (parts.length === 0) return;
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const message of messages) {
    if (message.role === "user") {
      push(
        "user",
        message.content.map((block): GeminiPart =>
          block.type === "text"
            ? { text: block.text }
            : { inlineData: { mimeType: block.mimeType, data: block.data } },
        ),
      );
      continue;
    }

    if (message.role === "assistant") {
      let pendingSignature: string | undefined;
      const parts: GeminiPart[] = [];
      for (const block of message.content) {
        if (block.type === "thinking") {
          if (block.signature !== undefined) pendingSignature = block.signature;
          if (block.text !== "" && block.signature !== undefined) {
            parts.push({
              text: block.text,
              thought: true,
              thoughtSignature: block.signature,
            });
            pendingSignature = undefined;
          }
          continue;
        }
        if (block.type === "text") {
          if (block.text !== "") {
            parts.push({
              text: block.text,
              ...(pendingSignature === undefined ? {} : { thoughtSignature: pendingSignature }),
            });
            pendingSignature = undefined;
          }
          continue;
        }
        callNames.set(block.id, block.name);
        parts.push({
          functionCall: {
            id: block.id,
            name: block.name,
            args: block.arguments,
          },
          ...(pendingSignature === undefined ? {} : { thoughtSignature: pendingSignature }),
        });
        pendingSignature = undefined;
      }
      push("model", parts);
      continue;
    }

    const toolName = callNames.get(message.callId) ?? message.callId;
    const textParts = message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const responseParts: GeminiPart[] = [
      {
        functionResponse: {
          id: message.callId,
          name: toolName,
          response: message.isError ? { error: textParts } : { output: textParts },
        },
      },
    ];
    for (const block of message.content) {
      if (block.type === "image") {
        responseParts.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
      }
    }
    push("user", responseParts);
  }

  return contents;
}

export function buildRequestBody(request: LlmRequest, model?: ModelInfo): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: toWireContents(request.messages),
  };
  if (request.system && request.system.trim() !== "") {
    body.systemInstruction = { parts: [{ text: request.system }] };
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: sanitizeGeminiSchema(tool.parameters),
        })),
      },
    ];
  }

  const generationConfig: Record<string, unknown> = {};
  const maxOutputTokens = request.maxTokens ?? model?.maxOutputTokens;
  if (maxOutputTokens !== undefined) generationConfig.maxOutputTokens = maxOutputTokens;
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
  if (request.effort !== undefined && request.effort !== "off" && model?.reasoning !== false) {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: resolveThinkingBudget(request.effort),
    };
  } else if (request.effort === "off" && model?.reasoning === true) {
    const minBudget = /^gemini-2\.5-pro/i.test(cleanModelId(request.model)) ? 128 : 0;
    generationConfig.thinkingConfig = { thinkingBudget: minBudget };
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }

  return body;
}

const FINISH_REASONS: Record<string, FinishReason> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "refusal",
  RECITATION: "refusal",
  BLOCKLIST: "refusal",
  PROHIBITED_CONTENT: "refusal",
  SPII: "refusal",
  IMAGE_SAFETY: "refusal",
  MALFORMED_FUNCTION_CALL: "error",
};

interface GeminiWirePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
}

interface GeminiWireChunk {
  candidates?: Array<{
    content?: { parts?: GeminiWirePart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  error?: {
    code?: number;
    status?: string;
    message?: string;
  };
}

/** Translate Gemini SSE events into canonical StreamChunks. */
export async function* translateStream(
  events: AsyncIterable<{ data: string }>,
  providerId: string,
): AsyncGenerator<StreamChunk> {
  let next = 0;
  let thinkingIndex: number | undefined;
  let textIndex: number | undefined;
  let hasToolCalls = false;
  let reason: FinishReason | undefined;

  for await (const sse of events) {
    if (sse.data === "[DONE]" || sse.data.trim() === "") continue;
    let chunk: GeminiWireChunk;
    try {
      chunk = JSON.parse(sse.data) as GeminiWireChunk;
    } catch {
      throw new LlmError({
        kind: "unknown",
        message: `${providerId} sent malformed Gemini stream JSON`,
        retryable: false,
      });
    }
    if (chunk.error !== undefined) {
      const code = chunk.error.code;
      const retryable = code === 429 || code === 500 || code === 503;
      const kind = code === 401 || code === 403
        ? "auth"
        : code === 429
          ? "rate-limit"
          : code === 503
            ? "overloaded"
            : code !== undefined && code >= 500
              ? "server"
              : "invalid-request";
      throw new LlmError({
        kind,
        ...(code === undefined ? {} : { status: code }),
        message: `${providerId}: ${chunk.error.message ?? chunk.error.status ?? "stream error"}`,
        retryable,
      });
    }

    for (const candidate of chunk.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.thought === true) {
          thinkingIndex ??= next++;
          if (typeof part.text === "string" && part.text !== "") {
            yield { type: "thinking-delta", index: thinkingIndex, text: part.text };
          }
          if (typeof part.thoughtSignature === "string" && part.thoughtSignature !== "") {
            yield { type: "thinking-signature", index: thinkingIndex, signature: part.thoughtSignature };
          }
          continue;
        }
        if (typeof part.thoughtSignature === "string" && part.thoughtSignature !== "") {
          thinkingIndex ??= next++;
          yield { type: "thinking-signature", index: thinkingIndex, signature: part.thoughtSignature };
        }
        if (part.functionCall !== undefined) {
          hasToolCalls = true;
          const index = next++;
          const callId = part.functionCall.id && part.functionCall.id !== "" ? part.functionCall.id : `gemini_call_${index}`;
          yield { type: "tool-call-start", index, id: callId, name: part.functionCall.name ?? "" };
          const serialized = JSON.stringify(part.functionCall.args ?? {});
          yield { type: "tool-call-delta", index, argumentsDelta: serialized };
          continue;
        }
        if (typeof part.text === "string" && part.text !== "") {
          textIndex ??= next++;
          yield { type: "text-delta", index: textIndex, text: part.text };
        }
      }
      if (typeof candidate.finishReason === "string") {
        reason = FINISH_REASONS[candidate.finishReason] ?? "stop";
      }
    }

    if (chunk.usageMetadata !== undefined) {
      const meta = chunk.usageMetadata;
      const cached = meta.cachedContentTokenCount ?? 0;
      const prompt = Math.max(0, (meta.promptTokenCount ?? 0) - cached);
      const candidates = meta.candidatesTokenCount ?? 0;
      const thoughts = meta.thoughtsTokenCount ?? 0;
      yield {
        type: "usage",
        usage: {
          inputTokens: prompt,
          outputTokens: candidates + thoughts,
          cacheReadTokens: cached,
          ...(thoughts > 0 ? { reasoningTokens: thoughts } : {}),
        },
      };
    }
  }

  yield { type: "finish", reason: hasToolCalls ? "tool-use" : (reason ?? "stop") };
}

export class GeminiAdapter implements LlmAdapter {
  private readonly baseUrl: string;

  constructor(private readonly ctx: Context, private readonly provider: ProviderConfig) {
    this.baseUrl = normalizeGeminiBaseUrl(provider.baseUrl);
  }

  private async headers(): Promise<Record<string, string>> {
    const key = await this.ctx.credentials.resolve(this.provider.apiKey);
    return {
      ...(key === undefined ? {} : { "x-goog-api-key": key }),
      ...this.provider.headers,
    };
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const model = this.provider.models?.find((candidate) => cleanModelId(candidate.id) === cleanModelId(request.model));
    const endpoint = joinUrl(this.baseUrl, `models/${encodeURIComponent(cleanModelId(request.model))}:streamGenerateContent?alt=sse`);
    const events = postSse(endpoint, await this.headers(), buildRequestBody(request, model), signal, this.provider.id);
    yield* translateStream(events, this.provider.id);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const configured = this.provider.models ?? [];
    let discovered: ModelInfo[] = [];
    try {
      const body = (await getJson(joinUrl(this.baseUrl, "models?pageSize=1000"), await this.headers(), this.provider.id, signal)) as {
        models?: Array<{
          name?: unknown;
          displayName?: unknown;
          inputTokenLimit?: unknown;
          outputTokenLimit?: unknown;
          thinking?: unknown;
          supportedGenerationMethods?: unknown;
        }>;
      };
      discovered = (body.models ?? []).flatMap((item): ModelInfo[] => {
        if (typeof item.name !== "string") return [];
        if (Array.isArray(item.supportedGenerationMethods) && !item.supportedGenerationMethods.includes("generateContent")) {
          return [];
        }
        const id = cleanModelId(item.name);
        if (id === "") return [];
        return [
          {
            id,
            ...(typeof item.displayName === "string" && item.displayName !== "" ? { name: item.displayName } : {}),
            ...(typeof item.inputTokenLimit === "number" ? { contextWindow: item.inputTokenLimit } : {}),
            ...(typeof item.outputTokenLimit === "number" ? { maxOutputTokens: item.outputTokenLimit } : {}),
            ...(item.thinking === true || /^gemini-(2\.5|[3-9])/.test(id) ? { reasoning: true } : {}),
            input: ["text", "image"],
          },
        ];
      });
    } catch (error) {
      if (configured.length === 0) throw error;
    }
    const byId = new Map(discovered.map((model) => [model.id, model]));
    for (const model of configured) {
      const id = cleanModelId(model.id);
      byId.set(id, { ...byId.get(id), ...model, id });
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

export const protocolSpec: LlmProtocolSpec = {
  defaultBaseUrl: DEFAULT_GEMINI_BASE_URL,
  normalizeBaseUrl: normalizeGeminiBaseUrl,
  createAdapter: (ctx, provider) => new GeminiAdapter(ctx, provider),
};

export function apply(ctx: Context, config?: Config): void {
  ctx.effect(() => ctx.llm.registerProtocol("gemini", protocolSpec), `${name}: protocol`);
  for (const provider of config?.providers ?? []) {
    ctx.effect(
      () =>
        ctx.llm.registerAdapter(
          {
            id: provider.id,
            name: provider.name ?? provider.id,
            api: "gemini",
            baseUrl: normalizeGeminiBaseUrl(provider.baseUrl),
          },
          new GeminiAdapter(ctx, provider),
        ),
      `${name}: ${provider.id}`,
    );
  }
}
