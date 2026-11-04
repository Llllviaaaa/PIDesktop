import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Sessions } from "@pid/session";
import * as sessionJsonl from "../src/index.ts";

let dir = "";
let ctx: Context | undefined;

afterEach(async () => {
  await ctx?.fiber.dispose();
  ctx = undefined;
  if (dir !== "") {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

const text = (value: string) => [{ type: "text" as const, text: value }];

async function openContext(sessionsDir: string, indexFile: string): Promise<Context> {
  const instance = new Context();
  await instance.plugin(Sessions);
  await instance.plugin(sessionJsonl, { dir: sessionsDir, indexFile });
  return instance;
}

describe("SQLite FTS5 derived session index", () => {
  it("indexes CJK and code identifiers, updates incrementally, and filters archived sessions", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-sqlite-idx-"));
    const sessionsDir = join(dir, "sessions");
    const indexFile = join(dir, "index.sqlite");
    ctx = await openContext(sessionsDir, indexFile);

    const authSession = ctx.sessions.create({ cwd: "D:/repo-alpha" });
    expect(existsSync(indexFile)).toBe(true);
    authSession.append("user", { content: text("请排查登录按钮点击后 OAuth2 回调失败的问题") });
    authSession.append("assistant", {
      content: text("问题出在 validatePkceVerifier 校验函数漏掉了尾部换行清理。"),
      model: { provider: "scripted", model: "m" },
      stop: "stop",
      usage: { inputTokens: 12, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    await authSession.flush();

    const dbSession = ctx.sessions.create({ cwd: "D:/repo-beta" });
    dbSession.append("user", { content: text("优化 SQLite WAL 写入性能") });
    await dbSession.flush();

    // CJK phrase search across message body
    const cjkHits = await ctx.sessions.search("登录按钮");
    expect(cjkHits.map((hit) => hit.session.id)).toEqual([authSession.id]);
    expect(cjkHits[0]?.snippet).toContain("登录按钮");

    // Prefix code-identifier search inside assistant reply
    const codeHits = await ctx.sessions.search("validatePkce");
    expect(codeHits.map((hit) => hit.session.id)).toEqual([authSession.id]);
    expect(codeHits[0]?.snippet).toContain("validatePkceVerifier");

    // Workspace-scoped filter
    expect(await ctx.sessions.search("validatePkce", { cwd: "D:/repo-beta" })).toEqual([]);
    expect((await ctx.sessions.search("validatePkce", { cwd: "D:/repo-alpha" })).length).toBe(1);

    // Archive hides session by default unless includeArchived is set
    authSession.append("label", { archived: true });
    await authSession.flush();
    expect(await ctx.sessions.search("validatePkce")).toEqual([]);
    expect((await ctx.sessions.search("validatePkce", { includeArchived: true })).map((hit) => hit.session.id)).toEqual([
      authSession.id,
    ]);

    // Delete removes session from both JSONL and SQLite index
    expect(await ctx.sessions.delete(dbSession.id)).toBe(true);
    expect(await ctx.sessions.search("SQLite")).toEqual([]);
  });

  it("rebuilds automatically from JSONL files when index.sqlite is deleted or corrupted", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-sqlite-rebuild-"));
    const sessionsDir = join(dir, "sessions");
    const indexFile = join(dir, "index.sqlite");

    const writer = await openContext(sessionsDir, indexFile);
    const created = writer.sessions.create({ cwd: "D:/workspace" });
    created.append("user", { content: text("跨进程持久化全文检索重建验证关键字 Xylophone99") });
    await created.flush();
    const sessionId = created.id;
    await writer.fiber.dispose();

    // Corrupt index.sqlite on disk and verify automatic self-healing rebuild
    writeFileSync(indexFile, "not-a-valid-sqlite-database");

    ctx = await openContext(sessionsDir, indexFile);
    const listed = await ctx.sessions.list();
    expect(listed.map((item) => item.id)).toEqual([sessionId]);

    const hits = await ctx.sessions.search("Xylophone99");
    expect(hits.map((hit) => hit.session.id)).toEqual([sessionId]);
    expect(hits[0]?.snippet).toContain("Xylophone99");
  });
});
