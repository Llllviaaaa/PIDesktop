import { useEffect, useRef, useState, type ReactNode } from "react";
import { Info, Link2, Share2, Terminal } from "lucide-react";
import type { TranscriptDensity } from "../../lib/transcriptDensity";
import { showToast } from "../../notifications";
import type { UiMessage } from "../../types";
import { PluginSlot } from "../common/PluginSlot";
import { IconCheck, IconCopy } from "../DshIcons";
import { Markdown } from "../Markdown";
import { formatMessageClock } from "./messageHelpers";

export function MessageIconActions({
  text,
  time,
  clock,
  copyTitle = "复制",
  className,
  extraActions,
}: {
  text: string;
  time?: number;
  clock: "start" | "end";
  copyTitle?: string;
  className?: string;
  extraActions?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  const onCopy = () => {
    if (copied) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        setCopied(false);
      }, 1000);
    }).catch(() => undefined);
  };

  const clockEl = typeof time === "number" && time > 0
    ? <span className={clock === "start" ? "dshc-time-start" : "dshc-time-end"}>{formatMessageClock(time)}</span>
    : null;

  return (
    <div className={`dshc-actions${className ? ` ${className}` : ""}`} data-clock={clock}>
      {clock === "start" ? clockEl : null}
      <button
        type="button"
        className="dshc-action"
        title={copied ? "已复制" : copyTitle}
        aria-label={copied ? "已复制" : "复制"}
        onClick={onCopy}
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
      {extraActions}
      {clock === "end" && clockEl ? <span className="dshc-end-info">{clockEl}</span> : null}
    </div>
  );
}

export function TerminalOrNoticeMessageRow({
  message,
  transcriptDensity,
}: {
  message: UiMessage;
  transcriptDensity: TranscriptDensity;
}) {
  if (message.role === "terminal") {
    return (
      <article className={`dshc-flow message-row terminal-message ${message.isError ? "error" : ""}`} id={`message-${message.id}`}>
        <div className="notice-heading"><Terminal size={14} /> 终端</div>
        <pre>{message.content}</pre>
      </article>
    );
  }

  if (message.noticeKind === "compaction" || message.noticeKind === "branch") {
    const label = message.noticeKind === "compaction" ? "上下文已压缩" : "会话已分叉";
    const detail = message.content.replace(/^(Context compacted|Branch summary)\s*/i, "").trim();
    return (
      <div className={`dshc-flow compaction-divider is-${message.noticeKind}`} role="separator" id={`message-${message.id}`}>
        <span>{label}</span>
        {detail && transcriptDensity === "verbose" && <small>{detail}</small>}
      </div>
    );
  }

  return (
    <article className="dshc-flow message-row notice-message" id={`message-${message.id}`}>
      <Info size={14} strokeWidth={1.75} aria-hidden="true" />
      <div className="notice-content"><Markdown content={message.content} /></div>
    </article>
  );
}

export function AssistantExtraActions({
  message,
  assistantContent,
  slotCwd,
  slotSessionFile,
}: {
  message: UiMessage;
  assistantContent: string;
  slotCwd: string;
  slotSessionFile: string | null;
}) {
  const shareContent = () => {
    const share = (navigator as Navigator & { share?: (data: ShareData) => Promise<void> }).share;
    if (typeof share === "function") {
      void share({ text: assistantContent }).catch(() => {
        void navigator.clipboard.writeText(assistantContent).then(() => showToast("已复制回复，可粘贴分享", "info"));
      });
      return;
    }
    void navigator.clipboard.writeText(assistantContent).then(() => showToast("已复制回复，可粘贴分享", "info")).catch(() => undefined);
  };

  const anchorMessage = () => {
    const node = document.getElementById(`message-${message.id}`);
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
    const url = `${window.location.href.split("#")[0]}#message-${message.id}`;
    void navigator.clipboard.writeText(url).then(() => showToast("已复制消息定位", "info")).catch(() => undefined);
  };

  return (
    <>
      <button type="button" className="dshc-action" title="分享" aria-label="分享" onClick={shareContent}>
        <Share2 size={15} strokeWidth={1.25} />
      </button>
      <button type="button" className="dshc-action" title="定位此消息" aria-label="定位此消息" onClick={anchorMessage}>
        <Link2 size={15} strokeWidth={1.25} />
      </button>
      <PluginSlot
        name="message.actions"
        messageRole="assistant"
        context={{ cwd: slotCwd, sessionFile: slotSessionFile, message, contentText: assistantContent }}
      />
    </>
  );
}
