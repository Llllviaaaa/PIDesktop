import type { PiEvent } from "../types";

export const PI_DESKTOP_PROTOCOL_VERSION = 1;

const EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "bash_execution_update",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "extension_error",
  "extension_ui_request",
  "response",
]);

interface PiEventEnvelope {
  protocolVersion: number;
  runtimeId: string;
  event: PiEvent;
}

export type PiEventDecodeResult =
  | { ok: true; value: PiEventEnvelope }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describe(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

function validateEventShape(event: Record<string, unknown>): string | null {
  const type = event.type;
  if (typeof type !== "string" || !EVENT_TYPES.has(type)) {
    return `unknown Pi event type: ${String(type)}`;
  }
  if (["message_start", "message_end"].includes(type) && !isRecord(event.message)) {
    return `${type} is missing message`;
  }
  if (type === "message_update" && !isRecord(event.assistantMessageEvent)) {
    return "message_update is missing assistantMessageEvent";
  }
  if (type.startsWith("tool_execution_")
    && (typeof event.toolCallId !== "string" || typeof event.toolName !== "string")) {
    return `${type} is missing tool identity`;
  }
  if (type === "response" && (typeof event.id !== "string" || typeof event.success !== "boolean")) {
    return "response is missing correlation fields";
  }
  if (type === "extension_ui_request"
    && (typeof event.id !== "string" || typeof event.method !== "string")) {
    return "extension_ui_request is missing request identity";
  }
  return null;
}

export function decodePiEventEnvelope(payload: unknown): PiEventDecodeResult {
  if (!isRecord(payload)) {
    return { ok: false, error: `invalid Pi event envelope: ${describe(payload)}` };
  }
  if (payload.protocolVersion !== PI_DESKTOP_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `unsupported Pi Desktop protocol version ${String(payload.protocolVersion)}; expected ${PI_DESKTOP_PROTOCOL_VERSION}`,
    };
  }
  if (typeof payload.runtimeId !== "string" || !payload.runtimeId) {
    return { ok: false, error: "Pi event envelope is missing runtimeId" };
  }
  if (!isRecord(payload.event)) {
    return { ok: false, error: "Pi event envelope is missing event" };
  }
  const shapeError = validateEventShape(payload.event);
  if (shapeError) {
    return { ok: false, error: `${shapeError}: ${describe(payload.event)}` };
  }
  return {
    ok: true,
    value: {
      protocolVersion: PI_DESKTOP_PROTOCOL_VERSION,
      runtimeId: payload.runtimeId,
      event: payload.event as unknown as PiEvent,
    },
  };
}
