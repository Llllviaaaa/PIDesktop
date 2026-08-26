import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentMessage,
  AppSettings,
  AttachmentPayload,
  ExtensionUIRequest,
  GitBranchInfo,
  GitCommitInfo,
  GitSnapshot,
  ModelProviderCheckResult,
  ModelProviderConfig,
  ModelProviderInput,
  PackageCatalogDetail,
  PackageCatalogPage,
  PiEvent,
  ProjectConfig,
  PullRequestCollection,
  ResourceItem,
  RpcResponse,
  SessionHistory,
  SessionInfo,
  SessionMessageTiming,
  ScheduledRunRecord,
  ScheduledRunResult,
  ScheduledTask,
  UsageSummary,
  WorkspaceDirEntry,
  WorkspaceEditorInfo,
  WorkspaceFileContent,
  WorktreeInfo,
} from "../types";
import { rejectRuntimeCommands, sendPiCommand, subscribePiEvents } from "./piTransport";

let sessionsRequest: Promise<SessionInfo[]> | null = null;
const gitSnapshotRequests = new Map<string, Promise<GitSnapshot>>();
const packageSearchCache = new Map<string, PackageCatalogPage>();
const packageDetailCache = new Map<string, PackageCatalogDetail>();

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

async function searchPackages(query: string, page = 0, pageSize = 30): Promise<PackageCatalogPage> {
  const key = `${query.trim().toLowerCase()}\u0000${page}\u0000${pageSize}`;
  const cached = packageSearchCache.get(key);
  if (cached) return cached;
  const result = await invoke<PackageCatalogPage>("search_pi_packages", { query, page, pageSize });
  packageSearchCache.set(key, result);
  return result;
}

async function packageDetail(name: string): Promise<PackageCatalogDetail> {
  const key = name.trim().toLowerCase();
  const cached = packageDetailCache.get(key);
  if (cached) return cached;
  const result = await invoke<PackageCatalogDetail>("pi_package_detail", { name });
  packageDetailCache.set(key, result);
  return result;
}

