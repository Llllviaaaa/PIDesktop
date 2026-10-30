// The frontend's harness adapter (src/lib/harnessRuntime.ts) against a real
// Harness Host in this process: the store's Pi commands and events over the
// real WebSocket client, with a scripted model.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop } from "@pid/agent-loop";
import * as checkpoints from "@pid/checkpoints";
import { LlmService } from "@pid/llm";
import { Permissions } from "@pid/permissions";
import * as plan from "@pid/plan";
import { Sessions } from "@pid/session";
import { SystemPrompt } from "@pid/system-prompt";
import { ScriptedProvider, textReply, toolReply, useScriptedProvider } from "@pid/testkit";
import * as toolFs from "@pid/tool-fs";
import { Tools } from "@pid/tools";
import { Ui } from "@pid/ui";
import { RpcGateway, WebServer, createHost, type Host } from "../packages/host/src/index";
import * as featuresRpc from "../packages/host/src/features-rpc";
import * as sessionsRpc from "../packages/host/src/sessions-rpc";
import * as uiRpc from "../packages/host/src/ui-rpc";
import { Mcp } from "@pid/mcp";
import { Schedule } from "@pid/schedule";
import * as scheduleRpc from "../packages/host/src/schedule-rpc";
import { runFromHost, taskFromHost, taskToHost } from "../src/lib/scheduleClient";
import type { ScheduledRunInfo } from "@pid/protocol";
import { connectHarness } from "../src/lib/harnessClient";
import { HarnessRuntimes } from "../src/lib/harnessRuntime";
import { sessionInfoFromHost } from "../src/lib/hostSessions";
import { historyToUi, type TranscriptEvent } from "../src/lib/transcript";
import type { ExtensionUIRequest } from "../src/types";

const token = Buffer.alloc(32, 3).toString("base64url");
let host: Host | undefined;
let dir = "";

