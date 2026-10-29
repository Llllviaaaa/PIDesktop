import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Sessions, type Session } from "@pid/session";
import { Tools, type ToolOutput } from "@pid/tools";
import { Ui } from "@pid/ui";
import * as browserPlugin from "../src/index.ts";
import { browserTools, keyEvent, normalizeUrl, parseElementRef, resolveWorkspacePath, type Browser, type Config, type PageSnapshot } from "../src/index.ts";

const text = (output: ToolOutput) => output.content.map((block) => (block.type === "text" ? block.text : `[${block.mimeType}]`)).join("\n");

describe("driver helpers", () => {
  it("normalizes URLs, refs, keys and workspace paths", () => {
    expect(normalizeUrl("example.com/a")).toBe("https://example.com/a");
    expect(() => normalizeUrl("file:///C:/x")).toThrow("Only http and https");
    expect([parseElementRef("e12"), parseElementRef(3), parseElementRef("x")]).toEqual([12, 3, undefined]);
    expect(keyEvent("Ctrl+Shift+a")).toMatchObject({ key: "a", code: "KeyA", modifiers: 10 });
    const root = join(tmpdir(), "ws");
    expect(resolveWorkspacePath("a.txt", root)).toBe(join(root, "a.txt"));
    expect(() => resolveWorkspacePath("../b.txt", root)).toThrow("outside the workspace");
    expect(() => resolveWorkspacePath("a.txt")).toThrow("require a workspace root");
  });
});

const page = (title: string): PageSnapshot => ({ url: "https://example.com/", title, text: "hello", elements: [{ ref: 1, tag: "button", text: "Go" }] });

function fakeBrowser(): Browser & { calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => async (...args: unknown[]) => {
    calls.push(`${name}(${args.filter((arg) => arg !== undefined).map((arg) => JSON.stringify(arg)).join(",")})`);
    return page(name);
  };
  return {
    calls,
    ensureStarted: async () => {},
    listTabs: async () => [{ id: "t1", title: "Tab", url: "about:blank", active: true }],
    newTab: async () => ({ tabs: [], snapshot: page("new") }),
    switchTab: async (id: string) => {
      calls.push(`switch(${id})`);
      return { tabs: [], snapshot: page("switched") };
    },
    closeTab: async () => ({ tabs: [], snapshot: page("closed") }),
    navigate: record("navigate"),
    inspect: record("inspect"),
    click: record("click"),
    clickAt: record("clickAt"),
    type: record("type"),
    press: record("press"),
    select: record("select"),
    upload: record("upload"),
    scroll: record("scroll"),
    wait: record("wait"),
    screenshot: async () => ({ data: "PNG", snapshot: page("after") }),
    close: async () => {
      calls.push("close");
    },
  } as unknown as Browser & { calls: string[] };
}

async function withFake(options: { answer?: boolean; mode?: string; config?: Config } = {}) {
  const ctx = new Context();
  await ctx.plugin(Sessions);
  await ctx.plugin(Ui);
  await ctx.plugin(Tools);
  const mode = options.mode;
  if (mode !== undefined) ctx.provide("permissions", { modes: () => ({ effective: mode }) });
  const asked: string[] = [];
  const answer = options.answer;
  if (answer !== undefined) {
    ctx.ui.attach({
      request: ({ requestId, request }) => {
        asked.push(request.kind === "confirm" ? request.message : request.kind);
        queueMicrotask(() => ctx.ui.respond(requestId, answer));
      },
      cancel: () => {},
      notify: () => {},
    });
  }
  const browsers = new Map<string, ReturnType<typeof fakeBrowser>>();
  const { tools, closeAll } = browserTools(ctx, options.config ?? {}, ({ id }) => {
    const created = fakeBrowser();
    browsers.set(id, created);
    return created;
  });
  for (const definition of tools) ctx.tools.register(definition);
  const sessions: Session[] = [ctx.sessions.create({ cwd: "/a" }), ctx.sessions.create({ cwd: "/b" })];
  const call = (name: string, args: Record<string, unknown>, index = 0) =>
    ctx.tools.execute({ id: "1", name, args }, { sessionId: sessions[index]?.id ?? "", cwd: sessions[index]?.header.cwd ?? "", signal: new AbortController().signal });
  return { ctx, call, asked, browsers, sessions, closeAll };
}

