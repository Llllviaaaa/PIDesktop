// The frontend's harness adapter (src/lib/harnessRuntime.ts) against a real
// Harness Host in this process: the store's Pi commands and events over the
// real WebSocket client, with a scripted model.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoop } from "@pid/agent-loop";
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
import { connectHarness } from "../src/lib/harnessClient";
import { HarnessRuntimes } from "../src/lib/harnessRuntime";
import type { ExtensionUIRequest, PiEvent } from "../src/types";

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
      [Mcp, {}],
      [sessionsRpc, { defaultModel: { provider: "scripted", model: "m" } }],
      [uiRpc],
      [featuresRpc],
      [{ name: "scripted", inject: ["llm"], apply: (ctx: never) => useScriptedProvider(ctx, provider) }],
    ],
  });
  await host.start();
  const port = await host.ctx.webServer.listen(0);
  const runtimes = new HarnessRuntimes(() => connectHarness({ baseUrl: `http://127.0.0.1:${port}/`, token }, { name: "test", version: "1" }));
  runtimes.setEngine("harness");
  const events: Array<[string, PiEvent]> = [];
  const waiters: Array<() => void> = [];
  runtimes.subscribe((runtimeId, event) => {
    events.push([runtimeId, event]);
    for (const waiter of waiters.splice(0)) waiter();
  });
  const until = async (match: (event: PiEvent) => boolean): Promise<PiEvent> => {
    for (;;) {
      const found = events.find(([, event]) => match(event));
      if (found !== undefined) return found[1];
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return { runtimes, events, until };
}

describe("harness runtimes", () => {
  it("run a task the way the store drives a Pi runtime", async () => {
    const provider = new ScriptedProvider([
      toolReply([{ id: "c1", name: "read", args: { path: "a.txt" } }]),
      toolReply([{ id: "c2", name: "write", args: { path: "b.txt", content: "made" } }]),
      textReply("Done."),
    ]);
    const { runtimes, events, until } = await start(provider);
    const { runtimeId } = await runtimes.start(dir);

    // Nothing is created until the first prompt: a prewarmed workspace leaves no session.
    expect((await runtimes.command(runtimeId, "get_state")).data).toMatchObject({ isStreaming: false });
    expect((await runtimes.command(runtimeId, "get_messages")).data).toEqual({ messages: [] });
    expect((await runtimes.command(runtimeId, "set_model", { provider: "scripted", modelId: "m" })).data).toMatchObject({ provider: "scripted", id: "m" });
    expect((await runtimes.command(runtimeId, "get_state")).data?.model).toMatchObject({ provider: "scripted", id: "m" });
    await runtimes.command(runtimeId, "set_thinking_level", { level: "high" });

    expect((await runtimes.command(runtimeId, "prompt", { message: "Copy a.txt" })).success).toBe(true);
    // The write needs confirmation: answer it as the extension dialog would.
    const request = await until((event) => event.type === "extension_ui_request" && event.method === "confirm") as ExtensionUIRequest;
    expect(request).toMatchObject({ method: "confirm", title: "Allow file change?" });
    await runtimes.respond(request, { confirmed: true });
    await until((event) => event.type === "agent_settled");

    const kinds = events.map(([, event]) => event.type);
    expect(kinds.slice(0, 3)).toEqual(["message_start", "agent_start", "message_start"]);
    expect(kinds.filter((kind) => kind === "tool_execution_end")).toHaveLength(2);
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("made");
    expect(provider.requests[0]?.effort).toBe("high");

    const state = (await runtimes.command(runtimeId, "get_state")).data;
    expect(state).toMatchObject({ isStreaming: false, thinkingLevel: "high", model: { provider: "scripted", id: "m" } });
    expect(String(state?.sessionFile)).toMatch(/^harness:/);
    const history = (await runtimes.command(runtimeId, "get_messages")).data?.messages ?? [];
    expect(history.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "assistant", "toolResult", "assistant"]);
    expect((await runtimes.command(runtimeId, "get_session_stats")).data).toMatchObject({ totalMessages: 4, tokens: { input: 30, output: 15 } });

    // Reopening the session from its sessionFile shows the same history.
    const reopened = await runtimes.start(dir, String(state?.sessionFile));
    expect(((await runtimes.command(reopened.runtimeId, "get_messages")).data?.messages ?? []).length).toBe(6);
  });

  it("switch modes through Pi's slash commands and report what it cannot do", async () => {
    const { runtimes } = await start(new ScriptedProvider([]));
    const { runtimeId } = await runtimes.start(dir);
    expect((await runtimes.command(runtimeId, "prompt", { message: "/pidesktop-mode plan" })).success).toBe(true);
    const sessionId = String((await runtimes.command(runtimeId, "get_state")).data?.sessionId);
    const session = await host?.ctx.sessions.get(sessionId);
    expect(session === undefined ? undefined : host?.ctx.permissions.modes(session).agentMode).toBe("plan");
    expect(await runtimes.command(runtimeId, "export_html")).toMatchObject({ success: false, error: "Harness 引擎暂不支持 export_html" });
    expect((await runtimes.command(runtimeId, "get_available_thinking_levels")).data?.levels).toEqual(["off", "low", "medium", "high"]);
    await runtimes.stop(runtimeId);
    expect(await runtimes.command(runtimeId, "get_state")).toMatchObject({ success: false });
  });
});
