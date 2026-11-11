import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Plus, TerminalSquare, X } from "lucide-react";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { agent } from "../../lib/agent";
import { describeError } from "../../lib/errors";
import { normalizeLocalPath, sameLocalPath } from "../../lib/pathIdentity";
import { useAppStore } from "../../store";
import { useWorkbenchStore } from "../../stores/workbenchStore";

interface TerminalSessionItem {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  exitCode?: number | null;
}

interface TerminalEventHandlers {
  onOutput: (data: string) => void;
  onExit: (exitCode: number | null) => void;
}

const terminalHandlers = new Map<string, TerminalEventHandlers>();
let sharedListenersPromise: Promise<[UnlistenFn, UnlistenFn]> | null = null;

function ensureSharedTerminalListeners(): Promise<[UnlistenFn, UnlistenFn]> {
  if (!sharedListenersPromise) {
    sharedListenersPromise = Promise.all([
      listen<{ id: string; data: string }>("terminal-output", (event) => {
        terminalHandlers.get(event.payload.id)?.onOutput(event.payload.data);
      }),
      listen<{ id: string; exitCode: number | null }>("terminal-exit", (event) => {
        terminalHandlers.get(event.payload.id)?.onExit(event.payload.exitCode);
      }),
    ]).catch((err) => {
      sharedListenersPromise = null;
      throw err;
    });
  }
  return sharedListenersPromise;
}

function registerTerminalHandlers(id: string, handlers: TerminalEventHandlers): () => void {
  terminalHandlers.set(id, handlers);
  void ensureSharedTerminalListeners().catch(() => undefined);
  return () => {
    terminalHandlers.delete(id);
    if (terminalHandlers.size === 0 && sharedListenersPromise) {
      const activePromise = sharedListenersPromise;
      sharedListenersPromise = null;
      void activePromise
        .then((stops) => {
          stops.forEach((stop) => stop());
        })
        .catch(() => undefined);
    }
  };
}

function readTerminalTheme() {
  if (typeof document === "undefined") {
    return {
      background: "#18181b",
      foreground: "#e4e4e7",
      cursor: "#4b93ff",
      selectionBackground: "rgba(75, 147, 255, 0.26)",
    };
  }
  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue("--panel").trim() || "#18181b";
  const fg = styles.getPropertyValue("--text").trim() || "#e4e4e7";
  const accent = styles.getPropertyValue("--accent").trim() || "#4b93ff";
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    selectionBackground: "rgba(75, 147, 255, 0.26)",
  };
}

function workspaceShortName(cwd: string): string {
  const cleaned = cwd.replace(/[\\/]+$/, "");
  return cleaned.split(/[\\/]/).pop() || cwd;
}

let nextTerminalSeq = 0;
function createTerminalId(): string {
  nextTerminalSeq += 1;
  return `pid-pty-${Date.now().toString(36)}-${nextTerminalSeq}`;
}

interface TerminalViewportProps {
  session: TerminalSessionItem;
  selected: boolean;
  visible: boolean;
  onExited: (id: string, exitCode: number | null) => void;
}

