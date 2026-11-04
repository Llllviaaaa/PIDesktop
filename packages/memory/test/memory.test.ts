import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Permissions } from "@pid/permissions";
import { Sessions } from "@pid/session";
import { SystemPrompt } from "@pid/system-prompt";
import { Tools } from "@pid/tools";
import { Ui } from "@pid/ui";
import * as memory from "../src/index.ts";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("local memory", () => {
  it("reads, appends, replaces and clears, and shows the memory to the model", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-memory-"));
    const file = join(dir, "nested", "memory.md");
    const ctx = new Context();
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(memory, { file });
    const env = { sessionId: "s", cwd: dir, signal: new AbortController().signal };
    const call = async (args: Record<string, unknown>) => {
      const output = await ctx.tools.execute({ id: "1", name: "desktop_memory", args }, env);
      return output.content[0]?.type === "text" ? output.content[0].text : "";
    };
    const prompt = () => ctx.systemPrompt.build({ sessionId: "s", cwd: dir, model: { provider: "p", model: "m" }, tools: [] });

    expect(await call({ action: "read" })).toBe("Local memory is empty.");
    expect(await prompt()).toBe("");
    await call({ action: "append", content: "Prefers pnpm." });
    await call({ action: "append", content: "Answers in Chinese." });
    expect(readFileSync(file, "utf8")).toBe("Prefers pnpm.\n\nAnswers in Chinese.\n");
    expect(await prompt()).toContain("<memory>\nPrefers pnpm.\n\nAnswers in Chinese.\n</memory>");
    await call({ action: "replace", content: "Only this." });
    expect(await call({ action: "read" })).toBe("Only this.\n");
    expect(await call({ action: "append" })).toBe("desktop_memory failed: content is required for append");
    await call({ action: "clear" });
    expect(readFileSync(file, "utf8")).toBe("");
    await ctx.fiber.dispose();
  });

  it("supports project scope (.pid/memory.md) with independent switches and trust gate", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-memory-proj-"));
    const globalFile = join(dir, "global", "memory.md");
    const workspace = join(dir, "workspace");
    let trusted = true;
    const ctx = new Context();
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(memory, { file: globalFile, userEnabled: true, projectEnabled: true, isTrusted: () => trusted });
    const env = { sessionId: "s", cwd: workspace, signal: new AbortController().signal };
    const call = async (args: Record<string, unknown>) => {
      const output = await ctx.tools.execute({ id: "1", name: "desktop_memory", args }, env);
      return output.content[0]?.type === "text" ? output.content[0].text : "";
    };
    const prompt = () => ctx.systemPrompt.build({ sessionId: "s", cwd: workspace, model: { provider: "p", model: "m" }, tools: [] });

    await call({ action: "append", scope: "user", content: "Global rule." });
    await call({ action: "append", scope: "project", content: "Use vitest for tests." });
    expect(readFileSync(join(workspace, ".pid", "memory.md"), "utf8")).toBe("Use vitest for tests.\n");

    const built = await prompt();
    expect(built).toContain("<memory>\nGlobal rule.\n</memory>");
    expect(built).toContain("<project-memory>\nUse vitest for tests.\n</project-memory>");

    trusted = false;
    const untrustedPrompt = await prompt();
    expect(untrustedPrompt).toContain("<memory>");
    expect(untrustedPrompt).not.toContain("<project-memory>");
    expect(await call({ action: "append", scope: "project", content: "Blocked." })).toContain("not trusted");
    await ctx.fiber.dispose();
  });

  it("requests unified-diff confirmation before writing under ask/workspace-write modes", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-memory-confirm-"));
    const file = join(dir, "memory.md");
    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(Permissions, { defaultPermission: "ask" });
    await ctx.plugin(memory, { file });

    const prompts: Array<{ title: string; message: string }> = [];
    let allow = true;
    ctx.ui.attach({
      request: ({ requestId, request }) => {
        if (request.kind === "confirm") prompts.push({ title: request.title, message: request.message });
        queueMicrotask(() => ctx.ui.respond(requestId, allow));
      },
      cancel: () => {},
      notify: () => {},
    });

    const session = ctx.sessions.create({ cwd: dir });
    const env = { sessionId: session.id, cwd: dir, signal: new AbortController().signal };
    const call = async (args: Record<string, unknown>) => {
      const output = await ctx.tools.execute({ id: "1", name: "desktop_memory", args }, env);
      return output.content[0]?.type === "text" ? output.content[0].text : "";
    };

    expect(await call({ action: "append", content: "Always use TypeScript." })).toBe("Preference added to local memory.");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.title).toBe("更新全局本地记忆？");
    expect(prompts[0]?.message).toContain("```diff");
    expect(prompts[0]?.message).toContain("+Always use TypeScript.");

    allow = false;
    expect(await call({ action: "replace", content: "Overwrite everything." })).toContain("Denied:");
    expect(readFileSync(file, "utf8")).toBe("Always use TypeScript.\n");

    ctx.permissions.set(session, { permission: "full-access" });
    expect(await call({ action: "append", content: "No prompt under full-access." })).toBe("Preference added to local memory.");
    expect(prompts).toHaveLength(2);
    expect(readFileSync(file, "utf8")).toContain("No prompt under full-access.");
    await ctx.fiber.dispose();
  });
});
