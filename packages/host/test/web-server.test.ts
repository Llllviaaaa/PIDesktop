import { afterEach, describe, expect, it } from "vitest";
import { WebServer, createHost, type Host } from "../src/index.ts";
import { parseOptions } from "../src/main.ts";

const pageOrigin = "http://tauri.localhost";
let host: Host | undefined;

afterEach(async () => {
  await host?.stop();
  host = undefined;
});

async function startHost(): Promise<string> {
  host = createHost({ version: "0", dataDir: "unused", plugins: [[WebServer, { pageOrigins: [pageOrigin] }]] });
  await host.start();
  host.ctx.webServer.register({
    kind: "prefix",
    path: "/files",
    handler: (req, res) => {
      res.end(`prefix ${req.headers["sec-fetch-site"] ?? "none"}`);
    },
  });
  host.ctx.webServer.register({ kind: "exact", path: "/files/exact", handler: (_req, res) => void res.end("exact") });
  host.ctx.webServer.register({ kind: "exact", path: "/boom", handler: () => Promise.reject(new Error("boom")) });
  const port = await host.ctx.webServer.listen(0);
  return `http://127.0.0.1:${port}`;
}

describe("webServer", () => {
  it("routes exact paths before the longest prefix", async () => {
    const base = await startHost();
    expect(await (await fetch(`${base}/files/exact`)).text()).toBe("exact");
    expect(await (await fetch(`${base}/files/a/b`)).text()).toBe("prefix none");
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
  });

  it("presents the page's requests as same-origin and answers CORS", async () => {
    const base = await startHost();
    const response = await fetch(`${base}/files/x`, { headers: { origin: pageOrigin } });
    expect(response.headers.get("access-control-allow-origin")).toBe(pageOrigin);
    expect(await response.text()).toBe("prefix same-origin");

    const preflight = await fetch(`${base}/files/x`, { method: "OPTIONS", headers: { origin: pageOrigin } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("refuses other browser origins, by Origin or by Referer", async () => {
    const base = await startHost();
    expect((await fetch(`${base}/files/x`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/files/x`, { headers: { referer: "https://evil.example/page" } })).status).toBe(403);
  });

  it("answers a failing route with 500 and stays up", async () => {
    const base = await startHost();
    expect((await fetch(`${base}/boom`)).status).toBe(500);
    expect((await fetch(`${base}/files/exact`)).status).toBe(200);
  });

  it("stops listening when the host stops", async () => {
    const base = await startHost();
    await host?.stop();
    host = undefined;
    await expect(fetch(`${base}/files/exact`)).rejects.toThrow();
  });
});

describe("parseOptions", () => {
  it("reads the sidecar-compatible flags", () => {
    expect(parseOptions(["--data-dir", "D:/data", "--port", "47100", "--page-origin", "a", "--page-origin", "b", "--exit-with-stdin"]))
      .toEqual({ dataDir: "D:/data", port: 47100, pageOrigins: ["a", "b"], exitWithStdin: true });
  });

  it("rejects missing or malformed values", () => {
    expect(() => parseOptions([])).toThrow("--data-dir");
    expect(() => parseOptions(["--data-dir", "d", "--port", "70000"])).toThrow("--port");
    expect(() => parseOptions(["--data-dir"])).toThrow("needs a value");
    expect(() => parseOptions(["--data-dir", "d", "--token", "x"])).toThrow("unknown argument");
  });
});
