// Importing Pi's past tasks from the desktop (src/lib/piImport.ts, P6b).
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { describeImport, piImport } = await import("../src/lib/piImport");
const { harnessRuntimes } = await import("../src/lib/harnessRuntime");

const report = { pending: 0, prompted: true, imported: 2, skipped: 1, failed: 1, problems: [] };

describe("Pi task import", () => {
  it("scans the desktop's session directory when it set one, the Host's default otherwise", async () => {
    const call = vi.spyOn(harnessRuntimes, "call").mockResolvedValue(report);
    await piImport.status("  ");
    expect(call).toHaveBeenLastCalledWith("import.piSessions", { dryRun: true });
    await piImport.dismiss("D:/pi-sessions");
    expect(call).toHaveBeenLastCalledWith("import.piSessions", { roots: ["D:/pi-sessions"], dryRun: true, markPrompted: true });
  });

  it("reports progress while it runs and stops listening after", async () => {
    let notify: ((params: unknown) => void) | undefined;
    const stop = vi.fn();
    vi.spyOn(harnessRuntimes, "onNotification").mockImplementation((method, listener) => {
      expect(method).toBe("import/progress");
      notify = listener;
      return stop;
    });
    vi.spyOn(harnessRuntimes, "call").mockImplementation(async () => {
      notify?.({ done: 1, total: 4 });
      return report;
    });
    const seen: unknown[] = [];
    expect(await piImport.run(undefined, (progress) => seen.push(progress))).toEqual(report);
    expect(seen).toEqual([{ done: 1, total: 4 }]);
    expect(stop).toHaveBeenCalled();
    expect(describeImport(report)).toBe("已导入 2 个任务，跳过 1 个（已导入或为空），1 个无法读取");
  });
});
