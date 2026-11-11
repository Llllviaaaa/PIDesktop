import type {
  AppSettings,
  AttachmentPayload,
  ManagedQueuedMessage,
  ModelInfo,
  SessionStats,
  SlashCommand,
  WorkspaceDirEntry,
} from "../../types";
import type { TranscriptDensity } from "../../lib/transcriptDensity";

export const PERMISSION_OPTIONS: Array<{
  value: AppSettings["permissionMode"];
  label: string;
  description: string;
}> = [
  { value: "read-only", label: "只读", description: "可检查文件，不能修改或执行交互操作" },
  { value: "ask", label: "先询问", description: "写入文件和执行命令前请求确认" },
  { value: "workspace-write", label: "工作区写入", description: "可修改当前工作区，命令仍按规则确认" },
  { value: "full-access", label: "完全访问", description: "允许修改文件并执行命令，不再逐项确认" },
];

export const STREAMING_BEHAVIOR_OPTIONS: Array<{
  value: "steer" | "followUp";
  chip: string;
  label: string;
  description: string;
}> = [
  { value: "steer", chip: "调整", label: "调整当前任务", description: "插进正在进行的任务" },
  { value: "followUp", chip: "排队", label: "排队到下一轮", description: "等这一轮做完再发送" },
];

export const MAX_COMMAND_MATCHES = 50;
export const MAX_MENTION_RESULTS = 50;

export interface ComposerProps {
  isStreaming: boolean;
  isSwitchingModel?: boolean;
  disabled?: boolean;
  attachments: AttachmentPayload[];
  commands: SlashCommand[];
  models: ModelInfo[];
  model: ModelInfo | null;
  thinkingLevel: string;
  thinkingLevels: string[];
  prefill?: string | null;
  insertRequest?: { text: string; nonce: number } | null;
  pendingCount: number;
  queuedMessages?: ManagedQueuedMessage[];
  requireCtrlEnter?: boolean;
  defaultFollowUpBehavior?: "steer" | "followUp";
  workspace?: string;
  sessionFile?: string | null;
  workspaceOptions?: string[];
  environment?: "local" | "worktree";
  branchLabel?: string;
  quickChat?: boolean;
  permissionMode?: AppSettings["permissionMode"];
  permissionLabel?: string;
  agentMode?: AppSettings["agentMode"];
  contextUsage?: SessionStats["contextUsage"];
  sessionCost?: number;
  sessionTokens?: SessionStats["tokens"];
  variant?: "task-start" | "follow-up";
  scope?: "main" | "side";
  transcriptDensity?: TranscriptDensity;
  onTranscriptDensityChange?: (density: TranscriptDensity) => void;
  onSend: (text: string, behavior?: "steer" | "followUp") => Promise<boolean | void> | boolean | void;
  onStop: () => void;
  onPickAttachments: () => void;
  onAttachFiles?: (paths: string[]) => void;
  onAttachPayloads?: (attachments: AttachmentPayload[]) => void;
  onSearchFiles?: (query: string, signal: AbortSignal) => Promise<WorkspaceDirEntry[]>;
  onRemoveAttachment: (path: string) => void;
  onModelChange: (model: ModelInfo) => void;
  onThinkingChange: (level: string) => void;
  onWorkspaceSelect?: (workspace: string) => void;
  onPickWorkspace?: () => void;
  onQuickChat?: () => void;
  onEnvironmentChange?: (environment: "local" | "worktree") => void;
  onPermissionChange?: (mode: AppSettings["permissionMode"]) => void | Promise<void>;
  onAgentModeChange?: (mode: AppSettings["agentMode"]) => void | Promise<void>;
  onPrefillConsumed?: () => void;
  onRemoveQueuedMessage?: (id: string) => void;
  onMoveQueuedMessage?: (id: string, direction: -1 | 1) => void;
  onSteerQueuedMessage?: (id: string) => void | Promise<void>;
}

export interface ContextUsageMetrics {
  normalizedContextPercent: number | null;
  contextUsedThousands: number | null;
  contextWindowThousands: number | null;
  remainingContextPercent: number | null;
}

export function computeContextUsageMetrics(
  contextUsage: SessionStats["contextUsage"] | undefined,
): ContextUsageMetrics {
  const normalizedContextPercent = typeof contextUsage?.percent === "number" && Number.isFinite(contextUsage.percent)
    ? Math.min(100, Math.max(0, Math.round(contextUsage.percent)))
    : null;
  const contextUsedTokens = typeof contextUsage?.tokens === "number" && Number.isFinite(contextUsage.tokens)
    ? Math.max(0, contextUsage.tokens)
    : null;
  const contextWindow = typeof contextUsage?.contextWindow === "number"
    && Number.isFinite(contextUsage.contextWindow)
    && contextUsage.contextWindow > 0
    ? contextUsage.contextWindow
    : null;
  return {
    normalizedContextPercent,
    contextUsedThousands: contextUsedTokens === null ? null : Math.round(contextUsedTokens / 1_000),
    contextWindowThousands: contextWindow === null ? null : Math.round(contextWindow / 1_000),
    remainingContextPercent: normalizedContextPercent === null ? null : Math.max(0, 100 - normalizedContextPercent),
  };
}

export function buildComposerPlaceholder(options: {
  disabled?: boolean;
  isStreaming: boolean;
  streamingBehavior: "steer" | "followUp";
  variant: "task-start" | "follow-up";
  hasSearchFiles: boolean;
  requireCtrlEnter: boolean;
}): string {
  const { disabled, isStreaming, streamingBehavior, variant, hasSearchFiles, requireCtrlEnter } = options;
  const commandHint = hasSearchFiles ? "用 / 调用命令，@ 引用文件" : "用 / 调用命令";
  const idleTail = requireCtrlEnter ? "，Ctrl+Enter 发送…" : "…";
  const streamingTail = requireCtrlEnter ? "（Ctrl+Enter 发送）…" : "…";
  if (disabled) return "正在准备…";
  if (isStreaming) {
    return streamingBehavior === "steer"
      ? `补充指示，会插入正在进行的任务${streamingTail}`
      : `写下一条消息，这一轮结束后发送${streamingTail}`;
  }
  return variant === "task-start"
    ? `描述要做的事，${commandHint}${idleTail}`
    : `继续对话，${commandHint}${idleTail}`;
}
