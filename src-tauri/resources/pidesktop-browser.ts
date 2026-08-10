import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type BrowserAction = "open" | "inspect" | "click" | "type" | "screenshot" | "close";

interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: Array<{ ref: number; tag: string; text: string; href?: string; placeholder?: string }>;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class CdpClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly waiters = new Map<string, Set<(params: unknown) => void>>();

  async connect(url: string): Promise<void> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to browser")), 10_000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Could not connect to browser debugging endpoint"));
      }, { once: true });
    });
    socket.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    socket.addEventListener("close", () => this.rejectPending(new Error("Browser connection closed")));
    this.socket = socket;
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Browser is not connected");
    }
    const id = this.nextId++;
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  waitFor(method: string, timeoutMs = 15_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.get(method)?.delete(complete);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const complete = (params: unknown) => {
        clearTimeout(timeout);
        this.waiters.get(method)?.delete(complete);
        resolve(params);
      };
      const listeners = this.waiters.get(method) ?? new Set();
      listeners.add(complete);
      this.waiters.set(method, listeners);
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  private handleMessage(raw: string): void {
    let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Browser command failed"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const listener of this.waiters.get(message.method) ?? []) listener(message.params);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

class BrowserSession {
  private process: ChildProcess | null = null;
  private dataDir: string | null = null;
  private readonly cdp = new CdpClient();

  async ensureStarted(headless: boolean): Promise<void> {
    if (this.process && this.process.exitCode === null) return;
    const executable = findBrowserExecutable();
    this.dataDir = await mkdtemp(join(tmpdir(), "pidesktop-browser-"));
    const args = [
      "--remote-debugging-port=0",
      `--user-data-dir=${this.dataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--window-size=1280,900",
      ...(headless ? ["--headless=new", "--disable-gpu"] : []),
      "about:blank",
    ];
    this.process = spawn(executable, args, { windowsHide: true, stdio: "ignore" });
    const port = await waitForDevToolsPort(this.dataDir, this.process);
    const targets = await waitForTargets(port);
    const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) throw new Error("Browser did not expose a debuggable page");
    await this.cdp.connect(page.webSocketDebuggerUrl);
    await Promise.all([this.cdp.send("Page.enable"), this.cdp.send("Runtime.enable")]);
  }

  async navigate(url: string): Promise<PageSnapshot> {
    const target = normalizeUrl(url);
    const loaded = this.cdp.waitFor("Page.loadEventFired").catch(() => undefined);
    await this.cdp.send("Page.navigate", { url: target });
    await loaded;
    return this.inspect();
  }

  async inspect(): Promise<PageSnapshot> {
    const expression = `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const candidates = Array.from(document.querySelectorAll("a,button,input,textarea,select,[role='button'],[contenteditable='true']"));
      const elements = candidates.slice(0, 120).map((element, index) => {
        const ref = index + 1;
        element.setAttribute("data-pidesktop-ref", String(ref));
        const tag = element.tagName.toLowerCase();
        const text = clean(element.innerText || element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("name") || element.getAttribute("placeholder"));
        const href = element instanceof HTMLAnchorElement ? element.href : undefined;
        const placeholder = element.getAttribute("placeholder") || undefined;
        return { ref, tag, text: text.slice(0, 180), href, placeholder };
      });
      return {
        url: location.href,
        title: document.title,
        text: clean(document.body?.innerText).slice(0, 16000),
        elements,
      };
    })()`;
    const response = await this.cdp.send<{ result?: { value?: PageSnapshot } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (!response.result?.value) throw new Error("Could not inspect the current page");
    return response.result.value;
  }

  async click(ref?: number, selector?: string): Promise<PageSnapshot> {
    const expression = elementExpression(ref, selector, `
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return true;
    `);
    await evaluateBoolean(this.cdp, expression, "Could not click the requested element");
    await delay(700);
    return this.inspect();
  }

  async type(ref: number | undefined, selector: string | undefined, text: string): Promise<PageSnapshot> {
    const expression = elementExpression(ref, selector, `
      element.scrollIntoView({ block: "center", inline: "center" });
      element.focus();
      if ("value" in element) {
        const prototype = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        if (descriptor?.set) descriptor.set.call(element, "");
        else element.value = "";
        element.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (element.isContentEditable) {
        element.textContent = "";
      }
      return true;
    `);
    await evaluateBoolean(this.cdp, expression, "Could not focus the requested element");
    await this.cdp.send("Input.insertText", { text });
    await delay(200);
    return this.inspect();
  }

  async screenshot(): Promise<{ data: string; snapshot: PageSnapshot }> {
    const [capture, snapshot] = await Promise.all([
      this.cdp.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      }),
      this.inspect(),
    ]);
    return { data: capture.data, snapshot };
  }

  async close(): Promise<void> {
    this.cdp.close();
    const child = this.process;
    this.process = null;
    if (child?.pid && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 3_000);
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("close", () => { clearTimeout(timeout); resolve(); });
          killer.once("error", () => { clearTimeout(timeout); resolve(); });
        } else {
          child.once("close", () => { clearTimeout(timeout); resolve(); });
          child.kill("SIGTERM");
        }
      });
    }
    const directory = this.dataDir;
    this.dataDir = null;
    const expectedPrefix = join(tmpdir(), "pidesktop-browser-");
    if (directory?.startsWith(expectedPrefix)) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function findBrowserExecutable(): string {
  const configured = process.env.PIDESKTOP_BROWSER_EXECUTABLE?.trim();
  const candidates = [
    configured,
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/microsoft-edge",
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("No supported Edge, Chrome, or Chromium installation was found");
  return executable;
}

async function waitForDevToolsPort(directory: string, child: ChildProcess): Promise<number> {
  const activePort = join(directory, "DevToolsActivePort");
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Browser exited during startup (${child.exitCode})`);
    try {
      const [port] = (await readFile(activePort, "utf8")).split(/\r?\n/);
      const parsed = Number(port);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    } catch {
      // The browser creates this file after its debugging endpoint is ready.
    }
    await delay(100);
  }
  throw new Error("Timed out starting browser debugging endpoint");
}

async function waitForTargets(port: number): Promise<Array<{ type?: string; webSocketDebuggerUrl?: string }>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) return await response.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
    } catch {
      // Retry while the browser finishes starting.
    }
    await delay(100);
  }
  throw new Error("Could not enumerate browser pages");
}

