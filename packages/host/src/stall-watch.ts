/**
 * Event-loop stall detection (ADR 0017). The Host and every plugin share one
 * event loop, so synchronous work that runs too long (a plugin stuck in a
 * loop, a huge synchronous parse) freezes every session and RPC at once.
 * Fiber isolation cannot catch that, and the desktop restarts the Host only
 * when it exits.
 *
 * A timer runs every `intervalMs` and measures how late it fires; `thresholdMs`
 * or more is a stall. A timer cannot run while the loop is blocked, so a stall
 * is reported once it is over, and one that never ends is never reported. The
 * point is to make freezes visible in the Host log, and so in the diagnostics
 * bundle, not to stop them.
 */

export const DEFAULT_STALL_INTERVAL_MS = 500;
export const DEFAULT_STALL_THRESHOLD_MS = 2_000;

/**
 * Gaps this long are taken for the machine sleeping, not a stall: the
 * monotonic clock can keep counting through a suspend, and nobody waits five
 * minutes on a frozen window before restarting it.
 */
export const SUSPEND_GAP_MS = 5 * 60_000;

export interface StallMeter {
  /** Records one timer tick at `now` and returns how long the loop was blocked, when that is a stall. */
  tick(now: number): number | undefined;
}

export function createStallMeter(intervalMs: number, thresholdMs: number, start: number): StallMeter {
  let last = start;
  return {
    tick(now) {
      const blockedMs = now - last - intervalMs;
      last = now;
      if (blockedMs < thresholdMs || blockedMs >= SUSPEND_GAP_MS) return undefined;
      return Math.round(blockedMs);
    },
  };
}

export interface StallWatchOptions {
  intervalMs?: number;
  thresholdMs?: number;
  /** Called after each stall with roughly how long the loop was blocked. */
  onStall(blockedMs: number): void;
}

/** Starts watching; the returned function stops it. The timer never keeps the process alive. */
export function watchEventLoopStalls(options: StallWatchOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_STALL_INTERVAL_MS;
  const thresholdMs = options.thresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const meter = createStallMeter(intervalMs, thresholdMs, performance.now());
  const timer = setInterval(() => {
    const blockedMs = meter.tick(performance.now());
    if (blockedMs === undefined) return;
    try {
      options.onStall(blockedMs);
    } catch {
      // Reporting a stall must never become a crash of its own.
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
