import type { UiMessage, UiToolCall, WorkStep } from "../types";
import { extractInlineThinking, foldThinking } from "./thinkingDisplay";

function mergeToolCalls(messages: UiMessage[]): UiToolCall[] | undefined {
  // A Map keeps first-insertion order even when a later update replaces the value,
  // which is the order calls were first seen in.
  const byId = new Map<string, UiToolCall>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      byId.set(call.id, { ...byId.get(call.id), ...call });
    }
  }
  if (!byId.size) return undefined;
  return [...byId.values()];
}

function normalizedMessages(messages: UiMessage[]): UiMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const split = extractInlineThinking(message.content, message.thinking);
    if (split.content === message.content && split.thinking === message.thinking) return message;
    return { ...message, content: split.content, thinking: split.thinking };
  });
}

function findFinalContentIndex(messages: UiMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (/```(?:qianji-rich|pidesktop-rich)/.test(messages[index].content || "")) return index;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    // Any text on or before a tool-calling message is narration that preceded those tool calls.
    if ((messages[index].toolCalls?.length ?? 0) > 0) return -1;
    if (messages[index].content?.trim()) return index;
  }
  return -1;
}

function turnDurationMs(messages: UiMessage[]): number | undefined {
  const explicit = messages[messages.length - 1]?.durationMs;
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const timestamps = messages.map((message) => message.timestamp).filter((value) => value > 0);
  if (timestamps.length < 2) return messages.find((message) => (message.durationMs ?? 0) > 0)?.durationMs;
  return Math.max(0, timestamps[timestamps.length - 1] - timestamps[0]);
}

export function workStepsFromMessages(
  messages: UiMessage[],
  finalContent: string,
  finalContentIndex?: number,
): WorkStep[] {
  const normalized = normalizedMessages(messages);
  const final = finalContent.trim();
  const steps: WorkStep[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const message = normalized[index];
    const thinking = foldThinking(message.thinking, finalContent);
    if (thinking) steps.push({ kind: "thinking", text: thinking });
    const note = message.content.trim();
    const isFinalMessage = finalContentIndex !== undefined ? index === finalContentIndex : note === final;
    if (note && !isFinalMessage) steps.push({ kind: "note", text: note });
    for (const call of message.toolCalls ?? []) steps.push({ kind: "tool", call });
  }
  return steps;
}

export function mergeAssistantTurn(messages: UiMessage[]): UiMessage {
  const normalized = normalizedMessages(messages);
  const last = normalized[normalized.length - 1];
  const finalIndex = findFinalContentIndex(normalized);
  const content = finalIndex >= 0 ? normalized[finalIndex].content : "";
  const steps = workStepsFromMessages(normalized, content, finalIndex);
  const thinking = steps.filter((step) => step.kind === "thinking").map((step) => step.text).join("\n\n") || undefined;
  return {
    ...last,
    id: normalized[0].id,
    content,
    thinking,
    workSteps: steps,
    toolCalls: mergeToolCalls(normalized),
    isStreaming: normalized.some((message) => message.isStreaming),
    isError: normalized.some((message) => message.isError),
    isAborted: normalized.some((message) => message.isAborted),
    durationMs: turnDurationMs(normalized),
    timestamp: last.timestamp || normalized[0].timestamp,
  };
}

/** Collapse consecutive assistant messages from one user turn into a single display row. */
export function groupTranscriptMessages(messages: UiMessage[]): UiMessage[] {
  const out: UiMessage[] = [];
  let bucket: UiMessage[] = [];
  const flush = () => {
    if (!bucket.length) return;
    out.push(mergeAssistantTurn(bucket));
    bucket = [];
  };
  for (const message of messages) {
    if (message.role === "assistant") {
      bucket.push(message);
      continue;
    }
    flush();
    out.push(message);
  }
  flush();
  return out;
}