function normalizeUrl(value: string): string {
  const input = value.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Only http and https pages are supported");
  return parsed.toString();
}

function elementExpression(ref: number | undefined, selector: string | undefined, operation: string): string {
  if (!ref && !selector?.trim()) throw new Error("Provide an element ref from inspect or a CSS selector");
  const lookup = ref
    ? `document.querySelector('[data-pidesktop-ref="${ref}"]')`
    : `document.querySelector(${JSON.stringify(selector?.trim())})`;
  return `(() => {
    const element = ${lookup};
    if (!element) return false;
    ${operation}
  })()`;
}

async function evaluateBoolean(cdp: CdpClient, expression: string, message: string): Promise<void> {
  const response = await cdp.send<{ result?: { value?: boolean }; exceptionDetails?: unknown }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (!response.result?.value || response.exceptionDetails) throw new Error(message);
}

function snapshotText(snapshot: PageSnapshot): string {
  const elements = snapshot.elements
    .map((element) => `[${element.ref}] <${element.tag}> ${element.text || element.placeholder || "(no label)"}${element.href ? ` -> ${element.href}` : ""}`)
    .join("\n");
  return `URL: ${snapshot.url}\nTitle: ${snapshot.title || "(untitled)"}\n\nPage text:\n${snapshot.text || "(empty)"}\n\nInteractive elements:\n${elements || "(none)"}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI) {
  const browser = new BrowserSession();
  const headless = process.env.PIDESKTOP_BROWSER_HEADLESS !== "0";
  const confirmActions = process.env.PIDESKTOP_BROWSER_CONFIRM !== "0";
  const permissionMode = process.env.PIDESKTOP_PERMISSION_MODE || "ask";

  pi.registerTool({
    name: "browser",
    label: "Browser",
    description: "Open and inspect web pages in an isolated local Edge/Chrome session, click elements, type text, and capture screenshots.",
    promptSnippet: "Open, inspect, interact with, and screenshot web pages",
    promptGuidelines: [
      "Use browser when the user asks to inspect or interact with a web page; call inspect after navigation to obtain current element refs.",
      "Never use browser type for passwords, API keys, payment data, or other secrets unless the user explicitly provides and authorizes that exact input.",
    ],
    parameters: Type.Object({
      action: StringEnum(["open", "inspect", "click", "type", "screenshot", "close"] as const),
      url: Type.Optional(Type.String({ description: "HTTP(S) URL for the open action" })),
      ref: Type.Optional(Type.Integer({ minimum: 1, description: "Element ref returned by inspect" })),
      selector: Type.Optional(Type.String({ description: "CSS selector when no ref is available" })),
      text: Type.Optional(Type.String({ description: "Text for the type action" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const action = params.action as BrowserAction;
      signal?.throwIfAborted();
      if (action === "close") {
        await browser.close();
        ctx.ui.setStatus("pidesktop-browser", undefined);
        return { content: [{ type: "text", text: "Browser session closed." }], details: { action } };
      }

      if (permissionMode === "read-only" && ["click", "type"].includes(action)) {
        throw new Error("Interactive browser actions are disabled in read-only mode");
      }

      if (confirmActions && ["open", "click", "type"].includes(action)) {
        const summary = action === "open"
          ? `Open ${params.url || "the requested page"}`
          : action === "type"
            ? `Type into element ${params.ref || params.selector || "(unknown)"}`
            : `Click element ${params.ref || params.selector || "(unknown)"}`;
        const allowed = await ctx.ui.confirm("Allow browser action?", summary);
        if (!allowed) throw new Error("Browser action denied by user");
      }

      onUpdate?.({ content: [{ type: "text", text: `Browser: ${action}…` }], details: { action } });
      await browser.ensureStarted(headless);
      signal?.throwIfAborted();

      if (action === "screenshot") {
        const capture = await browser.screenshot();
        ctx.ui.setStatus("pidesktop-browser", capture.snapshot.title || capture.snapshot.url);
        return {
          content: [
            { type: "text", text: `Screenshot captured.\nURL: ${capture.snapshot.url}\nTitle: ${capture.snapshot.title || "(untitled)"}` },
            { type: "image", data: capture.data, mimeType: "image/png" },
          ],
          details: { action, url: capture.snapshot.url, title: capture.snapshot.title },
        };
      }

      let snapshot: PageSnapshot;
      if (action === "open") {
        if (!params.url) throw new Error("The open action requires url");
        snapshot = await browser.navigate(params.url);
      } else if (action === "click") {
        snapshot = await browser.click(params.ref, params.selector);
      } else if (action === "type") {
        if (typeof params.text !== "string") throw new Error("The type action requires text");
        snapshot = await browser.type(params.ref, params.selector, params.text);
      } else {
        snapshot = await browser.inspect();
      }
      ctx.ui.setStatus("pidesktop-browser", snapshot.title || snapshot.url);
      return {
        content: [{ type: "text", text: snapshotText(snapshot) }],
        details: { action, url: snapshot.url, title: snapshot.title, elementCount: snapshot.elements.length },
      };
    },
  });

  pi.registerCommand("browser-diagnose", {
    description: "启动隔离浏览器并验证页面检查与截图能力",
    handler: async (args, ctx) => {
      const target = args.trim() || "https://example.com";
      ctx.ui.setStatus("pidesktop-browser", "正在检查浏览器…");
      try {
        await browser.ensureStarted(headless);
        const snapshot = await browser.navigate(target);
        const capture = await browser.screenshot();
        ctx.ui.setStatus("pidesktop-browser", snapshot.title || snapshot.url);
        ctx.ui.notify(
          `浏览器检查通过：${snapshot.title || snapshot.url}，截图 ${Math.round(capture.data.length * 0.75 / 1024)} KB`,
          "info",
        );
      } catch (error) {
        ctx.ui.setStatus("pidesktop-browser", undefined);
        ctx.ui.notify(`浏览器检查失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await browser.close();
  });
}
