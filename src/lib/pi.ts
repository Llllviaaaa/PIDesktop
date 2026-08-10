import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppSettings,
  AttachmentPayload,
  ExtensionUIRequest,
  GitSnapshot,
  PiEvent,
  ResourceItem,
  RpcResponse,
  SessionInfo,
  UsageSummary,
  WorktreeInfo,
} from "../types";

export const pi = {
  start: (cwd: string, sessionFile?: string) => invoke<string>("pi_start", { cwd, sessionFile }),
  stop: (runtimeId: string) => invoke<void>("pi_stop", { runtimeId }),
  sendRaw: (runtimeId: string, line: string) => invoke<void>("pi_send", { runtimeId, line }),
  isRunning: (runtimeId: string) => invoke<boolean>("pi_is_running", { runtimeId }),
  bindSession: (runtimeId: string, sessionFile: string) => invoke<void>("pi_bind_session", { runtimeId, sessionFile }),
  listRuntimes: () => invoke<PiRuntimeInfo[]>("list_pi_runtimes"),
  quickChatDir: () => invoke<string>("quick_chat_dir"),
  listSessions: () => invoke<SessionInfo[]>("list_sessions_cmd"),
  listArchivedSessions: () => invoke<SessionInfo[]>("list_archived_sessions_cmd"),
  archiveSession: (file: string) => invoke<void>("archive_session_cmd", { file }),
  restoreSession: (file: string) => invoke<void>("restore_session_cmd", { file }),
  deleteSession: (file: string) => invoke<void>("delete_session_cmd", { file }),
  getSettings: () => invoke<AppSettings>("get_settings"),
  setSettings: (settings: AppSettings) => invoke<void>("set_settings", { settings }),
  readAttachment: (file: string) => invoke<AttachmentPayload>("read_attachment", { file }),
  gitSnapshot: (cwd: string) => invoke<GitSnapshot>("git_snapshot", { cwd }),
  listResources: (cwd: string) => invoke<ResourceItem[]>("list_resources", { cwd }),
  listWorktrees: (cwd: string) => invoke<WorktreeInfo[]>("list_worktrees", { cwd }),
  createWorktree: (cwd: string, base?: string) => invoke<WorktreeInfo>("create_worktree", { cwd, base }),
  packageAction: (action: "install" | "remove" | "update", source?: string, cwd?: string) => invoke<string>("pi_package_action", { action, source, cwd }),
  usageSummary: () => invoke<UsageSummary>("usage_summary"),
};

export interface PiRuntimeInfo {
  runtimeId: string;
  cwd: string;
  sessionFile?: string | null;
  isStreaming: boolean;
  pendingExtension?: ExtensionUIRequest | null;
}

export interface PiRuntimeStatus {
  runtimeId: string;
  status: string;
  code?: number | null;
  cwd?: string;
}

interface TaggedPiEvent {
  runtimeId: string;
  event: PiEvent;
}

interface TaggedPiLog {
  runtimeId: string;
  line: string;
}

export interface PiListeners {
  onEvent: (runtimeId: string, event: PiEvent) => void;
  onStatus: (status: PiRuntimeStatus) => void;
  onLog: (runtimeId: string, line: string) => void;
}

export async function subscribeToPi(listeners: PiListeners): Promise<UnlistenFn> {
  const unlisteners = await Promise.all([
    listen<TaggedPiEvent>("pi-event", (event) => listeners.onEvent(event.payload.runtimeId, event.payload.event)),
    listen<PiRuntimeStatus>(
      "pi-status",
      (event) => listeners.onStatus(event.payload),
    ),
    listen<TaggedPiLog>("pi-log", (event) => listeners.onLog(event.payload.runtimeId, event.payload.line)),
  ]);
  return () => unlisteners.forEach((unlisten) => unlisten());
}

export async function sendCommand(
  runtimeId: string,
  command: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<RpcResponse> {
  const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  return new Promise<RpcResponse>((resolve, reject) => {
    let cleanup: UnlistenFn | undefined;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanup?.();
      fn();
    };
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error(`Pi command '${command}' timed out`)));
    }, timeoutMs);

    void listen<TaggedPiEvent>("pi-event", (event) => {
      if (event.payload.runtimeId !== runtimeId) return;
      const response = event.payload.event as RpcResponse;
      if (response.type !== "response" || response.id !== id) return;
      if (!response.success) {
        finish(() => reject(new Error(response.error || `Pi command '${command}' failed`)));
      } else {
        finish(() => resolve(response));
      }
    })
      .then((unlisten) => {
        cleanup = unlisten;
        if (settled) {
          unlisten();
          return;
        }
        return pi.sendRaw(runtimeId, JSON.stringify({ id, type: command, ...payload }));
      })
      .catch((error) => finish(() => reject(error)));
  });
}

export function respondToExtension(
  runtimeId: string,
  request: ExtensionUIRequest,
  response: { value?: string; confirmed?: boolean; cancelled?: true },
): Promise<void> {
  return pi.sendRaw(
    runtimeId,
    JSON.stringify({
      type: "extension_ui_response",
      id: request.id,
      ...response,
    }),
  );
}
