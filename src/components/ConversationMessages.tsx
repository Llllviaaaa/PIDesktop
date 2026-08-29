import { useEffect, useMemo, useState } from "react";
import { ChevronUp } from "lucide-react";
import { usePiStore } from "../store";
import type { UiMessage } from "../types";
import { Message } from "./Message";

export function ConversationMessages({
  showThinking,
  expectVisibleThinking,
  isStreaming,
  statusText,
  editingMessageId,
  onEdit,
  onRewind,
  onCancelEdit,
  onSubmitEdit,
  scrollerRef,
  autoFollowRef,
  lastAutoScrollAtRef,
  conversationKey,
}: {
  showThinking: boolean;
  expectVisibleThinking: boolean;
  isStreaming: boolean;
  statusText: string;
  editingMessageId?: string;
  onEdit: (message: UiMessage) => void;
  onRewind: (message: UiMessage) => Promise<boolean>;
  onCancelEdit: () => void;
  onSubmitEdit: (message: UiMessage, text: string) => Promise<boolean>;
  scrollerRef: { current: HTMLDivElement | null };
  autoFollowRef: { current: boolean };
  lastAutoScrollAtRef: { current: number };
  conversationKey: string;
}) {
  const messages = usePiStore((state) => state.messages);
  const [visibleCount, setVisibleCount] = useState(120);
  const firstVisibleIndex = Math.max(0, messages.length - visibleCount);
  const visibleMessages = messages.slice(firstVisibleIndex);
  const lastAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const role = messages[index].role;
      if (role === "assistant") return messages[index].id;
      if (role === "user") return null;
    }
    return null;
  }, [messages]);

  useEffect(() => setVisibleCount(120), [conversationKey]);

  useEffect(() => {
    if (!autoFollowRef.current) return;
    const now = performance.now();
    if (isStreaming && now - lastAutoScrollAtRef.current < 80) return;
    lastAutoScrollAtRef.current = now;
    const frame = window.requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFollowRef, isStreaming, lastAutoScrollAtRef, messages, scrollerRef]);

  const revealEarlier = () => {
    const scroller = scrollerRef.current;
    const previousHeight = scroller?.scrollHeight ?? 0;
    setVisibleCount((count) => count + 120);
    window.requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop += scroller.scrollHeight - previousHeight;
    });
  };

  return (
    <>
      {firstVisibleIndex > 0 && (
        <button type="button" className="load-earlier-messages" onClick={revealEarlier}>
          <ChevronUp size={14} strokeWidth={1.8} />
          更早的 {Math.min(120, firstVisibleIndex)} 条消息
        </button>
      )}
      {visibleMessages.map((message) => (
        <Message
          key={message.id}
          message={message}
          showThinking={showThinking}
          expectVisibleThinking={expectVisibleThinking}
          isLastAssistant={message.id === lastAssistantId}
          globalStreaming={isStreaming}
          workingLabel={message.id === lastAssistantId ? statusText : undefined}
          editing={editingMessageId === message.id}
          onEdit={message.role === "user" ? onEdit : undefined}
          onRewind={message.role === "user" ? onRewind : undefined}
          onCancelEdit={onCancelEdit}
          onSubmitEdit={onSubmitEdit}
        />
      ))}
    </>
  );
}
