/**
 * P6b: Pi's sessions converted into this host's events, checked against
 * sessions Pi itself wrote (fixtures/pi-sessions, scripts/record-pi-session-samples.mjs).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentBranch, deriveState } from "@pid/session";
import { convertPiSession, piSessionFiles } from "../src/pi-sessions.ts";

const sample = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "pi-sessions", `${name}.jsonl`), "utf8");
let dir = "";
afterEach(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("Pi session conversion", () => {
  it("carries messages, tool calls, thinking, the model, the effort and the name", () => {
    const converted = convertPiSession(sample("tools"));
    expect(converted).toMatchObject({ id: "00000000-0000-4000-8000-000000000005", cwd: "C:\\work\\demo" });
    expect(converted.events.map((event) => event.type)).toEqual(["model", "effort", "user", "assistant", "tool-call", "tool-result", "assistant", "label"]);
    expect(converted.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const [model, effort, user, called, call, result, answer, label] = converted.events;
    expect(model?.data).toEqual({ provider: "deepseek", model: "deepseek-chat" });
    expect(effort?.data).toEqual({ effort: "high" });
    expect(user?.data).toEqual({ content: [{ type: "text", text: "List the files" }] });
    expect(called?.data).toMatchObject({
      content: [
        { type: "thinking", text: "I should run ls.", signature: "sig-1" },
        { type: "text", text: "Looking." },
        { type: "tool-call", id: "call_1", name: "bash", arguments: { command: "ls" } },
      ],
      stop: "tool-use",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 0 },
    });
    expect(call?.data).toEqual({ callId: "call_1", name: "bash", args: { command: "ls" } });
    expect(result?.data).toEqual({ callId: "call_1", name: "bash", content: [{ type: "text", text: "a.txt\nb.txt" }], isError: false });
    expect(answer?.data).toMatchObject({ stop: "stop" });
    expect(label?.data).toEqual({ title: "List files" });
    expect(converted.skipped).toEqual({ label: 1 });
  });

  it("takes the branch the session ended on and keeps a failed reply's error", () => {
    const converted = convertPiSession(sample("branched"));
    const texts = converted.events.flatMap((event) => (event.type === "user" || event.type === "assistant" ? event.data.content.flatMap((block) => (block.type === "text" ? [block.text] : [])) : []));
    expect(texts).toEqual(["First question", "First answer", "Second question", "Second answer"]);
    expect(converted.events.at(-1)?.data).toMatchObject({ stop: "error", error: { message: "rate limited" } });
  });

  it("keeps a compaction's summary and what it kept, an image and a command run", () => {
    const converted = convertPiSession(sample("compacted"));
    const compaction = converted.events.find((event) => event.type === "compaction");
    const kept = converted.events.find((event) => event.type === "user" && event.data.content.some((block) => block.type === "image"));
    expect(compaction?.data).toEqual({ throughSeq: (kept?.seq ?? 0) - 1, summary: "The user asked an old question." });
    expect(kept?.data).toEqual({ content: [{ type: "text", text: "Look at this" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }] });
    expect(converted.events.some((event) => event.type === "user" && JSON.stringify(event.data).includes("Ran `git status`"))).toBe(true);
    expect(converted.skipped).toEqual({ custom_message: 1 });
    expect(converted.events.at(-1)?.data).toMatchObject({ stop: "length" });

    // What the model sees from it: the summary, then the kept turn onwards.
    const state = deriveState(currentBranch(converted.events));
    expect(state.messages[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(state.messages[0])).toContain("The user asked an old question.");
    expect(JSON.stringify(state.messages)).not.toContain("Old answer");
  });

  it("refuses a file that is not a Pi session", () => {
    expect(() => convertPiSession('{"type":"other"}\n')).toThrow("not a Pi session file");
    expect(() => convertPiSession("not json")).toThrow();
  });

  it("finds session files the way Pi's list does, skipping its trash", () => {
    dir = mkdtempSync(join(tmpdir(), "pid-pi-sessions-"));
    mkdirSync(join(dir, "--C--work--"), { recursive: true });
    mkdirSync(join(dir, ".trash"), { recursive: true });
    writeFileSync(join(dir, "--C--work--", "a.jsonl"), "");
    writeFileSync(join(dir, ".trash", "b.jsonl"), "");
    writeFileSync(join(dir, "notes.txt"), "");
    expect(piSessionFiles(dir)).toEqual([join(dir, "--C--work--", "a.jsonl")]);
    expect(piSessionFiles(join(dir, "missing"))).toEqual([]);
  });
});
