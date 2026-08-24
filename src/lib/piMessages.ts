import type {
  AgentBrowserState,
  AgentMessage,
  AssistantMessage,
  AttachmentPayload,
  ComputerState,
  ForkPoint,
  ImageContent,
  SessionMessageTiming,
  ToolResultMessage,
  UiMessage,
  UiToolCall,
} from "../types";

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => (block as { text?: string }).text ?? "")
    .join("");
}

export function imagesFromContent(content: unknown): ImageContent[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const images = content.filter(
    (block): block is ImageContent =>
      Boolean(block) &&
      typeof block === "object" &&
      (block as { type?: string }).type === "image" &&
      typeof (block as { data?: unknown }).data === "string",
  );
  return images.length ? images : undefined;
}

function thinkingFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const value = content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const item = block as { type?: string; thinking?: string; text?: string; reasoning?: string };
      if (item.type !== "thinking" && item.type !== "reasoning" && item.type !== "thought") return "";
      return item.thinking || item.text || item.reasoning || "";
    })
    .join("");
  return value || undefined;
}

export function mergeAssistantUi(previous: UiMessage, incoming: UiMessage): UiMessage {
  const previousCalls = new Map(previous.toolCalls?.map((call) => [call.id, call]));
  const toolCalls = incoming.toolCalls?.length
    ? incoming.toolCalls.map((call) => ({ ...previousCalls.get(call.id), ...call }))
    : previous.toolCalls;
  return {
    ...previous,
    ...incoming,
    id: previous.id,
    thinking: incoming.thinking || previous.thinking,
    toolCalls,
  };
}

function toolCallsFromContent(content: unknown, startedAt?: number): UiToolCall[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const calls = content
    .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "toolCall")
    .map((block) => {
      const call = block as { id?: string; name?: string; arguments?: Record<string, unknown> };
      return {
        id: call.id ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: call.name ?? "tool",
        args: call.arguments ?? {},
        running: false,
        startedAt,
      } satisfies UiToolCall;
    });
  return calls.length ? calls : undefined;
}

export function messageId(message: AgentMessage): string {
  if (message.role === "toolResult") return `tool-${message.toolCallId}-${message.timestamp}`;
  return `msg-${message.role}-${message.timestamp}`;
}

export function assistantToUi(message: AssistantMessage, streaming = false, durationMs?: number): UiMessage {
  return {
    id: messageId(message),
    role: "assistant",
    content: textFromContent(message.content) || message.errorMessage || "",
    thinking: thinkingFromContent(message.content),
    model: message.model,
    usage: message.usage,
    toolCalls: toolCallsFromContent(message.content, message.timestamp),
    isStreaming: streaming,
    isError: message.stopReason === "error" || message.stopReason === "aborted",
    durationMs,
    timestamp: message.timestamp,
  };
}

function messageDurations(timings: SessionMessageTiming[]): Map<string, number> {
  const durations = new Map<string, number>();
  let turnStartedAt: number | null = null;
  for (const timing of timings) {
    const entryAt = Date.parse(timing.entryTimestamp);
    if (!Number.isFinite(entryAt)) continue;
    if (timing.role === "user") {
      turnStartedAt = entryAt;
    } else if (turnStartedAt !== null && entryAt > turnStartedAt) {
      durations.set(`msg-assistant-${timing.messageTimestamp}`, entryAt - turnStartedAt);
    }
  }
  return durations;
}

export function messagesToUi(messages: AgentMessage[], timings: SessionMessageTiming[] = []): UiMessage[] {
  const result: UiMessage[] = [];
  const toolCalls = new Map<string, UiToolCall>();
  const durations = messageDurations(timings);
  for (const message of messages) {
    if (message.role === "assistant") {
      const converted = assistantToUi(message, false, durations.get(messageId(message)));
      result.push(converted);
      for (const call of converted.toolCalls ?? []) toolCalls.set(call.id, call);
    } else if (message.role === "user") {
      result.push({
        id: messageId(message),
        role: "user",
        content: textFromContent(message.content),
        images: imagesFromContent(message.content),
        timestamp: message.timestamp,
      });
    } else if (message.role === "toolResult") {
      const call = toolCalls.get(message.toolCallId);
      if (call) applyToolResult(call, message);
    } else if (message.role === "bashExecution") {
      result.push({
        id: messageId(message),
        role: "terminal",
        content: `$ ${message.command}\n${message.output}`,
        isError: Boolean(message.exitCode),
        timestamp: message.timestamp,
      });
    } else if (message.role === "custom" && message.display) {
      result.push({
        id: messageId(message),
        role: "notice",
        content: textFromContent(message.content),
        timestamp: message.timestamp,
      });
    } else if (message.role === "compactionSummary" || message.role === "branchSummary") {
      result.push({
        id: messageId(message),
        role: "notice",
        content: message.role === "compactionSummary"
          ? `Context compacted\n\n${message.summary}`
          : `Branch summary\n\n${message.summary}`,
        timestamp: message.timestamp,
      });
    }
  }
  return result;
}

