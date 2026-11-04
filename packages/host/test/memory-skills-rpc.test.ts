import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Commands } from "@pid/commands";
import { ErrorCode } from "@pid/protocol";
import * as promptContext from "@pid/prompt-context";
import { SystemPrompt } from "@pid/system-prompt";
import { RpcGateway, WebServer, createHost, type Host } from "../src/index.ts";
import * as memorySkillsRpc from "../src/memory-skills-rpc.ts";

let host: Host | undefined;
let dir = "";

afterEach(async () => {
  await host?.stop();
  host = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function call<T>(target: Host, method: string, params?: unknown): Promise<T> {
  const handler = (target.ctx.rpc as unknown as { handlers: Map<string, (p: unknown, c: { signal: AbortSignal }) => unknown> }).handlers.get(method);
  if (handler === undefined) throw new Error(`no ${method}`);
  return (await handler(params, { signal: new AbortController().signal })) as T;
}

describe("memory & skills RPC", () => {
  it("manages dual-layer memory and full skill lifecycle with command notifications", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-mem-skills-"));
    const dataDir = join(dir, "data");
    const workspace = join(dir, "workspace");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });

    host = createHost({
      version: "0",
      dataDir,
      plugins: [
        [WebServer, { pageOrigins: [] }],
        [RpcGateway, { token: Buffer.alloc(32, 3).toString("base64url") }],
        [Commands],
        [SystemPrompt],
        [promptContext, { dataDir }],
        [memorySkillsRpc, { dataDir }],
      ],
    });
    await host.start();

    const changedReasons: string[] = [];
    host.ctx.on("commands/changed", (reason) => changedReasons.push(reason));

    // 1. User & project memory get / set / delete
    expect((await call<{ content: string }>(host, "memory.get", { scope: "user" })).content).toBe("");
    await call(host, "memory.set", { scope: "user", content: "# Global\n- Prefer concise output\n" });
    await call(host, "memory.set", { scope: "project", cwd: workspace, content: "# Project\n- Use vitest\n" });

    expect((await call<{ content: string }>(host, "memory.get", { scope: "user" })).content).toContain("Prefer concise output");
    expect((await call<{ content: string }>(host, "memory.get", { scope: "project", cwd: workspace })).content).toContain("Use vitest");
    expect(readFileSync(join(workspace, ".pid", "memory.md"), "utf8")).toContain("Use vitest");

    await call(host, "memory.delete", { scope: "project", cwd: workspace });
    expect(existsSync(join(workspace, ".pid", "memory.md"))).toBe(false);

    // 2. Skill create / read / save / toggle / delete + slash command sync
    const created = await call<{ skill: { name: string; path: string; enabled: boolean } }>(host, "skill.create", {
      scope: "project",
      cwd: workspace,
      name: "fix-ci",
      description: "Diagnose and repair CI failures",
    });
    expect(created.skill).toMatchObject({ name: "fix-ci", enabled: true });
    expect(changedReasons).toContain("skills");

    expect((await host.ctx.commands.list(workspace)).some((cmd) => cmd.name === "skill:fix-ci")).toBe(true);

    const read = await call<{ content: string; description: string }>(host, "skill.read", {
      path: created.skill.path,
      cwd: workspace,
    });
    expect(read.description).toBe("Diagnose and repair CI failures");

    await call(host, "skill.save", {
      path: created.skill.path,
      cwd: workspace,
      content: "---\nname: fix-ci\ndescription: Updated CI workflow\n---\n\nRun tests first.\n",
    });
    expect((await call<{ description: string }>(host, "skill.read", { path: created.skill.path, cwd: workspace })).description).toBe("Updated CI workflow");

    // Disable skill -> omitted from slash commands and system prompt
    await call(host, "skill.toggle", { path: created.skill.path, cwd: workspace, enabled: false });
    expect((await host.ctx.commands.list(workspace)).some((cmd) => cmd.name === "skill:fix-ci")).toBe(false);
    const promptDisabled = await host.ctx.systemPrompt.build({
      sessionId: "s",
      cwd: workspace,
      model: { provider: "p", model: "m" },
      tools: [{ name: "read", description: "", parameters: {} }],
    });
    expect(promptDisabled).not.toContain("fix-ci");

    // Re-enable -> back in slash commands and system prompt
    await call(host, "skill.toggle", { path: created.skill.path, cwd: workspace, enabled: true });
    expect((await host.ctx.commands.list(workspace)).some((cmd) => cmd.name === "skill:fix-ci")).toBe(true);

    // Path confinement rejects traversal outside skill roots
    await expect(
      call(host, "skill.read", { path: join(workspace, "SKILL.md"), cwd: workspace }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });

    // Delete skill
    const afterDelete = await call<{ skills: unknown[] }>(host, "skill.delete", { path: created.skill.path, cwd: workspace });
    expect(afterDelete.skills).toEqual([]);
    expect(existsSync(created.skill.path)).toBe(false);
  });
});
