import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { SystemPrompt } from "@pid/system-prompt";
import * as promptContext from "../src/index.ts";
import { GUIDELINES, IDENTITY, contextFiles, findSkills, readFrontMatter } from "../src/index.ts";

let root = "";
afterEach(() => rmSync(root, { recursive: true, force: true }));

function layout() {
  root = mkdtempSync(join(tmpdir(), "pid-prompt-"));
  const dataDir = join(root, "data");
  const repo = join(root, "repo");
  const pkg = join(repo, "pkg");
  mkdirSync(join(dataDir, "skills", "deploy"), { recursive: true });
  mkdirSync(join(pkg, ".pid", "skills", "deploy"), { recursive: true });
  mkdirSync(join(pkg, ".pid", "skills", "nodesc"), { recursive: true });
  writeFileSync(join(dataDir, "AGENTS.md"), "global rules");
  writeFileSync(join(repo, "AGENTS.md"), "repo rules");
  writeFileSync(join(repo, "CLAUDE.md"), "ignored next to AGENTS.md");
  writeFileSync(join(pkg, "CLAUDE.md"), "package rules");
  writeFileSync(join(dataDir, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: global deploy\n---\nbody");
  writeFileSync(join(pkg, ".pid", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: \"project deploy\"\n---\nbody");
  writeFileSync(join(pkg, ".pid", "skills", "nodesc", "SKILL.md"), "no front matter");
  return { dataDir, repo, pkg };
}

describe("context files and skills", () => {
  it("collects one context file per directory, global first", () => {
    const { dataDir, repo, pkg } = layout();
    expect(contextFiles(dataDir, pkg)).toEqual([join(dataDir, "AGENTS.md"), join(repo, "AGENTS.md"), join(pkg, "CLAUDE.md")]);
  });

  it("lets a project skill replace a global one and skips skills without a description", () => {
    const { dataDir, pkg } = layout();
    expect(findSkills([join(dataDir, "skills"), join(pkg, ".pid", "skills")])).toEqual([
      { name: "deploy", description: "project deploy", path: join(pkg, ".pid", "skills", "deploy", "SKILL.md") },
    ]);
    expect(readFrontMatter("---\r\nname: x\r\ndescription: y: z\r\n---")).toEqual({ name: "x", description: "y: z" });
  });

  it("builds the sections in order", async () => {
    const { dataDir, pkg } = layout();
    const ctx = new Context();
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(promptContext, { dataDir, now: () => new Date("2026-10-29T12:00:00Z") });
    ctx.systemPrompt.section("late", () => "LATE", { order: 1000 });
    ctx.systemPrompt.section("broken", () => {
      throw new Error("nope");
    });
    const prompt = await ctx.systemPrompt.build({ sessionId: "s", cwd: pkg, model: { provider: "p", model: "m" }, tools: [{ name: "read", description: "", parameters: {} }] });
    const order = [IDENTITY, GUIDELINES, "global rules", "repo rules", "package rules", "project deploy", `- Working directory: ${pkg}`, "- Date: 2026-10-29", "LATE"];
    const positions = order.map((part) => prompt.indexOf(part));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(prompt).not.toContain("ignored next to AGENTS.md");

    const withoutRead = await ctx.systemPrompt.build({ sessionId: "s", cwd: pkg, model: { provider: "p", model: "m" }, tools: [] });
    expect(withoutRead).not.toContain("<skills>");
    await ctx.fiber.dispose();
  });
});