export function attachForkPointsToUi(messages: UiMessage[], points: ForkPoint[]): UiMessage[] {
  if (points.length === 0) return messages;
  const available = new Map<string, ForkPoint[]>();
  for (const point of points) {
    const matches = available.get(point.text) ?? [];
    matches.push(point);
    available.set(point.text, matches);
  }
  let changed = false;
  const hydrated = messages.map((message) => {
    if (message.role !== "user" || message.entryId) return message;
    const matches = available.get(message.content);
    const point = matches?.shift();
    if (!point) return message;
    changed = true;
    return { ...message, entryId: point.entryId };
  });
  return changed ? hydrated : messages;
}

export function buildPromptPayload(text: string, attachments: AttachmentPayload[]) {
  const trimmed = text.trim();
  const imageAttachments = attachments.filter((item) => item.kind === "image" && item.data);
  const fileReferences = attachments
    .filter((item) => item.kind !== "image")
    .map((item) => `- ${item.fileName}: ${item.path}`);
  const message = fileReferences.length
    ? `${trimmed}\n\n附加的本地文件：\n${fileReferences.join("\n")}`.trim()
    : trimmed;
  const images = imageAttachments.map((item) => ({
    type: "image" as const,
    data: item.data!,
    mimeType: item.mimeType,
  }));
  return { message, images };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function applyToolResult(call: UiToolCall, result: ToolResultMessage) {
  call.result = stringifyResult(result.content);
  call.images = imagesFromContent(result.content);
  call.details = isRecord(result.details) ? result.details : undefined;
  call.isError = result.isError;
  call.running = false;
  call.finishedAt = result.timestamp;
}

export function attachToolResult(messages: UiMessage[], result: ToolResultMessage) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const call = message.toolCalls?.find((candidate) => candidate.id === result.toolCallId);
    if (call) {
      applyToolResult(call, result);
      return;
    }
  }
}

export function resultContent(result: unknown): unknown[] {
  return isRecord(result) && Array.isArray(result.content) ? result.content : [];
}

export function resultDetails(result: unknown): Record<string, unknown> | undefined {
  return isRecord(result) && isRecord(result.details) ? result.details : undefined;
}

export function agentBrowserFromResult(
  result: unknown,
  previous: AgentBrowserState | null,
): AgentBrowserState | null {
  const details = resultDetails(result);
  const images = imagesFromContent(resultContent(result));
  const url = typeof details?.url === "string" ? details.url : previous?.url;
  const title = typeof details?.title === "string" ? details.title : previous?.title;
  if (!url && !title && !images?.[0]) return previous;
  return {
    url: url || "about:blank",
    title: title || url || "Agent 浏览器",
    screenshot: images?.[0] ?? previous?.screenshot,
    updatedAt: Date.now(),
  };
}

export function agentBrowserFromMessages(messages: UiMessage[]): AgentBrowserState | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const calls = messages[messageIndex].toolCalls ?? [];
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex -= 1) {
      const call = calls[callIndex];
      if (call.name.toLowerCase() !== "browser") continue;
      const url = typeof call.details?.url === "string" ? call.details.url : "about:blank";
      const title = typeof call.details?.title === "string" ? call.details.title : url;
      return { url, title, screenshot: call.images?.[0], updatedAt: call.finishedAt ?? Date.now() };
    }
  }
  return null;
}

export function computerFromResult(result: unknown, previous: ComputerState | null): ComputerState | null {
  const details = resultDetails(result);
  const images = imagesFromContent(resultContent(result));
  const hasDesktopFrame = Boolean(images?.[0])
    || typeof details?.width === "number"
    || typeof details?.height === "number";
  if (!hasDesktopFrame && !previous) return null;
  return {
    action: typeof details?.action === "string" ? details.action : previous?.action || "screenshot",
    width: typeof details?.width === "number" ? details.width : previous?.width || 0,
    height: typeof details?.height === "number" ? details.height : previous?.height || 0,
    left: typeof details?.left === "number" ? details.left : previous?.left || 0,
    top: typeof details?.top === "number" ? details.top : previous?.top || 0,
    screenshot: images?.[0] ?? previous?.screenshot,
    updatedAt: Date.now(),
  };
}

export function computerFromMessages(messages: UiMessage[]): ComputerState | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const calls = messages[messageIndex].toolCalls ?? [];
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex -= 1) {
      const call = calls[callIndex];
      if (call.name.toLowerCase() !== "computer") continue;
      return computerFromResult({ content: call.images ?? [], details: call.details }, null);
    }
  }
  return null;
}

export function stringifyResult(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const text = textFromContent(result);
    if (text) return text;
  }
  if (typeof result === "object" && result !== null && "content" in result) {
    const text = textFromContent((result as { content: unknown }).content);
    if (text) return text;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
