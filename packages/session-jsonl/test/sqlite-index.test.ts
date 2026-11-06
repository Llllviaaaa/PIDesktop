import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Sessions, type SessionEvent } from "@pid/session";
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

  it("extracts only active-branch text across chained rewinds and overwritten titles", async () => {
    expect(sessionJsonl.extractSessionSearchBody([])).toBe("");

    dir = mkdtempSync(join(tmpdir(), "pid-sqlite-rewind-"));
    const sessionsDir = join(dir, "sessions");
    const indexFile = join(dir, "index.sqlite");
    ctx = await openContext(sessionsDir, indexFile);

    const s = ctx.sessions.create({ cwd: "D:/repo-branch" });
    const first = s.append("user", { content: text("KeepTurnOne") });
    s.append("label", { title: "SupersededTitleOld" });
    s.append("label", { title: "ActiveTitleCurrent" });
    s.append("user", { content: text("DiscardedTurnTwo") });
    s.append("rewind", { toSeq: 3 });
    s.append("user", { content: text("KeepTurnThree") });
    await s.flush();

    const body = sessionJsonl.extractSessionSearchBody(s.events);
    expect(body).toContain("KeepTurnOne");
    expect(body).toContain("KeepTurnThree");
    expect(body).toContain("ActiveTitleCurrent");
    expect(body).not.toContain("DiscardedTurnTwo");
    expect(body).not.toContain("SupersededTitleOld");
    expect(first.seq).toBe(1);

    expect(await ctx.sessions.search("DiscardedTurnTwo")).toEqual([]);
    expect(await ctx.sessions.search("SupersededTitleOld")).toEqual([]);
    expect((await ctx.sessions.search("KeepTurnThree")).map((h) => h.session.id)).toEqual([s.id]);
    expect((await ctx.sessions.search("ActiveTitleCurrent")).map((h) => h.session.id)).toEqual([s.id]);
  });

  it("preserves activeTitle and valid UTF-16 when active-branch messages exceed 256 KB", () => {
    const padBeforePair = "a".repeat(262_143);
    const pairMessage = `${padBeforePair}𠮷tail`;
    const noTitleEvents: SessionEvent[] = [
      { seq: 1, ts: "t", type: "user", data: { content: text(pairMessage) } },
    ];
    const noTitleBody = sessionJsonl.extractSessionSearchBody(noTitleEvents);
    expect(noTitleBody.length).toBe(262_143);
    expect(Buffer.from(noTitleBody, "utf8").toString("utf8")).toBe(noTitleBody);

    const bigEvents: SessionEvent[] = [
      { seq: 1, ts: "t", type: "label", data: { title: "ImportantCustomTitle77" } },
      { seq: 2, ts: "t", type: "user", data: { content: text("x".repeat(270_000)) } },
    ];
    const withTitleBody = sessionJsonl.extractSessionSearchBody(bigEvents);
    expect(withTitleBody.length).toBeLessThanOrEqual(262_144);
    expect(withTitleBody).toContain("ImportantCustomTitle77");
    expect(Buffer.from(withTitleBody, "utf8").toString("utf8")).toBe(withTitleBody);
  });

  it("purges stale rewound-branch rows when upgrading an existing user_version=2 SQLite index", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-sqlite-v2-upgrade-"));
    const sessionsDir = join(dir, "sessions");
    const indexFile = join(dir, "index.sqlite");

    const writer = await openContext(sessionsDir, indexFile);
    const created = writer.sessions.create({ cwd: "D:/workspace-v2" });
    created.append("user", { content: text("StaleRewoundTokenV2") });
    created.append("rewind", { toSeq: 0 });
    created.append("user", { content: text("CleanActiveTokenV3") });
    await created.flush();
    const sessionId = created.id;
    await writer.fiber.dispose();

    // Poison the existing SQLite index with stale rewound text and downgrade user_version to 2
    // while keeping mtime_ms and size_bytes unchanged so only SCHEMA_VERSION mismatch forces rebuild.
    const rawDb = new DatabaseSync(indexFile);
    rawDb.prepare("UPDATE sessions SET raw_text = ? WHERE id = ?").run("StaleRewoundTokenV2\nCleanActiveTokenV3", sessionId);
    rawDb.prepare("UPDATE sessions_fts SET body = ? WHERE session_id = ?").run("StaleRewoundTokenV2 CleanActiveTokenV3", sessionId);
    rawDb.exec("PRAGMA user_version = 2;");
    rawDb.close();

    ctx = await openContext(sessionsDir, indexFile);
    expect(await ctx.sessions.search("StaleRewoundTokenV2")).toEqual([]);
    expect((await ctx.sessions.search("CleanActiveTokenV3")).map((h) => h.session.id)).toEqual([sessionId]);
  });
});
