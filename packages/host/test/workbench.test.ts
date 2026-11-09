import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  clientSubprotocols,
  type WorkbenchOpenNotification,
  type WorkbenchPreviewUrlResult,
} from "@pid/protocol";
import { Sessions } from "@pid/session";
import { Tools } from "@pid/tools";
import WebSocket from "ws";
import { createHost, type Host } from "../src/host.ts";
import { RpcGateway } from "../src/rpc.ts";
import { WebServer } from "../src/web-server.ts";
import * as workbenchRpc from "../src/workbench-rpc.ts";

let tempDir = "";
let host: Host | undefined;

afterEach(async () => {
  await host?.stop();
  host = undefined;
  if (tempDir !== "") {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("native workbench host plugin", () => {
  it("broadcasts workbench/open from sidebar_open and confines file paths to the workspace", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "pid-workbench-test-"));
    host = createHost({
      version: "0.5.0-test",
      dataDir: tempDir,
      plugins: [
        [WebServer, { pageOrigins: ["http://tauri.localhost"] }],
        [RpcGateway, { token: "w".repeat(32) }],
        [Sessions],
        [Tools],
        [workbenchRpc],
      ],
    });
    await host.start();

    const broadcasted: Array<{ method: string; params: unknown }> = [];
    const origBroadcast = host.ctx.rpc.broadcast.bind(host.ctx.rpc);
    host.ctx.rpc.broadcast = (method: string, params: unknown) => {
      broadcasted.push({ method, params });
      origBroadcast(method, params);
    };

    const session = host.ctx.sessions.create({ cwd: tempDir });
    const signal = new AbortController().signal;

    // 1. Open file inside workspace with line range.
    const fileRes = await host.ctx.tools.execute(
      { id: "c1", name: "sidebar_open", args: { path: "src/App.tsx", line: 42, endLine: 50 } },
      { sessionId: session.id, cwd: tempDir, signal },
    );
    expect(fileRes.isError).toBeUndefined();
    expect(broadcasted.at(-1)).toEqual({
      method: "workbench/open",
      params: {
        sessionId: session.id,
        cwd: tempDir,
        target: "editor",
        path: "src/App.tsx",
        line: 42,
        endLine: 50,
      } satisfies WorkbenchOpenNotification,
    });

    // 2. Reject path traversal outside workspace.
    const escapeRes = await host.ctx.tools.execute(
      { id: "c2", name: "sidebar_open", args: { path: "../outside.txt" } },
      { sessionId: session.id, cwd: tempDir, signal },
    );
    expect(escapeRes.isError).toBe(true);
    expect(escapeRes.content[0]).toEqual({
      type: "text",
      text: "path is outside the workspace: ../outside.txt",
    });

    // 3. Reject javascript: URLs and allow https:// URLs.
    const badUrlRes = await host.ctx.tools.execute(
      { id: "c3", name: "sidebar_open", args: { url: "javascript:alert(1)" } },
      { sessionId: session.id, cwd: tempDir, signal },
    );
    expect(badUrlRes.isError).toBe(true);
    expect(badUrlRes.content[0]).toEqual({
      type: "text",
      text: "url must use http:// or https://",
    });

    const goodUrlRes = await host.ctx.tools.execute(
      { id: "c4", name: "sidebar_open", args: { url: "http://127.0.0.1:1420/preview" } },
      { sessionId: session.id, cwd: tempDir, signal },
    );
    expect(goodUrlRes.isError).toBeUndefined();
    expect(broadcasted.at(-1)).toMatchObject({
      method: "workbench/open",
      params: {
        target: "preview",
        url: "http://127.0.0.1:1420/preview",
      },
    });
  });

  it("mints capability-protected loopback preview URLs for HTML and relative assets while blocking traversal", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "pid-workbench-preview-"));
    mkdirSync(join(tempDir, "assets"), { recursive: true });
    writeFileSync(
      join(tempDir, "pelican-bicycle.html"),
      '<!doctype html><html><head><link rel="stylesheet" href="./assets/style.css"></head><body><svg></svg></body></html>',
      "utf8",
    );
    writeFileSync(join(tempDir, "assets", "style.css"), "body { background: #10202c; }", "utf8");

    const token = "p".repeat(32);
    host = createHost({
      version: "0.5.0-test",
      dataDir: tempDir,
      plugins: [
        [WebServer, { pageOrigins: ["http://tauri.localhost"] }],
        [RpcGateway, { token }],
        [Sessions],
        [Tools],
        [workbenchRpc],
      ],
    });
    await host.start();
    const port = await host.ctx.webServer.listen(0);
    expect(port).toBeGreaterThan(0);

    // Call `workbench.previewUrl` over JSON-RPC WebSocket endpoint.
    const rpcResult = await new Promise<WorkbenchPreviewUrlResult>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, clientSubprotocols(token));
      ws.on("error", reject);
      ws.on("open", () => {
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "0.0.0" } },
        }));
      });
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as { id?: number; result?: WorkbenchPreviewUrlResult; error?: { message: string } };
        if (msg.id === 1) {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "workbench.previewUrl",
            params: { cwd: tempDir, path: "pelican-bicycle.html" },
          }));
        } else if (msg.id === 2) {
          ws.close();
          if (msg.error) reject(new Error(msg.error.message));
          else if (msg.result) resolve(msg.result);
          else reject(new Error("missing result"));
        }
      });
    });
    expect(rpcResult.path).toBe("pelican-bicycle.html");
    const previewUrl = rpcResult.url;
    if (!previewUrl) throw new Error("expected loopback preview URL");
    expect(previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/preview\/[A-Za-z0-9_-]+\/pelican-bicycle\.html$/);

    // Fetch HTML without needing bearer header (capability-scoped for iframe).
    const htmlRes = await fetch(previewUrl);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("content-type")).toContain("text/html");
    expect(htmlRes.headers.get("cache-control")).toBe("no-store");
    expect(await htmlRes.text()).toContain("./assets/style.css");

    // Relative asset resolves seamlessly against the HTML preview URL.
    const cssUrl = new URL("./assets/style.css", previewUrl).toString();
    const cssRes = await fetch(cssUrl);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toContain("text/css");
    expect(await cssRes.text()).toContain("#10202c");

    // Forged capability token is rejected.
    const badCapRes = await fetch(`http://127.0.0.1:${port}/preview/invalidcap/pelican-bicycle.html`);
    expect(badCapRes.status).toBe(404);

    // `sidebar_open(target: "preview", path: "pelican-bicycle.html")` auto-mints a loopback URL.
    const broadcasted: Array<{ method: string; params: unknown }> = [];
    const origBroadcast = host.ctx.rpc.broadcast.bind(host.ctx.rpc);
    host.ctx.rpc.broadcast = (method: string, params: unknown) => {
      broadcasted.push({ method, params });
      origBroadcast(method, params);
    };
    const session = host.ctx.sessions.create({ cwd: tempDir });
    const previewToolRes = await host.ctx.tools.execute(
      { id: "c-prev", name: "sidebar_open", args: { target: "preview", path: "pelican-bicycle.html" } },
      { sessionId: session.id, cwd: tempDir, signal: new AbortController().signal },
    );
    expect(previewToolRes.isError).toBeUndefined();
    const lastBroadcast = broadcasted.at(-1)?.params as WorkbenchOpenNotification;
    expect(lastBroadcast.target).toBe("preview");
    expect(lastBroadcast.url).toBe(previewUrl);
  });
});
