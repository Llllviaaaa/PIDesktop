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
  start: (cwd: string) => invoke<void>("pi_start", { cwd }),
  stop: () => invoke<void>("pi_stop"),
  sendRaw: (line: string) => invoke<void>("pi_send", { line }),
  isRunning: () => invoke<boolean>("pi_is_running"),
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

export interface PiListeners {
  onEvent: (event: PiEvent) => void;
  onStatus: (status: { status: string; code?: number | null; cwd?: string }) => void;
  onLog: (line: string) => void;
}

export async function subscribeToPi(listeners: PiListeners): Promise<UnlistenFn> {
  const unlisteners = await Promise.all([
    listen<PiEvent>("pi-event", (event) => listeners.onEvent(event.payload)),
    listen<{ status: string; code?: number | null; cwd?: string }>(
      "pi-status",
      (event) => listeners.onStatus(event.payload),
    ),
    listen<string>("pi-log", (event) => listeners.onLog(event.payload)),
  ]);
  return () => unlisteners.forEach((unlisten) => unlisten());
}

export async function sendCommand(
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

    void listen<RpcResponse>("pi-event", (event) => {
      const response = event.payload;
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
        return pi.sendRaw(JSON.stringify({ id, type: command, ...payload }));
      })
      .catch((error) => finish(() => reject(error)));
  });
}

export function respondToExtension(
  request: ExtensionUIRequest,
  response: { value?: string; confirmed?: boolean; cancelled?: true },
): Promise<void> {
  return pi.sendRaw(
    JSON.stringify({
      type: "extension_ui_response",
      id: request.id,
      ...response,
    }),
  );
}
