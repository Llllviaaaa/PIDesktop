import { invoke } from "@tauri-apps/api/core";
import type { UsageSummaryResult } from "@pid/protocol";
import type {
  AppSettings,
  AttachmentPayload,
  ExtensionUIRequest,
  ModelProviderInput,
  ProjectConfig,
  PullRequestCollection,
  ResourceItem,
  UsageSummary,
  WorkspaceDirEntry,
  TerminalAppInfo,
  WorkspaceEditorInfo,
  WorkspaceFileContent,
  WorktreeInfo,
} from "../types";
import { gitClient } from "./gitClient";
import { harnessProviders } from "./harnessProviders";
import { harnessRuntimes } from "./harnessRuntime";
import type { TranscriptEvent } from "./transcript";
import { scheduleClient } from "./scheduleClient";
import { sessionClient } from "./sessionClient";

/** Token totals over the Host's sessions, imported Pi tasks included; the Host does not compute costs. */
async function usageSummary(): Promise<UsageSummary> {
  const { sessions, messages, usage } = await harnessRuntimes.call<UsageSummaryResult>("usage.summary");
  return {
    sessions,
    messages,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: 0,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    totalCost: 0,
  };
}

// Task runtimes are the Harness Host's sessions behind `harnessRuntimes`
// (docs/adr/0014-frontend-harness-adapter.md); the store calls its typed
// methods. Its events still arrive in Pi's shapes until P6d-2.
// An isolated runtime (a side chat) runs on a hidden fork of its parent.
export const pi = {
  start: (cwd: string, sessionFile?: string, isolated = false) => harnessRuntimes.start(cwd, sessionFile, isolated),
  stop: (runtimeId: string) => harnessRuntimes.stop(runtimeId),
  isRunning: (runtimeId: string) => Promise.resolve(harnessRuntimes.isRunning(runtimeId)),
  /** A Host runtime follows its session itself. */
  bindSession: (_runtimeId: string, _sessionFile: string) => Promise.resolve(),
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
  // Providers live in the Host's providers.json (src/lib/harnessProviders.ts).
  listModelProviders: () => harnessProviders.configs(),
  discoverModelProviderModels: (provider: ModelProviderInput) => harnessProviders.discover(provider),
  saveModelProvider: (provider: ModelProviderInput) => harnessProviders.save(provider),
  deleteModelProvider: (id: string) => harnessProviders.delete(id),
  checkModelProvider: (id: string) => harnessProviders.check(id),
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
  /** Skills, themes and pets in the workspace's `.pi/` that its `.pid/` lacks (P6a). */
  legacyProjectResources: (cwd: string) => invoke<number>("legacy_project_resources", { cwd }),
  migrateProjectResources: (cwd: string) => invoke<number>("migrate_project_resources", { cwd }),
  openAppearanceDirectory: (cwd: string, kind: "theme" | "pet", scope: "user" | "project") =>
    invoke<string>("open_appearance_directory", { cwd, kind, scope }),
  installAppearanceExtension: (source: string, cwd: string, kind: "theme" | "pet", scope: "user" | "project") =>
    invoke<string>("install_appearance_extension", { source, cwd, kind, scope }),
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
  usageSummary,
};

export interface PiStartResult {
  runtimeId: string;
  sessionLoaded: boolean;
  sessionForked: boolean;
}

export interface PiRuntimeStatus {
  runtimeId: string;
  status: string;
  code?: number | null;
  cwd?: string;
}

export interface PiListeners {
  onEvent: (runtimeId: string, event: TranscriptEvent) => void;
  onStatus?: (status: PiRuntimeStatus) => void;
  onLog?: (runtimeId: string, line: string) => void;
  onProtocolError?: (message: string) => void;
}

/** Hear the runtimes' events. Host runtimes have no process to exit or log of their own. */
export async function subscribeToPi(listeners: PiListeners): Promise<() => void> {
  return harnessRuntimes.subscribe(listeners.onEvent);
}

export function respondToExtension(
  runtimeId: string,
  request: ExtensionUIRequest,
  response: { value?: string; confirmed?: boolean; cancelled?: true },
): Promise<void> {
  void runtimeId;
  return harnessRuntimes.respond(request, response);
}
