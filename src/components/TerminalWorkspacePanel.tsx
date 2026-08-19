import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Folder, Plus, SquareTerminal, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

interface TerminalWorkspacePanelProps {
  cwd: string;
  shellLabel: string;
  placement?: "side" | "bottom";
  onClose: () => void;
}

interface TerminalTab {
  id: string;
  title: string;
}

interface TerminalOutputEvent {
  id: string;
  data: string;
}

interface TerminalExitEvent {
  id: string;
}

function createTab(shellLabel: string, index: number): TerminalTab {
  const label = shellLabel || "PowerShell";
  return {
    id: `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: index > 1 ? `${label} ${index}` : label,
  };
}

export function TerminalWorkspacePanel({ cwd, shellLabel, placement = "side", onClose }: TerminalWorkspacePanelProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [createTab(shellLabel, 1)]);
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const cwdLabel = useMemo(() => cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || cwd || "工作区", [cwd]);

  const addTab = useCallback(() => {
    setTabs((current) => {
      const tab = createTab(shellLabel, current.length + 1);
      setActiveId(tab.id);
      return [...current, tab];
    });
  }, [shellLabel]);

  const closeTab = useCallback((id: string) => {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      if (!next.length) {
        window.queueMicrotask(onClose);
        return current;
      }
      if (activeId === id) setActiveId(next[Math.min(index, next.length - 1)].id);
      return next;
    });
  }, [activeId, onClose]);

  return (
    <section className={placement === "bottom" ? "bottom-terminal-dock workspace-terminal-pane" : "workspace-terminal-pane"} aria-label="终端">
      <header className="bottom-terminal-header workspace-terminal-header">
        <div className="terminal-workspace-path" title={cwd || "工作区"}>
          <Folder size={14} strokeWidth={1.7} />
          <span>{cwdLabel}</span>
        </div>
        <div className="terminal-tabs" role="tablist" aria-label="终端标签">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-tab ${activeId === tab.id ? "active" : ""}`}
              role="tab"
              aria-selected={activeId === tab.id}
              title={`${tab.title} · ${cwd}`}
              onClick={() => setActiveId(tab.id)}
            >
              <SquareTerminal size={14} strokeWidth={1.7} />
              <span>{tab.title}</span>
              <button
                type="button"
                className="terminal-tab-close"
                title={`关闭 ${tab.title}`}
                aria-label={`关闭 ${tab.title}`}
                onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}
              >
                <X size={13} strokeWidth={1.7} />
              </button>
            </div>
          ))}
          <button type="button" className="terminal-tab-add" title="新建终端" aria-label="新建终端" onClick={addTab}>
            <Plus size={14} strokeWidth={1.8} />
          </button>
        </div>
        <button type="button" className="terminal-panel-close" title="关闭面板" aria-label="关闭终端面板" onClick={onClose}>
          <X size={14} strokeWidth={1.7} />
        </button>
      </header>
      <div className="terminal-tab-bodies">
        {tabs.map((tab) => (
          <TerminalTabView
            key={tab.id}
            id={tab.id}
            cwd={cwd}
            shellLabel={shellLabel}
            active={activeId === tab.id}
          />
        ))}
      </div>
    </section>
  );
}

function TerminalTabView({
  id,
  cwd,
  shellLabel,
  active,
}: {
  id: string;
  cwd: string;
  shellLabel: string;
  active: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const startedRef = useRef(false);
  const isTauri = "__TAURI_INTERNALS__" in window;
  const theme = useMemo(() => {
    const dark = document.documentElement.dataset.theme === "dark";
    return dark
      ? { background: "#121214", foreground: "#e4e4e7", cursor: "#e4e4e7", selectionBackground: "#3f3f46" }
      : { background: "#ffffff", foreground: "#303238", cursor: "#303238", selectionBackground: "#dfe7f5" };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || terminalRef.current) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: "var(--code-font)",
      fontSize: 12.5,
      lineHeight: 1.35,
      scrollback: 5000,
      theme,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;

    let disposed = false;
    let resizeFrame = 0;
    let unlistenOutput: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    const resize = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        if (disposed || !host.isConnected || host.clientWidth < 10 || host.clientHeight < 10) return;
        fit.fit();
        if (startedRef.current && isTauri) {
          void invoke("terminal_resize", { id, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
        }
      });
    };

    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const inputDisposable = terminal.onData((data) => {
      if (isTauri && startedRef.current) void invoke("terminal_write", { id, data }).catch((error) => terminal.writeln(`\r\n${String(error)}`));
    });

    if (!isTauri) {
      terminal.writeln(`${shellLabel || "PowerShell"} · ${cwd}`);
      terminal.writeln("浏览器预览不启动本机终端。请在 PIDesktop 客户端中使用此功能。");
      resize();
      return () => {
        disposed = true;
        window.cancelAnimationFrame(resizeFrame);
        observer.disconnect();
        inputDisposable.dispose();
        terminal.dispose();
        terminalRef.current = null;
        fitRef.current = null;
      };
    }

    void Promise.all([
      listen<TerminalOutputEvent>("terminal-output", (event) => {
        if (event.payload.id === id) terminal.write(event.payload.data);
      }),
      listen<TerminalExitEvent>("terminal-exit", (event) => {
        if (event.payload.id === id) terminal.writeln("\r\n[进程已退出]");
      }),
    ]).then(async ([offOutput, offExit]) => {
      if (disposed) {
        offOutput();
        offExit();
        return;
      }
      unlistenOutput = offOutput;
      unlistenExit = offExit;
      fit.fit();
      try {
        await invoke("terminal_create", {
          id,
          cwd,
          shell: shellLabel,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        startedRef.current = true;
        if (active) terminal.focus();
      } catch (error) {
        terminal.writeln(`\r\n无法启动终端：${String(error)}`);
      }
    });

    resize();
    return () => {
      disposed = true;
      window.cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      inputDisposable.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      if (startedRef.current) void invoke("terminal_close", { id }).catch(() => undefined);
      startedRef.current = false;
    };
  }, [cwd, id, isTauri, shellLabel, theme]);

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      fitRef.current?.fit();
      terminalRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  return <div ref={hostRef} className={`terminal-tab-body ${active ? "active" : ""}`} aria-hidden={!active} />;
}
