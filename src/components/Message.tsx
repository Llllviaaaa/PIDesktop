import { memo, useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, ChevronUp, CircleAlert, Copy, Info, Link2, LoaderCircle, Pencil, RotateCcw, Share2, Terminal } from "lucide-react";
import type { UiMessage, UiToolCall } from "../types";
import { usePiStore } from "../store";
import { isGoalToolCall } from "../lib/activeGoal";
import { Markdown } from "./Markdown";
import { ToolCall } from "./ToolCall";

export const USER_MESSAGE_COLLAPSED_LINES = 6;

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

export const Message = memo(function Message({
  message,
  showThinking = true,
  expectVisibleThinking = false,
  isLastAssistant = false,
  globalStreaming = false,
  workingLabel,
  allowRichContent = false,
  summaryMode = false,
  editing = false,
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
  editing?: boolean;
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
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const userMessageTextRef = useRef<HTMLDivElement>(null);
  const assistantWorking = message.role === "assistant"
    && (message.isStreaming || (isLastAssistant && globalStreaming));
  const liveThinking = assistantWorking && showThinking && Boolean(message.thinking);

  useEffect(() => {
    if (!liveThinking) return;
    const frame = window.requestAnimationFrame(() => {
      const node = thinkingRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [liveThinking, message.thinking]);

  useEffect(() => {
    if (liveThinking) {
      setThinkingExpanded(true);
    } else if (message.content) {
      setThinkingExpanded(false);
    }
  }, [liveThinking, message.content, message.id]);

  useEffect(() => {
    if (!editing) {
      setSubmittingEdit(false);
      return;
    }
    setEditDraft(message.content);
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

  useEffect(() => setUserMessageExpanded(false), [message.id]);

  useEffect(() => {
    if (message.role !== "user" || editing || !message.content) {
      setUserMessageCollapsible(false);
      return;
    }
    const node = userMessageTextRef.current;
    if (!node || node.closest(".side-chat-messages")) {
      setUserMessageCollapsible(false);
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
        <div className="user-content">
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
        </div>
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
    return (
      <article className="message-row notice-message" id={`message-${message.id}`}>
        <Info size={14} strokeWidth={1.75} aria-hidden="true" />
        <div className="notice-content"><Markdown content={message.content} /></div>
      </article>
    );
  }

  const toolCalls = (message.toolCalls ?? []).filter((call) => !isGoalToolCall(call));
  const hasTools = toolCalls.length > 0;
  const thinkingText = showThinking ? (message.thinking || "").trim() : "";
  const hasThinking = Boolean(thinkingText);
  // B1: during reasoning/tool phases message.isStreaming is false while the agent is still working,
  // so the newest assistant reply also honors the app-level streaming flag.
  const working = assistantWorking;
  const reasoningUnavailable = showThinking
    && expectVisibleThinking
    && isLastAssistant
    && !working
    && !hasThinking
    && Boolean(message.content)
    && !message.isError;
  const duration = formatDuration(message.durationMs ?? 0) ?? formatWorkDuration(toolCalls);
  const thinkingLabel = reasoningUnavailable
    ? "模型未返回可见推理"
    : working
    ? workingLabel || "Pi 正在工作…"
    : duration
      ? `思考了 ${duration}`
      : "思考过程";
  const thinkingDetailsVisible = hasThinking && !summaryMode && (working || thinkingExpanded);
  const thinkingToggleLabel = thinkingDetailsVisible ? "收起思考过程" : "展开思考过程";

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
      {(working || hasThinking || reasoningUnavailable) && (
        <div className="thinking-block">
          {hasThinking && !summaryMode ? (
            <button
              type="button"
              className="thinking-caption thinking-toggle"
              title={thinkingToggleLabel}
              aria-label={thinkingToggleLabel}
              aria-expanded={thinkingDetailsVisible}
              disabled={working}
              onClick={() => setThinkingExpanded((value) => !value)}
            >
              <span>{thinkingLabel}</span>
              {thinkingDetailsVisible
                ? <ChevronUp size={13} strokeWidth={1.8} />
                : <ChevronDown size={13} strokeWidth={1.8} />}
            </button>
          ) : (
            <div className="thinking-caption">{thinkingLabel}</div>
          )}
          {thinkingDetailsVisible && (
            <div
              ref={thinkingRef}
              className={`thinking-prose ${working ? "streaming" : ""}`}
              role="log"
              aria-label="思考过程"
            >
              {message.thinking}
            </div>
          )}
        </div>
      )}
      {hasTools && (
        <div className="tool-list">
          {toolCalls.map((call) => <ToolCall call={call} key={call.id} />)}
        </div>
      )}
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
        <span className="response-waiting" role="status" aria-label="等待回复">
          <i />
          <i />
          <i />
        </span>
      )}
    </article>
  );
});
