import { invoke } from "@tauri-apps/api/core";
import type { UsageSummaryResult } from "@pid/protocol";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppSettings,
  AttachmentPayload,
  ExtensionUIRequest,
  ModelProviderCheckResult,
  ModelProviderConfig,
  ModelProviderInput,
  ModelProviderModel,
  PackageCatalogDetail,
  PackageCatalogPage,
  PiEvent,
  ProjectConfig,
  PullRequestCollection,
  ResourceItem,
  RpcResponse,
  UsageSummary,
  WorkspaceDirEntry,
  TerminalAppInfo,
  WorkspaceEditorInfo,
  WorkspaceFileContent,
  WorktreeInfo,
} from "../types";
import { rejectRuntimeCommands, sendPiCommand, subscribePiEvents } from "./piTransport";
import { gitClient } from "./gitClient";
import { harnessProviders } from "./harnessProviders";
import { harnessRuntimes, isHarnessRuntime, isHarnessSessionFile } from "./harnessRuntime";
import { scheduleClient } from "./scheduleClient";
import { sessionClient } from "./sessionClient";

/** Pi's usage from its session files, plus the Harness Host's sessions when it can be reached (costs are not computed there). */
async function usageSummary(): Promise<UsageSummary> {
  const [pi, host] = await Promise.all([
    invoke<UsageSummary>("usage_summary"),
    harnessRuntimes.call<UsageSummaryResult>("usage.summary").catch(() => null),
  ]);
  if (host === null) return pi;
  const { usage } = host;
  return {
    ...pi,
    sessions: pi.sessions + host.sessions,
    messages: pi.messages + host.messages,
    inputTokens: pi.inputTokens + usage.inputTokens,
    outputTokens: pi.outputTokens + usage.outputTokens,
    cacheReadTokens: pi.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: pi.cacheWriteTokens + usage.cacheWriteTokens,
    totalTokens: pi.totalTokens + usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
  };
}

const onHarness = () => harnessRuntimes.getEngine() === "harness";

const packageSearchCache = new Map<string, PackageCatalogPage>();
const packageDetailCache = new Map<string, PackageCatalogDetail>();

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

