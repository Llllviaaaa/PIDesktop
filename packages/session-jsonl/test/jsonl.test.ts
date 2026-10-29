import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Sessions } from "@pid/session";
import * as sessionJsonl from "../src/index.ts";
import { parseLog } from "../src/index.ts";

let dir = "";
let ctx: Context | undefined;

afterEach(async () => {
  await ctx?.fiber.dispose();
  ctx = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<Context> {
  dir = mkdtempSync(join(tmpdir(), "pid-sessions-"));
  ctx = new Context();
  await ctx.plugin(Sessions);
  await ctx.plugin(sessionJsonl, { dir });
  return ctx;
}

const text = (value: string) => [{ type: "text" as const, text: value }];

describe("JSONL session storage", () => {
  it("writes a header and one line per event, and reads them back", async () => {
    const first = await start();
    const session = first.sessions.create({ cwd: "D:/repo" });
    session.append("user", { content: text("hello") });
    session.append("label", { title: "Hello" });
    await session.flush();

    const file = join(dir, session.header.createdAt.slice(0, 7), `${session.id}.jsonl`);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ format: "pid.session", version: 1, id: session.id, cwd: "D:/repo" });
    expect(lines.slice(1).map((line) => [line.seq, line.type])).toEqual([[1, "user"], [2, "label"]]);
  });

  it("lists and loads sessions written by an earlier process", async () => {
    const writer = await start();
    const session = writer.sessions.create({ cwd: "/w" });
    session.append("user", { content: text("hi") });
    const id = session.id;
    await writer.fiber.dispose();

    const reader = new Context();
    ctx = reader;
    await reader.plugin(Sessions);
    await reader.plugin(sessionJsonl, { dir });
    expect((await reader.sessions.list()).map((summary) => [summary.id, summary.lastSeq])).toEqual([[id, 1]]);
    const loaded = await reader.sessions.get(id);
    expect(loaded?.state().messages).toEqual([{ role: "user", content: text("hi") }]);
    loaded?.append("user", { content: text("again") });
    expect(loaded?.lastSeq).toBe(2);
  });

  it("skips a torn last line and unknown event types", async () => {
    const writer = await start();
    const session = writer.sessions.create({ cwd: "/w" });
    session.append("user", { content: text("kept") });
    const file = join(dir, session.header.createdAt.slice(0, 7), `${session.id}.jsonl`);
    appendFileSync(file, `${JSON.stringify({ seq: 2, ts: "t", type: "future-thing", data: {} })}\n{"seq":3,"ts":"t","ty`);
    const parsed = parseLog(readFileSync(file, "utf8"));
    expect(parsed.events.map((event) => event.seq)).toEqual([1]);
    expect(parsed.skipped).toBe(2);
  });

  it("refuses a newer major version and files that are not sessions", () => {
    expect(() => parseLog(`${JSON.stringify({ format: "pid.session", version: 2, id: "x" })}\n`)).toThrow("newer");
    expect(() => parseLog(`{"hello":1}\n`)).toThrow("not a pid session");
    expect(() => parseLog("")).toThrow("empty");
  });
});
