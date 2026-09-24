/**
 * Integrated terminal sessions that live outside React.
 *
 * The panel used to own its xterm instances, so hiding the panel (Ctrl+J),
 * switching tools or switching threads unmounted them and killed the shells,
 * taking a running dev server down with them. Sessions now live here, keyed by
 * tab id: a view attaches a session's DOM node while it is visible and
 * detaches it when hidden, and only closing the tab ends the shell.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import { describeError } from "./errors";
import { sameLocalPath } from "./pathIdentity";
import { publishTerminalTabs, type TerminalTabInfo } from "./terminalTabs";

export type { TerminalStatus, TerminalTabInfo } from "./terminalTabs";
export { subscribeTerminalTabs as subscribeTerminals, terminalTabsFor, terminalTabsSnapshot as terminalSnapshot } from "./terminalTabs";

interface TerminalEntry {
  info: TerminalTabInfo;
  terminal: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  /** The node xterm renders into; views move it in and out of the DOM. */
  container: HTMLDivElement;
  opened: boolean;
  /** The backend PTY id. A restart gets a new one; the tab id stays. */
  ptyId: string | null;
}

const entries = new Map<string, TerminalEntry>();
const tabByPty = new Map<string, string>();
let bridge: Promise<void> | null = null;
let themeObserver: MutationObserver | null = null;
let linkHandler: (uri: string) => void = () => undefined;
let searchRequestHandler: (tabId: string) => void = () => undefined;

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function emit() {
  publishTerminalTabs([...entries.values()].map((entry) => ({ ...entry.info })));
}

/** Clicked links go through the app so localhost pages can open in the built-in browser. */
export function setTerminalLinkHandler(handler: (uri: string) => void) {
  linkHandler = handler;
}

/** Ctrl+F inside a terminal asks the panel to show its search box. */
export function setTerminalSearchRequestHandler(handler: (tabId: string) => void) {
  searchRequestHandler = handler;
}

/**
 * ANSI colors for light backgrounds. xterm's defaults assume a dark one, so
 * PowerShell's white and yellow syntax colors vanish on a light theme.
 */
const LIGHT_ANSI: ITheme = {
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#7d4e00",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

/** xterm cannot read CSS variables, so resolve the appearance palette into concrete colors. */
function readTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  const light = document.documentElement.dataset.theme === "light";
  return {
    ...(light ? LIGHT_ANSI : {}),
    background: read("--app", "#14161e"),
    foreground: read("--text", "#dce0ea"),
    cursor: read("--accent", "#6366f1"),
    cursorAccent: read("--app", "#14161e"),
    selectionBackground: read("--active", "#2e313d"),
  };
}

function readFont(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--code-font").trim();
  return value || 'Consolas, "Cascadia Mono", "Courier New", monospace';
}

function ensureThemeObserver() {
  if (themeObserver || typeof MutationObserver === "undefined") return;
  // The palette lives in inline CSS variables on <html>; follow theme switches live.
  themeObserver = new MutationObserver(() => {
    const theme = readTheme();
    const fontFamily = readFont();
    for (const entry of entries.values()) {
      entry.terminal.options.theme = theme;
      if (entry.terminal.options.fontFamily !== fontFamily) entry.terminal.options.fontFamily = fontFamily;
    }
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
}

function ensureBridge(): Promise<void> {
  if (bridge) return bridge;
  bridge = Promise.all([
    listen<{ id: string; data: string }>("terminal-output", (event) => {
      const tabId = tabByPty.get(event.payload.id);
      const entry = tabId ? entries.get(tabId) : undefined;
      entry?.terminal.write(event.payload.data);
    }),
    listen<{ id: string }>("terminal-exit", (event) => {
      const tabId = tabByPty.get(event.payload.id);
      const entry = tabId ? entries.get(tabId) : undefined;
      if (!entry || entry.ptyId !== event.payload.id) return;
      entry.info.status = "exited";
      entry.terminal.write("\r\n\x1b[2m[进程已退出 · 按 Enter 重新启动]\x1b[0m\r\n");
      emit();
    }),
  ]).then(() => undefined);
  return bridge;
}

async function copyText(text: string) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access can be refused; the selection stays for a manual copy.
  }
}

function nextTitle(cwd: string, shell: string): string {
  const same = [...entries.values()].filter((entry) => entry.info.shell === shell && sameLocalPath(entry.info.cwd, cwd));
  return same.length ? `${shell} ${same.length + 1}` : shell;
}

async function startPty(entry: TerminalEntry) {
  if (entry.ptyId) return;
  if (!isTauri()) {
    entry.info.status = "error";
    entry.terminal.writeln(`${entry.info.shell} · ${entry.info.cwd}`);
    entry.terminal.writeln("浏览器预览不启动本机终端。请在 PIDesktop 客户端中使用此功能。");
    emit();
    return;
  }
  const ptyId = `pty-${entry.info.id}-${Date.now().toString(36)}`;
  entry.ptyId = ptyId;
  tabByPty.set(ptyId, entry.info.id);
  entry.info.status = "starting";
  emit();
  try {
    await ensureBridge();
    try {
      entry.fit.fit();
    } catch {
      // Not measurable yet; the PTY starts at the default size and resizes on the next fit.
    }
    await invoke("terminal_create", {
      id: ptyId,
      cwd: entry.info.cwd,
      shell: entry.info.shell,
      cols: entry.terminal.cols,
      rows: entry.terminal.rows,
    });
    if (entry.ptyId !== ptyId) return;
    entry.info.status = "running";
  } catch (error) {
    if (entry.ptyId !== ptyId) return;
    entry.info.status = "error";
    entry.terminal.writeln(`\r\n无法启动终端：${describeError(error)}`);
  }
  emit();
}

