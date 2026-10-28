import type { AssistantContent, AssistantMessage, FinishReason, LlmErrorInfo, StreamChunk, Usage } from "./types.ts";

export interface AssembledResponse {
  message: AssistantMessage;
  usage: Usage;
  reason: FinishReason;
  error?: LlmErrorInfo;
}

type OpenBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; signature?: string; redacted?: string }
  | { type: "tool-call"; id: string; name: string; json: string };

function parseArguments(json: string): Record<string, unknown> {
  if (json.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
  } catch {
    // Kept so the loop can report the malformed call back to the model.
    return { __invalidJson: json };
  }
}

/** Builds the final assistant message from a stream, chunk by chunk. */
export class BlockAssembler {
  private readonly blocks = new Map<number, OpenBlock>();
  private readonly usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  private finish: { reason: FinishReason; error?: LlmErrorInfo } | undefined;

  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case "text-delta": {
        const block = this.block(chunk.index, () => ({ type: "text", text: "" }));
        if (block.type === "text") block.text += chunk.text;
        break;
      }
      case "thinking-delta": {
        const block = this.block(chunk.index, () => ({ type: "thinking", text: "" }));
        if (block.type === "thinking") block.text += chunk.text;
        break;
      }
      case "thinking-signature": {
        const block = this.block(chunk.index, () => ({ type: "thinking", text: "" }));
        if (block.type === "thinking") block.signature = (block.signature ?? "") + chunk.signature;
        break;
      }
      case "thinking-redacted": {
        const block = this.block(chunk.index, () => ({ type: "thinking", text: "" }));
        if (block.type === "thinking") block.redacted = chunk.data;
        break;
      }
      case "tool-call-start":
        this.blocks.set(chunk.index, { type: "tool-call", id: chunk.id, name: chunk.name, json: "" });
        break;
      case "tool-call-delta": {
        const block = this.blocks.get(chunk.index);
        if (block?.type === "tool-call") block.json += chunk.argumentsDelta;
        break;
      }
      case "usage":
        // Providers report running totals, so the latest value of each field wins.
        for (const key of Object.keys(chunk.usage) as Array<keyof Usage>) {
          const value = chunk.usage[key];
          if (typeof value === "number") this.usage[key] = value;
        }
        break;
      case "finish":
        this.finish = chunk.error === undefined ? { reason: chunk.reason } : { reason: chunk.reason, error: chunk.error };
        break;
    }
  }

  result(): AssembledResponse {
    const content: AssistantContent[] = [...this.blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, block]): AssistantContent => {
        if (block.type === "tool-call") return { type: "tool-call", id: block.id, name: block.name, arguments: parseArguments(block.json) };
        if (block.type === "thinking") {
          const thinking: AssistantContent = { type: "thinking", text: block.text };
          if (block.signature !== undefined) thinking.signature = block.signature;
          if (block.redacted !== undefined) thinking.redacted = block.redacted;
          return thinking;
        }
        return { type: "text", text: block.text };
      });
    const finish = this.finish ?? { reason: "error" as const, error: { kind: "unknown" as const, message: "Stream ended without finishing", retryable: true } };
    return { message: { role: "assistant", content }, usage: { ...this.usage }, ...finish };
  }

  private block(index: number, create: () => OpenBlock): OpenBlock {
    let block = this.blocks.get(index);
    if (block === undefined) {
      block = create();
      this.blocks.set(index, block);
    }
    return block;
  }
}

/** Drain a stream into its final message. */
export async function assemble(stream: AsyncIterable<StreamChunk>): Promise<AssembledResponse> {
  const assembler = new BlockAssembler();
  for await (const chunk of stream) assembler.push(chunk);
  return assembler.result();
}
