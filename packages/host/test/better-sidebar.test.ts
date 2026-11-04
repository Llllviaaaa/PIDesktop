import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LlmService } from "@pid/llm";
import { Sessions } from "@pid/session";
import { ScriptedProvider, useScriptedProvider } from "@pid/testkit";
import { Tools } from "@pid/tools";
import * as betterSidebar from "../src/better-sidebar/index.ts";
import { WebServer, createHost, type Host } from "../src/index.ts";

const pageOrigin = "http://tauri.localhost";
let host: Host | undefined;
let dataDir = "";

afterEach(async () => {
  await host?.stop();
  host = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

async function startHost(withAgentServices = false): Promise<string> {
  dataDir = mkdtempSync(join(tmpdir(), "pid-host-sidebar-"));
  const scripted = new ScriptedProvider();
  host = createHost({
    version: "0",
    dataDir,
    plugins: [
      [WebServer, { pageOrigins: [pageOrigin] }],
      ...(withAgentServices
        ? ([
            [LlmService],
            [Sessions],
            [Tools],
            [{ name: "test-scripted-llm", inject: ["llm"], apply: (ctx: never) => useScriptedProvider(ctx, scripted) }],
          ] as const)
        : []),
      [betterSidebar, { dataDir, defaultModel: () => ({ provider: "scripted", model: "m" }) }],
    ],
  });
  await host.start();
  return `http://127.0.0.1:${await host.ctx.webServer.listen(0)}`;
}

function api(base: string, method: string, payload: unknown): Promise<Response> {
  return fetch(`${base}/sidebar/api/${method}`, {
    method: "POST",
    headers: { origin: pageOrigin, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("better-sidebar in the host", () => {
  it("serves its API to Pi Desktop's page", async () => {
    const base = await startHost();
    const response = await api(base, "settings.get", {});
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(pageOrigin);
    expect(await response.json()).toMatchObject({ ok: true, value: { revision: 0 } });
  });

  it("persists settings and refuses a stale writer as a conflict", async () => {
    const base = await startHost();
    expect((await api(base, "settings.update", { patch: {}, expectedRevision: 0 })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(dataDir, "better-sidebar", "settings.json"), "utf8")).revision).toBe(1);

    // The shim's SettingsConflictError must be the class the plugin checks against.
    const stale = await api(base, "settings.update", { patch: {}, expectedRevision: 0 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ok: false, error: { code: "settings-conflict" } });
  });

  it("still refuses other origins", async () => {
    const base = await startHost();
    const response = await fetch(`${base}/sidebar/api/settings.get`, { method: "POST", headers: { origin: "https://evil.example" } });
    expect(response.status).toBe(403);
  });

  it("bridges real sessions, llm models, and registers sidebar_open onto Host tools", async () => {
    const base = await startHost(true);
    const activeHost = host;
    if (activeHost === undefined) throw new Error("host not started");

    // 1. sidebar_open is registered in Host's Tools service by default
    expect(activeHost.ctx.tools.schemas().map((tool) => tool.name)).toContain("sidebar_open");

    // 2. git.models lists models from the Host's LlmService and defaultModel
    const modelsRes = await api(base, "git.models", {});
    expect(modelsRes.status).toBe(200);
    const modelsBody = (await modelsRes.json()) as {
      ok: boolean;
      value: {
        llm: boolean;
        providers: Array<{ provider: string; models: Array<{ id: string }> }>;
        default?: { provider: string; model: string };
      };
    };
    expect(modelsBody.ok).toBe(true);
    expect(modelsBody.value.llm).toBe(true);
    expect(modelsBody.value.default).toEqual({ provider: "scripted", model: "m" });
    expect(modelsBody.value.providers).toContainEqual(expect.objectContaining({ provider: "scripted" }));

    // 3. Create a real session with a file inside its workspace and execute sidebar_open
    const workspaceDir = mkdtempSync(join(tmpdir(), "pid-sidebar-ws-"));
    try {
      writeFileSync(join(workspaceDir, "hello.ts"), "export const answer = 42;\n");
      const session = activeHost.ctx.sessions.create({ cwd: workspaceDir });

      // Connect a WebSocket subscriber to /sidebar/ws/agent-opens to verify live push delivery
      const wsUrl = `${base.replace("http://", "ws://")}/sidebar/ws/agent-opens?sessionId=${encodeURIComponent(session.id)}`;
      const received: unknown[] = [];
      const ws = new WebSocket(wsUrl, { headers: { origin: pageOrigin } } as never);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", (event) => reject(event), { once: true });
      });
      ws.addEventListener("message", (event) => {
        received.push(JSON.parse(String(event.data)));
      });

      const output = await activeHost.ctx.tools.execute(
        { id: "open-1", name: "sidebar_open", args: { target: "hello.ts", line: 1 } },
        { sessionId: session.id, cwd: workspaceDir, signal: new AbortController().signal },
      );
      const outputText = output.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
      expect(output.isError).toBeUndefined();
      expect(outputText).toContain("hello.ts");

      await expect.poll(() => received.length).toBeGreaterThanOrEqual(1);
      expect(received[0]).toMatchObject({
        sessionId: session.id,
        kind: "file",
        title: "hello.ts",
      });
      ws.close();
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