function TerminalViewport({ session, selected, visible, onExited }: TerminalViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const onExitedRef = useRef(onExited);

  useEffect(() => {
    onExitedRef.current = onExited;
  }, [onExited]);

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12.5,
      fontFamily: "'JetBrains Mono Variable', Consolas, 'Cascadia Mono', monospace",
      lineHeight: 1.35,
      scrollback: 5000,
      theme: readTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    const linksAddon = new WebLinksAddon((_event, uri) => {
      void openUrl(uri);
    });

    term.loadAddon(fitAddon);
    term.loadAddon(linksAddon);
    term.open(container);
    try {
      fitAddon.fit();
    } catch {
      // Container may have zero size while hidden.
    }

    termRef.current = term;
    fitRef.current = fitAddon;

    let disposed = false;

    const dataDisposable = term.onData((data) => {
      void agent.terminalWrite(session.id, data).catch(() => undefined);
    });

    const unregisterHandlers = registerTerminalHandlers(session.id, {
      onOutput: (data) => {
        if (!disposed) {
          term.write(data);
        }
      },
      onExit: (code) => {
        if (!disposed) {
          term.writeln(`\r\n\x1b[90m[进程已退出${code !== null ? `，退出码 ${code}` : ""}]\x1b[0m`);
          onExitedRef.current(session.id, code);
        }
      },
    });

    void ensureSharedTerminalListeners()
      .then(() => {
        if (disposed) return;
        const cols = Math.max(20, term.cols || 80);
        const rows = Math.max(6, term.rows || 24);
        return agent.terminalCreate({
          id: session.id,
          cwd: session.cwd,
          shell: session.shell,
          cols,
          rows,
        });
      })
      .catch((error) => {
        if (!disposed) {
          term.writeln(`\x1b[31m无法启动终端：${describeError(error)}\x1b[0m`);
        }
      });

    const resizeObserver = new ResizeObserver(() => {
      if (disposed || container.clientWidth === 0 || container.clientHeight === 0) return;
      try {
        fitAddon.fit();
        void agent.terminalResize(session.id, Math.max(20, term.cols), Math.max(6, term.rows)).catch(() => undefined);
      } catch {
        // Ignore transient resize errors.
      }
    });
    resizeObserver.observe(container);

    const themeObserver = typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => {
          if (disposed) return;
          term.options.theme = readTerminalTheme();
        })
      : null;
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-appearance", "style"],
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      themeObserver?.disconnect();
      dataDisposable.dispose();
      unregisterHandlers();
      void agent.terminalClose(session.id).catch(() => undefined);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [session.cwd, session.id, session.shell]);

  const focusedAndVisible = selected && visible;
  useEffect(() => {
    if (!focusedAndVisible) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
        const term = termRef.current;
        if (term) {
          void agent.terminalResize(session.id, Math.max(20, term.cols), Math.max(6, term.rows)).catch(() => undefined);
          term.focus();
        }
      } catch {
        // Ignore if not yet measurable.
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedAndVisible, session.id]);

  return (
    <div
      ref={hostRef}
      className="pid-wb-xterm-viewport"
      hidden={!selected}
    />
  );
}

export interface TerminalPanelProps {
  cwd: string;
  visible?: boolean;
}

