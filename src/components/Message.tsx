import { memo, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowUp, BrainCircuit, Check, ChevronDown, ChevronRight, ChevronUp, CircleAlert, Copy, Info, Link2, LoaderCircle, Pencil, RotateCcw, Share2, Sparkles, Terminal } from "lucide-react";
import { useSyncOnChange } from "../hooks/useSyncOnChange";
import type { UiMessage, UiToolCall } from "../types";
import type { TaskPlanSummary } from "../lib/envSources";
import { foldThinking } from "../lib/thinkingDisplay";
import { normalizeTranscriptDensity, type TranscriptDensity } from "../lib/transcriptDensity";
import { presentToolCall, type ToolDiffLine } from "../lib/toolPresentation";
import { usePiStore } from "../store";
import { isGoalToolCall } from "../lib/activeGoal";
import { ConversationPlan } from "./ConversationPlan";
import { Markdown } from "./Markdown";
import { ToolCall } from "./ToolCall";

export const USER_MESSAGE_COLLAPSED_LINES = 6;

/** A user message younger than this at mount was just sent, so its bubble animates in. */
const USER_MESSAGE_ENTRY_WINDOW_MS = 1_500;
const USER_BUBBLE_HIDDEN = { opacity: 0, scale: 0.82, x: 14, y: 12 };
const USER_BUBBLE_VISIBLE = { opacity: 1, scale: 1, x: 0, y: 0 };
const USER_BUBBLE_SPRING = { type: "spring", stiffness: 520, damping: 24, mass: 0.8 } as const;

export function isUserMessageOverLineLimit(contentHeight: number, lineHeight: number): boolean {
  if (!Number.isFinite(contentHeight) || !Number.isFinite(lineHeight) || contentHeight <= 0 || lineHeight <= 0) {
    return false;
  }
  return contentHeight > lineHeight * USER_MESSAGE_COLLAPSED_LINES + 2;
}

