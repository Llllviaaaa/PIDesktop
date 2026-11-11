import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { Tools, textOutput, type ToolEnv } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import { evaluateToolPermission, isForcePush, isSelfKillCommand, Permissions, rulesFromConfig, type Config } from "../src/index.ts";

async function setup(config: Config = {}, withUi = true) {
  const ctx = new Context();
  await ctx.plugin(Sessions);
  await ctx.plugin(Ui);
  await ctx.plugin(Tools);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Permissions, config);
  for (const name of ["read", "write", "bash"]) {
    ctx.tools.register({ name, description: name, parameters: { type: "object" }, execute: () => textOutput(`${name} ran`) });
  }
  const asked: string[] = [];
  let answer = true;
  if (withUi) {
    ctx.ui.attach({
      request: ({ requestId, request }) => {
        asked.push(request.kind === "confirm" ? request.title : request.kind);
        queueMicrotask(() => ctx.ui.respond(requestId, answer));
      },
      cancel: () => {},
      notify: () => {},
    });
  }
  const session = ctx.sessions.create({ cwd: "D:/repo" });
  const env = (): ToolEnv => ({ sessionId: session.id, cwd: "D:/repo", signal: new AbortController().signal });
  const run = async (name: string, args: Record<string, unknown>) => {
    const output = await ctx.tools.execute({ id: "1", name, args }, env());
    return output.content[0]?.type === "text" ? output.content[0].text : "";
  };
  return { ctx, session, asked, run, deny: () => { answer = false; } };
}

describe("permissions", () => {
  it("asks before shell commands and file changes in ask mode", async () => {
    const { run, asked, deny } = await setup();
    expect(await run("read", { path: "a.ts" })).toBe("read ran");
    expect(await run("write", { path: "a.ts", content: "" })).toBe("write ran");
    expect(asked).toEqual(["允许修改文件？"]);
    deny();
    expect(await run("bash", { command: "rm -rf build" })).toBe("Denied: 允许执行命令？ denied by user");
  });

  it("follows a session's modes, recorded in its log", async () => {
    const { ctx, session, run, asked } = await setup();
    expect(ctx.permissions.modes(session)).toEqual({ permission: "ask", agentMode: "agent", effective: "ask" });
    ctx.permissions.set(session, { permission: "workspace-write" });
    expect(await run("write", { path: "src/a.ts", content: "" })).toBe("write ran");
    expect(await run("write", { path: "D:/elsewhere/a.ts", content: "" })).toMatch(/^Denied: Write outside workspace blocked by rule/);
    ctx.permissions.set(session, { agentMode: "plan" });
    expect(ctx.permissions.modes(session)).toEqual({ permission: "workspace-write", agentMode: "plan", effective: "read-only" });
    expect(await run("bash", { command: "ls" })).toBe("Denied: Qianji is in read-only mode");
    expect(asked).toEqual([]);
    expect(await ctx.systemPrompt.build({ sessionId: session.id, cwd: "D:/repo", model: { provider: "p", model: "m" }, tools: [] })).toContain("Qianji mode: Plan.");
  });

  it("defaults side-chat forks to read-only ask mode regardless of parent write permissions, while allowing explicit side overrides", async () => {
    const { ctx, session, asked } = await setup();
    ctx.permissions.set(session, { permission: "full-access", agentMode: "agent" });
    expect(ctx.permissions.modes(session)).toEqual({ permission: "full-access", agentMode: "agent", effective: "full-access" });

    const side = ctx.sessions.fork(session, session.lastSeq, { side: true });
    expect(ctx.permissions.modes(side)).toEqual({ permission: "read-only", agentMode: "ask", effective: "read-only" });

    const sideEnv = (): ToolEnv => ({ sessionId: side.id, cwd: "D:/repo", signal: new AbortController().signal });
    const runSide = async (name: string, args: Record<string, unknown>) => {
      const output = await ctx.tools.execute({ id: "side-1", name, args }, sideEnv());
      return output.content[0]?.type === "text" ? output.content[0].text : "";
    };

    expect(await runSide("read", { path: "a.ts" })).toBe("read ran");
    expect(await runSide("write", { path: "a.ts", content: "x" })).toBe("Denied: Qianji is in read-only mode");
    expect(await runSide("bash", { command: "echo hi" })).toBe("Denied: Qianji is in read-only mode");
    expect(asked).toEqual([]);
    expect(await ctx.systemPrompt.build({ sessionId: side.id, cwd: "D:/repo", model: { provider: "p", model: "m" }, tools: [] })).toContain("Qianji mode: Ask.");

    // Explicit mode change on the side session itself takes effect.
    ctx.permissions.set(side, { permission: "workspace-write", agentMode: "agent" });
    expect(ctx.permissions.modes(side)).toEqual({ permission: "workspace-write", agentMode: "agent", effective: "workspace-write" });
    expect(await runSide("write", { path: "a.ts", content: "x" })).toBe("write ran");
  });

  it("denies what needs confirmation when no UI can answer", async () => {
    const { run } = await setup({}, false);
    expect(await run("bash", { command: "ls" })).toBe("Denied: Confirmation required but no UI is available");
  });

  it("applies allow-listed prefixes and tool rules", async () => {
    const { ctx, session, run, asked } = await setup({
      alwaysConfirmShell: false,
      shellAllowPrefixes: ["git status"],
      toolRules: [{ id: "no-npm-publish", enabled: true, toolPattern: "bash", action: "block", commandPrefix: "npm publish", pathPrefix: "" }],
    });
    ctx.permissions.set(session, { permission: "workspace-write" });
    expect(await run("bash", { command: "git status --short" })).toBe("bash ran");
    expect(await run("bash", { command: "npm publish" })).toBe("Denied: Blocked by tool rule: no-npm-publish");
    expect(asked).toEqual([]);
  });

  it("reads rule defaults like the Pi guard", () => {
    expect(rulesFromConfig({})).toEqual({ alwaysConfirmShell: true, blockWriteOutsideWorkspace: true, allowForcePush: false, shellAllowPrefixes: [], toolRules: [] });
    expect(rulesFromConfig({ toolRules: [{ id: "x", enabled: true, toolPattern: "*", action: "allow" } as never, { bogus: true } as never] }).toolRules)
      .toEqual([{ id: "x", enabled: true, toolPattern: "*", action: "allow", commandPrefix: "", pathPrefix: "" }]);
  });
});