describe("browser tools", () => {
  it("confirm interactive actions, keep one browser per session and stream page changes", async () => {
    const { ctx, call, asked, browsers, sessions } = await withFake({ answer: true });
    const live: unknown[] = [];
    ctx.on("session/delta", (_session, _seq, delta) => void live.push(delta));
    expect(text(await call("browser_navigate", { url: "example.com" }))).toContain("Title: after");
    expect(text(await call("browser_click", { ref: "e1", tabId: "t2" }))).toContain("[image/png]");
    expect(await call("browser_inspect", {})).toMatchObject({ details: { action: "inspect" } });
    await call("browser_tabs", { action: "list" }, 1);
    expect(asked).toEqual(["Open example.com", "Click e1"]);
    expect(browsers.get(sessions[0]?.id ?? "")?.calls).toEqual(["navigate(\"example.com\")", "switch(t2)", "click(1)", "inspect()"]);
    expect(browsers.size).toBe(2);
    expect(live).toContainEqual({ type: "browser", url: "https://example.com/", title: "after" });
  });

  it("refuse when denied, in read-only sessions, and on bad input", async () => {
    const denied = await withFake({ answer: false });
    expect(text(await denied.call("browser_type", { text: "secret" }))).toBe("Browser action denied by user");
    expect(text(await denied.call("browser_click", {}))).toBe("browser_click requires a ref from browser_inspect or x/y coordinates");
    expect(text(await denied.call("browser_scroll", {}))).toBe("browser_scroll requires a non-zero deltaX or deltaY");

    const readOnly = await withFake({ answer: true, mode: "read-only" });
    expect(text(await readOnly.call("browser_press", { key: "Enter" }))).toBe("Interactive browser actions are disabled in read-only mode");
    expect(readOnly.asked).toEqual([]);

    const full = await withFake({ mode: "full-access" });
    expect((await full.call("browser_select", { selector: "#c", value: "two" })).isError).toBeUndefined();
  });

  it("close an idle session's browser and all of them on shutdown", async () => {
    vi.useFakeTimers();
    try {
      const { call, browsers, sessions, closeAll } = await withFake({ mode: "full-access", config: { idleMinutes: 1 } });
      await call("browser_inspect", {});
      await call("browser_inspect", {}, 1);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(browsers.get(sessions[0]?.id ?? "")?.calls.at(-1)).toBe("close");
      await call("browser_inspect", {});
      await closeAll();
      expect([...browsers.values()].every((browser) => browser.calls.at(-1) === "close")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("with a real browser", () => {
  let server: Server;
  let origin = "";
  let workspace = "";
  beforeAll(async () => {
    workspace = mkdtempSync(join(tmpdir(), "pid-browser-"));
    writeFileSync(join(workspace, "upload.txt"), "upload me");
    server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Harness browser</title>
        <button onclick="document.querySelector('#status').textContent='clicked'">Run</button>
        <input id="name" aria-label="Name" />
        <input id="file" type="file" aria-label="File" onchange="document.querySelector('#status').textContent=this.files[0]?.name" />
        <div id="status">idle</div>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it("drives a page through the tools, with uploads confined to the session's directory", async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Ui);
    await ctx.plugin(Tools);
    ctx.provide("permissions", { modes: () => ({ effective: "full-access" }) });
    await ctx.plugin(browserPlugin, { headless: true });
    const session = ctx.sessions.create({ cwd: workspace });
    const call = (name: string, args: Record<string, unknown>) =>
      ctx.tools.execute({ id: "1", name, args }, { sessionId: session.id, cwd: workspace, signal: new AbortController().signal });
    try {
      expect(text(await call("browser_navigate", { url: origin }))).toContain("Title: Harness browser");
      const inspected = text(await call("browser_inspect", {}));
      const button = /\[e(\d+)\] <button>/.exec(inspected)?.[1];
      const file = /\[e(\d+)\] <input[^>]*> File/.exec(inspected)?.[1];
      expect(text(await call("browser_click", { ref: `e${button}` }))).toContain("clicked");
      expect(text(await call("browser_upload", { ref: `e${file}`, filePath: "upload.txt" }))).toContain("upload.txt");
      expect(text(await call("browser_upload", { ref: `e${file}`, filePath: "../outside.txt" }))).toContain("outside the workspace");
      expect(text(await call("browser_tabs", { action: "list" }))).toContain(origin);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
