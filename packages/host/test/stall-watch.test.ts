import { describe, expect, it } from "vitest";
import { createStallMeter, SUSPEND_GAP_MS, watchEventLoopStalls } from "../src/stall-watch.ts";

function blockFor(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Busy-wait: hold the event loop the way a stuck plugin would.
  }
}

describe("event-loop stall detection (ADR 0017)", () => {
  it("reports only ticks that run at least the threshold late", () => {
    const meter = createStallMeter(500, 2_000, 0);
    expect(meter.tick(500)).toBeUndefined();
    expect(meter.tick(1_010)).toBeUndefined();
    expect(meter.tick(3_000)).toBeUndefined(); // 1490 ms late
    expect(meter.tick(6_000)).toBe(2_500);
    // The next tick measures from the stall's end, not from before it.
    expect(meter.tick(6_500)).toBeUndefined();
  });

  it("takes a suspend-sized gap for the machine sleeping", () => {
    const meter = createStallMeter(500, 2_000, 0);
    expect(meter.tick(500 + SUSPEND_GAP_MS)).toBeUndefined();
    expect(meter.tick(1_000 + SUSPEND_GAP_MS)).toBeUndefined();
  });

  it("notices a real synchronous block once it ends, and stops when asked", async () => {
    const stalls: number[] = [];
    const stop = watchEventLoopStalls({ intervalMs: 10, thresholdMs: 100, onStall: (ms) => stalls.push(ms) });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      blockFor(250);
      await new Promise((resolve) => setTimeout(resolve, 50));
      // A loaded test machine may add a stall of its own; the 250 ms block must be among them.
      expect(Math.max(0, ...stalls)).toBeGreaterThanOrEqual(200);
    } finally {
      stop();
    }
    const seen = stalls.length;
    blockFor(150);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stalls.length).toBe(seen);
  });

  it("swallows a failing reporter instead of crashing the host", async () => {
    let calls = 0;
    const stop = watchEventLoopStalls({
      intervalMs: 10,
      thresholdMs: 100,
      onStall: () => {
        calls += 1;
        throw new Error("reporter failed");
      },
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      blockFor(200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toBeGreaterThanOrEqual(1);
    } finally {
      stop();
    }
  });
});
