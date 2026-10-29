/**
 * The Harness Host's session log and live progress in the shapes the
 * transcript already renders (docs/adr/0014-frontend-harness-adapter.md).
 *
 * Persisted events become Pi's `AgentMessage`s; live deltas become the Pi
 * events the store's `handleEvent` consumes. Everything here is a pure
 * function or a small stateful translator, so it is tested against the
 * loop's golden logs.
 */
import type { LiveDelta, PersistedEvent, SessionInfo as HostSessionInfo } from "@pid/protocol";
import type {
  AgentMessage,
  AssistantMessage,
  ImageContent,
  PiEvent,
  SessionInfo,
  SessionMessageTiming,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "../types";

type Block = { type: string; [key: string]: unknown };

const timestamp = (event: PersistedEvent): number => {
  const parsed = Date.parse(event.ts);
  return Number.isFinite(parsed) ? parsed : 0;
};

function userContent(blocks: unknown): (TextContent | ImageContent)[] {
  return (Array.isArray(blocks) ? (blocks as Block[]) : []).flatMap((block): (TextContent | ImageContent)[] => {
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      return [{ type: "image", data: block.data, mimeType: block.mimeType }];
    }
    return [];
  });
}

const STOP_REASONS: Record<string, AssistantMessage["stopReason"]> = {
  stop: "stop",
  length: "length",
  "tool-use": "toolUse",
  error: "error",
  aborted: "aborted",
  refusal: "stop",
};

function usageOf(value: unknown): Usage {
  const usage = (value ?? {}) as Record<string, unknown>;
  const n = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  const input = n("inputTokens");
  const output = n("outputTokens");
  const cacheRead = n("cacheReadTokens");
  const cacheWrite = n("cacheWriteTokens");
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite };
}

export function assistantContent(blocks: unknown): (TextContent | ThinkingContent | ToolCallContent)[] {
  return (Array.isArray(blocks) ? (blocks as Block[]) : []).flatMap((block): (TextContent | ThinkingContent | ToolCallContent)[] => {
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type === "thinking" && typeof block.text === "string") return [{ type: "thinking", thinking: block.text }];
    if (block.type === "tool-call" && typeof block.id === "string" && typeof block.name === "string") {
      return [{ type: "toolCall", id: block.id, name: block.name, arguments: (block.arguments ?? {}) as Record<string, unknown> }];
    }
    return [];
  });
}

export function userMessageOf(event: PersistedEvent): UserMessage {
  const data = event.data as { content?: unknown };
  return { role: "user", content: userContent(data.content), timestamp: timestamp(event) };
}

export function assistantMessageOf(event: PersistedEvent): AssistantMessage {
  const data = event.data as { content?: unknown; model?: { provider?: string; model?: string }; usage?: unknown; stop?: string; error?: { message?: string } };
  return {
    role: "assistant",
    content: assistantContent(data.content),
    provider: data.model?.provider ?? "",
    model: data.model?.model ?? "",
    usage: usageOf(data.usage),
    stopReason: STOP_REASONS[data.stop ?? ""] ?? "stop",
    ...(data.error?.message === undefined ? {} : { errorMessage: data.error.message }),
    timestamp: timestamp(event),
  };
}

export function toolResultMessageOf(event: PersistedEvent): ToolResultMessage {
  const data = event.data as { callId?: string; name?: string; content?: unknown; isError?: boolean };
  return {
    role: "toolResult",
    toolCallId: data.callId ?? "",
    toolName: data.name ?? "",
    content: userContent(data.content),
    isError: data.isError === true,
    timestamp: timestamp(event),
  };
}

/** The events on the current branch: each `rewind` drops what came after its `toSeq` (ADR 0004). */
export function currentBranch(events: readonly PersistedEvent[]): PersistedEvent[] {
  let branch: PersistedEvent[] = [];
  for (const event of events) {
    if (event.type === "rewind") {
      const toSeq = (event.data as { toSeq?: number }).toSeq ?? 0;
      branch = branch.filter((kept) => kept.seq <= toSeq);
    } else {
      branch.push(event);
    }
  }
  return branch;
}

/**
 * The transcript of a session log. A compaction shows as a summary message
 * where it happened; the messages before it stay visible, as in Pi.
 */
