/**
 * The feature plugins through the host: a permission prompt answered over
 * the WebSocket, the permission, plan and checkpoint methods, and harness.json.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AgentLoop } from "@pid/agent-loop";
import * as checkpoints from "@pid/checkpoints";
import { LlmService } from "@pid/llm";
import { Mcp } from "@pid/mcp";
import { Permissions } from "@pid/permissions";
import { Schedule } from "@pid/schedule";
import * as plan from "@pid/plan";
import { PROTOCOL_VERSION, clientSubprotocols, ErrorCode } from "@pid/protocol";
import { Sessions } from "@pid/session";
import { SystemPrompt } from "@pid/system-prompt";
import { ScriptedProvider, textReply, toolReply, useScriptedProvider } from "@pid/testkit";
import * as toolFs from "@pid/tool-fs";
import { Tools } from "@pid/tools";
import { Ui } from "@pid/ui";
import * as featuresRpc from "../src/features-rpc.ts";
import * as piSessions from "../src/pi-sessions.ts";
import { defaultHarnessConfig, readHarnessConfig } from "../src/harness-config.ts";
import { RpcGateway, WebServer, createHost, type Host } from "../src/index.ts";
import * as scheduleRpc from "../src/schedule-rpc.ts";
import * as sessionsRpc from "../src/sessions-rpc.ts";
import * as uiRpc from "../src/ui-rpc.ts";

/** Parsed wire JSON; the assertions check its shape. */
type Json = ReturnType<typeof JSON.parse>;

const token = Buffer.alloc(32, 5).toString("base64url");
let host: Host | undefined;
let dir = "";