afterEach(async () => {
  await host?.stop();
  host = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function start(provider: ScriptedProvider) {
  dir = mkdtempSync(join(tmpdir(), "pid-harness-runtime-"));
  writeFileSync(join(dir, "a.txt"), "hello\n");
  // A git repository, so runs take workspace checkpoints to rewind to.
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, windowsHide: true });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
  host = createHost({
    version: "0",
    dataDir: dir,
    plugins: [
      [WebServer, { pageOrigins: [] }],
      [RpcGateway, { token }],
      [LlmService, { maxAttempts: 1 }],
      [Sessions],
      [Ui],
      [Tools],
      [SystemPrompt],
      [Permissions, {}],
      [toolFs],
      [plan],
      [AgentLoop],
      [checkpoints],
      [Mcp, {}],
      [Schedule, { tasksFile: join(dir, "schedules.json"), runsFile: join(dir, "schedule-runs.jsonl"), defaultModel: { provider: "scripted", model: "m" }, tickMs: 60_000 }],
      [scheduleRpc],
      [sessionsRpc, { defaultModel: { provider: "scripted", model: "m" } }],
      [uiRpc],
      [featuresRpc],
      [{ name: "scripted", inject: ["llm"], apply: (ctx: never) => useScriptedProvider(ctx, provider) }],
    ],
  });
  await host.start();
  const port = await host.ctx.webServer.listen(0);
  const runtimes = new HarnessRuntimes(() => connectHarness({ baseUrl: `http://127.0.0.1:${port}/`, token }, { name: "test", version: "1" }));
  const events: Array<[string, TranscriptEvent]> = [];
  const waiters: Array<() => void> = [];
  runtimes.subscribe((runtimeId, event) => {
    events.push([runtimeId, event]);
    for (const waiter of waiters.splice(0)) waiter();
  });
  const until = async (match: (event: TranscriptEvent) => boolean): Promise<TranscriptEvent> => {
    for (;;) {
      const found = events.find(([, event]) => match(event));
      if (found !== undefined) return found[1];
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  /** The next dialog the Host (or the runtime itself) asks for. */
  const nextQuestion = async (title?: string): Promise<ExtensionUIRequest> => {
    const found = await until((event) => event.type === "ui-request" && event.request.method === "confirm" && (title === undefined || event.request.title === title));
    return (found as Extract<TranscriptEvent, { type: "ui-request" }>).request;
  };
  return { runtimes, events, until, nextQuestion };
}

describe("harness runtimes", () => {
  it("run a task the way the store drives a Pi runtime", async () => {
    const provider = new ScriptedProvider([
      toolReply([{ id: "c1", name: "read", args: { path: "a.txt" } }]),
      toolReply([{ id: "c2", name: "write", args: { path: "b.txt", content: "made" } }]),
      textReply("Done."),
    ]);
    const { runtimes, events, until, nextQuestion } = await start(provider);
    const { runtimeId } = await runtimes.start(dir);

    // Nothing is created until the first prompt: a prewarmed workspace leaves no session.
    expect(await runtimes.state(runtimeId)).toMatchObject({ isStreaming: false });
    expect(await runtimes.messages(runtimeId)).toEqual([]);
    expect(await runtimes.setModel(runtimeId, "scripted", "m")).toMatchObject({ provider: "scripted", id: "m" });
    expect((await runtimes.state(runtimeId)).model).toMatchObject({ provider: "scripted", id: "m" });
    await runtimes.setThinkingLevel(runtimeId, "high");

    await runtimes.prompt(runtimeId, { message: "Copy a.txt", images: [] });
    // The write needs confirmation: answer it as the extension dialog would.
    const request = await nextQuestion();
    expect(request).toMatchObject({ method: "confirm", title: "Allow file change?" });
    await runtimes.respond(request, { confirmed: true });
    await until((event) => event.type === "turn-end");

    const kinds = events.map(([, event]) => event.type);
    expect(kinds.slice(0, 3)).toEqual(["user", "turn-start", "assistant-start"]);
    expect(kinds.filter((kind) => kind === "tool-end")).toHaveLength(2);
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("made");
    expect(provider.requests[0]?.effort).toBe("high");

    const state = await runtimes.state(runtimeId);
    expect(state).toMatchObject({ isStreaming: false, thinkingLevel: "high", model: { provider: "scripted", id: "m" } });
    expect(String(state?.sessionFile)).toMatch(/^harness:/);
    const history = await runtimes.messages(runtimeId);
    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
    expect(history.flatMap((message) => message.toolCalls ?? []).every((call) => !call.running && call.isError === false)).toBe(true);
    expect(await runtimes.stats(runtimeId)).toMatchObject({ totalMessages: 4, tokens: { input: 30, output: 15 } });

    // Reopening the session from its sessionFile shows the same history.
    const reopened = await runtimes.start(dir, String(state?.sessionFile));
    expect(await runtimes.messages(reopened.runtimeId)).toHaveLength(4);

    // The sidebar's view of it: listed with its first message, history readable without a runtime.
    const sessionId = String(state?.sessionId);
    const listed = await runtimes.listSessions();
    expect(listed.map((session) => [session.id, session.firstMessage])).toEqual([[sessionId, "Copy a.txt"]]);
    expect(sessionInfoFromHost(listed[0] as never)).toMatchObject({ file: `harness:${sessionId}`, cwd: dir, firstMessage: "Copy a.txt", messageCount: 4 });
    const logged = await runtimes.readEvents(sessionId);
    expect(historyToUi(logged).map((message) => message.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
  });

  it("switch modes and refuse a runtime that has stopped", async () => {
    const { runtimes } = await start(new ScriptedProvider([]));
    const { runtimeId } = await runtimes.start(dir);
    await runtimes.setPermission(runtimeId, { agentMode: "plan" });
    const sessionId = String((await runtimes.state(runtimeId)).sessionId);
    const session = await host?.ctx.sessions.get(sessionId);
    expect(session === undefined ? undefined : host?.ctx.permissions.modes(session).agentMode).toBe("plan");
    expect(runtimes.thinkingLevels()).toEqual(["off", "low", "medium", "high"]);
    await runtimes.stop(runtimeId);
    await expect(runtimes.state(runtimeId)).rejects.toThrow("Harness 任务已结束");
  });
});

describe("rewinding and forking", () => {
  it("rewind a message and its file changes, fork, clone and show the tree", async () => {
    const provider = new ScriptedProvider([
      toolReply([{ id: "c1", name: "write", args: { path: "b.txt", content: "made" } }]),
      textReply("Wrote it."),
      textReply("Second answer."),
    ]);
    const { runtimes, events, until, nextQuestion } = await start(provider);
    const { runtimeId } = await runtimes.start(dir);
    await runtimes.setPermission(runtimeId, { permission: "full-access" });
    await runtimes.prompt(runtimeId, { message: "Make b.txt", images: [] });
    await until((event) => event.type === "turn-end");
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("made");

    const points = await runtimes.forkPoints(runtimeId);
    expect(points.map((point) => point.text)).toEqual(["Make b.txt"]);

    // Rewinding asks before putting the files back, through the same dialog as Host questions.
    const rewinding = runtimes.rewind(runtimeId, String(points[0]?.entryId));
    const question = await nextQuestion("回退消息和工作区？");
    expect(question).toMatchObject({ message: expect.stringContaining("1 个文件将恢复") });
    await runtimes.respond(question, { confirmed: true });
    expect(await rewinding).toBe(true);
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
    expect(await runtimes.messages(runtimeId)).toEqual([]);

    // The rewound turn stays in the tree as a side branch.
    events.length = 0;
    await runtimes.prompt(runtimeId, { message: "Just answer", images: [] });
    await until((event) => event.type === "turn-end");
    const tree = await runtimes.tree(runtimeId);
    expect(tree.tree).toHaveLength(2);
    const before = String((await runtimes.state(runtimeId)).sessionId);

    // Forking from the leaf (an assistant reply) keeps it; cloning copies everything.
    await runtimes.fork(runtimeId, String(tree.leafId));
    const forked = await runtimes.state(runtimeId);
    expect(forked?.sessionId).not.toBe(before);
    expect((await runtimes.messages(runtimeId)).map((message) => message.role)).toEqual(["user", "assistant"]);
    await runtimes.clone(runtimeId);
    expect((await runtimes.state(runtimeId)).sessionId).not.toBe(forked.sessionId);

    // A new session starts empty and is created on its first prompt.
    runtimes.newSession(runtimeId);
    expect((await runtimes.state(runtimeId)).sessionId).toBeUndefined();
  });

  it("cancel a rewind the user declines", async () => {
    const provider = new ScriptedProvider([toolReply([{ id: "c1", name: "write", args: { path: "b.txt", content: "made" } }]), textReply("Done.")]);
    const { runtimes, until, nextQuestion } = await start(provider);
    const { runtimeId } = await runtimes.start(dir);
    await runtimes.setPermission(runtimeId, { permission: "full-access" });
    await runtimes.prompt(runtimeId, { message: "Make b.txt", images: [] });
    await until((event) => event.type === "turn-end");
    const points = await runtimes.forkPoints(runtimeId);
    const rewinding = runtimes.rewind(runtimeId, String(points[0]?.entryId));
    const question = await nextQuestion();
    await runtimes.respond(question, { confirmed: false });
    expect(await rewinding).toBe(false);
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("made");
    expect((await runtimes.messages(runtimeId)).length).toBeGreaterThan(0);
  });
});

describe("side chats", () => {
  it("run on a hidden fork of the conversation that goes when the side chat stops", async () => {
    const { runtimes, events, until } = await start(new ScriptedProvider([textReply("Main answer."), textReply("Side answer.")]));
    const main = await runtimes.start(dir);
    await runtimes.prompt(main.runtimeId, { message: "Main question", images: [] });
    await until((event) => event.type === "turn-end");
    const parentFile = String((await runtimes.state(main.runtimeId)).sessionFile);

    const side = await runtimes.start(dir, parentFile, true);
    expect(side.sessionForked).toBe(true);
    const sideFile = String((await runtimes.state(side.runtimeId)).sessionFile);
    expect(sideFile).not.toBe(parentFile);
    expect((await runtimes.messages(side.runtimeId)).map((message) => message.role)).toEqual(["user", "assistant"]);
    events.length = 0;
    await runtimes.prompt(side.runtimeId, { message: "Side question", images: [] });
    await until((event) => event.type === "turn-end");
    const sideMessages = await runtimes.messages(side.runtimeId);
    expect(sideMessages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(JSON.stringify(sideMessages.at(-1))).toContain("Side answer.");

    // The sidebar never lists it, and the parent keeps only its own turn.
    expect((await runtimes.listSessions()).map((session) => `harness:${session.id}`)).toEqual([parentFile]);
    expect(await runtimes.messages(main.runtimeId)).toHaveLength(2);

    await runtimes.stop(side.runtimeId);
    const all = await runtimes.call<{ sessions: Array<{ id: string }> }>("session.list");
    expect(all.sessions.map((session) => `harness:${session.id}`)).toEqual([parentFile]);
  });
});

describe("scheduled tasks through the adapter", () => {
  it("map tasks and runs, and hear the Host's run updates", async () => {
    const { runtimes } = await start(new ScriptedProvider([textReply("Report ready.")]));
    const heard: ScheduledRunInfo[] = [];
    const stop = runtimes.onNotification("schedule/run", (params) => void heard.push(params as ScheduledRunInfo));
    const task = { id: "nightly", name: "Nightly", prompt: "report", cwd: dir, frequency: "daily" as const, hour: 2, minute: 0, weekday: 1, permissionMode: "read-only" as const, timeoutMinutes: null, enabled: true, lastStatus: "" as const, lastMessage: "" };
    const saved = await runtimes.call<{ task: never }>("schedule.save", { task: taskToHost(task) });
    expect(taskFromHost(saved.task)).toMatchObject({ id: "nightly", permissionMode: "read-only", timeoutMinutes: null, lastStatus: "", enabled: true });
    const { run } = await runtimes.call<{ run: ScheduledRunInfo }>("schedule.run", { id: "nightly" });
    expect(runFromHost(run, task)).toMatchObject({ taskName: "Nightly", cwd: dir, prompt: "report", permissionMode: "read-only", status: "success", output: "Report ready.", sessionFile: `harness:${run.sessionId}` });
    expect(heard.map((item) => item.status)).toEqual(["running", "success"]);
    stop();
  });
});
