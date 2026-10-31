/**
 * The desktop's state (P6e): four slices, each with the actions that change
 * it. src/store/index.ts composes them into one store; components read the
 * fields they need with the slice hooks in src/store/selectors.ts.
 */
import type { TranscriptEvent } from "../lib/transcript";
import type { RuntimeStatus } from "../lib/agent";
import type { HostStatus } from "../lib/harnessRuntime";
import type {
  AgentBrowserState,
  AppNotification,
  AppSettings,
  AttachmentPayload,
  ComputerState,
  ConnectionState,
  ExtensionUIRequest,
  ForkPoint,
  GitSnapshot,
  ManagedQueuedMessage,
  ModelInfo,
  SessionInfo,
  SessionStats,
  SessionTreeNodeView,
  SlashCommand,
  Toast,
  UiMessage,
} from "../types";

export interface TerminalState {
  running: boolean;
  command: string;
  output: string;
  exitCode?: number;
  history: Array<{ command: string; output: string; exitCode?: number }>;
}

export interface RuntimeState {
  runtimeId: string;
  cwd: string;
  sessionFile: string | null;
  isStreaming: boolean;
  status: ConnectionState;
  extensionRequest: ExtensionUIRequest | null;
  updatedAt: number;
}

/** The task on screen and its runtimes: connection, model and effort, settings, Git. */
export interface RuntimeSlice {
  runtimeId: string | null;
  runtimes: Record<string, RuntimeState>;
  connection: ConnectionState;
  /** Whether the Harness Host can be reached (src/lib/harnessRuntime.ts). */
  hostStatus: HostStatus;
  cwd: string;
  hostLog: string[];
  lastError: string | null;
  sessionFile: string | null;
  sessionId: string | null;
  sessionName: string | null;
  isSwitchingModel: boolean;
  thinkingLevel: string;
  model: ModelInfo | null;
  availableModels: ModelInfo[];
  availableThinkingLevels: string[];
  commands: SlashCommand[];
  stats: SessionStats | null;
  settings: AppSettings | null;
  git: GitSnapshot | null;
  connect: (cwd: string, sessionFile?: string) => Promise<void>;
  prewarmWorkspace: (cwd: string) => Promise<void>;
  restoreRuntimes: (preferredRuntimeId?: string | null) => Promise<boolean>;
  switchSession: (cwd: string, sessionFile: string) => Promise<void>;
  disconnect: () => Promise<void>;
  handleStatus: (status: RuntimeStatus) => void;
  handleLog: (runtimeId: string, line: string) => void;
  handleHostStatus: (status: HostStatus) => void;
  /** Start the Host again after it crashed too often for Rust to restart it. */
  restartHost: () => Promise<void>;
  appendLog: (line: string) => void;
  prepareNewTask: () => void;
  setModel: (model: ModelInfo) => Promise<void>;
  /** Make live chats re-read credentials and models.json, then reload the picker's models. */
  reloadProviderCatalog: () => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
  setRuntimeAgentMode: (mode: AppSettings["agentMode"]) => Promise<void>;
  setRuntimePermissionMode: (mode: AppSettings["permissionMode"]) => Promise<void>;
  refreshGit: () => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
}

/** The task list and navigating a session: archive, rewind, fork, the session tree, export. */
export interface SessionsSlice {
  sessions: SessionInfo[];
  sessionTree: SessionTreeNodeView[];
  sessionTreeLeafId: string | null;
  sessionTreeError: string | null;
  sessionTreeLoading: boolean;
  resolveMessageForkPoint: (messageId: string) => Promise<ForkPoint | null>;
  rewindMessage: (entryId: string) => Promise<boolean>;
  editAndResend: (entryId: string, text: string, attachments?: AttachmentPayload[]) => Promise<boolean>;
  newSession: () => Promise<void>;
  cloneSession: () => Promise<void>;
  forkLatest: () => Promise<void>;
  loadSessionTree: () => Promise<void>;
  continueFromTreeNode: (entryId: string) => Promise<void>;
  /** Write the task on screen as Markdown to `destination`; returns where it went. */
  exportSession: (destination: string) => Promise<string>;
  setSessionName: (name: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
}

/** The conversation: messages, streaming, queued messages, and the browser and computer panels. */
export interface TranscriptSlice {
  messages: UiMessage[];
  isStreaming: boolean;
  isCompacting: boolean;
  retryStatus: string | null;
  steeringQueue: unknown[];
  followUpQueue: unknown[];
  managedFollowUpQueue: ManagedQueuedMessage[];
  agentBrowser: AgentBrowserState | null;
  computer: ComputerState | null;
  terminal: TerminalState;
  extensionWidgets: Record<string, string[]>;
  handleEvent: (runtimeId: string, event: TranscriptEvent) => void;
  sendMessage: (text: string, attachments?: AttachmentPayload[], behavior?: "steer" | "followUp") => Promise<boolean>;
  removeManagedFollowUp: (id: string) => void;
  moveManagedFollowUp: (id: string, direction: -1 | 1) => void;
  steerManagedFollowUp: (id: string) => Promise<void>;
  abort: () => Promise<void>;
  compact: () => Promise<void>;
}

/** Dialogs the agent asks, toasts and notifications. */
export interface UiSlice {
  extensionRequest: ExtensionUIRequest | null;
  extensionStatuses: Record<string, string>;
  composerPrefill: string | null;
  toasts: Toast[];
  notifications: AppNotification[];
  answerExtension: (response: { value?: string; confirmed?: boolean; cancelled?: true }) => Promise<void>;
  showToast: (message: string, kind?: Toast["kind"]) => void;
  addNotification: (notification: Omit<AppNotification, "createdAt" | "read"> & { createdAt?: number; read?: boolean }) => void;
  setViewedSession: (sessionFile: string | null) => void;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  dismissNotification: (id: string) => void;
  clearComposerPrefill: () => void;
  dismissToast: (id: string) => void;
}

export type AppState = RuntimeSlice & SessionsSlice & TranscriptSlice & UiSlice;