afterEach(async () => {
  await host?.stop();
  host = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function start(provider: ScriptedProvider) {
  dir = mkdtempSync(join(tmpdir(), "pid-host-features-"));
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
      [sessionsRpc, { defaultModel: { provider: "scripted", model: "m" } }],
      [uiRpc],
      [featuresRpc],
      [scheduleRpc],
      [piSessions, { stateFile: join(dir, "pi-import.json") }],
      [{ name: "scripted", inject: ["llm"], apply: (ctx: never) => useScriptedProvider(ctx, provider) }],
    ],
  });
  await host.start();
  const port = await host.ctx.webServer.listen(0);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, clientSubprotocols(token));
  await new Promise((resolve, reject) => socket.once("open", resolve).once("error", reject));
  const pending = new Map<number, (message: Json) => void>();
  const notifications: Array<{ method: string; params: Json }> = [];
  const waiters: Array<() => void> = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (typeof message.id === "number") pending.get(message.id)?.(message);
    else {
      notifications.push(message);
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  let next = 0;
  const call = (method: string, params?: unknown): Promise<Json> => new Promise((done) => {
    const id = ++next;
    pending.set(id, done);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  const until = async (match: (n: { method: string; params: Json }) => boolean) => {
    while (!notifications.some(match)) await new Promise<void>((resolve) => waiters.push(resolve));
    return notifications.find(match) as { method: string; params: Json };
  };
  await call("initialize", { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" } });
  return { call, until, notifications };
}

const settled = (n: { method: string; params: Json }) => n.method === "session/delta" && n.params.delta.type === "agent-end";

describe("feature plugins in the host", () => {
  it("asks the client before a file change and runs it once allowed", async () => {
    const provider = new ScriptedProvider([
      toolReply([{ id: "c1", name: "write", args: { path: "note.txt", content: "hi" } }]),
      textReply("Written."),
    ]);
    const { call, until, notifications } = await start(provider);
    const sessionId = (await call("session.create", { cwd: dir })).result.session.id;
    await call("session.subscribe", { sessionId });
    expect((await call("permission.get", { sessionId })).result).toEqual({ permission: "ask", agentMode: "agent", effective: "ask" });

    await call("session.prompt", { sessionId, content: "write a note" });
    const request = await until((n) => n.method === "ui/request");
    expect(request.params).toMatchObject({ sessionId, kind: "confirm", title: "允许修改文件？" });
    expect((await call("ui.pending")).result.requests).toHaveLength(1);
    expect((await call("ui.respond", { requestId: request.params.requestId, value: true })).result).toEqual({});
    expect((await call("ui.respond", { requestId: request.params.requestId, value: true })).error?.code).toBe(ErrorCode.InvalidParams);
    await until(settled);
    const result = notifications.find((n) => n.method === "session/event" && n.params.event.type === "tool-result");
    expect(result?.params.event.data).toMatchObject({ isError: false });
    expect(notifications.some((n) => n.method === "ui/cancel")).toBe(true);
  });

  it("switches modes, reads the plan and lists checkpoints", async () => {
    const provider = new ScriptedProvider([
      toolReply([{ id: "c1", name: "update_plan", args: { items: [{ id: "a", text: "Look around", status: "in_progress" }] } }]),
      textReply("Planned."),
    ]);
    const { call, until } = await start(provider);
    const sessionId = (await call("session.create", { cwd: dir })).result.session.id;
    await call("session.subscribe", { sessionId });
    expect((await call("permission.set", { sessionId, agentMode: "plan" })).result.seq).toBeGreaterThan(0);
    expect((await call("permission.get", { sessionId })).result).toMatchObject({ agentMode: "plan", effective: "read-only" });
    expect((await call("permission.set", { sessionId, permission: "root" })).error?.code).toBe(ErrorCode.InvalidParams);

    await call("session.prompt", { sessionId, content: "plan it" });
    await until(settled);
    expect((await call("plan.get", { sessionId })).result.plan.items).toEqual([{ id: "a", text: "Look around", status: "in_progress" }]);
    expect(provider.requests[0]?.system).toContain("PIDesktop mode: Plan.");
    expect(provider.requests[0]?.system).toContain("pidesktop-rich");
    // Read-only run, and not a git repository either: no checkpoint.
    expect((await call("checkpoint.list", { sessionId })).result).toEqual({ checkpoints: [] });
    expect((await call("checkpoint.restore", { sessionId, userSeq: 1 })).error?.code).toBe(ErrorCode.InvalidParams);

    expect((await call("mcp.status")).result).toEqual({ servers: [] });
    expect((await call("usage.summary")).result).toEqual({
      sessions: 1,
      messages: 3,
      usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect((await call("session.list")).result.sessions[0]).toMatchObject({ firstMessage: "plan it", messageCount: 3 });
  });
});

describe("schedule methods", () => {
  it("saves, runs and lists scheduled tasks, notifying clients", async () => {
    const { call, notifications } = await start(new ScriptedProvider([textReply("Nightly report done.")]));
    const task = { id: "nightly", name: "Nightly", prompt: "report", cwd: dir, frequency: "daily", hour: 2, minute: 0, permissionMode: "read-only" };
    expect((await call("schedule.save", { task })).result.task).toMatchObject({ id: "nightly", enabled: true, running: false });
    expect((await call("schedule.save", { task: { ...task, permissionMode: "full-access" } })).error?.code).toBe(ErrorCode.InvalidParams);
    expect((await call("schedule.run", { id: "nightly" })).result.run).toMatchObject({ status: "success", output: "Nightly report done." });
    expect((await call("schedule.list")).result.tasks).toMatchObject([{ id: "nightly", lastStatus: "success", running: false }]);
    expect((await call("schedule.runs", { taskId: "nightly" })).result.runs).toHaveLength(1);
    expect(notifications.filter((n) => n.method === "schedule/run").map((n) => n.params.status)).toEqual(["running", "success"]);
    expect((await call("schedule.delete", { id: "nightly" })).result).toEqual({});
    expect(notifications.at(-1)).toMatchObject({ method: "schedule/task", params: { id: "nightly", deleted: true } });
    expect((await call("schedule.cancel", { id: "nightly" })).error?.code).toBe(ErrorCode.InvalidParams);
  });
});

describe("harness.json", () => {
  it("reads sections and reports the ones it ignores", () => {
    dir = mkdtempSync(join(tmpdir(), "pid-harness-config-"));
    const file = join(dir, "harness.json");
    expect(readHarnessConfig(file)).toEqual({ config: defaultHarnessConfig(), problems: [] });
    writeFileSync(file, JSON.stringify({ permissions: { defaultPermission: "full-access" }, hooks: "nope", memory: { enabled: false } }));
    const { config, problems } = readHarnessConfig(file);
    expect(config.permissions).toEqual({ defaultPermission: "full-access" });
    expect(config.memory.enabled).toBe(false);
    expect(config.hooks).toEqual({ hooks: [] });
    expect(problems).toEqual(["hooks must be an object; using its defaults"]);
    writeFileSync(file, "{");
    expect(readHarnessConfig(file).problems[0]).toMatch(/not valid JSON/);
  });
});

describe("Pi session import", () => {
  it("imports Pi's sessions once, and an imported one carries on", async () => {
    const provider = new ScriptedProvider([textReply("Carried on.")]);
    const { call, until } = await start(provider);
    const root = join(dir, "pi", "sessions");
    mkdirSync(join(root, "--C--work--demo--"), { recursive: true });
    for (const name of ["tools", "branched", "compacted"]) {
      // The samples were recorded with the cwd C:\work\demo; point them at a directory that exists here.
      const text = readFileSync(join(import.meta.dirname, "fixtures", "pi-sessions", `${name}.jsonl`), "utf8");
      writeFileSync(join(root, "--C--work--demo--", `${name}.jsonl`), text.replace('"cwd":"C:\\\\work\\\\demo"', `"cwd":${JSON.stringify(dir)}`));
    }
    writeFileSync(join(root, "--C--work--demo--", "broken.jsonl"), "not a session\n");

    // A dry run counts what is left; offering the import is recorded once.
    expect((await call("import.piSessions", { roots: [root], dryRun: true })).result).toEqual({ pending: 4, prompted: false, imported: 0, skipped: 0, failed: 0, problems: [] });
    expect((await call("import.piSessions", { roots: [root], dryRun: true, markPrompted: true })).result).toMatchObject({ pending: 4, prompted: true });
    expect((await call("import.piSessions", { roots: "nope" })).error.code).toBe(ErrorCode.InvalidParams);

    const report = (await call("import.piSessions", { roots: [root] })).result;
    expect(report).toMatchObject({ prompted: true, imported: 3, skipped: 0, failed: 1 });
    expect((await call("import.piSessions", { roots: [root], dryRun: true })).result).toMatchObject({ pending: 1, prompted: true });
    expect(report.problems).toEqual(expect.arrayContaining(["left out 1 label entry", "left out 1 custom_message entry"]));
    expect((await call("import.piSessions", { roots: [root] })).result).toMatchObject({ imported: 0, skipped: 3, failed: 1 });

    const sessions = (await call("session.list")).result.sessions as Array<{ id: string; title?: string; cwd: string; createdAt: string }>;
    const imported = sessions.find((session) => session.title === "List files");
    expect(imported).toMatchObject({ cwd: dir });
    expect(imported?.createdAt).toBe(JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "pi-sessions", "tools.jsonl"), "utf8").split("\n")[0] ?? "{}").timestamp);
    const sessionId = String(imported?.id);
    expect((await call("session.get", { sessionId })).result.session).toMatchObject({ importedFrom: { format: "pi", id: "00000000-0000-4000-8000-000000000005" } });

    await call("session.subscribe", { sessionId });
    await call("model.set", { sessionId, provider: "scripted", model: "m" });
    await call("session.prompt", { sessionId, content: "Which one is newer?" });
    await until(settled);
    const sent = JSON.stringify(provider.requests[0]?.messages);
    expect(sent).toContain("Two files: a.txt and b.txt.");
    expect(sent).toContain("Which one is newer?");
  });
});
