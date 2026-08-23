import { memo, useEffect, useRef, useState } from "react";
import { ArrowUp, Check, CircleAlert, Copy, Info, Link2, Pencil, Share2, Terminal } from "lucide-react";
import type { UiMessage, UiToolCall } from "../types";
import { usePiStore } from "../store";
import { Markdown } from "./Markdown";
import { ToolCall } from "./ToolCall";

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
  isLastAssistant = false,
  globalStreaming = false,
  workingLabel,
  summaryMode = false,
  editing = false,
  onEdit,
  onCancelEdit,
  onSubmitEdit,
}: {
  message: UiMessage;
  showThinking?: boolean;
  /** True when this is the newest assistant reply of the current turn. */
  isLastAssistant?: boolean;
  /** App-level streaming flag; message.isStreaming is false during reasoning/tool phases. */
  globalStreaming?: boolean;
  /** Current runtime status, rendered with the active assistant reply instead of above the thread. */
  workingLabel?: string;
  /** Codex 摘要：收起工具轨迹，不展开工作日志。 */
  summaryMode?: boolean;
  editing?: boolean;
  onEdit?: (message: UiMessage) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: (message: UiMessage, text: string) => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  const [editDraft, setEditDraft] = useState(message.content);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
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
      textarea.style.height = `${Math.min(280, Math.max(96, textarea.scrollHeight))}px`;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing, message.content]);

  const resizeEditTextarea = () => {
    const textarea = editTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(280, Math.max(96, textarea.scrollHeight))}px`;
  };

  const submitEdit = async () => {
    if (submittingEdit || !editDraft.trim() || !onSubmitEdit) return;
    setSubmittingEdit(true);
    const sent = await onSubmitEdit(message, editDraft);
    if (!sent) setSubmittingEdit(false);
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
    return (
      <article className="message-row user-message" id={`message-${message.id}`}>
        <div className="user-content">
          {message.images && message.images.length > 0 && (
            <div className="message-images">
              {message.images.map((image, index) => (
                <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`附件 ${index + 1}`} />
              ))}
            </div>
          )}
          {message.content && <Markdown content={message.content} />}
        </div>
        {message.content && onEdit && (
          <div className="user-message-actions">
            <button type="button" className="message-copy" title="编辑消息" aria-label="编辑消息" onClick={() => onEdit(message)}>
              <Pencil size={13} strokeWidth={1.75} />
            </button>
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

  const toolCalls = message.toolCalls ?? [];
  const hasTools = toolCalls.length > 0;
  const thinkingText = showThinking ? (message.thinking || "").trim() : "";
  const hasThinking = Boolean(thinkingText);
  // B1: during reasoning/tool phases message.isStreaming is false while the agent is still working,
  // so the newest assistant reply also honors the app-level streaming flag.
  const working = assistantWorking;
  const duration = formatDuration(message.durationMs ?? 0) ?? formatWorkDuration(toolCalls);
  const thinkingLabel = working
    ? workingLabel || "Pi 正在工作…"
    : duration
      ? `思考了 ${duration}`
      : "思考过程";

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

  return (
    <article
      className={`message-row assistant-message ${message.isError ? "error" : ""} ${!message.content && (working || hasThinking || hasTools) ? "work-only" : ""}`}
      id={`message-${message.id}`}
    >
      {(working || hasThinking) && (
        <div className="thinking-block">
          <div className="thinking-caption">{thinkingLabel}</div>
          {!summaryMode && hasThinking && (
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
          <Markdown content={message.content} />
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
