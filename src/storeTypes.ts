import type { PiRuntimeStatus } from "./lib/pi";
import type {
  AgentBrowserState,
  AppSettings,
  AttachmentPayload,
  ComputerState,
  ConnectionState,
  ExtensionUIRequest,
  ForkPoint,
  GitSnapshot,
  ManagedQueuedMessage,
  ModelInfo,
  PiEvent,
  SessionInfo,
  SessionStats,
  SessionTreeNodeView,
  SlashCommand,
  Toast,
  UiMessage,
} from "./types";

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

export interface PiState {
  runtimeId: string | null;
  runtimes: Record<string, RuntimeState>;
  connection: ConnectionState;
  cwd: string;
  piLog: string[];
  lastError: string | null;
  messages: UiMessage[];
  sessionFile: string | null;
  sessionId: string | null;
  sessionName: string | null;
  isStreaming: boolean;
  isSwitchingModel: boolean;
  isCompacting: boolean;
  retryStatus: string | null;
  thinkingLevel: string;
  model: ModelInfo | null;
  availableModels: ModelInfo[];
  availableThinkingLevels: string[];
  commands: SlashCommand[];
  stats: SessionStats | null;
  steeringQueue: unknown[];
  followUpQueue: unknown[];
  managedFollowUpQueue: ManagedQueuedMessage[];
  sessions: SessionInfo[];
  settings: AppSettings | null;
  git: GitSnapshot | null;
  agentBrowser: AgentBrowserState | null;
  computer: ComputerState | null;
  terminal: TerminalState;
  extensionRequest: ExtensionUIRequest | null;
  extensionStatuses: Record<string, string>;
  extensionWidgets: Record<string, string[]>;
  composerPrefill: string | null;
  toasts: Toast[];
  sessionTree: SessionTreeNodeView[];
  sessionTreeLeafId: string | null;
  sessionTreeError: string | null;
  sessionTreeLoading: boolean;

  connect: (cwd: string, sessionFile?: string) => Promise<void>;
  prewarmWorkspace: (cwd: string) => Promise<void>;
  restoreRuntimes: (preferredRuntimeId?: string | null) => Promise<boolean>;
  switchSession: (cwd: string, sessionFile: string) => Promise<void>;
  disconnect: () => Promise<void>;
  handleEvent: (runtimeId: string, event: PiEvent) => void;
  handleStatus: (status: PiRuntimeStatus) => void;
  handleLog: (runtimeId: string, line: string) => void;
  appendLog: (line: string) => void;
  sendMessage: (text: string, attachments?: AttachmentPayload[], behavior?: "steer" | "followUp") => Promise<boolean>;
  removeManagedFollowUp: (id: string) => void;
  moveManagedFollowUp: (id: string, direction: -1 | 1) => void;
  steerManagedFollowUp: (id: string) => Promise<void>;
  resolveMessageForkPoint: (messageId: string) => Promise<ForkPoint | null>;
  editAndResend: (entryId: string, text: string, attachments?: AttachmentPayload[]) => Promise<boolean>;
  abort: () => Promise<void>;
  prepareNewTask: () => void;
  newSession: () => Promise<void>;
  cloneSession: () => Promise<void>;
  forkLatest: () => Promise<void>;
  loadSessionTree: () => Promise<void>;
  continueFromTreeNode: (entryId: string) => Promise<void>;
  compact: () => Promise<void>;
  exportSession: () => Promise<string | null>;
  setModel: (model: ModelInfo) => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
  setRuntimeAgentMode: (mode: AppSettings["agentMode"]) => Promise<void>;
  setRuntimePermissionMode: (mode: AppSettings["permissionMode"]) => Promise<void>;
  setSessionName: (name: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshGit: () => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  runBash: (command: string, excludeFromContext?: boolean) => Promise<void>;
  abortBash: () => Promise<void>;
  resetTerminal: () => void;
  answerExtension: (response: { value?: string; confirmed?: boolean; cancelled?: true }) => Promise<void>;
  showToast: (message: string, kind?: Toast["kind"]) => void;
  clearComposerPrefill: () => void;
  dismissToast: (id: string) => void;
}
