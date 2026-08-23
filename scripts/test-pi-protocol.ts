import { decodePiEventEnvelope, PI_DESKTOP_PROTOCOL_VERSION } from "../src/lib/piProtocol.ts";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const valid = decodePiEventEnvelope({
  protocolVersion: PI_DESKTOP_PROTOCOL_VERSION,
  runtimeId: "runtime-1",
  event: { type: "agent_start" },
});
assert(valid.ok && valid.value.runtimeId === "runtime-1", "valid event was rejected");

const incompatible = decodePiEventEnvelope({
  protocolVersion: PI_DESKTOP_PROTOCOL_VERSION + 1,
  runtimeId: "runtime-1",
  event: { type: "agent_start" },
});
assert(!incompatible.ok && incompatible.error.includes("unsupported"), "protocol mismatch was accepted");

const unknown = decodePiEventEnvelope({
  protocolVersion: PI_DESKTOP_PROTOCOL_VERSION,
  runtimeId: "runtime-1",
  event: { type: "future_event" },
});
assert(!unknown.ok && unknown.error.includes("unknown Pi event type"), "unknown event was accepted");

const malformed = decodePiEventEnvelope({
  protocolVersion: PI_DESKTOP_PROTOCOL_VERSION,
  runtimeId: "runtime-1",
  event: { type: "message_update" },
});
assert(!malformed.ok && malformed.error.includes("assistantMessageEvent"), "malformed event was accepted");

console.log("pi-protocol: version and event-shape validation passed");
