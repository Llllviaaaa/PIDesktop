import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowUp, ChevronDown, ChevronUp, LoaderCircle, Pencil, RotateCcw } from "lucide-react";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import {
  formatSendShortcutHint,
  insertNewlineAtSelection,
  resolveChatEnterAction,
} from "../../lib/composerKeys";
import type { UiMessage } from "../../types";
import { PluginSlot } from "../common/PluginSlot";
import { MessageIconActions } from "./MessageActionToolbar";
import {
  isUserMessageOverLineLimit,
  USER_BUBBLE_HIDDEN,
  USER_BUBBLE_SPRING,
  USER_BUBBLE_VISIBLE,
  USER_MESSAGE_COLLAPSED_LINES,
  USER_MESSAGE_ENTRY_WINDOW_MS,
} from "./messageHelpers";

export interface UserMessageRowProps {
  message: UiMessage;
  editing: boolean;
  requireCtrlEnter: boolean;
  slotCwd: string;
  slotSessionFile: string | null;
  onEdit?: (message: UiMessage) => void;
  onRewind?: (message: UiMessage) => Promise<boolean>;
  onCancelEdit?: () => void;
  onSubmitEdit?: (message: UiMessage, text: string) => Promise<boolean>;
}

export function UserMessageRow({
  message,
  editing,
  requireCtrlEnter,
  slotCwd,
  slotSessionFile,
  onEdit,
  onRewind,
  onCancelEdit,
  onSubmitEdit,
}: UserMessageRowProps) {
  const [editDraft, setEditDraft] = useState(message.content);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const [userMessageCollapsible, setUserMessageCollapsible] = useState(false);
  const [userMessageExpanded, setUserMessageExpanded] = useState(false);
  const reduceMotion = useReducedMotion();
  const [userBubbleEntering] = useState(
    () => Date.now() - message.timestamp < USER_MESSAGE_ENTRY_WINDOW_MS,
  );
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const userMessageTextRef = useRef<HTMLDivElement>(null);

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

  useSyncOnChange([editing, message.content], () => {
    if (editing || !message.content) {
      setUserMessageCollapsible(false);
    }
  });

  useEffect(() => {
    if (editing || !message.content) return;
    const node = userMessageTextRef.current;
    if (!node || node.closest(".side-chat-messages")) return;

    const measure = () => {
      const styles = window.getComputedStyle(node);
      const measuredLineHeight = Number.parseFloat(styles.lineHeight);
      const fontSize = Number.parseFloat(styles.fontSize);
      const lineHeight = Number.isFinite(measuredLineHeight)
        ? measuredLineHeight
        : (Number.isFinite(fontSize) ? fontSize * 1.5 : 22);
      node.style.setProperty("--user-message-collapsed-height", `${lineHeight * USER_MESSAGE_COLLAPSED_LINES}px`);
      node.style.setProperty("--user-message-full-height", `${node.scrollHeight}px`);
      const next = isUserMessageOverLineLimit(node.scrollHeight, lineHeight);
      setUserMessageCollapsible((current) => (current === next ? current : next));
    };

    const frame = window.requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [editing, message.content]);

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

  if (editing) {
    return (
      <article className="dshc-flow dshc-user-row is-editing" data-chat-flow-kind="user" id={`message-${message.id}`}>
        <div className="message-edit-card">
          {message.images && message.images.length > 0 && (
            <div className="dshc-attachment-row">
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
              if (event.key === "Escape" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                event.preventDefault();
                onCancelEdit?.();
                return;
              }
              const action = resolveChatEnterAction(
                {
                  key: event.key,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  shiftKey: event.shiftKey,
                  altKey: event.altKey,
                  isComposing: event.nativeEvent.isComposing,
                  keyCode: event.nativeEvent.keyCode,
                  defaultPrevented: event.defaultPrevented,
                },
                { requireCtrlEnter },
              );
              if (action === "submit") {
                event.preventDefault();
                void submitEdit();
                return;
              }
              if (action === "insert-newline") {
                event.preventDefault();
                const { value: nextDraft, caret: nextCaret } = insertNewlineAtSelection(
                  editDraft,
                  event.currentTarget.selectionStart,
                  event.currentTarget.selectionEnd,
                );
                setEditDraft(nextDraft);
                window.requestAnimationFrame(() => {
                  const el = editTextareaRef.current;
                  if (!el) return;
                  el.setSelectionRange(nextCaret, nextCaret);
                  resizeEditTextarea();
                });
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
              title={`从此消息重新发送 (${formatSendShortcutHint(requireCtrlEnter)})`}
            >
              <ArrowUp size={14} strokeWidth={2} />
              <span>{submittingEdit ? "发送中" : "发送"}</span>
            </button>
          </div>
        </div>
      </article>
    );
  }

  const userMessageCollapsed = userMessageCollapsible && !userMessageExpanded;
  const expandLabel = userMessageExpanded ? "收起消息" : "展开完整消息";
  const contentId = `message-${message.id}-content`;
  const summaryId = `message-${message.id}-collapsed-summary`;
  const accessibleSummary = message.content.length > 240
    ? `${message.content.slice(0, 240)}…`
    : message.content;

  return (
    <article className="dshc-flow dshc-user-row" data-chat-flow-kind="user" id={`message-${message.id}`}>
      <motion.div
        className="dshc-user-stack"
        initial={userBubbleEntering && !reduceMotion ? USER_BUBBLE_HIDDEN : false}
        animate={USER_BUBBLE_VISIBLE}
        transition={USER_BUBBLE_SPRING}
        style={{ originX: 1, originY: 1 }}
      >
        {message.images && message.images.length > 0 && (
          <div className="dshc-attachment-row" data-message-attachments="">
            {message.images.map((image, index) => (
              <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`附件 ${index + 1}`} />
            ))}
          </div>
        )}
        {message.content && (
          <div className={`dshc-bubble${userMessageCollapsible ? userMessageExpanded ? " is-collapsible is-expanded" : " is-collapsible is-collapsed" : ""}`}>
            <div
              ref={userMessageTextRef}
              id={contentId}
              className="dshc-bubble-text"
              aria-hidden={userMessageCollapsed || undefined}
              inert={userMessageCollapsed || undefined}
            >
              {message.content}
            </div>
            {userMessageCollapsed && (
              <span id={summaryId} className="dshc-visually-hidden">
                消息预览：{accessibleSummary}，其余内容已折叠。
              </span>
            )}
            {userMessageCollapsible && (
              <button
                type="button"
                className="dshc-bubble-expand"
                title={expandLabel}
                aria-label={expandLabel}
                aria-controls={contentId}
                aria-describedby={userMessageCollapsed ? summaryId : undefined}
                aria-expanded={userMessageExpanded}
                onClick={() => setUserMessageExpanded((value) => !value)}
              >
                {userMessageExpanded
                  ? <ChevronUp size={14} strokeWidth={1.6} />
                  : <ChevronDown size={14} strokeWidth={1.6} />}
              </button>
            )}
          </div>
        )}
      </motion.div>
      {(message.content || (message.images && message.images.length > 0)) && (
        <MessageIconActions
          text={message.content}
          time={message.timestamp}
          clock="start"
          className="dshc-user-actions"
          extraActions={(
            <>
              {onEdit && (
                <button type="button" className="dshc-action" title="编辑消息" aria-label="编辑消息" disabled={rewinding} onClick={() => onEdit(message)}>
                  <Pencil size={15} strokeWidth={1.25} />
                </button>
              )}
              {onRewind && (
                <button
                  type="button"
                  className="dshc-action"
                  title="回退消息和改动"
                  aria-label="回退消息和改动"
                  disabled={rewinding}
                  onClick={() => void rewindMessage()}
                >
                  {rewinding ? <LoaderCircle className="spin" size={15} strokeWidth={1.25} /> : <RotateCcw size={15} strokeWidth={1.25} />}
                </button>
              )}
              <PluginSlot
                name="message.actions"
                messageRole="user"
                context={{
                  cwd: slotCwd,
                  sessionFile: slotSessionFile,
                  message,
                  contentText: message.content,
                }}
              />
            </>
          )}
        />
      )}
    </article>
  );
}
