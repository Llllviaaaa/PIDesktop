/**
 * The session methods over a real WebSocket, and a headless run end to end
 * through the OpenAI-compatible adapter against a fake provider.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AgentLoop } from "@pid/agent-loop";
import { LlmService } from "@pid/llm";
import { ErrorCode, PROTOCOL_VERSION, clientSubprotocols, type SessionEventNotification } from "@pid/protocol";
import { Sessions } from "@pid/session";
import { SystemPrompt } from "@pid/system-prompt";
import { ScriptedProvider, textReply, toolReply, useScriptedProvider } from "@pid/testkit";
import * as toolFs from "@pid/tool-fs";
import { Tools } from "@pid/tools";
import { startFakeProvider, type FakeProvider } from "../../llm/test/fake-server.ts";
import { runHeadless } from "../src/headless.ts";
import { RpcGateway, WebServer, createHost, type Host } from "../src/index.ts";
import * as sessionsRpc from "../src/sessions-rpc.ts";

/** Parsed wire JSON; the assertions check its shape. */
type Json = ReturnType<typeof JSON.parse>;

const token = Buffer.alloc(32, 9).toString("base64url");
let host: Host | undefined;
let server: FakeProvider | undefined;
let dir = "";

afterEach(async () => {
  await host?.stop();
  await server?.close();
  host = undefined;
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

interface Client {
  call(method: string, params?: unknown): Promise<{ result?: Json; error?: { code: number; message: string } }>;
  notifications: Array<{ method: string; params: Json }>;
  /** Resolves when a notification matching `match` has arrived (or already had). */
  until(match: (notification: { method: string; params: Json }) => boolean): Promise<void>;
}

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, clientSubprotocols(token));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const pending = new Map<number, (message: Json) => void>();
  const notifications: Client["notifications"] = [];
  const waiters: Array<() => void> = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (typeof message.id === "number") {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    } else {
      notifications.push(message);
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  let next = 0;
  const client: Client = {
    notifications,
    call(method, params) {
      const id = ++next;
      return new Promise((done) => {
        pending.set(id, done);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    async until(match) {
      while (!notifications.some(match)) await new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
  await client.call("initialize", { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" } });
  return client;
}

async function startHost(provider: ScriptedProvider): Promise<{ port: number; cwd: string }> {
  dir = mkdtempSync(join(tmpdir(), "pid-host-sessions-"));
  writeFileSync(join(dir, "hello.txt"), "hi there\n");
  host = createHost({
    version: "0",
    dataDir: dir,
    plugins: [
      [WebServer, { pageOrigins: [] }],
      [RpcGateway, { token }],
      [LlmService, { maxAttempts: 1 }],
      [Sessions],
      [Tools],
      [toolFs],
      [SystemPrompt],
      [AgentLoop],
      [sessionsRpc, { defaultModel: { provider: "scripted", model: "m" } }],
      [{ name: "scripted", inject: ["llm"], apply: (ctx: never) => useScriptedProvider(ctx, provider) }],
    ],
  });
  await host.start();
  return { port: await host.ctx.webServer.listen(0), cwd: dir };
}

const settled = (n: { method: string; params: Json }) => n.method === "session/delta" && n.params.delta.type === "agent-end";

describe("session RPC", () => {
  it("creates a session, runs a prompt and streams its events", async () => {
    const provider = new ScriptedProvider([
      toolReply([{ id: "call-1", name: "read", args: { path: "hello.txt" } }]),
      textReply("It says hi."),
    ]);
    const { port, cwd } = await startHost(provider);
    const client = await connect(port);

    const created = await client.call("session.create", { cwd, effort: "low" });
    const sessionId = created.result.session.id as string;
    expect(created.result.session).toMatchObject({ cwd, lastSeq: 2, archived: false });

    const subscribed = await client.call("session.subscribe", { sessionId });
    expect(subscribed.result.events.map((event: { type: string }) => event.type)).toEqual(["model", "effort"]);
    expect(subscribed.result.status).toMatchObject({ running: false });

    expect((await client.call("session.prompt", { sessionId, content: "What does hello.txt say?" })).result).toEqual({ seq: 3 });
    await client.until(settled);
    const events = client.notifications
      .filter((n) => n.method === "session/event")
      .map((n) => (n.params as SessionEventNotification).event);
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [3, "user"], [4, "assistant"], [5, "tool-call"], [6, "tool-result"], [7, "assistant"],
    ]);
    expect(events[3]?.data).toMatchObject({ isError: false, content: [{ type: "text", text: "hi there\n" }] });
    const liveSeqs = client.notifications.filter((n) => n.method === "session/delta").map((n) => n.params.liveSeq);
    expect(liveSeqs).toEqual([...liveSeqs].sort((a, b) => a - b));

    const got = await client.call("session.get", { sessionId });
    expect(got.result).toMatchObject({ model: { provider: "scripted", model: "m" }, effort: "low", status: { running: false } });
    expect((await client.call("session.subscribe", { sessionId, afterSeq: 6 })).result.events.map((event: { seq: number }) => event.seq)).toEqual([7]);
  });

  it("forks, rewinds, renames, archives and switches models", async () => {
    const provider = new ScriptedProvider([textReply("One.")]);
    const { port, cwd } = await startHost(provider);
    const client = await connect(port);
    const sessionId = (await client.call("session.create", { cwd })).result.session.id;
    await client.call("session.subscribe", { sessionId });
    await client.call("session.prompt", { sessionId, content: [{ type: "text", text: "First" }] });
    await client.until(settled);

    const fork = await client.call("session.fork", { sessionId, seq: 2 });
    expect(fork.result.session).toMatchObject({ forkedFrom: { sessionId, seq: 2 }, lastSeq: 2 });
    expect((await client.call("session.rewind", { sessionId, toSeq: 1 })).result).toEqual({ seq: 4 });
    expect((await client.call("session.rename", { sessionId, title: "Renamed" })).result).toEqual({ seq: 5 });
    expect((await client.call("session.archive", { sessionId })).result).toEqual({ seq: 6 });
    expect((await client.call("model.set", { sessionId, provider: "scripted", model: "other" })).result).toEqual({ seq: 7 });
    expect((await client.call("model.setEffort", { sessionId, effort: "high" })).result).toEqual({ seq: 8 });

    const list = (await client.call("session.list")).result.sessions;
    expect(list.map((session: { id: string }) => session.id).sort()).toEqual([sessionId, fork.result.session.id].sort());
    expect(list.find((session: { id: string }) => session.id === sessionId)).toMatchObject({ title: "Renamed", archived: true });
    expect((await client.call("session.get", { sessionId })).result).toMatchObject({ model: { model: "other" }, effort: "high" });
  });

  it("answers with protocol errors", async () => {
    const provider = new ScriptedProvider([[{ type: "text-delta", index: 0, text: "…" }, { type: "finish", reason: "stop" }]], { chunkDelayMs: 30 });
    const { port, cwd } = await startHost(provider);
    const client = await connect(port);
    expect((await client.call("session.get", { sessionId: "nope" })).error?.code).toBe(ErrorCode.SessionNotFound);
    expect((await client.call("session.create", { cwd: "relative" })).error?.code).toBe(ErrorCode.InvalidParams);
    expect((await client.call("session.create", { cwd, model: { provider: "nope", model: "m" } })).error?.code).toBe(ErrorCode.InvalidParams);

    const sessionId = (await client.call("session.create", { cwd })).result.session.id;
    expect((await client.call("session.prompt", { sessionId, content: [] })).error?.code).toBe(ErrorCode.InvalidParams);
    await client.call("session.prompt", { sessionId, content: "one" });
    expect((await client.call("session.prompt", { sessionId, content: "two" })).error?.code).toBe(ErrorCode.SessionBusy);
    expect((await client.call("session.rewind", { sessionId, toSeq: 1 })).error?.code).toBe(ErrorCode.SessionBusy);
    expect((await client.call("session.steer", { sessionId, content: "three" })).result).toEqual({});
    await client.call("session.abort", { sessionId });
    expect((await client.call("session.get", { sessionId })).result.status.running).toBe(false);
  });
});

class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer, _encoding: string, done: () => void): void {
    this.text += chunk.toString();
    done();
  }
}

function sse(...chunks: unknown[]): string {
  return [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join("");
}

describe("deleting and exporting", () => {
  it("export the current branch as Markdown and delete idle sessions", async () => {
    const provider = new ScriptedProvider([textReply("Hello there.")]);
    const { port, cwd } = await startHost(provider);
    const client = await connect(port);
    const sessionId = (await client.call("session.create", { cwd })).result.session.id;
    await client.call("session.subscribe", { sessionId });
    await client.call("session.prompt", { sessionId, content: "Hi" });
    await client.until(settled);

    const destination = join(cwd, "out", "chat.md");
    expect((await client.call("session.export", { sessionId, destination })).result).toEqual({ path: destination });
    expect(readFileSync(destination, "utf8")).toBe("# PIDesktop conversation\n\n## User\n\nHi\n\n## Assistant\n\nHello there.\n\n");
    expect((await client.call("session.export", { sessionId, destination: "relative.md" })).error?.code).toBe(ErrorCode.InvalidParams);

    expect((await client.call("session.delete", { sessionId })).result).toEqual({});
    expect((await client.call("session.list")).result.sessions).toEqual([]);
    expect((await client.call("session.get", { sessionId })).error?.code).toBe(ErrorCode.SessionNotFound);
  });
});

describe("headless run", () => {
  it("completes a task through a real adapter and continues the session", async () => {
    server = await startFakeProvider();
    dir = mkdtempSync(join(tmpdir(), "pid-headless-"));
    const dataDir = join(dir, "data");
    const work = join(dir, "work");
    mkdirSync(dataDir);
    mkdirSync(work);
    writeFileSync(join(dataDir, "providers.json"), JSON.stringify({
      providers: [{ api: "openai-compat", id: "fake", baseUrl: `${server.baseUrl}/v1`, apiKey: { value: "k" } }],
      defaultModel: { provider: "fake", model: "m" },
    }));
    server.reply(
      { sse: sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "out.txt", content: "done" }) } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) },
      { sse: sse({ choices: [{ index: 0, delta: { content: "Wrote out.txt." }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) },
    );

    const out = new Capture();
    const err = new Capture();
    const code = await runHeadless(["--data-dir", dataDir, "--cwd", work, "create", "out.txt"], out, err);
    expect(err.text).toContain("▸ write");
    expect(code).toBe(0);
    expect(readFileSync(join(work, "out.txt"), "utf8")).toBe("done");
    expect(out.text).toBe("Wrote out.txt.\n");
    const body = server.requests[1]?.body as { messages: Array<{ role: string }>; tools: Array<{ function: { name: string } }> };
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
    const toolNames = body.tools.map((tool) => tool.function.name);
    expect(toolNames.filter((tool) => tool.startsWith("browser_"))).toHaveLength(11);
    expect(toolNames.filter((tool) => !tool.startsWith("computer_") && !tool.startsWith("browser_"))).toEqual(["bash", "delegate_task", "desktop_memory", "edit", "find", "grep", "ls", "read", "update_plan", "write"]);
    expect(toolNames.filter((tool) => tool.startsWith("computer_"))).toHaveLength(11);

    const sessionId = /\[session ([0-9a-f-]+): done\]/.exec(err.text)?.[1];
    expect(sessionId).toBeDefined();
    expect(existsSync(join(dataDir, "sessions"))).toBe(true);
    server.reply({ sse: sse({ choices: [{ index: 0, delta: { content: "Still here." }, finish_reason: "stop" }] }) });
    const json = new Capture();
    expect(await runHeadless(["--data-dir", dataDir, "--session", sessionId as string, "--json", "again"], json, new Capture())).toBe(0);
    expect(json.text.trim().split("\n").map((line) => JSON.parse(line).type)).toEqual(["user", "assistant"]);
    expect((server.requests[2]?.body as { messages: unknown[] }).messages).toHaveLength(6);
  });

  it("explains missing arguments and models", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-headless-"));
    const err = new Capture();
    expect(await runHeadless(["--data-dir", dir], new Capture(), err)).toBe(2);
    expect(err.text).toContain("a prompt is required");
    const noModel = new Capture();
    expect(await runHeadless(["--data-dir", dir, "--cwd", dir, "hi"], new Capture(), noModel)).toBe(2);
    expect(noModel.text).toContain("no model");
  });
});
