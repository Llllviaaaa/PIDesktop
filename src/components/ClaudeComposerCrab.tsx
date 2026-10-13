import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { CRAB_FRAME_MS, CRAB_SHEETS, CRAB_SHEET_URLS } from "../lib/claudeCrabSheets";

export type CrabStateKey = keyof typeof CRAB_SHEETS;

interface ClaudeComposerCrabProps {
  isStreaming?: boolean;
  isThinking?: boolean;
  isCompacting?: boolean;
  hasNotification?: boolean;
  hasError?: boolean;
}

const IDLE_EXTRAS: CrabStateKey[] = ["idle-look", "idle-wave", "idle-laptop"];

export function ClaudeComposerCrab({
  isStreaming = false,
  isThinking = false,
  isCompacting = false,
  hasNotification = false,
  hasError = false,
}: ClaudeComposerCrabProps) {
  const stripRef = useRef<HTMLSpanElement>(null);
  const [reaction, setReaction] = useState<CrabStateKey | null>(null);
  const [idleExtra, setIdleExtra] = useState<CrabStateKey | null>(null);
  const clicksRef = useRef<number[]>([]);
  const reactionTimerRef = useRef<number | null>(null);

  const baseKey: CrabStateKey = reaction
    ? reaction
    : hasError
      ? "error"
      : hasNotification
        ? "notification"
        : isCompacting
          ? "compacting"
          : isThinking
            ? "thinking"
            : isStreaming
              ? "typing"
              : idleExtra ?? "idle";

  const sheet = CRAB_SHEETS[baseKey] ?? CRAB_SHEETS.idle;
  const urls = CRAB_SHEET_URLS[baseKey] ?? CRAB_SHEET_URLS.idle;
  const [boxX, boxY, boxW, boxH] = sheet.box;
  const stripRows = Math.ceil(sheet.frames / 8);

  // Periodic idle extras ("idle-look", "idle-wave", "idle-laptop") every 22–38s
  useEffect(() => {
    if (isStreaming || isThinking || isCompacting || hasNotification || hasError || reaction) {
      return;
    }
    const delay = 22_000 + Math.floor(Math.random() * 16_000);
    const timer = window.setTimeout(() => {
      const picked = IDLE_EXTRAS[Math.floor(Math.random() * IDLE_EXTRAS.length)] ?? "idle-look";
      setIdleExtra(picked);
      const spec = CRAB_SHEETS[picked] ?? CRAB_SHEETS.idle;
      window.setTimeout(() => {
        setIdleExtra((current) => (current === picked ? null : current));
      }, spec.frames * CRAB_FRAME_MS);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [hasError, hasNotification, idleExtra, isCompacting, isStreaming, isThinking, reaction]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || typeof strip.animate !== "function") return;

    const frameOffset = (frame: number) =>
      `translate(${-((frame % 8) * boxW) * 2}px, ${-(Math.floor(frame / 8) * boxH) * 2}px)`;

    const keyframes: Keyframe[] = [];
    for (let frame = 0; frame < sheet.frames; frame++) {
      keyframes.push({
        offset: frame / sheet.frames,
        transform: frameOffset(frame),
        easing: "steps(1)",
      });
    }
    keyframes.push({ offset: 1, transform: frameOffset(0) });

    const anim = strip.animate(keyframes, {
      duration: sheet.frames * CRAB_FRAME_MS,
      iterations: Infinity,
      fill: "forwards",
    });

    return () => anim.cancel();
  }, [baseKey, boxH, boxW, sheet.frames]);

  useEffect(() => () => {
    if (reactionTimerRef.current !== null) window.clearTimeout(reactionTimerRef.current);
  }, []);

  const onHitClick = (event: MouseEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    const now = Date.now();
    const lastClick = clicksRef.current[clicksRef.current.length - 1];
    if (lastClick !== undefined && now - lastClick > 450) {
      clicksRef.current = [];
    }
    clicksRef.current.push(now);
    let nextReaction: CrabStateKey;
    if (clicksRef.current.length >= 4) {
      clicksRef.current = [];
      nextReaction = "tickle";
    } else {
      const rect = event.currentTarget.getBoundingClientRect();
      nextReaction = event.clientX - rect.left < rect.width / 2 ? "poke-left" : "poke-right";
    }
    setReaction(nextReaction);
    if (reactionTimerRef.current !== null) window.clearTimeout(reactionTimerRef.current);
    const spec = CRAB_SHEETS[nextReaction] ?? CRAB_SHEETS.idle;
    reactionTimerRef.current = window.setTimeout(() => {
      setReaction(null);
      reactionTimerRef.current = null;
    }, spec.frames * CRAB_FRAME_MS);
  };

  return (
    <span
      className="dsh-claude-crab"
      data-ready=""
      data-animation={baseKey}
      aria-hidden="true"
      style={{
        "--dsh-claude-crab-sheet": `url("${urls.body}")`,
        "--dsh-claude-crab-ink": `url("${urls.ink}")`,
        "--dsh-claude-crab-x": String(boxX),
        "--dsh-claude-crab-y": String(boxY),
        "--dsh-claude-crab-w": String(boxW),
        "--dsh-claude-crab-h": String(boxH),
        "--dsh-claude-crab-cell-w": String(boxW),
        "--dsh-claude-crab-strip-h": String(boxH * stripRows),
      } as CSSProperties}
    >
      <span className="dsh-claude-crab-sprite">
        <span ref={stripRef} className="dsh-claude-crab-strip" />
      </span>
      <span className="dsh-claude-crab-hit" onClick={onHitClick} title="点我一下" />
    </span>
  );
}
