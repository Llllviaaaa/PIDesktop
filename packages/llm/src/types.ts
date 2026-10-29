/**
 * The canonical LLM vocabulary (ADR 0007). The agent loop, session log and
 * every adapter speak this; adapters translate a provider's wire format to
 * and from it and nothing provider-specific leaks past them.
 */

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  mimeType: string;
  /** Base64 without a data: prefix. */
  data: string;
}

export interface ThinkingBlock {
  type: "thinking";
  text: string;
  /** Opaque provider token that must be sent back unchanged (Anthropic). */
  signature?: string;
  /** The provider returned the reasoning encrypted; `text` is empty. */
  redacted?: string;
}

export interface ToolCallBlock {
  type: "tool-call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type UserContent = TextBlock | ImageBlock;
export type AssistantContent = TextBlock | ThinkingBlock | ToolCallBlock;
export type ToolResultContent = TextBlock | ImageBlock;

export interface UserMessage {
  role: "user";
  content: UserContent[];
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
}

export interface ToolResultMessage {
  role: "tool-result";
  callId: string;
  content: ToolResultContent[];
  isError: boolean;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
}

/** How hard the model should think, where the provider supports it. */
export type Effort = "off" | "low" | "medium" | "high";

export interface LlmRequest {
  provider: string;
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolSchema[];
  maxTokens?: number;
  effort?: Effort;
  temperature?: number;
}

/** Token counts as every adapter reports them: `inputTokens` excludes cached input. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type FinishReason = "stop" | "length" | "tool-use" | "refusal" | "error" | "aborted";

/**
 * One streamed event. Blocks are numbered in the order they open; deltas name
 * the block they extend. A stream always ends with exactly one `finish`.
 */
export type StreamChunk =
  | { type: "text-delta"; index: number; text: string }
  | { type: "thinking-delta"; index: number; text: string }
  | { type: "thinking-signature"; index: number; signature: string }
  | { type: "thinking-redacted"; index: number; data: string }
  | { type: "tool-call-start"; index: number; id: string; name: string }
  | { type: "tool-call-delta"; index: number; argumentsDelta: string }
  | { type: "usage"; usage: Partial<Usage> }
  | { type: "finish"; reason: FinishReason; error?: LlmErrorInfo };

export type LlmErrorKind =
  | "auth"
  | "rate-limit"
  | "overloaded"
  | "invalid-request"
  | "context-length"
  | "network"
  | "server"
  | "aborted"
  | "unknown";

export interface LlmErrorInfo {
  kind: LlmErrorKind;
  message: string;
  status?: number;
  /** Whether trying the same request again may succeed. */
  retryable: boolean;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
}

export interface ProviderInfo {
  id: string;
  name: string;
  /** The adapter's wire protocol, e.g. `openai-compat`, `anthropic`. */
  api: string;
  baseUrl: string;
}
