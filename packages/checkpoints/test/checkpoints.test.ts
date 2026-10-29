import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Sessions } from "@pid/session";
import * as checkpoints from "../src/index.ts";
import { checkpointFor, checkpointsOf, diffCheckpoint, restoreCheckpoint, takeCheckpoint } from "../src/index.ts";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function repo(): string {
  dir = mkdtempSync(join(tmpdir(), "pid-checkpoints-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, windowsHide: true });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
  return dir;
}

describe("checkpoints", () => {
  it("snapshots before a run and restores the files", async () => {
    const cwd = repo();
    const ctx = new Context();
    await ctx.plugin(Sessions);
    const session = ctx.sessions.create({ cwd });
    const user = session.append("user", { content: [{ type: "text", text: "change a.txt" }] });

    const record = await takeCheckpoint(session);
    expect(record?.userSeq).toBe(user.seq);
    expect(await takeCheckpoint(session)).toBeUndefined();
    expect(checkpointsOf(session)).toHaveLength(1);

    writeFileSync(join(cwd, "a.txt"), "two\n");
    writeFileSync(join(cwd, "b.txt"), "new\n");
    const found = checkpointFor(session, user.seq);
    if (found === undefined) throw new Error("no checkpoint");
    expect(await diffCheckpoint(found)).toMatchObject({ changed: true, files: ["a.txt", "b.txt"] });
    await restoreCheckpoint(found);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\n");
    expect((await diffCheckpoint(found)).changed).toBe(false);

    // The ref lives in the repository, under the namespace the Pi engine uses.
    expect(execFileSync("git", ["for-each-ref", "refs/pidesktop/checkpoints"], { cwd, encoding: "utf8" })).toContain(found.checkpoint.ref);
    await ctx.fiber.dispose();
  });

  it("checkpoints on agent/before-start unless the session is read-only", async () => {
    const cwd = repo();
    const ctx = new Context();
    await ctx.plugin(Sessions);
    ctx.provide("agents", {});
    let effective = "ask";
    ctx.provide("permissions", { modes: () => ({ effective }) });
    await ctx.plugin(checkpoints);
    const session = ctx.sessions.create({ cwd });
    session.append("user", { content: [{ type: "text", text: "go" }] });
    effective = "read-only";
    await ctx.serial("agent/before-start", session);
    expect(checkpointsOf(session)).toHaveLength(0);
    effective = "ask";
    await ctx.serial("agent/before-start", session);
    expect(checkpointsOf(session)).toHaveLength(1);
    await ctx.fiber.dispose();
  });

  it("does nothing outside a git repository", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-checkpoints-"));
    const ctx = new Context();
    await ctx.plugin(Sessions);
    const session = ctx.sessions.create({ cwd: dir });
    session.append("user", { content: [{ type: "text", text: "go" }] });
    expect(await takeCheckpoint(session)).toBeUndefined();
    await ctx.fiber.dispose();
  });
});
