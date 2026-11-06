import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Plus, TerminalSquare, X } from "lucide-react";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { agent } from "../../lib/agent";
import { describeError } from "../../lib/errors";
import { useAppStore } from "../../store";
import { useWorkbenchStore } from "../../stores/workbenchStore";

interface TerminalSessionItem {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  exitCode?: number | null;
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

    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue("--panel").trim() || "#18181b";
    const fg = styles.getPropertyValue("--text").trim() || "#e4e4e7";
    const accent = styles.getPropertyValue("--accent").trim() || "#d97757";

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12.5,
      fontFamily: "'JetBrains Mono Variable', Consolas, 'Cascadia Mono', monospace",
      lineHeight: 1.35,
      scrollback: 5000,
      theme: {
        background: bg,
        foreground: fg,
        cursor: accent,
        selectionBackground: "rgba(217, 119, 87, 0.28)",
      },
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const linksAddon = new WebLinksAddon((_event, uri) => {
      void openUrl(uri);
    });

    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
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
    const unlisteners: UnlistenFn[] = [];

    const dataDisposable = term.onData((data) => {
      void agent.terminalWrite(session.id, data).catch(() => undefined);
    });

    void Promise.all([
      listen<{ id: string; data: string }>(`terminal-output`, (event) => {
        if (!disposed && event.payload.id === session.id) {
          term.write(event.payload.data);
        }
      }),
      listen<{ id: string; exitCode: number | null }>(`terminal-exit`, (event) => {
        if (!disposed && event.payload.id === session.id) {
          const code = event.payload.exitCode;
          term.writeln(`\r\n\x1b[90m[进程已退出${code !== null ? `，退出码 ${code}` : ""}]\x1b[0m`);
          onExitedRef.current(session.id, code);
        }
      }),
    ]).then((stops) => {
      if (disposed) {
        stops.forEach((stop) => stop());
        return;
      }
      unlisteners.push(...stops);
      const cols = Math.max(20, term.cols || 80);
      const rows = Math.max(6, term.rows || 24);
      return agent.terminalCreate({
        id: session.id,
        cwd: session.cwd,
        shell: session.shell,
        cols,
        rows,
      });
    }).catch((error) => {
      if (!disposed) {
        term.writeln(`\x1b[31m无法启动终端：${describeError(error)}\x1b[0m`);
      }
    });

    const observer = new ResizeObserver(() => {
      if (disposed || container.clientWidth === 0 || container.clientHeight === 0) return;
      try {
        fitAddon.fit();
        void agent.terminalResize(session.id, Math.max(20, term.cols), Math.max(6, term.rows)).catch(() => undefined);
      } catch {
        // Ignore transient resize errors.
      }
    });
    observer.observe(container);

    return () => {
      disposed = true;
      observer.disconnect();
      dataDisposable.dispose();
      unlisteners.forEach((stop) => stop());
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
  const [activeId, setActiveId] = useState<string | null>(null);

  const createSession = useCallback((shellOverride?: string) => {
    const shell = shellOverride || defaultShell;
    if (!shell || !cwd) return;
    const id = createTerminalId();
    const label = shell.split(/[\\/]/).pop()?.replace(/\.exe$/i, "") || "终端";
    setSessions((prev) => {
      const nextIndex = prev.length + 1;
      return [...prev, { id, title: `${label} ${nextIndex}`, cwd, shell }];
    });
    setActiveId(id);
  }, [cwd, defaultShell]);

  // Spawn the initial terminal once the terminal tab is visible and shells & workspace are known.
  useSyncOnChange([defaultShell, cwd, visible], () => {
    if (visible && sessions.length === 0 && defaultShell && cwd) {
      createSession(defaultShell);
    }
  });

  useSyncOnChange([terminalCreateNonce], () => {
    if (terminalCreateNonce > 0 && defaultShell && cwd) {
      createSession(defaultShell);
    }
  });

  const handleClose = useCallback((id: string) => {
    setSessions((prev) => {
      const idx = prev.findIndex((item) => item.id === id);
      const next = prev.filter((item) => item.id !== id);
      if (activeId === id) {
        setActiveId(next[idx]?.id ?? next[idx - 1]?.id ?? null);
      }
      return next;
    });
  }, [activeId]);

  const handleExited = useCallback((id: string, exitCode: number | null) => {
    setSessions((prev) => prev.map((item) => (
      item.id === id ? { ...item, exitCode } : item
    )));
  }, []);

  if (sessions.length === 0) {
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

  const resolvedActiveId = activeId ?? sessions[0]?.id ?? null;

  return (
    <div className="pid-wb-terminal-wrap">
      <div className="pid-wb-terminal-tabs">
        <div className="pid-wb-terminal-tab-list" role="tablist" aria-label="终端会话">
          {sessions.map((item) => {
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
                  onClick={() => setActiveId(item.id)}
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
        {sessions.length === 0 ? (
          <div className="pid-wb-empty">
            <button type="button" className="pid-wb-btn" onClick={() => createSession()}>
              <Plus size={13} />
              <span>新建终端</span>
            </button>
          </div>
        ) : (
          sessions.map((session) => (
            <TerminalViewport
              key={session.id}
              session={session}
              selected={session.id === resolvedActiveId}
              visible={visible}
              onExited={handleExited}
            />
          ))
        )}
      </div>
    </div>
  );
}
