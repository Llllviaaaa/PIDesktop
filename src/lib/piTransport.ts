import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PiEvent, RpcResponse } from "../types";
import { decodePiEventEnvelope } from "./piProtocol";
import { PiRpcResponseRouter } from "./piRpcRouter";

interface EventSubscriber {
  onEvent: (runtimeId: string, event: PiEvent) => void;
  onProtocolError?: (message: string) => void;
}

type RawSender = (runtimeId: string, line: string) => Promise<void>;

const subscribers = new Set<EventSubscriber>();
const responses = new PiRpcResponseRouter();
let eventTransport: Promise<UnlistenFn> | null = null;

async function ensureEventTransport(): Promise<void> {
  if (!eventTransport) {
    eventTransport = listen<unknown>("pi-event", (event) => {
      const decoded = decodePiEventEnvelope(event.payload);
      if (!decoded.ok) {
        for (const subscriber of subscribers) subscriber.onProtocolError?.(decoded.error);
        return;
      }
      const { runtimeId, event: piEvent } = decoded.value;
      if (piEvent.type === "response") {
        responses.handle(runtimeId, piEvent as RpcResponse);
      }
      for (const subscriber of subscribers) subscriber.onEvent(runtimeId, piEvent);
    });
  }
  await eventTransport;
}

export async function subscribePiEvents(subscriber: EventSubscriber): Promise<UnlistenFn> {
  subscribers.add(subscriber);
  try {
    await ensureEventTransport();
  } catch (error) {
    subscribers.delete(subscriber);
    throw error;
  }
  return () => subscribers.delete(subscriber);
}

export async function sendPiCommand(
  sendRaw: RawSender,
  runtimeId: string,
  command: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<RpcResponse> {
  await ensureEventTransport();
  const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const pending = responses.register(runtimeId, id, command, timeoutMs);
  try {
    await sendRaw(runtimeId, JSON.stringify({ id, type: command, ...payload }));
  } catch (error) {
    responses.reject(runtimeId, id, error);
  }
  return pending;
}

export function rejectRuntimeCommands(runtimeId: string, reason: string): void {
  responses.rejectRuntime(runtimeId, reason);
}