export function toAgentMessages(events: readonly PersistedEvent[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const event of currentBranch(events)) {
    if (event.type === "user") messages.push(userMessageOf(event));
    else if (event.type === "assistant") messages.push(assistantMessageOf(event));
    else if (event.type === "tool-result") messages.push(toolResultMessageOf(event));
    else if (event.type === "compaction") {
      const summary = (event.data as { summary?: string }).summary ?? "";
      messages.push({ role: "compactionSummary", summary, tokensBefore: 0, timestamp: timestamp(event) });
    }
  }
  return messages;
}

/** The harness's efforts as Pi's thinking levels, and back. */
export const HARNESS_THINKING_LEVELS = ["off", "low", "medium", "high"];

export function effortForLevel(level: string): "off" | "low" | "medium" | "high" {
  if (level === "off") return "off";
  if (level === "minimal" || level === "low") return "low";
  if (level === "high" || level === "xhigh") return "high";
  return "medium";
}

export interface PlanInfo {
  items: Array<{ text: string; status: string }>;
}

/** The plan widget's lines, as the Pi plan extension draws them. */
export function planWidgetLines(plan: PlanInfo): string[] {
  if (plan.items.length === 0) return [];
  const completed = plan.items.filter((item) => item.status === "completed").length;
  return [
    `计划 ${completed}/${plan.items.length}`,
    ...plan.items.map((item) => `${item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]"} ${item.text}`),
  ];
}

const queueOf = (count: unknown): unknown[] => Array.from({ length: typeof count === "number" ? count : 0 }, () => "");

/**
 * Turns one session's notifications into Pi events. Stateful only for the
 * model call in progress: tool calls stream in pieces and the transcript
 * shows each once its arguments are complete.
 */
export class HarnessEventTranslator {
  private toolCalls = new Map<number, { id: string; name: string; json: string }>();

  constructor(private readonly model: () => { provider: string; model: string } | undefined) {}

  event(event: PersistedEvent): PiEvent[] {
    switch (event.type) {
      case "user":
        return [{ type: "message_start", message: userMessageOf(event) }];
      case "assistant":
        this.toolCalls.clear();
        return [{ type: "message_end", message: assistantMessageOf(event) }];
      case "tool-call": {
        const data = event.data as { callId: string; name: string; args?: Record<string, unknown> };
        return [{ type: "tool_execution_start", toolCallId: data.callId, toolName: data.name, args: data.args ?? {} }];
      }
      case "tool-result": {
        const message = toolResultMessageOf(event);
        return [
          { type: "tool_execution_end", toolCallId: message.toolCallId, toolName: message.toolName, result: { content: message.content }, isError: message.isError },
          { type: "message_end", message },
        ];
      }
      default:
        return [];
    }
  }

  delta(delta: LiveDelta): PiEvent[] {
    switch (delta.type) {
      case "agent-start":
        return [{ type: "agent_start" }];
      case "agent-end":
        return [{ type: "agent_end" }, { type: "agent_settled" }];
      case "llm-start": {
        this.toolCalls.clear();
        const model = this.model();
        const message: AssistantMessage = {
          role: "assistant",
          content: [],
          provider: (delta.provider as string | undefined) ?? model?.provider ?? "",
          model: (delta.model as string | undefined) ?? model?.model ?? "",
          stopReason: "pending",
          timestamp: Date.now(),
        };
        return [{ type: "message_start", message }];
      }
      case "llm-chunk":
        return this.chunk((delta.chunk ?? {}) as Block);
      case "queue":
        return [{ type: "queue_update", steering: queueOf(delta.steer), followUp: queueOf(delta.followUp) }];
      case "compaction-start":
        return [{ type: "compaction_start" }];
      case "compaction-end":
        return [{ type: "compaction_end", ...(delta.ok === false ? { errorMessage: "上下文压缩失败" } : {}) }];
      case "plan": {
        const lines = planWidgetLines((delta.plan ?? { items: [] }) as PlanInfo);
        return [{ type: "extension_ui_request", id: "harness-plan", method: "setWidget", widgetKey: "pidesktop-plan", ...(lines.length > 0 ? { widgetLines: lines } : {}) }];
      }
      default:
        return [];
    }
  }

