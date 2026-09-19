import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  decodeProviderMessage,
  PROVIDER_SERVICE_COMMAND,
  type AuthEventSummary,
  type AuthMethod,
  type ProviderModelSummary,
  type ProviderSummary,
} from "../../src-tauri/resources/pidesktop-providers-core";
import type { ExtensionUIRequest, PiEvent } from "../types";
import type { PiRuntimeStatus } from "./pi";
import { rejectRuntimeCommands, sendPiCommand, subscribePiEvents } from "./piTransport";

export type { AuthEventSummary, AuthMethod, ProviderModelSummary, ProviderSummary };

/** Matches PROVIDER_SERVICE_RUNTIME_ID in src-tauri/src/lib.rs. */
export const PROVIDER_SERVICE_RUNTIME_ID = "pidesktop-provider-service";
export { PROVIDER_SERVICE_COMMAND };

export type ProviderDialogRequest = Extract<ExtensionUIRequest, { method: "select" | "input" }>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onAuth?: (event: AuthEventSummary) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRequest>();
let dialogHandler: ((request: ProviderDialogRequest) => void) | null = null;
let ready: Promise<void> | null = null;
let listening: Promise<void> | null = null;

const sendRaw = (_runtimeId: string, line: string) => invoke<void>("provider_service_send", { line });

function settle(id: string): PendingRequest | undefined {
  const entry = pending.get(id);
  if (!entry) return undefined;
  pending.delete(id);
  clearTimeout(entry.timer);
  return entry;
}

function failAll(reason: string) {
  for (const id of [...pending.keys()]) settle(id)?.reject(new Error(reason));
  rejectRuntimeCommands(PROVIDER_SERVICE_RUNTIME_ID, reason);
}

function respond(request: ExtensionUIRequest, value: string | undefined) {
  const response = value === undefined ? { cancelled: true } : { value };
  return sendRaw(PROVIDER_SERVICE_RUNTIME_ID, JSON.stringify({ type: "extension_ui_response", id: request.id, ...response }));
}

function handleEvent(runtimeId: string, event: PiEvent) {
  if (runtimeId !== PROVIDER_SERVICE_RUNTIME_ID) return;
  if (event.type === "response") {
    // Slash-command prompts only answer here when Pi rejects them outright.
    const requestId = event.id?.startsWith("svc-") ? event.id.slice(4) : "";
    if (requestId && !event.success) settle(requestId)?.reject(new Error(event.error || "模型服务拒绝了请求"));
    return;
  }
  if (event.type !== "extension_ui_request") return;
  const request = event as ExtensionUIRequest;
  if (request.method === "notify") {
    const message = decodeProviderMessage(request.message);
    if (!message) return;
    if (message.type === "auth") {
      pending.get(message.id)?.onAuth?.(message.event);
      return;
    }
    const entry = settle(message.id);
    if (message.type === "result") entry?.resolve(message.result);
    else entry?.reject(new Error(message.message));
    return;
  }
  if (request.method === "select" || request.method === "input") {
    if (dialogHandler) dialogHandler(request);
    else void respond(request, undefined);
  } else if (request.method === "confirm" || request.method === "editor") {
    void respond(request, undefined);
  }
}

function ensureListening(): Promise<void> {
  listening ??= Promise.all([
    subscribePiEvents({ onEvent: handleEvent }),
    listen<PiRuntimeStatus>("pi-status", (event) => {
      if (event.payload.runtimeId !== PROVIDER_SERVICE_RUNTIME_ID || event.payload.status !== "exited") return;
      ready = null;
      failAll("模型服务已退出，请重试");
    }),
  ]).then(() => undefined).catch((error) => {
    listening = null;
    throw error;
  });
  return listening;
}

async function start(): Promise<void> {
  await ensureListening();
  await invoke<string>("provider_service_start");
  // A custom Pi binary without the -e extension would treat our slash command as a model prompt.
  const commands = await sendPiCommand(sendRaw, PROVIDER_SERVICE_RUNTIME_ID, "get_commands", {}, 30_000);
  if (!commands.data?.commands?.some((command) => command.name === PROVIDER_SERVICE_COMMAND)) {
    await invoke("provider_service_stop");
    throw new Error("当前 Pi 运行时无法加载桌面模型管理扩展，请检查「高级」设置中的 Pi 可执行文件。");
  }
}

export function ensureProviderService(): Promise<void> {
  ready ??= start().catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}

async function call<T>(
  op: string,
  params: Record<string, unknown> = {},
  options: { timeoutMs?: number; onAuth?: (event: AuthEventSummary) => void; requestId?: string } = {},
): Promise<T> {
  await ensureProviderService();
  const id = options.requestId ?? crypto.randomUUID();
  const result = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => settle(id)?.reject(new Error("模型服务响应超时")), options.timeoutMs ?? 30_000);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onAuth: options.onAuth, timer });
  });
  const message = `/${PROVIDER_SERVICE_COMMAND} ${JSON.stringify({ id, op, ...params })}`;
  try {
    await sendRaw(PROVIDER_SERVICE_RUNTIME_ID, JSON.stringify({ id: `svc-${id}`, type: "prompt", message }));
  } catch (error) {
    settle(id);
    throw error;
  }
  return result;
}

export const providerService = {
  list: () => call<{ providers: ProviderSummary[] }>("list").then((result) => result.providers),
  /** Re-read models.json and credentials; `network` also refreshes remote model catalogs. */
  refresh: (network = false) => call<{ refreshed: boolean }>("refresh", { network }, { timeoutMs: network ? 120_000 : 30_000 }),
  login: (
    providerId: string,
    method: AuthMethod,
    options: { apiKey?: string; requestId?: string; onAuth?: (event: AuthEventSummary) => void } = {},
  ) => call<{ providers: ProviderSummary[] }>(
    "login",
    { providerId, method, apiKey: options.apiKey },
    { timeoutMs: 15 * 60_000, onAuth: options.onAuth, requestId: options.requestId },
  ).then((result) => result.providers),
  cancel: (target: string) => call<{ cancelled: boolean }>("cancel", { target }),
  logout: (providerId: string) => call<{ providers: ProviderSummary[] }>("logout", { providerId }).then((result) => result.providers),
  check: (providerId: string, modelId: string) => call<{ latencyMs: number }>("check", { providerId, modelId }, { timeoutMs: 60_000 }),
  /** Route login dialogs (method choice, pasted codes, extra fields) to the Settings UI. */
  onDialog(handler: (request: ProviderDialogRequest) => void): () => void {
    dialogHandler = handler;
    return () => {
      if (dialogHandler === handler) dialogHandler = null;
    };
  },
  respond,
  stop: () => {
    ready = null;
    return invoke<void>("provider_service_stop");
  },
};
