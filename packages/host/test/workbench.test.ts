import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkbenchOpenNotification } from "@pid/protocol";
import { Sessions } from "@pid/session";
import { Tools } from "@pid/tools";
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
});
