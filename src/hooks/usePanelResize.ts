import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  clampSize,
  nextSizeFromKey,
  readStoredSize,
  writeStoredSize,
  type KeyboardResize,
  type SizeBounds,
} from "../lib/panelLayout";

/**
 * A panel the user can drag or arrow-key to resize, with its size remembered
 * per viewer.
 *
 * App.tsx had three copies of this pointer dance — capture the pointer, track
 * it on window, restore the cursor, write the final size to localStorage —
 * differing only in axis, direction and bounds. The arithmetic lives in
 * lib/panelLayout.ts; this hook owns the DOM side.
 */
export interface PanelResizeOptions {
  storageKey: string;
  bounds: SizeBounds;
  keys: KeyboardResize;
  /** "x" for a side panel, "y" for the bottom panel. */
  axis: "x" | "y";
  /**
   * Whether moving the pointer towards positive coordinates grows the panel.
   * False for panels docked right or bottom, which grow as the pointer moves back.
   */
  growsWithPointer: boolean;
  /** Class put on <body> while dragging, so CSS can suppress hover states. */
  resizingClass: string;
  /** Divides pointer movement so a scaled UI still tracks the cursor. */
  scale: number;
  /** The live upper bound, which may be narrower than `bounds.max`. */
  maxSize: () => number;
}

export interface PanelResize {
  size: number;
  setSize: (size: number) => void;
  beginResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  resizeWithKeyboard: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

export function usePanelResize(options: PanelResizeOptions): PanelResize {
  const { storageKey, bounds, keys, axis, growsWithPointer, resizingClass, scale, maxSize } = options;
  const [size, setSizeState] = useState(() => readStoredSize(storageKey, bounds));
  const sizeRef = useRef(size);
  const cleanupDragRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  useEffect(() => () => {
    cleanupDragRef.current?.();
  }, []);

  const setSize = useCallback(
    (next: number) => {
      const clamped = clampSize(next, bounds);
      sizeRef.current = clamped;
      setSizeState(clamped);
    },
    [bounds],
  );

  const beginResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      cleanupDragRef.current?.();

      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const start = axis === "x" ? event.clientX : event.clientY;
      const startSize = sizeRef.current;
      const limit = maxSize();
      const safeScale = scale > 0 ? scale : 1;
      let latestSize = startSize;
      let rafId: number | null = null;

      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== pointerId) return;
        const current = axis === "x" ? move.clientX : move.clientY;
        const travelled = (growsWithPointer ? current - start : start - current) / safeScale;
        latestSize = Math.min(limit, Math.max(bounds.min, startSize + travelled));
        sizeRef.current = latestSize;
        if (rafId === null) {
          rafId = window.requestAnimationFrame(() => {
            rafId = null;
            setSizeState(latestSize);
          });
        }
      };

      const cleanup = () => {
        if (rafId !== null) {
          window.cancelAnimationFrame(rafId);
          rafId = null;
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        try {
          if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
        } catch {
          // Element may already be detached from DOM.
        }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.body.classList.remove(resizingClass);
        cleanupDragRef.current = null;
      };

      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== pointerId) return;
        cleanup();
        sizeRef.current = latestSize;
        setSizeState(latestSize);
        writeStoredSize(storageKey, latestSize);
      };

      cleanupDragRef.current = cleanup;
      target.setPointerCapture(pointerId);
      document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      document.body.classList.add(resizingClass);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [axis, bounds.min, growsWithPointer, maxSize, resizingClass, scale, storageKey],
  );

  const resizeWithKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const next = nextSizeFromKey(event.key, event.shiftKey, sizeRef.current, keys, {
        min: bounds.min,
        max: maxSize(),
      });
      // A key this panel does not handle must keep its default behaviour.
      if (next === null) return;
      event.preventDefault();
      sizeRef.current = next;
      setSizeState(next);
      writeStoredSize(storageKey, next);
    },
    [bounds.min, keys, maxSize, storageKey],
  );

  return { size, setSize, beginResize, resizeWithKeyboard };
}
