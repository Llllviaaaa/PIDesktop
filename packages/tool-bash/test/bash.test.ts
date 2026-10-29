import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolEnv } from "@pid/tools";
import { bashTool, findShell } from "../src/index.ts";

const shell = findShell();
const cwd = mkdtempSync(join(tmpdir(), "pid-tool-bash-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

const env = (signal = new AbortController().signal): ToolEnv => ({ sessionId: "s", cwd, signal });
const textOf = (output: Awaited<ReturnType<ReturnType<typeof bashTool>["execute"]>>) =>
  output.content.map((block) => (block.type === "text" ? block.text : "")).join("");

describe("findShell", () => {
  it("never picks WSL's bash on Windows", () => {
    expect(findShell("win32", { ProgramFiles: "Z:\\none" })?.toLowerCase().includes("system32")).not.toBe(true);
  });
});

describe.skipIf(shell === undefined)("bash tool", () => {
  const tool = bashTool({ shell });

  it("runs in the session cwd and returns combined output", async () => {
    const output = await tool.execute({ command: "echo out; echo err >&2; pwd" }, env());
    expect(output.isError).toBe(false);
    const text = textOf(output);
    expect(text).toContain("out");
    expect(text).toContain("err");
  });

  it("reports a failing exit code as an error", async () => {
    const output = await tool.execute({ command: "exit 3" }, env());
    expect(output.isError).toBe(true);
    expect(textOf(output)).toBe("(no output)\n[Exit code 3]");
  });

  it("kills a command that times out", async () => {
    const output = await tool.execute({ command: "sleep 5", timeout: 1 }, env());
    expect(output.isError).toBe(true);
    expect(textOf(output)).toContain("[Timed out after 1s");
  });

  it("kills a command when the run is aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const output = await tool.execute({ command: "sleep 5" }, env(controller.signal));
    expect(textOf(output)).toContain("[Aborted");
  });

  it("keeps the tail of long output", async () => {
    const output = await tool.execute({ command: "for i in $(seq 1 3000); do echo line$i; done" }, env());
    const text = textOf(output);
    expect(text.startsWith("[Output truncated; showing the end.]")).toBe(true);
    expect(text).toContain("line3000");
    expect(text).not.toContain("line1\n");
  });
});
