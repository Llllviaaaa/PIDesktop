import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolEnv } from "@qianji/tools";
import { bashTool, chooseShell, findPowerShell, findShell, isPowerShell, powershellTool, shellArgs } from "../src/index.ts";

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

  it("does not hang when a background child process keeps stdio pipes open after the shell exits", async () => {
    const started = Date.now();
    const output = await tool.execute({ command: "(sleep 5 &) && echo background-started", timeout: 3 }, env());
    expect(output.isError).toBe(false);
    expect(textOf(output)).toContain("background-started");
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("refuses to execute commands that would terminate Qianji or its Harness Host", async () => {
    for (const command of [
      "taskkill /F /IM qianji.exe",
      "Stop-Process -Name qianji-harness -Force",
      `kill -9 ${process.pid}`,
    ]) {
      const output = await tool.execute({ command }, env());
      expect(output.isError, command).toBe(true);
      expect(textOf(output), command).toMatch(/已拦截针对千机自身进程/);
    }
  });
});

describe("shell choice (ADR 0021)", () => {
  const none = () => undefined;
  it("uses bash where it exists and PowerShell only on Windows without it", () => {
    expect(chooseShell({}, "linux", {}, { bash: () => "/bin/bash" })).toEqual({ kind: "bash", path: "/bin/bash" });
    expect(chooseShell({}, "win32", {}, { bash: () => String.raw`C:\Git\bin\bash.exe`, powershell: () => "pwsh.exe" }).kind).toBe("bash");
    expect(chooseShell({}, "win32", {}, { bash: none, powershell: () => String.raw`C:\pwsh.exe` })).toEqual({ kind: "powershell", path: String.raw`C:\pwsh.exe` });
    expect(chooseShell({}, "win32", {}, { bash: none, powershell: none })).toEqual({ kind: "bash" });
    expect(chooseShell({ shell: String.raw`C:\Program Files\PowerShell\7\pwsh.exe` }, "win32").kind).toBe("powershell");
    expect(chooseShell({ shell: "/usr/bin/zsh" }, "linux").kind).toBe("bash");
  });

  it("prefers PowerShell 7 on PATH, then in Program Files, then Windows PowerShell", () => {
    const only = (...paths: string[]) => (path: string) => paths.includes(path);
    const env = { PATH: String.raw`C:\tools;C:\ps7`, ProgramFiles: String.raw`C:\Program Files`, SystemRoot: String.raw`C:\Windows` };
    const legacy = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
    const onPath = String.raw`C:\ps7\pwsh.exe`;
    const installed = String.raw`C:\Program Files\PowerShell\7\pwsh.exe`;
    expect(findPowerShell(env, only(onPath, legacy))).toBe(onPath);
    expect(findPowerShell(env, only(installed, legacy))).toBe(installed);
    expect(findPowerShell(env, only(legacy))).toBe(legacy);
    expect(findPowerShell(env, only())).toBeUndefined();
  });

  it("passes PowerShell the command encoded, with UTF-8 output and the 5.1 exit fix", () => {
    expect(shellArgs("/bin/bash", "echo hi")).toEqual(["-c", "echo hi"]);
    const decode = (args: string[]) => Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
    const pwsh = shellArgs(String.raw`C:\ps7\pwsh.exe`, 'Write-Output "a \'b\' c"');
    expect(pwsh.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(decode(pwsh)).toContain("[Console]::OutputEncoding");
    expect(decode(pwsh)).toContain('Write-Output "a \'b\' c"');
    expect(decode(pwsh)).not.toContain("NativeCommandError");
    expect(decode(shellArgs("powershell.exe", "git push 2>&1"))).toContain("NativeCommandError");
    expect(decode(shellArgs("powershell.exe", "Get-ChildItem `"))).not.toContain("NativeCommandError");
    expect(isPowerShell(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\PowerShell.EXE`)).toBe(true);
    expect(isPowerShell("/bin/bash")).toBe(false);
  });
});

const powershell = process.platform === "win32" ? findPowerShell() : undefined;

describe.skipIf(powershell === undefined)("powershell tool (ADR 0021)", () => {
  const tool = powershellTool({}, undefined, powershell);

  it("is named powershell and runs PowerShell in the session cwd with UTF-8 output", async () => {
    expect(tool.name).toBe("powershell");
    expect(tool.description).toContain("There is no bash on this machine");
    const output = await tool.execute({ command: 'Write-Output "héllo 千机"; (Get-Location).Path' }, env());
    expect(output.isError).toBe(false);
    const text = textOf(output);
    expect(text).toContain("héllo 千机");
    expect(text.toLowerCase()).toContain(cwd.toLowerCase());
  });

  it("reports a failing command as an error", async () => {
    const output = await tool.execute({ command: "exit 3" }, env());
    expect(output.isError).toBe(true);
  });

  it("does not count a native command's redirected stderr as failure", async () => {
    const output = await tool.execute({ command: 'cmd /c "echo warn 1>&2 & exit 0" 2>&1' }, env());
    expect(textOf(output)).toContain("warn");
    expect(output.isError).toBe(false);
  });
});