  private chunk(chunk: Block): PiEvent[] {
    const update = (assistantMessageEvent: Extract<PiEvent, { type: "message_update" }>["assistantMessageEvent"]): PiEvent => ({ type: "message_update", assistantMessageEvent });
    switch (chunk.type) {
      case "text-delta":
        return [update({ type: "text_delta", delta: String(chunk.text ?? "") })];
      case "thinking-delta":
        return [update({ type: "thinking_delta", delta: String(chunk.text ?? "") })];
      case "tool-call-start":
        this.toolCalls.set(Number(chunk.index), { id: String(chunk.id), name: String(chunk.name), json: "" });
        return [];
      case "tool-call-delta": {
        const call = this.toolCalls.get(Number(chunk.index));
        if (call !== undefined) call.json += String(chunk.argumentsDelta ?? "");
        return [];
      }
      case "finish":
        return [...this.toolCalls.values()].map((call) => update({
          type: "toolcall_end",
          toolCall: { type: "toolCall", id: call.id, name: call.name, arguments: parseArguments(call.json) },
        }));
      default:
        return [];
    }
  }
}

function parseArguments(json: string): Record<string, unknown> {
  if (json.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A Host session as a sidebar entry; its file is `harness:<id>`. */
export function sessionInfoFromHost(session: HostSessionInfo): SessionInfo {
  const updatedAt = Date.parse(session.updatedAt);
  return {
    file: `harness:${session.id}`,
    sessionId: session.id,
    cwd: session.cwd,
    ...(session.title === undefined ? {} : { name: session.title }),
    ...(session.firstMessage === undefined ? {} : { firstMessage: session.firstMessage }),
    messageCount: session.messageCount,
    createdAt: session.createdAt,
    ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
  };
}

/** When each user and assistant message on the current branch was written, as Pi's session reader reports it. */
export function messageTimingsOf(events: readonly PersistedEvent[]): SessionMessageTiming[] {
  return currentBranch(events).flatMap((event): SessionMessageTiming[] => (
    event.type === "user" || event.type === "assistant"
      ? [{ role: event.type, messageTimestamp: Date.parse(event.ts) || 0, entryTimestamp: event.ts }]
      : []
  ));
}

/** The user messages on the current branch, as Pi's fork points (`entryId` is the event's seq). */
export function forkPointsOf(events: readonly PersistedEvent[]): Array<{ entryId: string; text: string }> {
  return currentBranch(events).flatMap((event) => {
    if (event.type !== "user") return [];
    const text = userContent((event.data as { content?: unknown }).content)
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");
    return [{ entryId: String(event.seq), text }];
  });
}

export interface HarnessTreeNode {
  entry: { type: "message"; id: string; parentId: string | null; timestamp: string; message: { role: string; content: unknown } };
  children: HarnessTreeNode[];
}

/**
 * The whole log as Pi's session tree: each user or assistant message hangs
 * off the previous message of its branch, and a rewind starts a new branch
 * from the last message at or before its `toSeq`. Returns the roots and the
 * id of the current branch's last message.
 */
export function sessionTreeOf(events: readonly PersistedEvent[]): { tree: HarnessTreeNode[]; leafId: string | null } {
  const roots: HarnessTreeNode[] = [];
  const nodes = new Map<number, HarnessTreeNode>();
  const path: number[] = [];
  for (const event of events) {
    if (event.type === "rewind") {
      const toSeq = (event.data as { toSeq?: number }).toSeq ?? 0;
      while (path.length > 0 && (path.at(-1) as number) > toSeq) path.pop();
      continue;
    }
    if (event.type !== "user" && event.type !== "assistant") continue;
    const parentSeq = path.at(-1);
    const node: HarnessTreeNode = {
      entry: {
        type: "message",
        id: String(event.seq),
        parentId: parentSeq === undefined ? null : String(parentSeq),
        timestamp: event.ts,
        message: { role: event.type, content: (event.data as { content?: unknown }).content },
      },
      children: [],
    };
    nodes.set(event.seq, node);
    if (parentSeq === undefined) roots.push(node);
    else nodes.get(parentSeq)?.children.push(node);
    path.push(event.seq);
  }
  const leaf = path.at(-1);
  return { tree: roots, leafId: leaf === undefined ? null : String(leaf) };
}