function formatDuration(durationMs: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}分钟 ${remainingSeconds}秒` : `${minutes}分钟`;
}

function formatWorkDuration(toolCalls: UiToolCall[]): string | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const call of toolCalls) {
    if (typeof call.startedAt === "number") start = start === null ? call.startedAt : Math.min(start, call.startedAt);
    if (typeof call.finishedAt === "number") end = end === null ? call.finishedAt : Math.max(end, call.finishedAt);
  }
  if (start === null || end === null || end <= start) return null;
  return formatDuration(end - start);
}

/** True while the agent is still thinking or running tools, before the answer (or after a new tool starts). */
export function isLiveAssistantWork(
  working: boolean,
  content: string | undefined,
  toolCalls: Array<{ running?: boolean }> | undefined,
): boolean {
  if (!working) return false;
  if (toolCalls?.some((call) => call.running)) return true;
  return !(content ?? "").trim();
}

/** Codex/Claude fold rows stay short; drop the app-level "Pi 正在工作…" status prefix. */
export function foldWorkingLabel(workingLabel: string | undefined): string {
  const label = workingLabel?.trim();
  if (!label || /正在工作/.test(label)) return "正在工作…";
  return label;
}

/** Extract single-line preview for collapsed/streaming reasoning row, matching dsh-claude-style ReasoningRow. */
function reasoningPreviewLine(text: string, streaming: boolean): string {
  const cleaned = text.replace(/\*\*/g, "").trim();
  if (!cleaned) return "";
  const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "";
  return streaming ? lines[lines.length - 1] : lines[0];
}

/** Build dsh-claude-style process summary ("执行 N 次思考，调用 M 次工具"). */
function buildClaudeProcessSummary(thinkingCount: number, toolCount: number): string | null {
  const parts: string[] = [];
  if (thinkingCount > 0) parts.push(`执行 ${thinkingCount} 次思考`);
  if (toolCount > 0) parts.push(`调用 ${toolCount} 次工具`);
  return parts.length > 0 ? parts.join("，") : null;
}

/** Resolve live turn activity label for dsh-claude-style waiting row. */
function resolveLiveActivityLabel(
  workingLabel: string | undefined,
  hasRunningTool: boolean,
  hasThinking: boolean,
  hasContent: boolean,
): string {
  const explicit = workingLabel?.trim();
  if (explicit && !/正在工作/.test(explicit)) return explicit;
  if (hasRunningTool) return "正在调用工具";
  if (hasContent) return "正在写回答";
  if (hasThinking) return "正在思考";
  return "正在工作…";
}

interface MergedFileToolMeta {
  headId: string;
  count: number;
  added: number;
  removed: number;
  diff: ToolDiffLine[];
}

/** Merge multiple edit/write tool calls targeting the same file within a single turn (dsh-claude-style D62). */
function computeMergedFileTools(calls: UiToolCall[]): Map<string, MergedFileToolMeta> {
  const byPath = new Map<string, Array<{ call: UiToolCall; presented: ReturnType<typeof presentToolCall> }>>();
  for (const call of calls) {
    if (call.isError) continue;
    const presented = presentToolCall(call);
    if ((presented.kind !== "edit" && presented.kind !== "write") || !presented.path || !presented.diff?.length) {
      continue;
    }
    const key = presented.path.replace(/\\/g, "/").toLowerCase();
    const list = byPath.get(key) ?? [];
    list.push({ call, presented });
    byPath.set(key, list);
  }
  const result = new Map<string, MergedFileToolMeta>();
  for (const group of byPath.values()) {
    if (group.length <= 1) continue;
    const headId = group[0].call.id;
    let added = 0;
    let removed = 0;
    const diff: ToolDiffLine[] = [];
    for (const item of group) {
      added += item.presented.added ?? 0;
      removed += item.presented.removed ?? 0;
      if (item.presented.diff) diff.push(...item.presented.diff);
    }
    for (const item of group) {
      result.set(item.call.id, {
        headId,
        count: group.length,
        added,
        removed,
        diff,
      });
    }
  }
  return result;
}

function ReasoningBlock({
  text,
  streaming,
  innerRef,
}: {
  text: string;
  streaming: boolean;
  innerRef?: React.Ref<HTMLDivElement>;
}) {
  const [userToggled, setUserToggled] = useState<{ streaming: boolean; expanded: boolean } | null>(null);
  const expanded = userToggled && userToggled.streaming === streaming ? userToggled.expanded : true;
  const preview = reasoningPreviewLine(text, streaming);

  return (
    <div
      className={`claude-reasoning-row${expanded ? " is-expanded" : " is-collapsed"}${streaming ? " is-streaming" : ""}`}
      data-variant="think"
      data-state={streaming ? "running" : "ok"}
      data-expanded={expanded || undefined}
    >
      <button
        type="button"
        className="claude-reasoning-header"
        aria-expanded={expanded}
        onClick={() => setUserToggled({ streaming, expanded: !expanded })}
      >
        <span className="claude-reasoning-leading" aria-hidden="true">
          <BrainCircuit size={13} className="claude-reasoning-icon" />
          {expanded ? (
            <ChevronDown size={13} className="claude-reasoning-chevron" />
          ) : (
            <ChevronRight size={13} className="claude-reasoning-chevron" />
          )}
        </span>
        <span className={`claude-reasoning-title${streaming ? " shimmer-text" : ""}`}>
          {streaming ? "正在思考" : "思考过程"}
        </span>
        {!expanded && preview && (
          <>
            <span className="claude-reasoning-sep" aria-hidden="true" />
            <span className="claude-reasoning-preview">{preview}</span>
          </>
        )}
      </button>
      <div
        ref={innerRef}
        className={`work-log-thinking${streaming ? " streaming" : ""}`}
        data-dsh-claude-reason-window={streaming ? "" : undefined}
        hidden={!expanded}
        role="log"
        aria-label="思考过程"
      >
        {text}
      </div>
    </div>
  );
}

function WaitingStatusRow({
  label,
  timestamp,
  showOvertimeCandidate,
}: {
  label: string;
  timestamp: number;
  showOvertimeCandidate: boolean;
}) {
  const [liveElapsedSec, setLiveElapsedSec] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const baseTime = timestamp > 0 ? timestamp : Date.now();
    const timer = window.setInterval(() => {
      setLiveElapsedSec(Math.max(1, Math.floor((Date.now() - baseTime) / 1000)));
    }, 500);
    return () => window.clearInterval(timer);
  }, [timestamp]);

  return (
    <div className="response-waiting dsh-claude-chat-wait" role="status" aria-label="等待回复">
      <Sparkles size={13} className="dsh-claude-wait-spark" aria-hidden="true" />
      <span className="dsh-claude-chat-wait-label shimmer-text" data-text={label}>
        {label}
      </span>
      {liveElapsedSec > 0 && (
        <span className="dsh-claude-chat-wait-clock">{liveElapsedSec}秒</span>
      )}
      {liveElapsedSec >= 10 && showOvertimeCandidate && (
        <span className="dsh-claude-chat-wait-badge">暂未响应</span>
      )}
      <span className="response-waiting-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

export const Message = memo(function Message({
  message,
  showThinking = true,
  expectVisibleThinking = false,
  isLastAssistant = false,
  globalStreaming = false,
  workingLabel,
  allowRichContent = false,
  summaryMode = false,
  density = "normal",
  editing = false,
  plan,
  onOpenPlan,
  onEdit,
  onRewind,
  onCancelEdit,
  onSubmitEdit,
}: {
  message: UiMessage;
  showThinking?: boolean;
  /** The selected runtime requested reasoning, so an empty stream should be explained. */
  expectVisibleThinking?: boolean;
  /** True when this is the newest assistant reply of the current turn. */
  isLastAssistant?: boolean;
  /** App-level streaming flag; message.isStreaming is false during reasoning/tool phases. */
  globalStreaming?: boolean;
  /** Current runtime status, rendered with the active assistant reply instead of above the thread. */
  workingLabel?: string;
  /** Enable the controlled rich-content protocol for completed assistant replies. */
  allowRichContent?: boolean;
  /** Codex 摘要：收起工具轨迹，不展开工作日志。 */
  summaryMode?: boolean;
  /** Conversation density; summaryMode still wins when both are set. */
  density?: TranscriptDensity;
  editing?: boolean;
  /** The plan this turn finished with; hidden while the turn works, when the composer shows it. */
  plan?: TaskPlanSummary;
  onOpenPlan?: () => void;
  onEdit?: (message: UiMessage) => void;
  onRewind?: (message: UiMessage) => Promise<boolean>;
  onCancelEdit?: () => void;
  onSubmitEdit?: (message: UiMessage, text: string) => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  const [editDraft, setEditDraft] = useState(message.content);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const [userMessageCollapsible, setUserMessageCollapsible] = useState(false);
  const [userMessageExpanded, setUserMessageExpanded] = useState(false);
  const reduceMotion = useReducedMotion();
  const [userBubbleEntering] = useState(
    () => message.role === "user" && Date.now() - message.timestamp < USER_MESSAGE_ENTRY_WINDOW_MS,
  );
  const assistantWorking = message.role === "assistant"
    && (message.isStreaming || (isLastAssistant && globalStreaming));
  const transcriptDensity = summaryMode ? "summary" : normalizeTranscriptDensity(density);
  const visibleToolCalls = (message.toolCalls ?? []).filter((call) => !isGoalToolCall(call));
  const liveWork = isLiveAssistantWork(assistantWorking, message.content, visibleToolCalls);
  const [workExpanded, setWorkExpanded] = useState(transcriptDensity === "verbose");
  const thinkingRef = useRef<HTMLDivElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const userMessageTextRef = useRef<HTMLDivElement>(null);
  const liveThinking = liveWork && showThinking && Boolean(message.thinking);

  useEffect(() => {
    if (!liveThinking) return;
    const frame = window.requestAnimationFrame(() => {
      const node = thinkingRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [liveThinking, message.thinking]);

  useSyncOnChange([liveWork, transcriptDensity], () => {
    setWorkExpanded(transcriptDensity === "verbose");
  });

  useSyncOnChange([editing, message.content], () => {
    if (!editing) {
      setSubmittingEdit(false);
      return;
    }
    setEditDraft(message.content);
  });

  useEffect(() => {
    if (!editing) return;
    const frame = window.requestAnimationFrame(() => {
      const textarea = editTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(220, Math.max(44, textarea.scrollHeight))}px`;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing, message.content]);

  useSyncOnChange([message.id], () => {
    setUserMessageExpanded(false);
  });

  useSyncOnChange([editing, message.content, message.role], () => {
    if (message.role !== "user" || editing || !message.content) {
      setUserMessageCollapsible(false);
    }
  });

  useEffect(() => {
    if (message.role !== "user" || editing || !message.content) {
      return;
    }
    const node = userMessageTextRef.current;
    if (!node || node.closest(".side-chat-messages")) {
      return;
    }

    const measure = () => {
      const styles = window.getComputedStyle(node);
      const measuredLineHeight = Number.parseFloat(styles.lineHeight);
      const fontSize = Number.parseFloat(styles.fontSize);
      const lineHeight = Number.isFinite(measuredLineHeight)
        ? measuredLineHeight
        : (Number.isFinite(fontSize) ? fontSize * 1.5 : 21);
      node.style.setProperty("--user-message-collapsed-height", `${lineHeight * USER_MESSAGE_COLLAPSED_LINES}px`);
      node.style.setProperty("--user-message-full-height", `${node.scrollHeight}px`);
      const next = isUserMessageOverLineLimit(node.scrollHeight, lineHeight);
      setUserMessageCollapsible((current) => current === next ? current : next);
    };

    const frame = window.requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    if (node.firstElementChild) observer?.observe(node.firstElementChild);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [editing, message.content, message.role]);

  const resizeEditTextarea = () => {
    const textarea = editTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(220, Math.max(44, textarea.scrollHeight))}px`;
  };

  const submitEdit = async () => {
    if (submittingEdit || !editDraft.trim() || !onSubmitEdit) return;
    setSubmittingEdit(true);
    const sent = await onSubmitEdit(message, editDraft);
    if (!sent) setSubmittingEdit(false);
  };

  const rewindMessage = async () => {
    if (rewinding || !onRewind) return;
    setRewinding(true);
    try {
      await onRewind(message);
    } finally {
      setRewinding(false);
    }
  };

  if (message.role === "user") {
    if (editing) {
      return (
        <article className="message-row user-message is-editing" id={`message-${message.id}`}>
          <div className="message-edit-card">
            {message.images && message.images.length > 0 && (
              <div className="message-images">
                {message.images.map((image, index) => (
                  <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`附件 ${index + 1}`} />
                ))}
              </div>
            )}
            <textarea
              ref={editTextareaRef}
              className="message-edit-input"
              aria-label="编辑消息"
              rows={1}
              value={editDraft}
              disabled={submittingEdit}
              onChange={(event) => {
                setEditDraft(event.target.value);
                window.requestAnimationFrame(resizeEditTextarea);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onCancelEdit?.();
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submitEdit();
                }
              }}
            />
            <div className="message-edit-actions">
              <button type="button" className="message-edit-cancel" disabled={submittingEdit} onClick={onCancelEdit}>
                取消
              </button>
              <button
                type="button"
                className="message-edit-submit"
                disabled={submittingEdit || !editDraft.trim()}
                onClick={() => void submitEdit()}
                title="从此消息重新发送"
              >
                <ArrowUp size={14} strokeWidth={2} />
                <span>{submittingEdit ? "发送中" : "发送"}</span>
              </button>
            </div>
          </div>
        </article>
      );
    }
    const userMessageState = userMessageCollapsible
      ? userMessageExpanded ? " is-collapsible is-expanded" : " is-collapsible is-collapsed"
      : "";
    const userMessageCollapsed = userMessageCollapsible && !userMessageExpanded;
    const expandLabel = userMessageExpanded ? "收起消息" : "展开完整消息";
    const contentId = `message-${message.id}-content`;
    const summaryId = `message-${message.id}-collapsed-summary`;
    const accessibleSummary = message.content.length > 240
      ? `${message.content.slice(0, 240)}…`
      : message.content;
    return (
      <article className={`message-row user-message${userMessageState}`} id={`message-${message.id}`}>
        <motion.div
          className="user-content"
          initial={userBubbleEntering && !reduceMotion ? USER_BUBBLE_HIDDEN : false}
          animate={USER_BUBBLE_VISIBLE}
          transition={USER_BUBBLE_SPRING}
          style={{ originX: 1, originY: 1 }}
        >
          {message.images && message.images.length > 0 && (
            <div className="message-images">
              {message.images.map((image, index) => (
                <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`附件 ${index + 1}`} />
              ))}
            </div>
          )}
          {message.content && (
            <div
              ref={userMessageTextRef}
              id={contentId}
              className={`user-message-text${userMessageCollapsible ? userMessageExpanded ? " is-expanded" : " is-collapsed" : ""}`}
              aria-hidden={userMessageCollapsed || undefined}
              inert={userMessageCollapsed || undefined}
            >
              <Markdown content={message.content} />
            </div>
          )}
          {userMessageCollapsed && (
            <span id={summaryId} className="user-message-accessible-summary">
              消息预览：{accessibleSummary}，其余内容已折叠。
            </span>
          )}
          {userMessageCollapsible && (
            <button
              type="button"
              className="user-message-expand"
              title={expandLabel}
              aria-label={expandLabel}
              aria-controls={contentId}
              aria-describedby={userMessageCollapsed ? summaryId : undefined}
              aria-expanded={userMessageExpanded}
              onClick={() => setUserMessageExpanded((value) => !value)}
            >
              {userMessageExpanded
                ? <ChevronUp size={14} strokeWidth={1.8} />
                : <ChevronDown size={14} strokeWidth={1.8} />}
            </button>
          )}
        </motion.div>
        {message.content && (onEdit || onRewind) && (
          <div className="user-message-actions">
            {onEdit && (
              <button type="button" className="message-copy" title="编辑消息" aria-label="编辑消息" disabled={rewinding} onClick={() => onEdit(message)}>
                <Pencil size={13} strokeWidth={1.75} />
              </button>
            )}
            {onRewind && (
              <button
                type="button"
                className="message-copy"
                title="回退消息和改动"
                aria-label="回退消息和改动"
                disabled={rewinding}
                onClick={() => void rewindMessage()}
              >
                {rewinding ? <LoaderCircle className="spin" size={13} strokeWidth={1.75} /> : <RotateCcw size={13} strokeWidth={1.75} />}
              </button>
            )}
          </div>
        )}
      </article>
    );
  }

  if (message.role === "terminal") {
    return (
      <article className={`message-row terminal-message ${message.isError ? "error" : ""}`} id={`message-${message.id}`}>
        <div className="notice-heading"><Terminal size={14} /> 终端</div>
        <pre>{message.content}</pre>
      </article>
    );
  }

  if (message.role === "notice") {
    if (message.noticeKind === "compaction" || message.noticeKind === "branch") {
      const label = message.noticeKind === "compaction" ? "上下文已压缩" : "会话已分叉";
      const detail = message.content.replace(/^(Context compacted|Branch summary)\s*/i, "").trim();
      return (
        <div className={`compaction-divider is-${message.noticeKind}`} role="separator" id={`message-${message.id}`}>
          <span>{label}</span>
          {detail && transcriptDensity === "verbose" && <small>{detail}</small>}
        </div>
      );
    }
    return (
      <article className="message-row notice-message" id={`message-${message.id}`}>
        <Info size={14} strokeWidth={1.75} aria-hidden="true" />
        <div className="notice-content"><Markdown content={message.content} /></div>
      </article>
    );
  }

  const toolCalls = visibleToolCalls;
  const hasTools = toolCalls.length > 0;
  const thinkingText = showThinking ? foldThinking(message.thinking, message.content) : "";
  const hasThinking = Boolean(thinkingText);
  const workSteps = (message.workSteps ?? []).filter((step) => showThinking || step.kind !== "thinking");
  const lastThinkingIndex = workSteps.reduce((last, step, index) => step.kind === "thinking" ? index : last, -1);
  const hasSteps = workSteps.length > 0;
  const thinkingStepCount = hasSteps
    ? workSteps.filter((step) => step.kind === "thinking").length
    : (hasThinking ? 1 : 0);
  const toolStepCount = hasSteps
    ? workSteps.filter((step) => step.kind === "tool").length
    : toolCalls.length;
  const mergedFileTools = computeMergedFileTools(
    hasSteps
      ? workSteps.flatMap((step) => step.kind === "tool" ? [step.call] : [])
      : toolCalls,
  );
  // B1: during reasoning/tool phases message.isStreaming is false while the agent is still working,
  // so the newest assistant reply also honors the app-level streaming flag.
  const working = assistantWorking;
  const hasRunningTool = toolCalls.some((call) => call.running);
  const reasoningUnavailable = showThinking
    && expectVisibleThinking
    && isLastAssistant
    && !working
    && !hasThinking
    && Boolean(message.content)
    && !message.isError;
  const duration = formatDuration(message.durationMs ?? 0) ?? formatWorkDuration(toolCalls);
  const autoExpanded = transcriptDensity === "verbose" || liveWork;
  const hasWork = working || hasThinking || hasTools || hasSteps || reasoningUnavailable;
  const workDetailsVisible = transcriptDensity !== "summary" && (autoExpanded || workExpanded) && (hasThinking || hasTools || hasSteps);
  const canToggleWork = !autoExpanded && transcriptDensity !== "summary" && (hasThinking || hasTools);
  const claudeProcessSummary = buildClaudeProcessSummary(thinkingStepCount, toolStepCount);
  const workLabel = reasoningUnavailable && !hasTools && !hasThinking
    ? "模型未返回可见推理"
    : working
      ? foldWorkingLabel(workingLabel)
      : duration
        ? `耗时 ${duration}`
        : "工作过程";
  const liveActivityLabel = resolveLiveActivityLabel(workingLabel, hasRunningTool, hasThinking, Boolean(message.content));
  const workToggleLabel = workDetailsVisible ? "收起工作过程" : "展开工作过程";

  const timeLabel = typeof message.timestamp === "number" && message.timestamp > 0
    ? new Date(message.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : null;

  const usage = message.usage;
  const copyTitle = usage
    ? `复制回复${message.model ? ` · ${message.model}` : ""} · ${(usage.totalTokens ?? usage.input + usage.output).toLocaleString()} 个 token`
    : "复制回复";

  const copyContent = () => {
    void navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => undefined);
  };

  const shareContent = () => {
    const text = message.content;
    const share = (navigator as Navigator & { share?: (data: ShareData) => Promise<void> }).share;
    if (typeof share === "function") {
      void share({ text }).catch(() => {
        void navigator.clipboard.writeText(text).then(() => usePiStore.getState().showToast("已复制回复，可粘贴分享", "info"));
      });
      return;
    }
    void navigator.clipboard.writeText(text).then(() => {
      usePiStore.getState().showToast("已复制回复，可粘贴分享", "info");
    }).catch(() => undefined);
  };

  const anchorMessage = () => {
    const node = document.getElementById(`message-${message.id}`);
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
    const url = `${window.location.href.split("#")[0]}#message-${message.id}`;
    void navigator.clipboard.writeText(url).then(() => {
      usePiStore.getState().showToast("已复制消息定位", "info");
    }).catch(() => undefined);
  };

  if (!message.content && !working && !hasThinking && !hasTools && !reasoningUnavailable) return null;

  return (
    <article
      className={`message-row assistant-message ${message.isError ? "error" : ""} ${!message.content && (working || hasThinking || hasTools) ? "work-only" : ""}`}
      id={`message-${message.id}`}
    >
      {hasWork && (
        <details
          className={`work-log${liveWork ? " is-live" : ""}`}
          open={workDetailsVisible}
          onToggle={(event) => {
            if (!canToggleWork) return;
            setWorkExpanded(event.currentTarget.open);
          }}
        >
          <summary
            className={`work-log-toggle${canToggleWork ? "" : " is-static"}`}
            title={canToggleWork ? workToggleLabel : undefined}
            aria-label={canToggleWork ? workToggleLabel : undefined}
            aria-expanded={workDetailsVisible}
            onClick={(event) => {
              if (!canToggleWork) event.preventDefault();
            }}
          >
            <span className="work-log-label">{workLabel}</span>
            {claudeProcessSummary && (
              <span className="dsh-claude-process-summary" aria-hidden="true">
                <span className="work-log-summary-dot">·</span>
                <span>{claudeProcessSummary}</span>
              </span>
            )}
            {(hasThinking || hasTools) && transcriptDensity !== "summary" && (
              <ChevronRight size={13} strokeWidth={1.8} className={workDetailsVisible ? "open" : undefined} />
            )}
          </summary>
          {workDetailsVisible && (hasThinking || hasTools || hasSteps) && (
            <div className="work-log-body">
              {hasSteps ? (
                workSteps.map((step, index) => {
                  if (step.kind === "thinking") {
                    return (
                      <ReasoningBlock
                        key={`thinking-${index}`}
                        innerRef={index === lastThinkingIndex ? thinkingRef : undefined}
                        text={step.text}
                        streaming={liveWork && index === lastThinkingIndex}
                      />
                    );
                  }
                  if (step.kind === "note") {
                    return <div key={`note-${index}`} className="work-log-note">{step.text}</div>;
                  }
                  const mergeMeta = mergedFileTools.get(step.call.id);
                  return (
                    <ToolCall
                      call={step.call}
                      key={step.call.id}
                      mergedCount={mergeMeta?.headId === step.call.id ? mergeMeta.count : undefined}
                      mergedAdded={mergeMeta?.headId === step.call.id ? mergeMeta.added : undefined}
                      mergedRemoved={mergeMeta?.headId === step.call.id ? mergeMeta.removed : undefined}
                      mergedDiff={mergeMeta?.headId === step.call.id ? mergeMeta.diff : undefined}
                      mergedHidden={mergeMeta !== undefined && mergeMeta.headId !== step.call.id}
                    />
                  );
                })
              ) : (
                <>
                  {hasThinking && (
                    <ReasoningBlock
                      innerRef={thinkingRef}
                      text={thinkingText}
                      streaming={liveWork}
                    />
                  )}
                  {hasTools && (
                    <div className="tool-list">
                      {toolCalls.map((call) => {
                        const mergeMeta = mergedFileTools.get(call.id);
                        return (
                          <ToolCall
                            call={call}
                            key={call.id}
                            mergedCount={mergeMeta?.headId === call.id ? mergeMeta.count : undefined}
                            mergedAdded={mergeMeta?.headId === call.id ? mergeMeta.added : undefined}
                            mergedRemoved={mergeMeta?.headId === call.id ? mergeMeta.removed : undefined}
                            mergedDiff={mergeMeta?.headId === call.id ? mergeMeta.diff : undefined}
                            mergedHidden={mergeMeta !== undefined && mergeMeta.headId !== call.id}
                          />
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </details>
      )}
      {plan && !working && <ConversationPlan plan={plan} onOpenPlan={onOpenPlan} />}
      {message.content && (
        <div className="assistant-content">
          {message.isError && <CircleAlert size={15} className="message-error-icon" />}
          <Markdown content={message.content} allowRichContent={allowRichContent && !working && !message.isError} />
        </div>
      )}
      {message.content && !working && (
        <div className={`message-actions ${isLastAssistant ? "persistent" : ""}`}>
          <button type="button" className="message-copy" title={copyTitle} onClick={copyContent}>
            {copied ? <Check size={13} strokeWidth={1.75} /> : <Copy size={13} strokeWidth={1.75} />}
          </button>
          <button type="button" className="message-copy" title="分享" onClick={shareContent}>
            <Share2 size={13} strokeWidth={1.75} />
          </button>
          <button type="button" className="message-copy" title="定位此消息" onClick={anchorMessage}>
            <Link2 size={13} strokeWidth={1.75} />
          </button>
          {isLastAssistant && timeLabel && <span className="message-time">{timeLabel}</span>}
        </div>
      )}
      {working && !message.content && (
        <WaitingStatusRow
          label={liveActivityLabel}
          timestamp={message.timestamp}
          showOvertimeCandidate={!hasThinking && !hasTools}
        />
      )}
    </article>
  );
});
