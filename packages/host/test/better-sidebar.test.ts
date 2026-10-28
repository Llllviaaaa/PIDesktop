import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

async function startHost(): Promise<string> {
  dataDir = mkdtempSync(join(tmpdir(), "pid-host-sidebar-"));
  host = createHost({
    version: "0",
    dataDir,
    plugins: [
      [WebServer, { pageOrigins: [pageOrigin] }],
      [betterSidebar, { dataDir }],
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
});