function restartPty(entry: TerminalEntry) {
  const previous = entry.ptyId;
  if (previous) {
    tabByPty.delete(previous);
    void invoke("terminal_close", { id: previous }).catch(() => undefined);
  }
  entry.ptyId = null;
  entry.terminal.write("\r\n");
  void startPty(entry);
}

/** Opens a new terminal tab for `cwd`. The shell starts once the tab is first shown. */
export function createTerminalTab(cwd: string, shell: string): string {
  ensureThemeObserver();
  const id = `terminal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const label = shell || "PowerShell";
  const terminal = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: readFont(),
    fontSize: 12.5,
    lineHeight: 1.35,
    scrollback: 10000,
    theme: readTheme(),
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  terminal.loadAddon(fit);
  terminal.loadAddon(search);
  terminal.loadAddon(new WebLinksAddon((event, uri) => {
    event.preventDefault();
    linkHandler(uri);
  }));
  const container = document.createElement("div");
  container.className = "terminal-surface";
  const entry: TerminalEntry = {
    info: { id, cwd, shell: label, title: nextTitle(cwd, label), status: "starting" },
    terminal,
    fit,
    search,
    container,
    opened: false,
    ptyId: null,
  };

  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    // App shortcuts (Ctrl+J, Ctrl+`) already ran in the capture phase; do not also send them to the shell.
    if (event.defaultPrevented) return false;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (ctrl && key === "c" && (event.shiftKey || terminal.hasSelection())) {
      event.preventDefault();
      void copyText(terminal.getSelection());
      if (!event.shiftKey) terminal.clearSelection();
      return false;
    }
    // Let the browser fire its paste event; xterm handles it (bracketed paste included).
    if (ctrl && key === "v") return false;
    if (ctrl && !event.shiftKey && !event.altKey && key === "f") {
      event.preventDefault();
      searchRequestHandler(id);
      return false;
    }
    return true;
  });

  terminal.onData((data) => {
    if (entry.info.status === "exited") {
      if (data.includes("\r")) restartPty(entry);
      return;
    }
    if (!entry.ptyId || entry.info.status !== "running") return;
    void invoke("terminal_write", { id: entry.ptyId, data }).catch((error) => {
      terminal.writeln(`\r\n${describeError(error)}`);
    });
  });

  entries.set(id, entry);
  emit();
  return id;
}

/**
 * Shows a tab inside `host`. The first attach opens xterm and starts the shell.
 * Returns the matching detach, which keeps the shell running.
 */
export function attachTerminal(tabId: string, host: HTMLElement): () => void {
  const entry = entries.get(tabId);
  if (!entry) return () => undefined;
  if (entry.container.parentElement !== host) host.appendChild(entry.container);
  if (!entry.opened) {
    entry.terminal.open(entry.container);
    entry.opened = true;
  }
  fitTerminal(tabId);
  if (!entry.ptyId) void startPty(entry);
  return () => {
    if (entry.container.parentElement === host) host.removeChild(entry.container);
  };
}

/** Fits the tab to its container and tells the PTY about the new size. */
export function fitTerminal(tabId: string) {
  const entry = entries.get(tabId);
  if (!entry?.opened || !entry.container.isConnected) return;
  if (entry.container.clientWidth < 10 || entry.container.clientHeight < 10) return;
  try {
    entry.fit.fit();
  } catch {
    return;
  }
  if (entry.ptyId && entry.info.status === "running" && isTauri()) {
    void invoke("terminal_resize", { id: entry.ptyId, cols: entry.terminal.cols, rows: entry.terminal.rows }).catch(() => undefined);
  }
}

export function focusTerminal(tabId: string) {
  entries.get(tabId)?.terminal.focus();
}

/** Ends the shell and forgets the tab. */
export function closeTerminalTab(tabId: string) {
  const entry = entries.get(tabId);
  if (!entry) return;
  entries.delete(tabId);
  if (entry.ptyId) {
    tabByPty.delete(entry.ptyId);
    if (isTauri()) void invoke("terminal_close", { id: entry.ptyId }).catch(() => undefined);
  }
  entry.container.remove();
  entry.terminal.dispose();
  emit();
}

/** The selection, or else the last `maxLines` non-empty lines of output. */
export function terminalText(tabId: string, maxLines = 80): string {
  const entry = entries.get(tabId);
  if (!entry) return "";
  const selection = entry.terminal.getSelection().trim();
  if (selection) return selection;
  const buffer = entry.terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-maxLines).join("\n").trim();
}

export function hasTerminalSelection(tabId: string): boolean {
  return Boolean(entries.get(tabId)?.terminal.hasSelection());
}

export function findInTerminal(tabId: string, query: string, direction: "next" | "previous"): boolean {
  const entry = entries.get(tabId);
  if (!entry || !query) return false;
  const options = {
    caseSensitive: false,
    decorations: {
      matchBackground: "#f5c54266",
      matchOverviewRuler: "#f5c542",
      activeMatchBackground: "#f59e0baa",
      activeMatchColorOverviewRuler: "#f59e0b",
    },
  };
  return direction === "next" ? entry.search.findNext(query, options) : entry.search.findPrevious(query, options);
}

export function clearTerminalSearch(tabId: string) {
  const entry = entries.get(tabId);
  entry?.search.clearDecorations();
  entry?.terminal.clearSelection();
}

export function clearTerminal(tabId: string) {
  entries.get(tabId)?.terminal.clear();
}