describe("Settings → 允许强制推送", () => {
  const shell = (command: string, allowForcePush?: boolean, mode: "ask" | "full-access" = "full-access") =>
    evaluateToolPermission({
      mode,
      rules: { ...rulesFromConfig({}), ...(allowForcePush === undefined ? {} : { allowForcePush }) },
      workspace: "D:/repo",
      toolName: "bash",
      input: { command },
    });

  it("recognises the ways a push can rewrite a remote branch", () => {
    for (const command of [
      "git push --force",
      "git push origin main --force",
      "git push --force-with-lease origin HEAD",
      "git push --force-with-lease=main:abc123",
      "git push -f",
      "git push -uf origin main",
      "git push origin +main",
      "git push origin +HEAD:main",
      "git -C ../repo push --force",
      "git -c push.default=current push -f",
      "npm test && git push --force",
      "git add . ; git commit -m wip; git push -f",
      "\"C:/Program Files/Git/cmd/git.exe\" push --force",
    ]) {
      expect(isForcePush(command), command).toBe(true);
    }
    for (const command of [
      "git push",
      "git push origin main",
      "git push -u origin feature",
      "git push --follow-tags",
      "git push --set-upstream origin fix/foo",
      "git fetch --force",
      "git commit -m \"push --force later\"",
      "echo git push",
      "git status | grep force",
    ]) {
      expect(isForcePush(command), command).toBe(false);
    }
  });

  it("blocks a force push by default, in every mode, ahead of other rules", () => {
    expect(shell("git push --force")).toMatchObject({ action: "block" });
    expect(shell("git push -f", false, "ask")).toMatchObject({ action: "block" });
    expect(shell("git push origin main")).toEqual({ action: "allow" });
    // A custom allow rule for bash does not lift it.
    const withAllowRule = evaluateToolPermission({
      mode: "ask",
      rules: { ...rulesFromConfig({ toolRules: [{ id: "all-bash", enabled: true, toolPattern: "bash", action: "allow", commandPrefix: "", pathPrefix: "" }] }) },
      workspace: "D:/repo",
      toolName: "bash",
      input: { command: "git push --force" },
    });
    expect(withAllowRule).toMatchObject({ action: "block" });
  });

  it("lets a force push through the usual checks once the setting is on", () => {
    expect(shell("git push --force", true)).toEqual({ action: "allow" });
    expect(shell("git push --force", true, "ask")).toMatchObject({ action: "confirm" });
    expect(rulesFromConfig({ allowForcePush: true }).allowForcePush).toBe(true);
    expect(rulesFromConfig({}).allowForcePush).toBe(false);
  });
});

