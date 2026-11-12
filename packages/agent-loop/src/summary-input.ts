/**
 * Shrinking the history a compaction summary is asked for (ADR 0019).
 *
 * Compaction in a run summarizes the whole branch with the session's model
 * (ADR 0008). When the run hit the context limit, that history is about as
 * large as the request that just failed, so the summary request can fail the
 * same way. Each fallback level clips long text (user messages, tool results,
 * string arguments of tool calls) to its start and end and replaces images
 * with a note. The model's own text and thinking are kept as they are.
 */
import type { AssistantContent, Message, ToolResultContent, UserContent } from "@qianji/llm";

/** Longest text kept verbatim at each fallback level, in characters. */
export const SUMMARY_CLIP_LEVELS = [8_000, 1_000] as const;

export const IMAGE_OMITTED = "[image omitted]";

/** `text` cut to its first and last `max / 2` characters, with how much was left out. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n[… ${text.length - 2 * half} characters omitted …]\n${text.slice(text.length - half)}`;
}

function clipValue(value: unknown, max: number): unknown {
  if (typeof value === "string") return clipText(value, max);
  if (Array.isArray(value)) return value.map((item) => clipValue(item, max));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipValue(item, max)]));
  }
  return value;
}

function clipContent<T extends UserContent | ToolResultContent>(block: T, max: number): UserContent | ToolResultContent {
  if (block.type === "image") return { type: "text", text: IMAGE_OMITTED };
  return { type: "text", text: clipText(block.text, max) };
}

function clipAssistant(block: AssistantContent, max: number): AssistantContent {
  if (block.type !== "tool-call") return block;
  return { ...block, arguments: clipValue(block.arguments, max) as Record<string, unknown> };
}

/** `messages` with every long text clipped to `max` characters and images replaced by a note. */
export function shrinkForSummary(messages: readonly Message[], max: number): Message[] {
  return messages.map((message): Message => {
    if (message.role === "assistant") return { ...message, content: message.content.map((block) => clipAssistant(block, max)) };
    if (message.role === "user") return { ...message, content: message.content.map((block) => clipContent(block, max)) };
    return { ...message, content: message.content.map((block) => clipContent(block, max)) };
  });
}
