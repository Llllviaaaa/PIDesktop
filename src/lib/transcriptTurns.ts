import type { UiMessage, UiToolCall, WorkStep } from "../types";
import { foldThinking } from "./thinkingDisplay";

function mergeToolCalls(messages: UiMessage[]): UiToolCall[] | undefined {
  const order: string[] = [];
  const byId = new Map<string, UiToolCall>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (!byId.has(call.id)) order.push(call.id);
      byId.set(call.id, { ...byId.get(call.id), ...call });
    }
  }
  if (!order.length) return undefined;
  return order.map((id) => byId.get(id)!);
}

function lastContent(messages: UiMessage[]): string {
  const rich = [...messages].reverse().find((message) => /```pidesktop-rich/.test(message.content || ""));
  if (rich) return rich.content;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].content?.trim()) return messages[index].content;
  }
  return "";
}

function turnDurationMs(messages: UiMessage[]): number | undefined {
  const explicit = messages[messages.length - 1]?.durationMs;
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const timestamps = messages.map((message) => message.timestamp).filter((value) => value > 0);
  if (timestamps.length < 2) return messages.find((message) => (message.durationMs ?? 0) > 0)?.durationMs;
  return Math.max(0, timestamps[timestamps.length - 1] - timestamps[0]);
}

export function workStepsFromMessages(messages: UiMessage[], finalContent: string): WorkStep[] {
  const final = finalContent.trim();
  const steps: WorkStep[] = [];
  for (const message of messages) {
    const thinking = foldThinking(message.thinking, finalContent);
    if (thinking) steps.push({ kind: "thinking", text: thinking });
    const note = message.content.trim();
    if (note && note !== final) steps.push({ kind: "note", text: note });
    for (const call of message.toolCalls ?? []) steps.push({ kind: "tool", call });
  }
  return steps;
}

export function mergeAssistantTurn(messages: UiMessage[]): UiMessage {
  const last = messages[messages.length - 1];
  const content = lastContent(messages);
  const steps = workStepsFromMessages(messages, content);
  const thinking = steps.filter((step) => step.kind === "thinking").map((step) => step.text).join("\n\n") || undefined;
  return {
    ...last,
    id: messages[0].id,
    content,
    thinking,
    workSteps: steps,
    toolCalls: mergeToolCalls(messages),
    isStreaming: messages.some((message) => message.isStreaming),
    isError: messages.some((message) => message.isError),
    durationMs: turnDurationMs(messages),
    timestamp: last.timestamp || messages[0].timestamp,
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
