import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

type BrowserAction =
  | "open"
  | "inspect"
  | "list_tabs"
  | "new_tab"
  | "switch_tab"
  | "close_tab"
  | "back"
  | "forward"
  | "reload"
  | "hover"
  | "click"
  | "type"
  | "press"
  | "select"
  | "upload"
  | "download"
  | "scroll"
  | "wait"
  | "screenshot"
  | "close";

interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: Array<{
    ref: number;
    tag: string;
    role?: string;
    text: string;
    href?: string;
    placeholder?: string;
    value?: string;
    checked?: boolean;
    disabled?: boolean;
  }>;
}

interface BrowserTarget {
  id?: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

class CdpClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly waiters = new Map<string, Set<(params: unknown) => void>>();

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

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

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Browser is not connected");
    }
    const id = this.nextId++;
    const response = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out running browser command ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
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
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.rejectPending(new Error("Browser connection closed"));
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
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message || "Browser command failed"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const listener of this.waiters.get(message.method) ?? []) listener(message.params);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class BrowserSession {
  private process: ChildProcess | null = null;
  private dataDir: string | null = null;
  private port: number | null = null;
  private targetId: string | null = null;
  private persistentProfile = false;
  private profileLockPath: string | null = null;
  private readonly cdp = new CdpClient();

  async ensureStarted(headless: boolean): Promise<void> {
    if (this.cdp.connected) return;
    if (this.port) {
      try {
        const targets = await waitForTargets(this.port, 5);
        const page = targets.find((target) => target.id === this.targetId)
          ?? targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page) {
          await this.connectTarget(page);
          return;
        }
      } catch {
        // Start a fresh browser below when the previous debugging endpoint is gone.
      }
    }
    await this.close();
    const executable = findBrowserExecutable();
    const persistentDirectory = process.env.PIDESKTOP_BROWSER_PROFILE_DIR?.trim();
    this.persistentProfile = Boolean(persistentDirectory);
    this.dataDir = persistentDirectory
      ? resolve(persistentDirectory)
      : await mkdtemp(join(tmpdir(), "pidesktop-browser-"));
    await mkdir(this.dataDir, { recursive: true });

    if (this.persistentProfile) {
      this.profileLockPath = await acquireProfileLock(this.dataDir);
      await unlink(join(this.dataDir, "DevToolsActivePort")).catch(() => undefined);
    }
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
    try {
      this.process = spawn(executable, args, { windowsHide: true, stdio: "ignore" });
      this.port = await waitForDevToolsPort(this.dataDir, this.process);
      const targets = await waitForTargets(this.port);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (!page?.webSocketDebuggerUrl) throw new Error("Browser did not expose a debuggable page");
      await this.connectTarget(page);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async listTabs(): Promise<BrowserTab[]> {
    if (!this.port) throw new Error("Browser debugging endpoint is unavailable");
    const targets = await waitForTargets(this.port, 5);
    return targets
      .filter((target): target is BrowserTarget & { id: string } => target.type === "page" && Boolean(target.id))
      .map((target) => ({
        id: target.id,
        title: target.title || "(untitled)",
        url: target.url || "about:blank",
        active: target.id === this.targetId,
      }));
  }

  async newTab(url?: string): Promise<{ tabs: BrowserTab[]; snapshot: PageSnapshot }> {
    const targetUrl = url?.trim() ? normalizeUrl(url) : "about:blank";
    const created = await this.cdp.send<{ targetId?: string }>("Target.createTarget", { url: targetUrl });
    if (!created.targetId) throw new Error("Browser did not return the new tab identifier");
    const target = await waitForTarget(this.port, created.targetId);
    await this.connectTarget(target);
    await this.settle();
    return { tabs: await this.listTabs(), snapshot: await this.inspect() };
  }

  async switchTab(tabId: string): Promise<{ tabs: BrowserTab[]; snapshot: PageSnapshot }> {
    const target = await waitForTarget(this.port, tabId);
    await this.connectTarget(target);
    await this.cdp.send("Page.bringToFront").catch(() => undefined);
    await this.waitForReadyState();
    return { tabs: await this.listTabs(), snapshot: await this.inspect() };
  }

  async closeTab(tabId?: string): Promise<{ tabs: BrowserTab[]; snapshot: PageSnapshot }> {
    const id = tabId?.trim() || this.targetId;
    if (!id) throw new Error("The close_tab action requires a tabId or an active tab");
    const currentTabs = await this.listTabs();
    if (currentTabs.length <= 1) throw new Error("Cannot close the only browser tab; use the close action to end the session");
    await this.cdp.send("Target.closeTarget", { targetId: id }).catch((error) => {
      if (!isRecoverableBrowserError(error)) throw error;
    });
    if (id === this.targetId) this.cdp.close();
    const remaining = (await waitForTargets(this.requiredPort(), 20))
      .filter((target) => target.type === "page" && target.id !== id && target.webSocketDebuggerUrl);
    const next = remaining[0];
    if (!next) throw new Error("Browser did not retain another tab");
    if (!this.cdp.connected || id === this.targetId) await this.connectTarget(next);
    return { tabs: await this.listTabs(), snapshot: await this.inspect() };
  }

  async navigate(url: string): Promise<PageSnapshot> {
    const target = normalizeUrl(url);
    const loaded = this.cdp.waitFor("Page.loadEventFired", 20_000).catch(() => undefined);
    const response = await this.cdp.send<{ errorText?: string }>("Page.navigate", { url: target });
    if (response.errorText) throw new Error(`Browser navigation failed: ${response.errorText}`);
    await this.settle(loaded);
    return this.inspect();
  }

  async history(direction: "back" | "forward"): Promise<PageSnapshot> {
    const history = await this.cdp.send<{ currentIndex: number; entries: Array<{ id: number }> }>("Page.getNavigationHistory");
    const targetIndex = history.currentIndex + (direction === "back" ? -1 : 1);
    const entry = history.entries[targetIndex];
    if (!entry) throw new Error(`No page is available to navigate ${direction}`);
    const loaded = this.cdp.waitFor("Page.loadEventFired", 15_000).catch(() => undefined);
    await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    await this.settle(loaded);
    return this.inspect();
  }

  async reload(): Promise<PageSnapshot> {
    const loaded = this.cdp.waitFor("Page.loadEventFired", 20_000).catch(() => undefined);
    await this.cdp.send("Page.reload", { ignoreCache: false });
    await this.settle(loaded);
    return this.inspect();
  }

  async inspect(): Promise<PageSnapshot> {
    const expression = `(() => {
      const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const candidates = Array.from(document.querySelectorAll("a,button,input,textarea,select,summary,[role],[tabindex],[contenteditable='true']"))
        .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
      const elements = candidates.slice(0, 300).map((element, index) => {
        const ref = index + 1;
        element.setAttribute("data-pidesktop-ref", String(ref));
        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute("role") || undefined;
        const text = clean(element.innerText || element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("name") || element.getAttribute("placeholder"));
        const href = element instanceof HTMLAnchorElement ? element.href : undefined;
        const placeholder = element.getAttribute("placeholder") || undefined;
        const value = "value" in element ? clean(element.value).slice(0, 180) : undefined;
        const checked = "checked" in element ? Boolean(element.checked) : undefined;
        const disabled = "disabled" in element ? Boolean(element.disabled) : element.getAttribute("aria-disabled") === "true";
        return { ref, tag, role, text: text.slice(0, 180), href, placeholder, value, checked, disabled };
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
    const point = await elementPoint(this.cdp, ref, selector);
    const loaded = this.cdp.waitFor("Page.loadEventFired", 5_000).catch(() => undefined);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await this.settle(loaded);
    return this.inspect();
  }

  async hover(ref?: number, selector?: string): Promise<PageSnapshot> {
    const point = await elementPoint(this.cdp, ref, selector);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await delay(250);
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
    await this.settle();
    return this.inspect();
  }

  async press(key: string, ref?: number, selector?: string): Promise<PageSnapshot> {
    if (ref || selector?.trim()) {
      await evaluateBoolean(this.cdp, elementExpression(ref, selector, `
        element.scrollIntoView({ block: "center", inline: "center" });
        element.focus();
        return true;
      `), "Could not focus the requested element");
    }
    const event = keyEvent(key);
    const loaded = this.cdp.waitFor("Page.loadEventFired", 5_000).catch(() => undefined);
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event, text: undefined });
    await this.settle(loaded);
    return this.inspect();
  }

  async select(ref: number | undefined, selector: string | undefined, value: string): Promise<PageSnapshot> {
    const expression = elementExpression(ref, selector, `
      if (!(element instanceof HTMLSelectElement)) return false;
      const requested = ${JSON.stringify(value)};
      const option = Array.from(element.options).find((candidate) => candidate.value === requested || candidate.label === requested || candidate.text === requested);
      if (!option) return false;
      element.value = option.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    `);
    await evaluateBoolean(this.cdp, expression, "Could not select the requested option");
    await this.settle();
    return this.inspect();
  }

  async upload(ref: number | undefined, selector: string | undefined, paths: string[]): Promise<PageSnapshot> {
    if (paths.length === 0) throw new Error("The upload action requires at least one file path");
    const files = await Promise.all(paths.map(async (value) => {
      const file = resolveWorkspacePath(value);
      const metadata = await stat(file).catch(() => null);
      if (!metadata?.isFile()) throw new Error(`Upload file does not exist or is not a file: ${value}`);
      return file;
    }));
    const expression = elementExpression(ref, selector, `
      if (!(element instanceof HTMLInputElement) || element.type !== "file") return false;
      return element;
    `);
    const evaluated = await this.cdp.send<{ result?: { objectId?: string; value?: false }; exceptionDetails?: unknown }>("Runtime.evaluate", {
      expression,
      returnByValue: false,
      awaitPromise: true,
    });
    const objectId = evaluated.result?.objectId;
    if (!objectId || evaluated.exceptionDetails || evaluated.result?.value === false) {
      throw new Error("The requested element is not an available file input");
    }
    await this.cdp.send("DOM.enable");
    await this.cdp.send("DOM.getDocument", { depth: 0, pierce: true });
    const node = await this.cdp.send<{ nodeId?: number }>("DOM.requestNode", { objectId });
    if (!node.nodeId) throw new Error("Could not resolve the requested file input");
    await this.cdp.send("DOM.setFileInputFiles", { files, nodeId: node.nodeId });
    await this.settle();
    return this.inspect();
  }

  async download(ref: number | undefined, selector: string | undefined, directory = ".pidesktop-downloads"): Promise<{ path: string; snapshot: PageSnapshot }> {
    const destination = resolveWorkspacePath(directory);
    await mkdir(destination, { recursive: true });
    const metadata = await stat(destination);
    if (!metadata.isDirectory()) throw new Error(`Download path is not a directory: ${directory}`);
    const before = new Set(await readdir(destination));
    await this.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: destination, eventsEnabled: true });
    const snapshot = await this.click(ref, selector);
    const path = await waitForDownload(destination, before);
    return { path, snapshot };
  }

  async scroll(deltaX: number, deltaY: number, ref?: number, selector?: string): Promise<PageSnapshot> {
    if (ref || selector?.trim()) {
      await evaluateBoolean(this.cdp, elementExpression(ref, selector, `
        element.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: "instant" });
        return true;
      `), "Could not scroll the requested element");
    } else {
      await this.cdp.send("Runtime.evaluate", {
        expression: `window.scrollBy({ left: ${deltaX}, top: ${deltaY}, behavior: "instant" })`,
      });
    }
    await delay(250);
    return this.inspect();
  }

  async wait(durationMs: number): Promise<PageSnapshot> {
    await delay(durationMs);
    await this.waitForReadyState();
    return this.inspect();
  }

  async screenshot(fullPage = false): Promise<{ data: string; snapshot: PageSnapshot }> {
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    if (fullPage) {
      const metrics = await this.cdp.send<{ cssContentSize?: { width: number; height: number }; contentSize?: { width: number; height: number } }>("Page.getLayoutMetrics");
      const size = metrics.cssContentSize || metrics.contentSize;
      if (size) clip = { x: 0, y: 0, width: Math.min(size.width, 12_000), height: Math.min(size.height, 12_000), scale: 1 };
    }
    const [capture, snapshot] = await Promise.all([
      this.cdp.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: fullPage,
        ...(clip ? { clip } : {}),
      }),
      this.inspect(),
    ]);
    return { data: capture.data, snapshot };
  }

  private requiredPort(): number {
    if (!this.port) throw new Error("Browser debugging endpoint is unavailable");
    return this.port;
  }

  private async connectTarget(target: BrowserTarget): Promise<void> {
    if (!target.id || !target.webSocketDebuggerUrl) throw new Error("Browser tab is not debuggable");
    this.cdp.close();
    await this.cdp.connect(target.webSocketDebuggerUrl);
    this.targetId = target.id;
    await Promise.all([
      this.cdp.send("Page.enable"),
      this.cdp.send("Runtime.enable"),
      this.cdp.send("DOM.enable"),
    ]);
  }

  private async settle(load?: Promise<unknown>): Promise<void> {
    if (load) await Promise.race([load, delay(1_200)]);
    await this.waitForReadyState();
    await delay(200);
  }

  private async waitForReadyState(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const response = await this.cdp.send<{ result?: { value?: string } }>("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      if (response.result?.value === "complete" || response.result?.value === "interactive") return;
      await delay(100);
    }
    throw new Error("Timed out waiting for the page to become interactive");
  }

  async close(): Promise<void> {
    const port = this.port;
    if (port) {
      const browserProcessId = await closeBrowser(port);
      let stopped = await waitForBrowserShutdown(port, 2_000);
      if (!stopped && browserProcessId && process.platform === "win32") {
        await terminateWindowsProcessTree(browserProcessId, false);
        stopped = await waitForBrowserShutdown(port, 3_000);
      }
      if (!stopped && browserProcessId && process.platform === "win32") {
        await terminateWindowsProcessTree(browserProcessId, true);
        await waitForBrowserShutdown(port, 1_000);
      }
    } else if (this.cdp.connected) {
      await this.cdp.send("Browser.close", {}, 3_000).catch(() => undefined);
    }
    this.cdp.close();
    const child = this.process;
    this.process = null;
    if (child?.pid && child.exitCode === null) {
      const exitedCleanly = await waitForChildExit(child, 3_000);
      if (!exitedCleanly) await new Promise<void>((resolve) => {
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
    const removeDirectory = !this.persistentProfile;
    this.dataDir = null;
    this.port = null;
    this.targetId = null;
    this.persistentProfile = false;
    if (directory && removeDirectory) {
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(() => undefined);
    }
    const profileLockPath = this.profileLockPath;
    this.profileLockPath = null;
    if (profileLockPath) await unlink(profileLockPath).catch(() => undefined);
  }
}

export function findBrowserExecutable(): string {
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
  let spawnError: Error | null = null;
  child.once("error", (error) => { spawnError = error; });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (spawnError) throw new Error(`Could not start browser: ${spawnError.message}`);
    try {
      const [port] = (await readFile(activePort, "utf8")).split(/\r?\n/);
      const parsed = Number(port);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    } catch {
      // The browser creates this file after its debugging endpoint is ready.
    }
    if (child.exitCode !== null && child.exitCode !== 0) throw new Error(`Browser exited during startup (${child.exitCode})`);
    await delay(100);
  }
  throw new Error("Timed out starting browser debugging endpoint");
}

async function waitForTargets(port: number, attempts = 50): Promise<BrowserTarget[]> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) return await response.json() as BrowserTarget[];
    } catch {
      // Retry while the browser finishes starting.
    }
    await delay(100);
  }
  throw new Error("Could not enumerate browser pages");
}

async function closeBrowser(port: number): Promise<number | null> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) throw new Error("Browser debugging endpoint did not return version information");
  const version = await response.json() as { webSocketDebuggerUrl?: string };
  if (!version.webSocketDebuggerUrl) throw new Error("Browser debugging endpoint did not provide a browser connection");
  const admin = new CdpClient();
  try {
    await admin.connect(version.webSocketDebuggerUrl);
    const processes = await admin.send<{ processInfo?: Array<{ type?: string; id?: number }> }>("SystemInfo.getProcessInfo").catch(() => ({ processInfo: [] }));
    const browserProcessId = processes.processInfo?.find((processInfo) => processInfo.type === "browser")?.id ?? null;
    await admin.send("Browser.close", {}, 5_000).catch((error) => {
      if (!isRecoverableBrowserError(error)) throw error;
    });
    return browserProcessId;
  } finally {
    admin.close();
  }
}

async function waitForBrowserShutdown(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (!response.ok) return true;
    } catch {
      return true;
    }
    await delay(100);
  }
  return false;
}

function terminateWindowsProcessTree(processId: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ["/PID", String(processId), "/T", ...(force ? ["/F"] : [])];
    const killer = spawn("taskkill", args, { windowsHide: true, stdio: "ignore" });
    const timeout = setTimeout(resolve, 3_000);
    killer.once("close", () => { clearTimeout(timeout); resolve(); });
    killer.once("error", () => { clearTimeout(timeout); resolve(); });
  });
}

async function acquireProfileLock(directory: string): Promise<string> {
  const lockPath = join(directory, ".pidesktop-browser.lock");
  try {
    await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
    return lockPath;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code !== "EEXIST") throw error;
  }

  const activePort = await readFile(join(directory, "DevToolsActivePort"), "utf8")
    .then((raw) => Number(raw.split(/\r?\n/)[0]))
    .catch(() => 0);
  if (activePort > 0) {
    try {
      await waitForTargets(activePort, 3);
      throw new Error("The persistent PIDesktop browser profile is already in use by another task");
    } catch (error) {
      if (error instanceof Error && error.message.includes("already in use")) throw error;
    }
  }

  await unlink(lockPath).catch(() => undefined);
  await writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
  return lockPath;
}

async function waitForTarget(port: number | null, targetId: string): Promise<BrowserTarget> {
  if (!port) throw new Error("Browser debugging endpoint is unavailable");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const target = (await waitForTargets(port, 3)).find((candidate) => candidate.id === targetId && candidate.webSocketDebuggerUrl);
    if (target) return target;
    await delay(100);
  }
  throw new Error(`Browser tab is unavailable: ${targetId}`);
}

export function normalizeUrl(value: string): string {
  const input = value.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Only http and https pages are supported");
  return parsed.toString();
}

export function resolveWorkspacePath(value: string): string {
  const workspace = process.env.PIDESKTOP_WORKSPACE_ROOT?.trim();
  if (!workspace) throw new Error("Browser file actions require a workspace root");
  const root = resolve(workspace);
  const target = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const pathFromRoot = relative(root, target);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error(`Browser file action is outside the workspace: ${value}`);
  }
  return target;
}

async function waitForDownload(directory: string, before: Set<string>): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const entries = await readdir(directory);
    const completed = entries.find((name) => !before.has(name) && !name.endsWith(".crdownload") && !name.endsWith(".tmp"));
    if (completed) return join(directory, completed);
    await delay(100);
  }
  throw new Error("Timed out waiting for the browser download to complete");
}

function isRecoverableBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /browser (?:is not connected|connection closed)|debugging endpoint|websocket|target closed|econnrefused/i.test(message);
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

async function elementPoint(cdp: CdpClient, ref?: number, selector?: string): Promise<{ x: number; y: number }> {
  const expression = elementExpression(ref, selector, `
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  `);
  const point = await evaluateValue<{ x: number; y: number }>(cdp, expression, "Could not locate the requested element");
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("The requested element has invalid screen coordinates");
  return point;
}

async function evaluateValue<T>(cdp: CdpClient, expression: string, message: string): Promise<T> {
  const response = await cdp.send<{ result?: { value?: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.result?.value === undefined || response.result.value === false || response.exceptionDetails) throw new Error(message);
  return response.result.value as T;
}

async function evaluateBoolean(cdp: CdpClient, expression: string, message: string): Promise<void> {
  await evaluateValue<boolean>(cdp, expression, message);
}

function keyEvent(combo: string): { key: string; code: string; windowsVirtualKeyCode: number; nativeVirtualKeyCode: number; modifiers: number; text?: string } {
  const parts = combo.split("+").map((part) => part.trim()).filter(Boolean);
  const keyName = parts.pop();
  if (!keyName) throw new Error("press requires a key or key combination");
  let modifiers = 0;
  for (const modifier of parts) {
    const normalized = modifier.toLowerCase();
    if (normalized === "alt") modifiers |= 1;
    else if (normalized === "ctrl" || normalized === "control") modifiers |= 2;
    else if (normalized === "meta" || normalized === "cmd" || normalized === "win") modifiers |= 4;
    else if (normalized === "shift") modifiers |= 8;
    else throw new Error(`Unsupported key modifier: ${modifier}`);
  }
  const named: Record<string, [string, string, number]> = {
    enter: ["Enter", "Enter", 13], tab: ["Tab", "Tab", 9], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
    space: [" ", "Space", 32], backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46],
    arrowup: ["ArrowUp", "ArrowUp", 38], up: ["ArrowUp", "ArrowUp", 38], arrowdown: ["ArrowDown", "ArrowDown", 40], down: ["ArrowDown", "ArrowDown", 40],
    arrowleft: ["ArrowLeft", "ArrowLeft", 37], left: ["ArrowLeft", "ArrowLeft", 37], arrowright: ["ArrowRight", "ArrowRight", 39], right: ["ArrowRight", "ArrowRight", 39],
    home: ["Home", "Home", 36], end: ["End", "End", 35], pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
  };
  for (let index = 1; index <= 12; index += 1) named[`f${index}`] = [`F${index}`, `F${index}`, 111 + index];
  const lower = keyName.toLowerCase();
  const mapped = named[lower];
  if (mapped) return { key: mapped[0], code: mapped[1], windowsVirtualKeyCode: mapped[2], nativeVirtualKeyCode: mapped[2], modifiers };
  if ([...keyName].length !== 1) throw new Error(`Unsupported browser key: ${keyName}`);
  const upper = keyName.toUpperCase();
  const keyCode = upper.charCodeAt(0);
  const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(upper) ? `Digit${upper}` : keyName;
  return { key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers, text: modifiers === 0 ? keyName : undefined };
}

function snapshotText(snapshot: PageSnapshot): string {
  const elements = snapshot.elements
    .map((element) => {
      const state = [element.role ? `role=${element.role}` : "", element.value ? `value=${JSON.stringify(element.value)}` : "", element.checked !== undefined ? `checked=${element.checked}` : "", element.disabled ? "disabled" : ""].filter(Boolean).join(" ");
      return `[${element.ref}] <${element.tag}${state ? ` ${state}` : ""}> ${element.text || element.placeholder || "(no label)"}${element.href ? ` -> ${element.href}` : ""}`;
    })
    .join("\n");
  return `URL: ${snapshot.url}\nTitle: ${snapshot.title || "(untitled)"}\n\nPage text:\n${snapshot.text || "(empty)"}\n\nInteractive elements:\n${elements || "(none)"}`;
}

function tabsText(tabs: BrowserTab[]): string {
  return tabs.map((tab) => `${tab.active ? "*" : "-"} ${tab.id} · ${tab.title} · ${tab.url}`).join("\n") || "(no tabs)";
}

async function withReadOnlyRecovery<T>(browser: BrowserSession, headless: boolean, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isRecoverableBrowserError(error)) throw error;
    await browser.ensureStarted(headless);
    return run();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const complete = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.off("close", complete);
      resolve(child.exitCode !== null);
    }, timeoutMs);
    child.once("close", complete);
  });
}

export default function (pi: ExtensionAPI) {
  const browser = new BrowserSession();
  const headless = process.env.PIDESKTOP_BROWSER_HEADLESS !== "0";
  const confirmActions = process.env.PIDESKTOP_BROWSER_CONFIRM !== "0";
  const permissionMode = process.env.PIDESKTOP_PERMISSION_MODE || "ask";

  pi.registerTool({
    name: "browser",
    label: "Browser",
    description: "Control an isolated local Edge/Chrome session. Manage tabs, inspect and interact with pages, upload workspace files, download into the workspace, and capture screenshots. Results return the current URL/title plus inspect refs or an image; invalid refs, blocked paths, missing files, timeouts, and closed targets return explicit errors.",
    promptSnippet: "Inspect and control web pages through a resilient CDP browser session",
    promptGuidelines: [
      "Use browser when the user asks to inspect or interact with a web page; call inspect after navigation to obtain current element refs.",
      "Prefer element refs returned by inspect over CSS selectors. Re-inspect after navigation or when a ref is no longer present.",
      "Use list_tabs before switching or closing tabs. Uploads and downloads are confined to the current workspace.",
      "Never use browser type for passwords, API keys, payment data, or other secrets unless the user explicitly provides and authorizes that exact input.",
    ],
    parameters: Type.Object({
      action: StringEnum(["open", "inspect", "list_tabs", "new_tab", "switch_tab", "close_tab", "back", "forward", "reload", "hover", "click", "type", "press", "select", "upload", "download", "scroll", "wait", "screenshot", "close"] as const),
      url: Type.Optional(Type.String({ description: "HTTP(S) URL for open or new_tab" })),
      tabId: Type.Optional(Type.String({ description: "Tab identifier returned by list_tabs" })),
      ref: Type.Optional(Type.Integer({ minimum: 1, description: "Element ref returned by inspect" })),
      selector: Type.Optional(Type.String({ description: "CSS selector when no ref is available" })),
      text: Type.Optional(Type.String({ description: "Text for the type action" })),
      value: Type.Optional(Type.String({ description: "Option value or label for the select action" })),
      paths: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20, description: "Workspace file paths for upload" })),
      path: Type.Optional(Type.String({ description: "Workspace directory for download; defaults to .pidesktop-downloads" })),
      key: Type.Optional(Type.String({ description: "Key or combination such as ENTER, CTRL+L, or SHIFT+TAB" })),
      deltaX: Type.Optional(Type.Integer({ minimum: -12000, maximum: 12000, description: "Horizontal scroll amount; positive scrolls right" })),
      deltaY: Type.Optional(Type.Integer({ minimum: -12000, maximum: 12000, description: "Vertical scroll amount; positive scrolls down" })),
      durationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000, description: "Wait duration in milliseconds" })),
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the full document instead of the viewport" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const action = params.action as BrowserAction;
      signal?.throwIfAborted();
      if (action === "close") {
        await browser.close();
        ctx.ui.setStatus("pidesktop-browser", undefined);
        return { content: [{ type: "text", text: "Browser session closed." }], details: { action } };
      }

      const stateChanging = ["new_tab", "close_tab", "click", "type", "press", "select", "upload", "download"].includes(action);
      if (permissionMode === "read-only" && stateChanging) {
        throw new Error("Interactive browser actions are disabled in read-only mode");
      }

      if (confirmActions && (action === "open" || stateChanging)) {
        const summary = action === "open"
          ? `Open ${params.url || "the requested page"}`
          : action === "new_tab"
            ? `Open a new tab${params.url ? ` at ${params.url}` : ""}`
          : action === "type"
            ? `Type ${String(params.text || "").length} characters into element ${params.ref || params.selector || "(unknown)"}`
            : action === "upload"
              ? `Upload ${(params.paths || []).length} workspace file(s) to element ${params.ref || params.selector || "(unknown)"}`
              : action === "download"
                ? `Download from element ${params.ref || params.selector || "(unknown)"} into ${params.path || ".pidesktop-downloads"}`
            : `${action} element ${params.ref || params.selector || "(current focus)"}`;
        const allowed = await ctx.ui.confirm("Allow browser action?", summary);
        if (!allowed) throw new Error("Browser action denied by user");
      }

      onUpdate?.({ content: [{ type: "text", text: `Browser: ${action}…` }], details: { action } });
      await browser.ensureStarted(headless);
      signal?.throwIfAborted();

      if (action === "list_tabs") {
        const tabs = await withReadOnlyRecovery(browser, headless, () => browser.listTabs());
        return { content: [{ type: "text", text: tabsText(tabs) }], details: { action, tabs } };
      }

      if (action === "screenshot") {
        const capture = await withReadOnlyRecovery(browser, headless, () => browser.screenshot(params.fullPage ?? false));
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
      let tabs: BrowserTab[] | undefined;
      let downloadedPath: string | undefined;
      if (action === "open") {
        if (!params.url) throw new Error("The open action requires url");
        snapshot = await browser.navigate(params.url);
      } else if (action === "new_tab") {
        const result = await browser.newTab(params.url);
        snapshot = result.snapshot;
        tabs = result.tabs;
      } else if (action === "switch_tab") {
        if (!params.tabId) throw new Error("The switch_tab action requires tabId");
        const result = await browser.switchTab(params.tabId);
        snapshot = result.snapshot;
        tabs = result.tabs;
      } else if (action === "close_tab") {
        const result = await browser.closeTab(params.tabId);
        snapshot = result.snapshot;
        tabs = result.tabs;
      } else if (action === "back" || action === "forward") {
        snapshot = await browser.history(action);
      } else if (action === "reload") {
        snapshot = await browser.reload();
      } else if (action === "hover") {
        snapshot = await browser.hover(params.ref, params.selector);
      } else if (action === "click") {
        snapshot = await browser.click(params.ref, params.selector);
      } else if (action === "type") {
        if (typeof params.text !== "string") throw new Error("The type action requires text");
        snapshot = await browser.type(params.ref, params.selector, params.text);
      } else if (action === "press") {
        if (!params.key) throw new Error("The press action requires key");
        snapshot = await browser.press(params.key, params.ref, params.selector);
      } else if (action === "select") {
        if (typeof params.value !== "string") throw new Error("The select action requires value");
        snapshot = await browser.select(params.ref, params.selector, params.value);
      } else if (action === "upload") {
        snapshot = await browser.upload(params.ref, params.selector, params.paths || []);
      } else if (action === "download") {
        const result = await browser.download(params.ref, params.selector, params.path);
        snapshot = result.snapshot;
        downloadedPath = result.path;
      } else if (action === "scroll") {
        if (!params.deltaX && !params.deltaY) throw new Error("The scroll action requires a non-zero deltaX or deltaY");
        snapshot = await browser.scroll(params.deltaX || 0, params.deltaY || 0, params.ref, params.selector);
      } else if (action === "wait") {
        snapshot = await browser.wait(Math.min(30_000, Math.max(0, params.durationMs ?? 1_000)));
      } else {
        snapshot = await withReadOnlyRecovery(browser, headless, () => browser.inspect());
      }
      const capture = action === "inspect" ? null : await browser.screenshot(false);
      if (capture) snapshot = capture.snapshot;
      ctx.ui.setStatus("pidesktop-browser", snapshot.title || snapshot.url);
      return {
        content: [
          { type: "text", text: `${downloadedPath ? `Downloaded to: ${downloadedPath}\n\n` : ""}${snapshotText(snapshot)}${tabs ? `\n\nTabs:\n${tabsText(tabs)}` : ""}` },
          ...(capture ? [{ type: "image" as const, data: capture.data, mimeType: "image/png" }] : []),
        ],
        details: { action, url: snapshot.url, title: snapshot.title, elementCount: snapshot.elements.length, tabs, path: downloadedPath },
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
