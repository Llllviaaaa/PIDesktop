import assert from "node:assert/strict";
import { test } from "vitest";
import { backgroundTerminalsFor, type TerminalTabInfo } from "../src/lib/terminalTabs.ts";

const tab = (id: string, cwd: string, extra: Partial<TerminalTabInfo> = {}): TerminalTabInfo => ({
  id,
  cwd,
  shell: "PowerShell",
  title: "PowerShell",
  status: "running",
  ...extra,
});

test("counts only the workspace's terminals and reports unseen output", () => {
  const tabs = [
    tab("a", "D:\\work\\app"),
    tab("b", "D:\\work\\app", { status: "exited", unseenOutput: true }),
    tab("c", "D:\\work\\other", { unseenOutput: true }),
  ];
  assert.deepEqual(backgroundTerminalsFor(tabs, "D:\\work\\app"), { count: 2, unseenOutput: true });
  assert.deepEqual(backgroundTerminalsFor(tabs.slice(0, 1), "D:\\work\\app"), { count: 1, unseenOutput: false });
});

test("reports nothing without a workspace", () => {
  assert.deepEqual(backgroundTerminalsFor([tab("a", "D:\\work\\app")], ""), { count: 0, unseenOutput: false });
});