export function TerminalPanel({ cwd, visible = true }: TerminalPanelProps) {
  const preferredShell = useAppStore((state) => state.settings?.terminalShell ?? "");
  const terminalCreateNonce = useWorkbenchStore((state) => state.terminalCreateNonce);

  const shellsQuery = useQuery({
    queryKey: ["workbench-terminal-shells"],
    queryFn: () => agent.terminalShells(),
    staleTime: Infinity,
  });

  const shells = shellsQuery.data ?? [];
  const defaultShell = (preferredShell && shells.includes(preferredShell) ? preferredShell : shells[0]) ?? "";

  const [sessions, setSessions] = useState<TerminalSessionItem[]>([]);
  const [activeIdByWorkspace, setActiveIdByWorkspace] = useState<Record<string, string | null>>({});
  const [handledCreateNonce, setHandledCreateNonce] = useState(0);

  const workspaceKey = cwd ? normalizeLocalPath(cwd) : "";
  const workspaceSessions = useMemo(
    () => (cwd ? sessions.filter((item) => sameLocalPath(item.cwd, cwd)) : []),
    [cwd, sessions],
  );

  const createSession = useCallback((shellOverride?: string) => {
    const shell = shellOverride || defaultShell;
    if (!shell || !cwd) return;
    const id = createTerminalId();
    const label = shell.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") || "终端";
    const repoLabel = workspaceShortName(cwd);
    const key = normalizeLocalPath(cwd);
    setSessions((prev) => {
      const inWorkspaceCount = prev.filter((item) => sameLocalPath(item.cwd, cwd)).length;
      const nextIndex = inWorkspaceCount + 1;
      const title = repoLabel ? `${label} ${nextIndex} · ${repoLabel}` : `${label} ${nextIndex}`;
      return [...prev, { id, title, cwd, shell }];
    });
    if (key) {
      setActiveIdByWorkspace((prev) => ({ ...prev, [key]: id }));
    }
  }, [cwd, defaultShell]);

  // Coordinate `+` create requests and initial per-workspace auto-spawn in a single pass
  // so clicking `+` while `shellsQuery` is still resolving never double-spawns two shells.
  useSyncOnChange([defaultShell, cwd, visible, terminalCreateNonce], () => {
    if (!defaultShell || !cwd) return;
    if (visible && terminalCreateNonce > handledCreateNonce) {
      setHandledCreateNonce(terminalCreateNonce);
      createSession(defaultShell);
      return;
    }
    if (visible && workspaceSessions.length === 0) {
      createSession(defaultShell);
    }
  });

  const resolvedActiveId = useMemo(() => {
    const preferred = workspaceKey ? activeIdByWorkspace[workspaceKey] : null;
    if (preferred && workspaceSessions.some((item) => item.id === preferred)) {
      return preferred;
    }
    return workspaceSessions[0]?.id ?? null;
  }, [activeIdByWorkspace, workspaceKey, workspaceSessions]);

  const handleSelectSession = useCallback((id: string) => {
    if (!workspaceKey) return;
    setActiveIdByWorkspace((prev) => ({ ...prev, [workspaceKey]: id }));
  }, [workspaceKey]);

  const handleClose = useCallback((id: string) => {
    const closedIdx = workspaceSessions.findIndex((item) => item.id === id);
    const remainingInWorkspace = workspaceSessions.filter((item) => item.id !== id);
    const replacementId = remainingInWorkspace[closedIdx]?.id
      ?? remainingInWorkspace[closedIdx - 1]?.id
      ?? null;
    setSessions((prev) => prev.filter((item) => item.id !== id));
    if (workspaceKey && resolvedActiveId === id) {
      setActiveIdByWorkspace((prev) => ({ ...prev, [workspaceKey]: replacementId }));
    }
  }, [resolvedActiveId, workspaceKey, workspaceSessions]);

  const handleExited = useCallback((id: string, exitCode: number | null) => {
    setSessions((prev) => prev.map((item) => (
      item.id === id ? { ...item, exitCode } : item
    )));
  }, []);

  if (workspaceSessions.length === 0 && sessions.length === 0) {
    if (!cwd) {
      return <div className="pid-wb-empty">选择工作区后即可打开集成终端。</div>;
    }

    if (shellsQuery.isLoading) {
      return <div className="pid-wb-empty">正在检测可用终端 Shell…</div>;
    }

    if (shells.length === 0) {
      return (
        <div className="pid-wb-empty">
          <TerminalSquare size={20} className="pid-wb-empty-icon" />
          <p>当前环境未检测到可用的本地 PTY Shell。</p>
        </div>
      );
    }
  }

  return (
    <div className="pid-wb-terminal-wrap">
      <div className="pid-wb-terminal-tabs">
        <div className="pid-wb-terminal-tab-list" role="tablist" aria-label="终端会话">
          {workspaceSessions.map((item) => {
            const active = item.id === resolvedActiveId;
            return (
              <div
                key={item.id}
                role="tab"
                aria-selected={active}
                className={`pid-wb-editor-tab${active ? " active" : ""}`}
              >
                <button
                  type="button"
                  className="pid-wb-editor-tab-label"
                  onClick={() => handleSelectSession(item.id)}
                  title={`${item.title} — ${item.cwd}`}
                >
                  <TerminalSquare size={12} />
                  <span>{item.title}</span>
                </button>
                <button
                  type="button"
                  className="pid-wb-editor-tab-close"
                  title="关闭此终端"
                  onClick={() => handleClose(item.id)}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="pid-wb-icon-btn"
          title="新建终端标签页"
          disabled={!cwd || !defaultShell}
          onClick={() => createSession()}
        >
          <Plus size={13} />
        </button>
      </div>

      <div className="pid-wb-terminal-stage">
        {workspaceSessions.length === 0 && (
          <div className="pid-wb-empty">
            {!cwd ? (
              <span>选择工作区后即可打开集成终端。</span>
            ) : shellsQuery.isLoading ? (
              <span>正在检测可用终端 Shell…</span>
            ) : shells.length === 0 ? (
              <span>当前环境未检测到可用的本地 PTY Shell。</span>
            ) : (
              <button type="button" className="pid-wb-btn" onClick={() => createSession()}>
                <Plus size={13} />
                <span>在 {workspaceShortName(cwd)} 中新建终端</span>
              </button>
            )}
          </div>
        )}
        {sessions.map((session) => (
          <TerminalViewport
            key={session.id}
            session={session}
            selected={session.id === resolvedActiveId && Boolean(cwd) && sameLocalPath(session.cwd, cwd)}
            visible={visible}
            onExited={handleExited}
          />
        ))}
      </div>
    </div>
  );
}
