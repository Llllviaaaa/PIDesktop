import { memo, useState, type ReactNode } from "react";
import { isGoalToolCall } from "../lib/activeGoal";
import type { TaskPlanSummary } from "../lib/envSources";
import type { IntelligentUiVersionGroup, TurnWidgetRef } from "../lib/intelligentUi";
import { extractInlineThinking, foldThinking } from "../lib/thinkingDisplay";
import { normalizeTranscriptDensity, type TranscriptDensity } from "../lib/transcriptDensity";
import { useAppStore } from "../store";
import type { UiMessage, WorkStep } from "../types";
import { ConversationPlan } from "./ConversationPlan";
import { IconChevronDown } from "./DshIcons";
import { IntelligentUiCard } from "./IntelligentUiCard";
import { Markdown } from "./Markdown";
import {
  AssistantExtraActions,
  MessageIconActions,
  TerminalOrNoticeMessageRow,
} from "./message/MessageActionToolbar";
import {
  buildProcessSummary,
  computeMergedFileTools,
  foldWorkingLabel,
  formatMessageClock,
  formatRunDuration,
  isLiveAssistantWork,
  isUserMessageOverLineLimit,
  liveActivityLabel,
  processSegments,
  summarizeProcessGroup,
  TRANSCRIPT_POLICIES,
  USER_MESSAGE_COLLAPSED_LINES,
  workDurationMs,
  type DurationPart,
  type ProcessSegment,
} from "./message/messageHelpers";
import { ProcessGroup, ReasoningRow, RunningRow } from "./message/MessageProcessBlocks";
import { UserMessageRow } from "./message/UserMessageRow";
import { ToolCall } from "./ToolCall";

export {
  buildProcessSummary,
  foldWorkingLabel,
  formatMessageClock,
  formatRunDuration,
  isLiveAssistantWork,
  isUserMessageOverLineLimit,
  processSegments,
  summarizeProcessGroup,
  USER_MESSAGE_COLLAPSED_LINES,
  type DurationPart,
  type ProcessSegment,
};

