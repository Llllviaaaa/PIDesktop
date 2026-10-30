/**
 * The Host under load (docs/REFACTOR_V2_P7.md, 3.2): twenty sessions running
 * at once each keep a whole, ordered log and hear only their own
 * notifications; creating, running and deleting two hundred sessions leaves
 * the heap and the active handles near where they started.
 *
 * Not part of `npm test`: run it with `npm run test:stress`
 * (vitest.stress.config.ts, which exposes `gc`).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AgentLoop } from "@pid/agent-loop";
import { LlmService, type LlmRequest } from "@pid/llm";
import { PROTOCOL_VERSION, clientSubprotocols, type PersistedEvent } from "@pid/protocol";
import { Sessions } from "@pid/session";
import * as sessionJsonl from "@pid/session-jsonl";
import { SystemPrompt } from "@pid/system-prompt";
import { ScriptedProvider, textReply, toolReply, useScriptedProvider } from "@pid/testkit";
import * as toolFs from "@pid/tool-fs";
import { Tools } from "@pid/tools";
import { RpcGateway, WebServer, createHost, type Host } from "../src/index.ts";
import * as sessionsRpc from "../src/sessions-rpc.ts";

/** Parsed wire JSON; the assertions check its shape. */
type Json = ReturnType<typeof JSON.parse>;
type Notification = { method: string; params: Json };

const token = Buffer.alloc(32, 7).toString("base64url");
let host: Host | undefined;
let dir = "";

afterEach(async () => {
  await host?.stop();
  host = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Every call reads a file, then answers with the text of the user message it
 * was asked, so a reply that reached the wrong session shows in its log.
 */
function echoingProvider(): ScriptedProvider {
  const provider = new ScriptedProvider();
  const reply = (request: LlmRequest) => {
    const last = request.messages.at(-1);
    if (last?.role === "tool-result") {
      const asked = request.messages.findLast((message) => message.role === "user");
      const text = asked?.content.map((block) => (block.type === "text" ? block.text : "")).join("") ?? "";
      return textReply(`done: ${text}`);
    }
    return toolReply([{ id: `read-${request.messages.length}`, name: "read", args: { path: "hello.txt" } }]);
  };
  // Enough replies for every test below; each is a function of its request.
  for (let index = 0; index < 1_000; index += 1) provider.push(reply);
  return provider;
}

async function startHost(): Promise<{ port: number; cwd: string }> {
  dir = mkdtempSync(join(tmpdir(), "pid-host-stress-"));
  writeFileSync(join(dir, "hello.txt"), "hi there\n");
  const provider = echoingProvider();
  host = createHost({
    version: "0",
    dataDir: dir,
    plugins: [
      [WebServer, { pageOrigins: [] }],
      [RpcGateway, { token }],
      [LlmService, { maxAttempts: 1 }],
      [Sessions],
      [sessionJsonl, { dir: join(dir, "sessions") }],
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

interface Client {
  call(method: string, params?: unknown): Promise<Json>;
  notifications: Notification[];
  until(match: (notification: Notification) => boolean): Promise<void>;
  close(): Promise<void>;
}

async function connect(port: number): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, clientSubprotocols(token));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const pending = new Map<number, (message: Json) => void>();
  const notifications: Notification[] = [];
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
      return new Promise((done, fail) => {
        pending.set(id, (message) => (message.error === undefined ? done(message.result) : fail(new Error(`${method}: ${message.error.message}`))));
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    },
    async until(match) {
      while (!notifications.some(match)) await new Promise<void>((resolve) => waiters.push(resolve));
    },
    close() {
      return new Promise((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
      });
    },
  };
  await client.call("initialize", { protocolVersion: PROTOCOL_VERSION, client: { name: "stress", version: "1" } });
  return client;
}

const ended = (sessionId: string) => (n: Notification) => n.method === "session/delta" && n.params.sessionId === sessionId && n.params.delta.type === "agent-end";

/** Runs one prompt in a new session over `client` and returns the session id. */
async function runOne(client: Client, cwd: string, text: string): Promise<string> {
  const { session } = await client.call("session.create", { cwd });
  await client.call("session.subscribe", { sessionId: session.id });
  await client.call("session.prompt", { sessionId: session.id, content: text });
  await client.until(ended(session.id));
  return session.id as string;
}

const gc = (): void => {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (collect === undefined) throw new Error("Run with --expose-gc (npm run test:stress)");
  collect();
  collect();
};

const handles = (): number => process.getActiveResourcesInfo().filter((kind) => kind !== "Timeout").length;

describe("host under load", () => {
  it("runs twenty sessions at once, each with its own whole log", async () => {
    const { port, cwd } = await startHost();
    const count = 20;
    const clients = await Promise.all(Array.from({ length: count }, () => connect(port)));
    const ids = await Promise.all(clients.map((client, index) => runOne(client, cwd, `task-${index}`)));

    expect(new Set(ids).size).toBe(count);
    for (const [index, client] of clients.entries()) {
      const id = ids[index];
      // A client hears only the session it subscribed to.
      expect(client.notifications.filter((n) => n.method.startsWith("session/")).every((n) => n.params.sessionId === id)).toBe(true);
      // Its events arrive in order without gaps.
      const heard = client.notifications.filter((n) => n.method === "session/event").map((n) => n.params.seq as number);
      expect(heard).toEqual(heard.map((_, offset) => heard[0] + offset));

      const { events } = await client.call("session.subscribe", { sessionId: id, afterSeq: 0 }) as { events: PersistedEvent[] };
      expect(events.map((event) => event.seq)).toEqual(events.map((_, offset) => offset + 1));
      expect(events.map((event) => event.type)).toEqual(["model", "user", "assistant", "tool-call", "tool-result", "assistant"]);
      const answer = events.at(-1)?.data as { content: Array<{ type: string; text?: string }> };
      expect(answer.content[0]?.text).toBe(`done: task-${index}`);
    }
    await Promise.all(clients.map((client) => client.close()));
  });

  it("returns to its baseline after creating and deleting two hundred sessions", async () => {
    const { port, cwd } = await startHost();
    const client = await connect(port);
    const cycle = async (round: number) => {
      const id = await runOne(client, cwd, `cycle-${round}`);
      await client.call("session.unsubscribe", { sessionId: id });
      await client.call("session.delete", { sessionId: id });
      client.notifications.length = 0;
    };
    // Warm up, so lazily built code and caches count in the baseline.
    for (let round = 0; round < 20; round += 1) await cycle(round);
    gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const handlesBefore = handles();

    for (let round = 0; round < 200; round += 1) await cycle(round);
    await new Promise((resolve) => setTimeout(resolve, 100));
    gc();
    const grownMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;
    expect(grownMb, `heap grew ${grownMb.toFixed(2)} MB over 200 sessions`).toBeLessThan(8);
    expect(handles()).toBeLessThanOrEqual(handlesBefore + 2);
    expect(host?.ctx.sessions.loaded).toBe(0);
    await client.close();
  });
});
