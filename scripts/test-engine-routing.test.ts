// Which engine a runtime starts on (src/lib/pi.ts): a session reopens on the
// engine that created it, a side chat runs beside its parent, and only a new
// task follows the engine setting (P5d).
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ runtimeId: "runtime-1", sessionLoaded: true, sessionForked: false })) }));

const { invoke } = await import("@tauri-apps/api/core");
const { pi } = await import("../src/lib/pi");
const { harnessRuntimes } = await import("../src/lib/harnessRuntime");

const hostStart = vi.spyOn(harnessRuntimes, "start").mockResolvedValue({ runtimeId: "harness:r", sessionLoaded: true, sessionForked: false });

async function engineOf(start: () => Promise<{ runtimeId: string }>): Promise<"pi" | "harness"> {
  hostStart.mockClear();
  vi.mocked(invoke).mockClear();
  await start();
  return hostStart.mock.calls.length > 0 ? "harness" : "pi";
}

describe("runtime routing", () => {
  it("starts new tasks on the configured engine and reopens sessions where they were made", async () => {
    harnessRuntimes.setEngine("harness");
    expect(await engineOf(() => pi.start("C:/w"))).toBe("harness");
    expect(await engineOf(() => pi.start("C:/w", "C:/pi/sessions/a.jsonl"))).toBe("pi");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("pi_start", { cwd: "C:/w", sessionFile: "C:/pi/sessions/a.jsonl", isolated: false });
    expect(await engineOf(() => pi.start("C:/w", "harness:abc"))).toBe("harness");

    harnessRuntimes.setEngine("pi");
    expect(await engineOf(() => pi.start("C:/w"))).toBe("pi");
    expect(await engineOf(() => pi.start("C:/w", "harness:abc"))).toBe("harness");
  });

  it("runs a side chat beside its parent", async () => {
    harnessRuntimes.setEngine("harness");
    expect(await engineOf(() => pi.start("C:/w", "harness:abc", true))).toBe("harness");
    expect(hostStart).toHaveBeenCalledWith("C:/w", "harness:abc", true);
    expect(await engineOf(() => pi.start("C:/w", "C:/pi/sessions/a.jsonl", true))).toBe("pi");
  });
});