// With the harness engine (settings.engine), task runtimes are the Harness
// Host's sessions behind `harnessRuntimes`, whose ids start with `harness:`
// (docs/adr/0014-frontend-harness-adapter.md). An isolated runtime (a side
// chat) runs where its parent session lives.
export const pi = {
  // A Host session reopens on the Host whichever engine new tasks use.
  start: (cwd: string, sessionFile?: string, isolated = false) => ((harnessRuntimes.getEngine() === "harness" && !isolated) || isHarnessSessionFile(sessionFile)
    ? harnessRuntimes.start(cwd, sessionFile, isolated)
    : invoke<PiStartResult>("pi_start", { cwd, sessionFile, isolated })),
  stop: (runtimeId: string) => (isHarnessRuntime(runtimeId) ? harnessRuntimes.stop(runtimeId) : invoke<void>("pi_stop", { runtimeId })),
  sendRaw: (runtimeId: string, line: string) => invoke<void>("pi_send", { runtimeId, line }),
  isRunning: (runtimeId: string) => (isHarnessRuntime(runtimeId) ? Promise.resolve(harnessRuntimes.isRunning(runtimeId)) : invoke<boolean>("pi_is_running", { runtimeId })),
  bindSession: (runtimeId: string, sessionFile: string) => (isHarnessRuntime(runtimeId) ? Promise.resolve() : invoke<void>("pi_bind_session", { runtimeId, sessionFile })),
  listRuntimes: () => invoke<PiRuntimeInfo[]>("list_pi_runtimes"),
  quickChatDir: () => invoke<string>("quick_chat_dir"),
  listProjects: () => invoke<ProjectConfig[]>("list_projects_cmd"),
  registerProject: (path: string) => invoke<ProjectConfig>("register_project_cmd", { path }),
  saveProject: (project: ProjectConfig) => invoke<ProjectConfig>("save_project_cmd", { project }),
  removeLocalProject: (path: string) => invoke<void>("remove_local_project_cmd", { path }),
  listScheduledTasks: scheduleClient.list,
  listScheduledRuns: scheduleClient.listRuns,
  saveScheduledTask: scheduleClient.save,
  deleteScheduledTask: scheduleClient.delete,
  runScheduledTask: scheduleClient.run,
  cancelScheduledTask: scheduleClient.cancel,
  listSessions: sessionClient.list,
  sessionHistory: sessionClient.history,
  exportSessionMarkdown: sessionClient.exportMarkdown,
  sessionMessageTimings: sessionClient.messageTimings,
  sessionMessages: sessionClient.messages,
  listArchivedSessions: sessionClient.listArchived,
  archiveSession: sessionClient.archive,
  restoreSession: sessionClient.restore,
  deleteSession: sessionClient.delete,
  getSettings: () => invoke<AppSettings>("get_settings"),
  setSettings: (settings: AppSettings) => invoke<void>("set_settings", { settings }),
  getLocalMemory: () => invoke<string>("get_local_memory"),
  setLocalMemory: (contents: string) => invoke<void>("set_local_memory", { contents }),
  exportLocalMemory: (destination: string) => invoke<string>("export_local_memory", { destination }),
  deleteLocalMemory: () => invoke<void>("delete_local_memory"),
  // On the harness engine providers live in the Host's providers.json (src/lib/harnessProviders.ts).
  listModelProviders: () => (onHarness() ? harnessProviders.configs() : invoke<ModelProviderConfig[]>("list_model_providers")),
  discoverModelProviderModels: (provider: ModelProviderInput) => (onHarness() ? harnessProviders.discover(provider) : invoke<ModelProviderModel[]>("discover_model_provider_models", { provider })),
  saveModelProvider: (provider: ModelProviderInput) => (onHarness() ? harnessProviders.save(provider) : invoke<void>("save_model_provider", { provider })),
  deleteModelProvider: (id: string) => (onHarness() ? harnessProviders.delete(id) : invoke<void>("delete_model_provider", { id })),
  checkModelProvider: (id: string) => (onHarness() ? harnessProviders.check(id) : invoke<ModelProviderCheckResult>("check_model_provider", { id })),
  readAttachment: (file: string) => invoke<AttachmentPayload>("read_attachment", { file }),
  gitSnapshot: gitClient.snapshot,
  gitRepositoryRoot: gitClient.repositoryRoot,
  gitRestoreFiles: gitClient.restoreFiles,
  gitStageFiles: gitClient.stageFiles,
  gitUnstageFiles: gitClient.unstageFiles,
  gitListBranches: gitClient.listBranches,
  gitCheckoutBranch: gitClient.checkoutBranch,
  gitCompare: gitClient.compare,
  gitReviewSnapshot: gitClient.reviewSnapshot,
  gitListCommits: gitClient.listCommits,
  gitCommitSnapshot: gitClient.commitSnapshot,
  gitDefaultBranch: gitClient.defaultBranch,
  gitCommit: gitClient.commit,
  gitPush: gitClient.push,
  gitGenerateCommitMessage: gitClient.generateCommitMessage,
  gitApplyPatch: gitClient.applyPatch,
  gitLastTurnSnapshot: gitClient.lastTurnSnapshot,
  listPullRequests: (cwd: string) => invoke<PullRequestCollection>("list_pull_requests", { cwd }),
  checkoutPullRequest: (cwd: string, number: number) => invoke<void>("checkout_pull_request", { cwd, number }),
  listResources: (cwd: string) => invoke<ResourceItem[]>("list_resources", { cwd }),
  openAppearanceDirectory: (cwd: string, kind: "theme" | "pet", scope: "user" | "project") =>
    invoke<string>("open_appearance_directory", { cwd, kind, scope }),
  installAppearanceExtension: (source: string, cwd: string, kind: "theme" | "pet", scope: "user" | "project") =>
    invoke<string>("install_appearance_extension", { source, cwd, kind, scope }),
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
  openFileInEditor: (path: string, editorId: WorkspaceEditorInfo["id"], options: { line?: number; column?: number; workspace?: string } = {}) =>
    invoke<void>("open_file_in_editor", { path, editorId, line: options.line ?? null, column: options.column ?? null, workspace: options.workspace ?? null }),
  revealPathInFileManager: (path: string) => invoke<void>("reveal_path_in_file_manager", { path }),
  listTerminalApps: () => invoke<TerminalAppInfo[]>("list_terminal_apps"),
  openWorkspaceInTerminalApp: (path: string, appId: string) =>
    invoke<void>("open_workspace_in_terminal_app", { path, appId }),
  terminalShells: () => invoke<string[]>("terminal_shells"),
  listWorktrees: (cwd: string) => invoke<WorktreeInfo[]>("list_worktrees", { cwd }),
  createWorktree: (cwd: string, base?: string) => invoke<WorktreeInfo>("create_worktree", { cwd, base }),
  packageAction: (action: "install" | "remove" | "update", source?: string, cwd?: string, scope: "user" | "project" = "user") => invoke<string>("pi_package_action", { action, source, cwd, scope }),
  usageSummary,
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
    harnessRuntimes.subscribe(listeners.onEvent),
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
  if (isHarnessRuntime(runtimeId)) {
    // Failures reject, as Pi's response router does.
    return harnessRuntimes.command(runtimeId, command, payload).then((response) => {
      if (!response.success) throw new Error(response.error || `Pi command '${command}' failed`);
      return response;
    });
  }
  return sendPiCommand(pi.sendRaw, runtimeId, command, payload, timeoutMs);
}

export function respondToExtension(
  runtimeId: string,
  request: ExtensionUIRequest,
  response: { value?: string; confirmed?: boolean; cancelled?: true },
): Promise<void> {
  if (isHarnessRuntime(runtimeId)) return harnessRuntimes.respond(request, response);
  return pi.sendRaw(
    runtimeId,
    JSON.stringify({
      type: "extension_ui_response",
      id: request.id,
      ...response,
    }),
  );
}
