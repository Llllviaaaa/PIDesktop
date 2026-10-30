import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronUp } from "lucide-react";
import { useAppStore } from "../store";
import type { UiMessage } from "../types";
import { deriveTurnPlans } from "../lib/envSources";
import { normalizeTranscriptDensity, type TranscriptDensity } from "../lib/transcriptDensity";
import { groupTranscriptMessages } from "../lib/transcriptTurns";
import { Message } from "./Message";

function singleLineExcerpt(text: string, maxLen = 46): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "（图片或附件）";
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

export function ConversationMessages({
  showThinking,
  expectVisibleThinking,
  isStreaming,
  statusText,
  editingMessageId,
  density = "normal",
  onEdit,
  onRewind,
  onCancelEdit,
  onSubmitEdit,
  onOpenPlan,
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
  density?: TranscriptDensity;
  onEdit: (message: UiMessage) => void;
  onRewind: (message: UiMessage) => Promise<boolean>;
  onCancelEdit: () => void;
  onSubmitEdit: (message: UiMessage, text: string) => Promise<boolean>;
  onOpenPlan?: () => void;
  scrollerRef: { current: HTMLDivElement | null };
  autoFollowRef: { current: boolean };
  lastAutoScrollAtRef: { current: number };
  conversationKey: string;
}) {
  const messages = useAppStore((state) => state.messages);
  const transcriptDensity = normalizeTranscriptDensity(density);
  const displayMessages = useMemo(() => groupTranscriptMessages(messages), [messages]);
  const { turnPlans, latestPlanMessageId } = useMemo(() => {
    const allPlans = deriveTurnPlans(displayMessages);
    return {
      turnPlans: isStreaming ? deriveTurnPlans(displayMessages, true) : allPlans,
      // The side panel shows the newest plan, so only the turn that holds it links there.
      latestPlanMessageId: [...allPlans.keys()].pop(),
    };
  }, [displayMessages, isStreaming]);
  const [visibleCount, setVisibleCount] = useState(120);
  const firstVisibleIndex = Math.max(0, displayMessages.length - visibleCount);
  const visibleMessages = displayMessages.slice(firstVisibleIndex);
  const userTurns = useMemo(
    () => visibleMessages.filter((msg) => msg.role === "user"),
    [visibleMessages],
  );
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [turnNavOpen, setTurnNavOpen] = useState(false);
  const landedTimerRef = useRef<number | null>(null);

  const lastAssistantId = useMemo(() => {
    for (let index = displayMessages.length - 1; index >= 0; index -= 1) {
      const role = displayMessages[index].role;
      if (role === "assistant") return displayMessages[index].id;
      if (role === "user") return null;
    }
    return null;
  }, [displayMessages]);

  // The running line's clock counts from the message that opened the newest turn.
  const lastTurnStartedAt = useMemo(() => {
    for (let index = displayMessages.length - 1; index >= 0; index -= 1) {
      if (displayMessages[index].role === "user") return displayMessages[index].timestamp;
    }
    return undefined;
  }, [displayMessages]);

  // Start each conversation from the most recent page.
  const [pagedConversation, setPagedConversation] = useState(conversationKey);
  if (pagedConversation !== conversationKey) {
    setPagedConversation(conversationKey);
    setVisibleCount(120);
  }

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

  // Track which user turn is currently in view for the dsh-claude-style turn rail.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const scroller = scrollerRef.current;
    if (!scroller || userTurns.length === 0) {
      setActiveTurnId(null);
      return;
    }
    const updateCurrentTurn = () => {
      const scrollerRect = scroller.getBoundingClientRect();
      const threshold = scrollerRect.top + scrollerRect.height * 0.35;
      let current = userTurns[0]?.id ?? null;
      for (const turn of userTurns) {
        const el = document.getElementById(`message-${turn.id}`);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.top <= threshold) current = turn.id;
        else break;
      }
      setActiveTurnId(current);
    };
    updateCurrentTurn();
    scroller.addEventListener("scroll", updateCurrentTurn, { passive: true });
    window.addEventListener("resize", updateCurrentTurn);
    return () => {
      scroller.removeEventListener("scroll", updateCurrentTurn);
      window.removeEventListener("resize", updateCurrentTurn);
    };
  }, [scrollerRef, userTurns]);

  const jumpToTurn = useCallback((turnId: string) => {
    const el = document.getElementById(`message-${turnId}`);
    if (!el) return;
    autoFollowRef.current = false;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveTurnId(turnId);
    setTurnNavOpen(false);
    document.querySelectorAll("[data-dsh-claude-turn-nav-landed]").forEach((node) => {
      node.removeAttribute("data-dsh-claude-turn-nav-landed");
    });
    el.setAttribute("data-dsh-claude-turn-nav-landed", "");
    if (landedTimerRef.current !== null) window.clearTimeout(landedTimerRef.current);
    landedTimerRef.current = window.setTimeout(() => {
      el.removeAttribute("data-dsh-claude-turn-nav-landed");
      landedTimerRef.current = null;
    }, 1450);
  }, [autoFollowRef]);

  useEffect(() => () => {
    if (landedTimerRef.current !== null) window.clearTimeout(landedTimerRef.current);
  }, []);

  // Alt+Up / Alt+Down turn navigation (mirrors dsh-claude-style D34)
  useEffect(() => {
    if (typeof window === "undefined" || userTurns.length < 2) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLTextAreaElement || activeEl instanceof HTMLInputElement) {
        if (activeEl.value.trim().length > 0) return;
      }
      event.preventDefault();
      const currentIndex = userTurns.findIndex((turn) => turn.id === activeTurnId);
      const baseIndex = currentIndex >= 0 ? currentIndex : userTurns.length - 1;
      const nextIndex = event.key === "ArrowUp"
        ? Math.max(0, baseIndex - 1)
        : Math.min(userTurns.length - 1, baseIndex + 1);
      const target = userTurns[nextIndex];
      if (target) jumpToTurn(target.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTurnId, jumpToTurn, userTurns]);

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
          turnStartedAt={message.id === lastAssistantId ? lastTurnStartedAt : undefined}
          allowRichContent
          density={transcriptDensity}
          editing={editingMessageId === message.id}
          plan={turnPlans.get(message.id)}
          onOpenPlan={message.id === latestPlanMessageId ? onOpenPlan : undefined}
          onEdit={message.role === "user" ? onEdit : undefined}
          onRewind={message.role === "user" ? onRewind : undefined}
          onCancelEdit={onCancelEdit}
          onSubmitEdit={onSubmitEdit}
        />
      ))}
      {userTurns.length > 1 && (
        <nav
          className="dsh-claude-turn-rail"
          aria-label="对话轮次导航"
          data-open={turnNavOpen || undefined}
          onMouseEnter={() => setTurnNavOpen(true)}
          onMouseLeave={() => setTurnNavOpen(false)}
        >
          <div className="dsh-claude-turn-rail-track" aria-hidden={turnNavOpen}>
            {userTurns.map((turn, index) => {
              const isCurrent = (activeTurnId ?? userTurns[userTurns.length - 1]?.id) === turn.id;
              return (
                <button
                  key={turn.id}
                  type="button"
                  className="dsh-claude-turn-rail-mark"
                  data-current={isCurrent || undefined}
                  title={`第 ${index + 1} 轮：${singleLineExcerpt(turn.content, 60)}`}
                  aria-label={`跳到第 ${index + 1} 轮`}
                  onClick={() => jumpToTurn(turn.id)}
                />
              );
            })}
          </div>
          {turnNavOpen && (
            <div className="dsh-claude-turn-nav dsh-claude-popover-card" data-open="true" role="menu">
              <div className="dsh-claude-turn-nav-list">
                {userTurns.map((turn) => {
                  const isCurrent = (activeTurnId ?? userTurns[userTurns.length - 1]?.id) === turn.id;
                  return (
                    <button
                      key={turn.id}
                      type="button"
                      role="menuitem"
                      className="dsh-claude-turn-nav-row"
                      data-current={isCurrent || undefined}
                      onClick={() => jumpToTurn(turn.id)}
                    >
                      <span className="dsh-claude-turn-nav-text">
                        {singleLineExcerpt(turn.content)}
                      </span>
                      <span className="dsh-claude-turn-nav-dash" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </nav>
      )}
    </>
  );
}