describe("Self-kill protection (防自杀拦截)", () => {
  it("detects Windows, PowerShell, WMI, POSIX, encoded, and PID-based self-kill commands", () => {
    const encodedStopQianji = Buffer.from("Stop-Process -Name qianji -Force", "utf16le").toString("base64");
    const protectedPids = new Set([42424, 53535]);

    for (const command of [
      "taskkill /F /IM qianji.exe",
      "taskkill.exe /im qianji-harness.exe /f",
      "taskkill /F /IM qianji-harness-x86_64-pc-windows-msvc.exe",
      "taskkill /F /FI \"IMAGENAME eq qianji*\"",
      "taskkill /PID 42424 /F",
      "tskill qianji",
      "tskill 53535",
      "Stop-Process -Name qianji -Force",
      "spps -Id 42424",
      "Get-Process qianji* | Stop-Process -Force",
      "Get-Process -Name qianji-harness | ForEach-Object { $_.Kill() }",
      `powershell -NoProfile -EncodedCommand ${encodedStopQianji}`,
      "wmic process where \"name='qianji.exe'\" delete",
      "Get-CimInstance Win32_Process -Filter \"Name = 'qianji.exe'\" | Invoke-CimMethod -MethodName Terminate",
      "pkill -9 qianji",
      "killall qianji-harness",
      "kill -9 42424",
      "kill -TERM $PPID",
      "echo $(taskkill /F /IM qianji.exe)",
      "kill $(pgrep qianji)",
      "cmd /c \"taskkill /F /IM qianji.exe\"",
      "(pkill -f qianji.exe)",
      "npm test; taskkill /F /IM qianji.exe",
      "node -e \"process.kill(42424, 'SIGKILL')\"",
      "node -e \"process.kill(process.ppid)\"",
      "python -c \"import os; os.kill(os.getppid(), 9)\"",
      "Get-Process | Where-Object { ($_.ProcessName -eq 'qianji') } | Stop-Process -Force",
      "Get-Process | Where-Object { $_.Name.Contains('qianji-harness') } | Stop-Process",
      "Get-Process | Where-Object { $_.Id -eq 42424 } | Stop-Process -Force",
      "(Get-Process -Id 42424).Kill()",
      "[System.Diagnostics.Process]::GetProcessesByName('qianji') | % { $_.Kill() }",
      "[Diagnostics.Process]::GetProcessById(42424).Kill()",
      "taskkill /F /FI:\"PID eq 42424\"",
      "Stop-Process -Name \"*qianji*.exe\" -Force",
    ]) {
      expect(isSelfKillCommand(command, protectedPids), command).toBe(true);
    }

    for (const safeCommand of [
      "git commit -m \"fix: block taskkill /F /IM qianji.exe\"",
      "rg \"taskkill.*qianji\" packages/",
      "ps aux | grep qianji",
      "tasklist /FI \"IMAGENAME eq qianji.exe\"",
      "Get-Process qianji -ErrorAction SilentlyContinue",
      "Get-Process | Where-Object { ($_.ProcessName -eq 'qianji') }",
      "pkill -f \"D:/work/qianji-demo/server.js\"",
      "kill -0 42424",
      "kill -s 0 42424",
      "node -e \"process.kill(42424, 0)\"",
      "node -e \"process.kill(process.ppid, 0)\"",
      "kill -9 99999",
      "npm run test:harness-host",
    ]) {
      expect(isSelfKillCommand(safeCommand, protectedPids), safeCommand).toBe(false);
    }
  });

  it("hard-blocks self-kill commands in full-access mode and ahead of custom allow rules", async () => {
    const decision = evaluateToolPermission({
      mode: "full-access",
      rules: {
        ...rulesFromConfig({
          toolRules: [{ id: "allow-all-bash", enabled: true, toolPattern: "bash", action: "allow", commandPrefix: "", pathPrefix: "" }],
        }),
      },
      workspace: "D:/repo",
      toolName: "bash",
      input: { command: "taskkill /F /IM qianji.exe" },
      protectedPids: new Set([12345]),
    });
    expect(decision).toMatchObject({ action: "block" });

    const { ctx, session, run, asked } = await setup();
    ctx.permissions.set(session, { permission: "full-access" });
    const blocked = await run("bash", { command: `kill -9 ${process.pid}` });
    expect(blocked).toMatch(/^Denied: 已拦截针对千机自身进程/);
    expect(asked).toEqual([]);
  });
});