export const Message = memo(function Message({
  message,
  showThinking = true,
  expectVisibleThinking = false,
  isLastAssistant = false,
  globalStreaming = false,
  workingLabel,
  turnStartedAt,
  allowRichContent = false,
  summaryMode = false,
  density = "normal",
  editing = false,
  requireCtrlEnter = false,
  plan,
  uiWidgets,
  uiGroups,
  footer,
  onOpenPlan,
  onEdit,
  onRewind,
  onCancelEdit,
  onSubmitEdit,
}: {
  message: UiMessage;
  showThinking?: boolean;
  expectVisibleThinking?: boolean;
  isLastAssistant?: boolean;
  globalStreaming?: boolean;
  workingLabel?: string;
  turnStartedAt?: number;
  allowRichContent?: boolean;
  summaryMode?: boolean;
  density?: TranscriptDensity;
  editing?: boolean;
  requireCtrlEnter?: boolean;
  plan?: TaskPlanSummary;
  uiWidgets?: readonly TurnWidgetRef[];
  uiGroups?: ReadonlyMap<string, IntelligentUiVersionGroup>;
  footer?: ReactNode;
  onOpenPlan?: () => void;
  onEdit?: (message: UiMessage) => void;
  onRewind?: (message: UiMessage) => Promise<boolean>;
  onCancelEdit?: () => void;
  onSubmitEdit?: (message: UiMessage, text: string) => Promise<boolean>;
}) {
  const [processOpen, setProcessOpen] = useState(false);
  const slotCwd = useAppStore((store) => store.cwd);
  const slotSessionFile = useAppStore((store) => store.sessionFile);
  const transcriptDensity = summaryMode ? "summary" : normalizeTranscriptDensity(density);
  const policy = TRANSCRIPT_POLICIES[transcriptDensity];

  if (message.role === "user") {
    return (
      <UserMessageRow
        message={message}
        editing={editing}
        requireCtrlEnter={requireCtrlEnter}
        slotCwd={slotCwd}
        slotSessionFile={slotSessionFile}
        onEdit={onEdit}
        onRewind={onRewind}
        onCancelEdit={onCancelEdit}
        onSubmitEdit={onSubmitEdit}
      />
    );
  }

  if (message.role === "terminal" || message.role === "notice") {
    return <TerminalOrNoticeMessageRow message={message} transcriptDensity={transcriptDensity} />;
  }

  const working = message.role === "assistant" && (message.isStreaming || (isLastAssistant && globalStreaming));
  const normalizedAssistant = extractInlineThinking(message.content, message.thinking);
  const assistantContent = normalizedAssistant.content;
  const toolCalls = (message.toolCalls ?? []).filter((call) => !isGoalToolCall(call));
  const thinkingText = showThinking ? foldThinking(normalizedAssistant.thinking, assistantContent) : "";
  const steps: WorkStep[] = message.workSteps
    ? message.workSteps.filter((step) => (step.kind === "tool" ? !isGoalToolCall(step.call) : step.kind !== "thinking" || showThinking))
    : [
      ...(thinkingText ? [{ kind: "thinking" as const, text: thinkingText }] : []),
      ...toolCalls.map((call) => ({ kind: "tool" as const, call })),
    ];
  const hasProcess = steps.length > 0;
  const hasContent = Boolean(assistantContent.trim());
  const hasRunningTool = toolCalls.some((call) => call.running);
  const lastStep = steps[steps.length - 1];
  const reasoningLive = showThinking && working && !hasContent && lastStep?.kind === "thinking";
  const thinkingCount = steps.filter((step) => step.kind === "thinking").length;
  const segments = processSegments(steps);
  const mergedFileTools = computeMergedFileTools(steps.flatMap((step) => (step.kind === "tool" ? [step.call] : [])));
  const reasoningUnavailable = showThinking
    && expectVisibleThinking
    && isLastAssistant
    && !working
    && thinkingCount === 0
    && hasContent
    && !message.isError
    && !message.isAborted;
  const durationMs = message.durationMs !== undefined && message.durationMs > 0 ? message.durationMs : workDurationMs(toolCalls);

  if (!hasContent && !working && !hasProcess && !reasoningUnavailable) return null;

  const usage = message.usage;
  const copyTitle = usage
    ? `复制回复${message.model ? ` · ${message.model}` : ""} · ${(usage.totalTokens ?? usage.input + usage.output).toLocaleString()} 个 token`
    : "复制回复";

  const renderStep = (step: WorkStep, index: number) => {
    if (step.kind === "thinking") {
      return (
        <ReasoningRow
          key={`thinking-${index}`}
          text={step.text}
          running={reasoningLive && index === steps.length - 1}
          settledPreview={policy.settledReasoningPreview}
        />
      );
    }
    if (step.kind === "note") return null;
    const mergeMeta = mergedFileTools.get(step.call.id);
    const head = mergeMeta?.headId === step.call.id;
    return (
      <ToolCall
        call={step.call}
        key={step.call.id}
        mergedCount={head ? mergeMeta.count : undefined}
        mergedAdded={head ? mergeMeta.added : undefined}
        mergedRemoved={head ? mergeMeta.removed : undefined}
        mergedDiff={head ? mergeMeta.diff : undefined}
        mergedHidden={mergeMeta !== undefined && !head}
      />
    );
  };

  const renderProcess = (grouped: boolean) => segments.map((segment, position) => {
    if (segment.kind === "text") {
      return (
        <div key={segment.key} className="dshc-process-text dshc-md dshc-md-prose" data-chat-group-part="response">
          <Markdown content={segment.text} />
        </div>
      );
    }
    const active = working && position === segments.length - 1 && (!hasContent || hasRunningTool);
    return (
      <ProcessGroup
        key={segment.key}
        grouped={grouped}
        live={active}
        autoOpen={active}
        summary={summarizeProcessGroup(
          segment.thinking,
          segment.members.flatMap(({ step }) => (step.kind === "tool" ? [step.call] : [])),
        )}
        activity={segment.activity}
      >
        {segment.members.map(({ step, index }) => renderStep(step, index))}
      </ProcessGroup>
    );
  });

  const canCollapse = hasProcess;
  const settledProcessVisible = hasProcess && processOpen;
  const showTurnProcess = !working && (
    hasProcess
    || (showThinking && durationMs !== null)
    || reasoningUnavailable
    || message.isAborted === true
    || message.isError === true
  );
  const turnProcessLabel = message.isError
    ? "处理失败"
    : message.isAborted
      ? (durationMs !== null ? "已停止，用时 " : "已停止")
      : (durationMs !== null ? "已完成，用时 " : "已完成");
  const durationParts = !message.isError && durationMs !== null ? formatRunDuration(Math.max(1000, durationMs)) : [];
  const liveProcessVisible = working && hasProcess;
  const liveLabel = liveActivityLabel(workingLabel, hasRunningTool, reasoningLive, working && hasContent);
  const toolActivity = toolCalls.map((call) => `${call.id}:${call.running ? 1 : 0}:${Object.keys(call.args).length}`).join(",");
  const activityKey = `${workingLabel ?? ""}:${assistantContent.length}:${(normalizedAssistant.thinking ?? "").length}:${toolActivity}`;

  return (
    <article
      className={`dshc-flow dshc-turn${message.isError ? " is-error" : ""}`}
      data-chat-flow-kind="assistant"
      data-turn-open={working || undefined}
      data-actions-reveal={isLastAssistant ? "always" : "hover"}
      id={`message-${message.id}`}
    >
      {showTurnProcess && (
        <button
          type="button"
          className="dshc-turn-process"
          data-open={(canCollapse && processOpen) || undefined}
          disabled={!canCollapse}
          aria-expanded={canCollapse ? processOpen : undefined}
          aria-label={canCollapse ? (processOpen ? "收起工作过程" : "展开工作过程") : undefined}
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            setProcessOpen((value) => !value);
          }}
        >
          <span className="dshc-turn-process-label">
            {turnProcessLabel}
            {durationParts.map((part, index) => (
              <span key={index} className={part.numeric ? "dshc-duration-number" : undefined}>{part.text}</span>
            ))}
          </span>
          {canCollapse && <IconChevronDown className="dshc-turn-process-chevron" />}
        </button>
      )}
      {reasoningUnavailable && !hasProcess && <div className="dshc-hint">模型未返回可见推理</div>}
      {settledProcessVisible && !working && renderProcess(true)}
      {liveProcessVisible && renderProcess(policy.liveGrouping)}
      {plan && !working && <ConversationPlan plan={plan} onOpenPlan={onOpenPlan} />}
      {!message.isError && uiWidgets && uiWidgets.length > 0 && uiGroups && (
        <div className="dshc-turn-widgets">
          {uiWidgets.map((ref) => {
            const group = uiGroups.get(ref.id);
            if (!group) return null;
            return <IntelligentUiCard key={ref.id} group={group} defaultVersion={ref.version} mode="inline" />;
          })}
        </div>
      )}
      {hasContent && (message.isError ? (
        <div className="dshc-turn-error" role="status">
          <span className="dshc-state-dot" data-state="error" aria-hidden="true" />
          <div className="dshc-turn-error-copy">
            <span className="dshc-turn-error-title">本轮出错</span>
            <span className="dshc-turn-error-message">{assistantContent}</span>
          </div>
        </div>
      ) : (
        <div className="dshc-answer" data-streaming={working || undefined}>
          <div className="dshc-md dshc-md-prose">
            <Markdown content={assistantContent} allowRichContent={allowRichContent && !working} />
          </div>
        </div>
      ))}
      {working && (
        <RunningRow
          label={liveLabel}
          startTime={turnStartedAt ?? message.timestamp}
          activityKey={activityKey}
          divider={hasProcess || hasContent}
          overtimeAllowed={!hasRunningTool}
        />
      )}
      {footer && !working && <div className="dshc-turn-footer">{footer}</div>}
      {hasContent && !working && (
        <MessageIconActions
          text={assistantContent}
          time={message.timestamp}
          clock="end"
          copyTitle={copyTitle}
          className="dshc-turn-actions"
          extraActions={(
            <AssistantExtraActions
              message={message}
              assistantContent={assistantContent}
              slotCwd={slotCwd}
              slotSessionFile={slotSessionFile}
            />
          )}
        />
      )}
    </article>
  );
});