function clearPackageCatalogCache() {
  packageSearchCache.clear();
  packageDetailCache.clear();
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
  listScheduledRuns: (taskId?: string, limit = 80) =>
    invoke<ScheduledRunRecord[]>("list_scheduled_runs_cmd", { taskId: taskId || null, limit }),
  saveScheduledTask: (task: ScheduledTask) => invoke<ScheduledTask>("save_scheduled_task_cmd", { task }),
  deleteScheduledTask: (id: string) => invoke<void>("delete_scheduled_task_cmd", { id }),
  runScheduledTask: (id: string, nextRunAt?: number | null) =>
    invoke<ScheduledRunResult>("run_scheduled_task_cmd", { id, nextRunAt: nextRunAt ?? null }),
  cancelScheduledTask: (id: string) => invoke<void>("cancel_scheduled_task_cmd", { id }),
  listSessions,
  sessionHistory: (file: string) => invoke<SessionHistory>("session_history_cmd", { file }),
  exportSessionMarkdown: (file: string, destination: string) => invoke<string>("export_session_markdown", { file, destination }),
  sessionMessageTimings: (file: string) => invoke<SessionMessageTiming[]>("session_message_timings_cmd", { file }),
  sessionMessages: (file: string) => invoke<AgentMessage[]>("session_messages_cmd", { file }),
  listArchivedSessions: () => invoke<SessionInfo[]>("list_archived_sessions_cmd"),
  archiveSession: (file: string) => invoke<void>("archive_session_cmd", { file }),
  restoreSession: (file: string) => invoke<void>("restore_session_cmd", { file }),
  deleteSession: (file: string) => invoke<void>("delete_session_cmd", { file }),
  getSettings: () => invoke<AppSettings>("get_settings"),
  setSettings: (settings: AppSettings) => invoke<void>("set_settings", { settings }),
  getLocalMemory: () => invoke<string>("get_local_memory"),
  setLocalMemory: (contents: string) => invoke<void>("set_local_memory", { contents }),
  exportLocalMemory: (destination: string) => invoke<string>("export_local_memory", { destination }),
  deleteLocalMemory: () => invoke<void>("delete_local_memory"),
  listModelProviders: () => invoke<ModelProviderConfig[]>("list_model_providers"),
  saveModelProvider: (provider: ModelProviderInput) => invoke<void>("save_model_provider", { provider }),
  deleteModelProvider: (id: string) => invoke<void>("delete_model_provider", { id }),
  checkModelProvider: (id: string) => invoke<ModelProviderCheckResult>("check_model_provider", { id }),
  readAttachment: (file: string) => invoke<AttachmentPayload>("read_attachment", { file }),
  gitSnapshot,
  gitRepositoryRoot: (cwd: string) => invoke<string | null>("git_repository_root", { cwd }),
  gitRestoreFiles: (cwd: string, paths: string[]) => invoke<void>("git_restore_files", { cwd, paths }),
  gitStageFiles: (cwd: string, paths: string[]) => invoke<void>("git_stage_files", { cwd, paths }),
  gitUnstageFiles: (cwd: string, paths: string[]) => invoke<void>("git_unstage_files", { cwd, paths }),
  gitListBranches: (cwd: string) => invoke<GitBranchInfo[]>("git_list_branches", { cwd }),
  gitCheckoutBranch: (cwd: string, branch: string) => invoke<void>("git_checkout_branch", { cwd, branch }),
  gitCompare: (cwd: string, base: string) => invoke<GitSnapshot>("git_compare", { cwd, base }),
  gitReviewSnapshot: (cwd: string, filter: "uncommitted" | "unstaged" | "staged") =>
    invoke<GitSnapshot>("git_review_snapshot", { cwd, filter }),
  gitListCommits: (cwd: string, limit = 50) => invoke<GitCommitInfo[]>("git_list_commits", { cwd, limit }),
  gitCommitSnapshot: (cwd: string, commit: string) => invoke<GitSnapshot>("git_commit_snapshot", { cwd, commit }),
  listPullRequests: (cwd: string) => invoke<PullRequestCollection>("list_pull_requests", { cwd }),
  checkoutPullRequest: (cwd: string, number: number) => invoke<void>("checkout_pull_request", { cwd, number }),
  listResources: (cwd: string) => invoke<ResourceItem[]>("list_resources", { cwd }),
  searchPackages,
  packageDetail,
  clearPackageCatalogCache,
  listWorkspaceDir: (cwd: string, path?: string) =>
    invoke<WorkspaceDirEntry[]>("list_workspace_dir", { cwd, path }),
  searchWorkspaceFiles: (cwd: string, query: string, requestId: string) =>
    invoke<WorkspaceDirEntry[]>("search_workspace_files", { cwd, query, requestId }),
  cancelWorkspaceSearch: (requestId: string) =>
    invoke<void>("cancel_workspace_search", { requestId }),
  readWorkspaceFile: (cwd: string, path: string) =>
    invoke<WorkspaceFileContent>("read_workspace_file", { cwd, path }),
  openWorkspaceInFileManager: (path: string) => invoke<void>("open_workspace_in_file_manager", { path }),
  listWorkspaceEditors: () => invoke<WorkspaceEditorInfo[]>("list_workspace_editors"),
  openWorkspaceInEditor: (path: string, editorId: WorkspaceEditorInfo["id"]) =>
    invoke<void>("open_workspace_in_editor", { path, editorId }),
  listWorktrees: (cwd: string) => invoke<WorktreeInfo[]>("list_worktrees", { cwd }),
  createWorktree: (cwd: string, base?: string) => invoke<WorktreeInfo>("create_worktree", { cwd, base }),
  packageAction: (action: "install" | "remove" | "update", source?: string, cwd?: string, scope: "user" | "project" = "user") => invoke<string>("pi_package_action", { action, source, cwd, scope }),
  usageSummary: () => invoke<UsageSummary>("usage_summary"),
};

export interface PiStartResult {
  runtimeId: string;
  sessionLoaded: boolean;
  sessionForked: boolean;
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

interface TaggedPiLog {
  runtimeId: string;
  line: string;
}

export interface PiListeners {
  onEvent: (runtimeId: string, event: PiEvent) => void;
  onStatus: (status: PiRuntimeStatus) => void;
  onLog: (runtimeId: string, line: string) => void;
  onProtocolError?: (message: string) => void;
}

export async function subscribeToPi(listeners: PiListeners): Promise<UnlistenFn> {
  const unlisteners = await Promise.all([
    subscribePiEvents({ onEvent: listeners.onEvent, onProtocolError: listeners.onProtocolError }),
    listen<PiRuntimeStatus>(
      "pi-status",
      (event) => {
        if (event.payload.status === "exited") {
          rejectRuntimeCommands(event.payload.runtimeId, "Pi runtime exited before the command completed");
        }
        listeners.onStatus(event.payload);
      },
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
  return sendPiCommand(pi.sendRaw, runtimeId, command, payload, timeoutMs);
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
