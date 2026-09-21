import { useSyncExternalStore } from "react";

/**
 * A wall clock that ticks every 30 seconds, shared by every component that
 * reads it. Good enough for "running for N minutes" labels; do not use it
 * for anything that needs second precision.
 *
 * The first subscriber starts the timer and the last one stops it, so an app
 * with nothing showing elapsed time runs no interval at all.
 */
const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let now = Date.now();
let timer: number | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    // React re-reads the snapshot right after subscribing, so this is seen at once.
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): number {
  return now;
}

export function useClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
