import type { UiMessage, UiToolCall } from "../types";

export function updateToolCall(
  source: UiMessage[],
  id: string,
  update: (call: UiToolCall) => UiToolCall,
  name = "tool",
  args: Record<string, unknown> = {},
): UiMessage[] {
  const messages = source.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map((call) => (call.id === id ? update(call) : call)),
  }));
  if (messages.some((message) => message.toolCalls?.some((call) => call.id === id))) return messages;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") {
      const call = update({ id, name, args, running: true });
      messages[index] = { ...messages[index], toolCalls: [...(messages[index].toolCalls ?? []), call] };
      break;
    }
  }
  return messages;
}
