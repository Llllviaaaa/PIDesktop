import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Sessions } from "@pid/session";
import * as sessionJsonl from "@pid/session-jsonl";
import * as sessionSearchFts from "../src/index.ts";

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

describe("@pid/session-search-fts", () => {
  it("indexes appended events asynchronously without blocking append, flushes before search, and falls back cleanly when unmounted", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-fts-plugin-"));
    const sessionsDir = join(dir, "sessions");
    const indexFile = join(dir, "sessions-index.sqlite");

    ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(sessionJsonl, { dir: sessionsDir });
    const ftsFiber = ctx.plugin(sessionSearchFts, { sessionsDir, indexFile, debounceMs: 500 });
    await ftsFiber;
    expect(ctx.sessionSearch).toBeDefined();
    expect(existsSync(indexFile)).toBe(true);

    const session = ctx.sessions.create({ cwd: "D:/project-one" });
    session.append("user", { content: text("异步全文索引插件改造验证 QuantumTokenizer42") });

    // Even with a 500ms background debounce, immediate search flushes dirty state and finds the hit deterministically!
    const hits = await ctx.sessions.search("QuantumTokenizer42");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.session.id).toBe(session.id);
    expect(hits[0]?.snippet).toContain("QuantumTokenizer42");

    // Unmounting `session-search-fts` leaves `session-jsonl` and fallback search working without data loss.
    await ftsFiber.dispose();
    session.append("user", { content: text("卸载全文索引插件后仍可正常检索 FallbackPhrase88") });
    const fallbackHits = await ctx.sessions.search("FallbackPhrase88");
    expect(fallbackHits).toHaveLength(1);
    expect(fallbackHits[0]?.session.id).toBe(session.id);
  });

  it("excludes discarded branch messages, compactions, labels, and rewound first messages after rewind", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-fts-rewind-"));
    const sessionsDir = join(dir, "sessions");
    const indexFile = join(dir, "sessions-index.sqlite");

    ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(sessionJsonl, { dir: sessionsDir });
    await ctx.plugin(sessionSearchFts, { sessionsDir, indexFile, debounceMs: 500 });

    const session = ctx.sessions.create({ cwd: "D:/project-rewind" });
    const keptUser = session.append("user", { content: text("保留分支首条提问 KeptRootAnchor11") });
    const keptAssistant = session.append("assistant", {
      content: text("保留分支回复 KeptReplyAnchor22"),
      model: { provider: "scripted", model: "m" },
      stop: "stop",
      usage: { inputTokens: 4, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(keptUser.seq).toBe(1);
    expect(keptAssistant.seq).toBe(2);

    // Append turns, compaction, and label that will be discarded by rewind (including a distinct model on the discarded branch)
    session.append("user", { content: text("走错方向的提问 AbandonedUserToken33 ::raw-sym??") });
    session.append("assistant", {
      content: text("走错方向的回复 AbandonedAssistantToken44"),
      model: { provider: "discarded-provider", model: "AbandonedModel99" },
      stop: "stop",
      usage: { inputTokens: 5, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    session.append("compaction", { throughSeq: 4, summary: "废弃分支压缩摘要 AbandonedCompaction55" });
    session.append("label", { title: "废弃标题 AbandonedLabel66" });

    // Sanity check: before rewind, the branch terms are indexed and searchable
    expect((await ctx.sessions.search("AbandonedUserToken33")).map((h) => h.session.id)).toEqual([session.id]);
    expect((await ctx.sessions.search("AbandonedAssistantToken44")).map((h) => h.session.id)).toEqual([session.id]);
    expect((await ctx.sessions.search("AbandonedCompaction55")).map((h) => h.session.id)).toEqual([session.id]);
    expect((await ctx.sessions.search("AbandonedLabel66")).map((h) => h.session.id)).toEqual([session.id]);

    // Rewind back to seq 2 and continue on a new active branch
    session.append("rewind", { toSeq: keptAssistant.seq, reason: "retry from turn 1" });
    session.append("user", { content: text("新分支继续提问 ReplacementBranchToken77") });
    await session.flush();

    // Discarded branch tokens, rewound modelUsage names, and JSON schema keys must not hit via FTS5 or LIKE fallback
    expect(await ctx.sessions.search("AbandonedUserToken33")).toEqual([]);
    expect(await ctx.sessions.search("走错方向")).toEqual([]);
    expect(await ctx.sessions.search("AbandonedAssistantToken44")).toEqual([]);
    expect(await ctx.sessions.search("AbandonedCompaction55")).toEqual([]);
    expect(await ctx.sessions.search("AbandonedLabel66")).toEqual([]);
    expect(await ctx.sessions.search("::raw-sym??")).toEqual([]);
    expect(await ctx.sessions.search("AbandonedModel99")).toEqual([]);
    expect(await ctx.sessions.search("discarded-provider")).toEqual([]);
    expect(await ctx.sessions.search("inputTokens")).toEqual([]);

    // Kept root branch and new replacement branch must hit cleanly
    expect((await ctx.sessions.search("KeptRootAnchor11")).map((h) => h.session.id)).toEqual([session.id]);
    expect((await ctx.sessions.search("KeptReplyAnchor22")).map((h) => h.session.id)).toEqual([session.id]);
    expect((await ctx.sessions.search("ReplacementBranchToken77")).map((h) => h.session.id)).toEqual([session.id]);

    // Rewinding all the way to seq 0 (editing the very first message) also purges the initial prompt from title/body
    session.append("rewind", { toSeq: 0, reason: "edit first message" });
    session.append("user", { content: text("全新首条提问 FreshRootPrompt99") });
    session.append("assistant", {
      content: text("压缩前仍留在活动分支的回复 PreCompactionActiveReply88"),
      model: { provider: "scripted", model: "m" },
      stop: "stop",
      usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    session.append("compaction", { throughSeq: session.lastSeq, summary: "活动分支压缩摘要 ActiveCompactionSummary66" });
    session.append("user", { content: text("压缩后继续提问 PostCompactionPrompt55") });
    await session.flush();

    expect(await ctx.sessions.search("KeptRootAnchor11")).toEqual([]);
    expect(await ctx.sessions.search("KeptReplyAnchor22")).toEqual([]);
    expect(await ctx.sessions.search("ReplacementBranchToken77")).toEqual([]);
    expect((await ctx.sessions.search("FreshRootPrompt99")).map((h) => h.session.id)).toEqual([session.id]);
    expect((await ctx.sessions.search("PreCompactionActiveReply88")).map((h) => h.session.id)).toEqual([session.id]);
    expect((await ctx.sessions.search("ActiveCompactionSummary66")).map((h) => h.session.id)).toEqual([session.id]);

    // Cold reopen from disk preserves active-branch-only FTS behavior (and fallback parity when FTS is unmounted)
    const sessionId = session.id;
    await ctx.fiber.dispose();
    ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(sessionJsonl, { dir: sessionsDir });
    const reopenedFts = ctx.plugin(sessionSearchFts, { sessionsDir, indexFile, debounceMs: 500 });
    await reopenedFts;

    expect(await ctx.sessions.search("AbandonedUserToken33")).toEqual([]);
    expect(await ctx.sessions.search("AbandonedModel99")).toEqual([]);
    expect(await ctx.sessions.search("KeptRootAnchor11")).toEqual([]);
    expect((await ctx.sessions.search("FreshRootPrompt99")).map((h) => h.session.id)).toEqual([sessionId]);

    await reopenedFts.dispose();
    expect(await ctx.sessions.search("AbandonedUserToken33")).toEqual([]);
    expect(await ctx.sessions.search("conversation so far was compacted")).toEqual([]);
    expect((await ctx.sessions.search("PreCompactionActiveReply88")).map((h) => h.session.id)).toEqual([sessionId]);
    expect((await ctx.sessions.search("ActiveCompactionSummary66")).map((h) => h.session.id)).toEqual([sessionId]);
  });
});
