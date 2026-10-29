import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { Sessions } from "@pid/session";
import { SystemPrompt } from "@pid/system-prompt";
import { Tools, textOutput, type ToolEnv } from "@pid/tools";
import { Ui } from "@pid/ui";
import { Permissions, rulesFromConfig, type Config } from "../src/index.ts";

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
    expect(asked).toEqual(["Allow file change?"]);
    deny();
    expect(await run("bash", { command: "rm -rf build" })).toBe("Denied: Allow command? denied by user");
  });

  it("follows a session's modes, recorded in its log", async () => {
    const { ctx, session, run, asked } = await setup();
    expect(ctx.permissions.modes(session)).toEqual({ permission: "ask", agentMode: "agent", effective: "ask" });
    ctx.permissions.set(session, { permission: "workspace-write" });
    expect(await run("write", { path: "src/a.ts", content: "" })).toBe("write ran");
    expect(await run("write", { path: "D:/elsewhere/a.ts", content: "" })).toMatch(/^Denied: Write outside workspace blocked by rule/);
    ctx.permissions.set(session, { agentMode: "plan" });
    expect(ctx.permissions.modes(session)).toEqual({ permission: "workspace-write", agentMode: "plan", effective: "read-only" });
    expect(await run("bash", { command: "ls" })).toBe("Denied: Pi Desktop is in read-only mode");
    expect(asked).toEqual([]);
    expect(await ctx.systemPrompt.build({ sessionId: session.id, cwd: "D:/repo", model: { provider: "p", model: "m" }, tools: [] })).toContain("PIDesktop mode: Plan.");
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
    expect(rulesFromConfig({})).toEqual({ alwaysConfirmShell: true, blockWriteOutsideWorkspace: true, shellAllowPrefixes: [], toolRules: [] });
    expect(rulesFromConfig({ toolRules: [{ id: "x", enabled: true, toolPattern: "*", action: "allow" } as never, { bogus: true } as never] }).toolRules)
      .toEqual([{ id: "x", enabled: true, toolPattern: "*", action: "allow", commandPrefix: "", pathPrefix: "" }]);
  });
});
