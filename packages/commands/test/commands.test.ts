import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import * as browser from "@pid/browser";
import { Commands, parseSlashCommand } from "../src/index.ts";
import * as plan from "@pid/plan";
import * as promptContext from "@pid/prompt-context";
import { Sessions } from "@pid/session";
import { SystemPrompt } from "@pid/system-prompt";
import { Tools } from "@pid/tools";
import { Ui } from "@pid/ui";

let tempDir = "";
let ctx: Context | undefined;

afterEach(async () => {
  await ctx?.fiber.dispose();
  ctx = undefined;
  if (tempDir !== "") {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("@pid/commands service", () => {
  it("parses leading slash commands and arguments", () => {
    expect(parseSlashCommand("hello /plan")).toBeUndefined();
    expect(parseSlashCommand("/doctor")).toEqual({ name: "doctor", rawArgs: "" });
    expect(parseSlashCommand("  /plan   clear  ")).toEqual({ name: "plan", rawArgs: "clear" });
    expect(parseSlashCommand("/skill:audit-auth src/auth.ts\ncheck tokens")).toEqual({
      name: "skill:audit-auth",
      rawArgs: "src/auth.ts\ncheck tokens",
    });
  });

  it("registers static and provider commands, cleans up on dispose, and emits commands/changed", async () => {
    ctx = new Context();
    await ctx.plugin(Commands);

    const reasons: string[] = [];
    ctx.on("commands/changed", (reason) => reasons.push(reason));

    const stopProvider = ctx.commands.registerProvider((cwd) => [
      {
        name: "workspace-info",
        description: "Show workspace path",
        source: "plugin",
        execute: () => ({ output: `cwd=${cwd ?? ""}` }),
      },
    ]);
    const stopStatic = ctx.commands.register({
      name: "/echo",
      description: "Echo input",
      argsHint: "<text>",
      source: "plugin",
      execute: (rawArgs) => ({ output: `echo:${rawArgs}` }),
    });

    expect((await ctx.commands.list("/repo")).map((item) => item.name)).toEqual(["echo", "workspace-info"]);
    expect(await ctx.commands.run("echo", "hello", { cwd: "/repo", signal: new AbortController().signal })).toEqual({
      handled: true,
      output: "echo:hello",
    });
    expect(await ctx.commands.run("workspace-info", "", { cwd: "/repo", signal: new AbortController().signal })).toEqual({
      handled: true,
      output: "cwd=/repo",
    });

    stopStatic();
    stopProvider();
    expect(await ctx.commands.list("/repo")).toEqual([]);
    expect(reasons).toEqual(["provider:add", "register:echo", "unregister:echo", "provider:remove"]);
  });

  it("wires /plan, /browser-diagnose, and dynamic /skill:<name> commands", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "pid-commands-"));
    const skillDir = join(tempDir, "skills", "fix-ci");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: fix-ci\ndescription: Diagnose and repair failing CI workflows\n---\nAlways inspect workflow logs before editing.\n",
    );

    ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(Commands);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(plan);
    await ctx.plugin(browser, { headless: true });
    await ctx.plugin(promptContext, { dataDir: tempDir, contextFiles: false });

    const listed = await ctx.commands.list(tempDir);
    expect(listed.map((item) => item.name)).toContain("plan");
    expect(listed.map((item) => item.name)).toContain("browser-diagnose");
    expect(listed.map((item) => item.name)).toContain("skill:fix-ci");

    const session = ctx.sessions.create({ cwd: tempDir });
    await ctx.tools.execute(
      {
        id: "call-1",
        name: "update_plan",
        args: {
          explanation: "Ship M2",
          items: [{ id: "1", text: "Wire commands", status: "in_progress" }],
        },
      },
      { sessionId: session.id, cwd: tempDir, signal: new AbortController().signal },
    );

    const shown = await ctx.commands.run("plan", "", {
      sessionId: session.id,
      cwd: tempDir,
      signal: new AbortController().signal,
    });
    expect(shown.handled).toBe(true);
    expect(shown.output).toContain("Ship M2");
    expect(shown.output).toContain("Wire commands");

    const cleared = await ctx.commands.run("plan", "clear", {
      sessionId: session.id,
      cwd: tempDir,
      signal: new AbortController().signal,
    });
    expect(cleared.output).toContain("已清空");

    const skillRun = await ctx.commands.run("skill:fix-ci", "check build.yml", {
      sessionId: session.id,
      cwd: tempDir,
      signal: new AbortController().signal,
    });
    expect(skillRun.handled).toBe(true);
    expect(skillRun.prompt).toContain("SKILL.md");
    expect(skillRun.prompt).toContain("fix-ci");
    expect(skillRun.prompt).toContain("check build.yml");
  });
});
