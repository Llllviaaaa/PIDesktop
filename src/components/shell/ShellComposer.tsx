import type { ComponentProps } from "react";
import { findMentionCandidates } from "../../lib/workspaceSearch";
import type { AppSettings, GitSnapshot, SessionStats } from "../../types";
import { RegionErrorBoundary } from "../common/ErrorBoundary";
import { Composer } from "../Composer";

type BaseComposerProps = ComponentProps<typeof Composer>;

export interface ShellComposerProps {
  variant: "task-start" | "follow-up";
  sessionFile: string | null;
  isStreaming: boolean;
  isSwitchingModel: boolean;
  attachments: BaseComposerProps["attachments"];
  commands: BaseComposerProps["commands"];
  models: BaseComposerProps["models"];
  model: BaseComposerProps["model"];
  thinkingLevel: string;
  thinkingLevels: BaseComposerProps["thinkingLevels"];
  prefill: string | null;
  pendingCount: number;
  queuedMessages: BaseComposerProps["queuedMessages"];
  settings: AppSettings | null;
  quickChat: boolean;
  draftWorkspace: string;
  workspaceCwd: string;
  workspaceOptions: string[];
  environment: "local" | "worktree";
  draftBranch: string;
  git: GitSnapshot | null;
  permissionLabel: string;
  stats: SessionStats | null;
  transcriptDensity: NonNullable<BaseComposerProps["transcriptDensity"]>;
  setTranscriptDensity: NonNullable<BaseComposerProps["onTranscriptDensityChange"]>;
  onSend: BaseComposerProps["onSend"];
  onStop: BaseComposerProps["onStop"];
  onPickAttachments: BaseComposerProps["onPickAttachments"];
  onAttachFiles: (files: string[]) => Promise<void>;
  onAttachPayloads: BaseComposerProps["onAttachPayloads"];
  onRemoveAttachment: BaseComposerProps["onRemoveAttachment"];
  onModelChange: BaseComposerProps["onModelChange"];
  onThinkingChange: BaseComposerProps["onThinkingChange"];
  onWorkspaceSelect: BaseComposerProps["onWorkspaceSelect"];
  onPickWorkspace: BaseComposerProps["onPickWorkspace"];
  onQuickChat: BaseComposerProps["onQuickChat"];
  onEnvironmentChange: BaseComposerProps["onEnvironmentChange"];
  onPermissionChange: BaseComposerProps["onPermissionChange"];
  onAgentModeChange: BaseComposerProps["onAgentModeChange"];
  onPrefillConsumed: BaseComposerProps["onPrefillConsumed"];
  onRemoveQueuedMessage: BaseComposerProps["onRemoveQueuedMessage"];
  onMoveQueuedMessage: BaseComposerProps["onMoveQueuedMessage"];
  onSteerQueuedMessage: BaseComposerProps["onSteerQueuedMessage"];
}

export function ShellComposer({
  variant,
  sessionFile,
  isStreaming,
  isSwitchingModel,
  attachments,
  commands,
  models,
  model,
  thinkingLevel,
  thinkingLevels,
  prefill,
  pendingCount,
  queuedMessages,
  settings,
  quickChat,
  draftWorkspace,
  workspaceCwd,
  workspaceOptions,
  environment,
  draftBranch,
  git,
  permissionLabel,
  stats,
  transcriptDensity,
  setTranscriptDensity,
  onSend,
  onStop,
  onPickAttachments,
  onAttachFiles,
  onAttachPayloads,
  onRemoveAttachment,
  onModelChange,
  onThinkingChange,
  onWorkspaceSelect,
  onPickWorkspace,
  onQuickChat,
  onEnvironmentChange,
  onPermissionChange,
  onAgentModeChange,
  onPrefillConsumed,
  onRemoveQueuedMessage,
  onMoveQueuedMessage,
  onSteerQueuedMessage,
}: ShellComposerProps) {
  return (
    <RegionErrorBoundary region="输入栏" resetKey={`${variant}:${sessionFile ?? "draft"}`}>
      <Composer
        variant={variant}
        sessionFile={variant === "follow-up" ? sessionFile : null}
        isStreaming={isStreaming}
        isSwitchingModel={isSwitchingModel}
        disabled={false}
        attachments={attachments}
        commands={commands}
        models={models}
        model={model}
        thinkingLevel={thinkingLevel}
        thinkingLevels={thinkingLevels}
        prefill={prefill}
        pendingCount={pendingCount}
        queuedMessages={queuedMessages}
        requireCtrlEnter={settings?.requireCtrlEnter}
        defaultFollowUpBehavior={settings?.followUpBehavior}
        workspace={quickChat ? "" : draftWorkspace}
        workspaceOptions={workspaceOptions}
        environment={environment}
        branchLabel={!quickChat ? (variant === "task-start" ? draftBranch : (git?.isRepository ? (git.branch || "") : "")) : ""}
        quickChat={quickChat}
        permissionMode={settings?.permissionMode ?? "ask"}
        permissionLabel={permissionLabel}
        agentMode={settings?.agentMode ?? "agent"}
        contextUsage={variant === "follow-up" ? stats?.contextUsage : undefined}
        sessionCost={variant === "follow-up" ? stats?.cost : undefined}
        sessionTokens={variant === "follow-up" ? stats?.tokens : undefined}
        transcriptDensity={transcriptDensity}
        onTranscriptDensityChange={variant === "follow-up" ? setTranscriptDensity : undefined}
        onSend={onSend}
        onStop={onStop}
        onPickAttachments={onPickAttachments}
        onAttachFiles={(files) => void onAttachFiles(files)}
        onAttachPayloads={onAttachPayloads}
        onSearchFiles={workspaceCwd && !quickChat ? (q, sig) => findMentionCandidates(workspaceCwd, q, sig) : undefined}
        onRemoveAttachment={onRemoveAttachment}
        onModelChange={onModelChange}
        onThinkingChange={onThinkingChange}
        onWorkspaceSelect={onWorkspaceSelect}
        onPickWorkspace={onPickWorkspace}
        onQuickChat={onQuickChat}
        onEnvironmentChange={onEnvironmentChange}
        onPermissionChange={onPermissionChange}
        onAgentModeChange={onAgentModeChange}
        onPrefillConsumed={onPrefillConsumed}
        onRemoveQueuedMessage={onRemoveQueuedMessage}
        onMoveQueuedMessage={onMoveQueuedMessage}
        onSteerQueuedMessage={onSteerQueuedMessage}
      />
    </RegionErrorBoundary>
  );
}
