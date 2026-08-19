import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentMessage,
  AppSettings,
  AttachmentPayload,
  ExtensionUIRequest,
  GitBranchInfo,
  GitSnapshot,
  ModelProviderCheckResult,
  ModelProviderConfig,
  ModelProviderInput,
  PiEvent,
  ProjectConfig,
  PullRequestCollection,
  ResourceItem,
  RpcResponse,
  SessionInfo,
  SessionMessageTiming,
  ScheduledRunResult,
  ScheduledTask,
  UsageSummary,
  WorkspaceDirEntry,
  WorkspaceFileContent,
  WorktreeInfo,
} from "../types";

let sessionsRequest: Promise<SessionInfo[]> | null = null;
const gitSnapshotRequests = new Map<string, Promise<GitSnapshot>>();

function listSessions(): Promise<SessionInfo[]> {
  if (!sessionsRequest) {
    sessionsRequest = invoke<SessionInfo[]>("list_sessions_cmd")
      .finally(() => { sessionsRequest = null; });
  }
  return sessionsRequest;
}

function gitSnapshot(cwd: string): Promise<GitSnapshot> {
  const key = cwd.replace(/[\\/]+$/, "").toLowerCase();
  const pending = gitSnapshotRequests.get(key);
  if (pending) return pending;
  const request = invoke<GitSnapshot>("git_snapshot", { cwd })
    .finally(() => { gitSnapshotRequests.delete(key); });
  gitSnapshotRequests.set(key, request);
  return request;
}

export const pi = {
  start: (cwd: string, sessionFile?: string, isolated = false) => invoke<PiStartResult>("pi_start", { cwd, sessionFile, isolated }),
  stop: (runtimeId: string) => invoke<void>("pi_stop", { runtimeId }),
  sendRaw: (runtimeId: string, line: string) => invoke<void>("pi_send", { runtimeId, line }),
  isRunning: (runtimeId: string) => invoke<boolean>("pi_is_running", { runtimeId }),
  bindSession: (runtimeId: string, sessionFile: string) => invoke<void>("pi_bind_session", { runtimeId, sessionFile }),
  listRuntimes: () => invoke<PiRuntimeInfo[]>("list_pi_runtimes"),
  quickChatDir: () => invoke<string>("quick_chat_dir"),
  listProjects: () => invoke<ProjectConfig[]>("list_projects_cmd"),
  registerProject: (path: string) => invoke<ProjectConfig>("register_project_cmd", { path }),
  saveProject: (project: ProjectConfig) => invoke<ProjectConfig>("save_project_cmd", { project }),
  removeLocalProject: (path: string) => invoke<void>("remove_local_project_cmd", { path }),
  listScheduledTasks: () => invoke<ScheduledTask[]>("list_scheduled_tasks_cmd"),
  saveScheduledTask: (task: ScheduledTask) => invoke<ScheduledTask>("save_scheduled_task_cmd", { task }),
  deleteScheduledTask: (id: string) => invoke<void>("delete_scheduled_task_cmd", { id }),
  runScheduledTask: (id: string, nextRunAt?: number | null) =>
    invoke<ScheduledRunResult>("run_scheduled_task_cmd", { id, nextRunAt: nextRunAt ?? null }),
  listSessions,
  sessionMessageTimings: (file: string) => invoke<SessionMessageTiming[]>("session_message_timings_cmd", { file }),
  sessionMessages: (file: string) => invoke<AgentMessage[]>("session_messages_cmd", { file }),
  listArchivedSessions: () => invoke<SessionInfo[]>("list_archived_sessions_cmd"),
  archiveSession: (file: string) => invoke<void>("archive_session_cmd", { file }),
  restoreSession: (file: string) => invoke<void>("restore_session_cmd", { file }),
  deleteSession: (file: string) => invoke<void>("delete_session_cmd", { file }),
  getSettings: () => invoke<AppSettings>("get_settings"),
  setSettings: (settings: AppSettings) => invoke<void>("set_settings", { settings }),
  listModelProviders: () => invoke<ModelProviderConfig[]>("list_model_providers"),
  saveModelProvider: (provider: ModelProviderInput) => invoke<void>("save_model_provider", { provider }),
  deleteModelProvider: (id: string) => invoke<void>("delete_model_provider", { id }),
  checkModelProvider: (id: string) => invoke<ModelProviderCheckResult>("check_model_provider", { id }),
  readAttachment: (file: string) => invoke<AttachmentPayload>("read_attachment", { file }),
  gitSnapshot,
  gitRestoreFiles: (cwd: string, paths: string[]) => invoke<void>("git_restore_files", { cwd, paths }),
  gitListBranches: (cwd: string) => invoke<GitBranchInfo[]>("git_list_branches", { cwd }),
  gitCheckoutBranch: (cwd: string, branch: string) => invoke<void>("git_checkout_branch", { cwd, branch }),
  gitCompare: (cwd: string, base: string) => invoke<GitSnapshot>("git_compare", { cwd, base }),
  listPullRequests: (cwd: string) => invoke<PullRequestCollection>("list_pull_requests", { cwd }),
  checkoutPullRequest: (cwd: string, number: number) => invoke<void>("checkout_pull_request", { cwd, number }),
  listResources: (cwd: string) => invoke<ResourceItem[]>("list_resources", { cwd }),
  listWorkspaceDir: (cwd: string, path?: string) =>
    invoke<WorkspaceDirEntry[]>("list_workspace_dir", { cwd, path }),
  searchWorkspaceFiles: (cwd: string, query: string) =>
    invoke<WorkspaceDirEntry[]>("search_workspace_files", { cwd, query }),
  readWorkspaceFile: (cwd: string, path: string) =>
    invoke<WorkspaceFileContent>("read_workspace_file", { cwd, path }),
  openWorkspaceInFileManager: (path: string) => invoke<void>("open_workspace_in_file_manager", { path }),
  listWorktrees: (cwd: string) => invoke<WorktreeInfo[]>("list_worktrees", { cwd }),
  createWorktree: (cwd: string, base?: string) => invoke<WorktreeInfo>("create_worktree", { cwd, base }),
  packageAction: (action: "install" | "remove" | "update", source?: string, cwd?: string) => invoke<string>("pi_package_action", { action, source, cwd }),
  usageSummary: () => invoke<UsageSummary>("usage_summary"),
};

export interface PiStartResult {
  runtimeId: string;
  sessionLoaded: boolean;
}

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
