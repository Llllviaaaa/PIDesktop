import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Eraser, Folder, MessageSquarePlus, Plus, Search, SquareTerminal, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { pi } from "../lib/pi";
import {
  attachTerminal,
  clearTerminal,
  clearTerminalSearch,
  closeTerminalTab,
  createTerminalTab,
  findInTerminal,
  fitTerminal,
  focusTerminal,
  setTerminalLinkHandler,
  setTerminalSearchRequestHandler,
  subscribeTerminals,
  terminalSnapshot,
  terminalTabsFor,
  terminalText,
  type TerminalTabInfo,
} from "../lib/terminalSessions";

interface TerminalWorkspacePanelProps {
  cwd: string;
  /** The shell a plain "+" opens (Settings → 集成终端 Shell). */
  defaultShell: string;
  /** Hides the panel; the shells keep running. */
  onHide: () => void;
  /** Hands selected (or recent) output to the composer. */
  onSendToChat?: (text: string, source: string) => void;
  /** Clicked links in terminal output (localhost pages open in the built-in browser). */
  onOpenLink: (url: string) => void;
}

/** The tab each workspace last showed, so reopening the panel lands where you left. */
const activeTabByWorkspace = new Map<string, string>();
let shellsRequest: Promise<string[]> | null = null;

function availableShells(): Promise<string[]> {
  if (!("__TAURI_INTERNALS__" in window)) return Promise.resolve(["PowerShell"]);
  shellsRequest ??= pi.terminalShells().catch(() => ["PowerShell"]);
  return shellsRequest;
}

function workspaceKey(cwd: string) {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function TerminalWorkspacePanel({ cwd, defaultShell, onHide, onSendToChat, onOpenLink }: TerminalWorkspacePanelProps) {
  const allTabs = useSyncExternalStore(subscribeTerminals, terminalSnapshot);
  const tabs = useMemo(() => (cwd ? terminalTabsFor(allTabs, cwd) : []), [allTabs, cwd]);
  const [activeByWorkspace, setActiveByWorkspace] = useState<Record<string, string>>({});
  const [shells, setShells] = useState<string[]>([]);
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchMiss, setSearchMiss] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const key = workspaceKey(cwd);
  const requested = activeByWorkspace[key] ?? activeTabByWorkspace.get(key);
  const active: TerminalTabInfo | undefined = tabs.find((tab) => tab.id === requested) ?? tabs[tabs.length - 1];
  const activeId = active?.id ?? null;
  const cwdLabel = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || cwd || "工作区";
  const shell = defaultShell || "PowerShell";

  const selectTab = (id: string) => {
    activeTabByWorkspace.set(key, id);
    setActiveByWorkspace((current) => ({ ...current, [key]: id }));
  };

  const openTab = (tabShell: string) => {
    if (!cwd) return;
    selectTab(createTerminalTab(cwd, tabShell));
    setShellMenuOpen(false);
  };

  // A workspace always has at least one terminal while the panel is open.
  useEffect(() => {
    if (!cwd) return;
    // Read the live registry, not this render's copy, so a double-run effect cannot open two tabs.
    if (terminalTabsFor(terminalSnapshot(), cwd).length > 0) return;
    const id = createTerminalTab(cwd, shell);
    activeTabByWorkspace.set(workspaceKey(cwd), id);
  }, [cwd, shell, tabs.length]);

  useEffect(() => {
    let cancelled = false;
    void availableShells().then((list) => {
      if (!cancelled) setShells(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Show the active tab; hiding it only detaches the node.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !activeId) return;
    const detach = attachTerminal(activeId, host);
    const frame = window.requestAnimationFrame(() => {
      fitTerminal(activeId);
      focusTerminal(activeId);
    });
    const observer = new ResizeObserver(() => fitTerminal(activeId));
    observer.observe(host);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      detach();
    };
  }, [activeId]);

  useEffect(() => {
    setTerminalLinkHandler(onOpenLink);
  }, [onOpenLink]);

  useEffect(() => {
    setTerminalSearchRequestHandler(() => {
      setSearchOpen(true);
      window.requestAnimationFrame(() => searchInputRef.current?.select());
    });
    return () => setTerminalSearchRequestHandler(() => undefined);
  }, []);

  useEffect(() => {
    if (!shellMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest?.(".terminal-shell-menu-wrap")) setShellMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [shellMenuOpen]);

  const closeTab = (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    closeTerminalTab(id);
    if (!remaining.length) {
      activeTabByWorkspace.delete(key);
      onHide();
      return;
    }
    if (id === activeId) selectTab(remaining[Math.min(Math.max(index, 0), remaining.length - 1)].id);
  };

  const runSearch = (direction: "next" | "previous", value = query) => {
    if (!activeId) return;
    setSearchMiss(Boolean(value) && !findInTerminal(activeId, value, direction));
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setSearchMiss(false);
    if (activeId) {
      clearTerminalSearch(activeId);
      focusTerminal(activeId);
    }
  };

  const sendToChat = () => {
    if (!activeId || !active || !onSendToChat) return;
    const text = terminalText(activeId);
    if (text) onSendToChat(text, `${active.title} · ${cwdLabel}`);
  };

  return (
    <section className="bottom-terminal-dock workspace-terminal-pane" aria-label="终端">
      <header className="bottom-terminal-header workspace-terminal-header">
        <div className="terminal-workspace-path" title={cwd || "工作区"}>
          <Folder size={14} strokeWidth={1.7} />
          <span>{cwdLabel}</span>
        </div>
        <div className="terminal-tabs" role="tablist" aria-label="终端标签">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-tab ${activeId === tab.id ? "active" : ""} status-${tab.status}`}
              role="tab"
              aria-selected={activeId === tab.id}
              title={`${tab.title} · ${tab.cwd}${tab.status === "exited" ? " · 已退出" : ""}`}
              onClick={() => selectTab(tab.id)}
            >
              <SquareTerminal size={14} strokeWidth={1.7} />
              <span>{tab.title}</span>
              {tab.status === "exited" && <em className="terminal-tab-state">已退出</em>}
              <button
                type="button"
                className="terminal-tab-close"
                title={`结束 ${tab.title}`}
                aria-label={`结束 ${tab.title}`}
                onClick={(event) => { event.stopPropagation(); closeTab(tab.id); }}
              >
                <X size={13} strokeWidth={1.7} />
              </button>
            </div>
          ))}
          <div className="terminal-shell-menu-wrap">
            <button type="button" className="terminal-tab-add" title={`新建 ${shell} 终端`} aria-label="新建终端" disabled={!cwd} onClick={() => openTab(shell)}>
              <Plus size={14} strokeWidth={1.8} />
            </button>
            {shells.length > 1 && (
              <button
                type="button"
                className="terminal-tab-add terminal-shell-trigger"
                title="选择 Shell"
                aria-label="选择 Shell"
                aria-haspopup="menu"
                aria-expanded={shellMenuOpen}
                disabled={!cwd}
                onClick={() => setShellMenuOpen((value) => !value)}
              >
                <ChevronDown size={12} strokeWidth={1.8} />
              </button>
            )}
            {shellMenuOpen && (
              <div className="terminal-shell-menu" role="menu">
                {shells.map((item) => (
                  <button key={item} type="button" role="menuitem" onClick={() => openTab(item)}>
                    <SquareTerminal size={14} />
                    <span>{item}</span>
                    {item === shell && <small>默认</small>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="terminal-header-actions">
          {searchOpen && (
            <div className={`terminal-search ${searchMiss ? "miss" : ""}`}>
              <Search size={12} />
              <input
                ref={searchInputRef}
                autoFocus
                value={query}
                placeholder="在终端中查找"
                aria-label="在终端中查找"
                onChange={(event) => {
                  setQuery(event.target.value);
                  runSearch("next", event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    runSearch(event.shiftKey ? "previous" : "next");
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    closeSearch();
                  }
                }}
              />
              <button type="button" title="上一个" aria-label="上一个匹配" disabled={!query} onClick={() => runSearch("previous")}><ArrowUp size={12} /></button>
              <button type="button" title="下一个" aria-label="下一个匹配" disabled={!query} onClick={() => runSearch("next")}><ArrowDown size={12} /></button>
              <button type="button" title="关闭查找" aria-label="关闭查找" onClick={closeSearch}><X size={12} /></button>
            </div>
          )}
          {!searchOpen && (
            <button type="button" className="terminal-panel-close" title="查找 (Ctrl+F)" aria-label="在终端中查找" disabled={!activeId} onClick={() => setSearchOpen(true)}>
              <Search size={14} strokeWidth={1.7} />
            </button>
          )}
          {onSendToChat && (
            <button
              type="button"
              className="terminal-panel-close"
              title="把选中内容（未选中时为最近输出）发送到对话"
              aria-label="发送到对话"
              disabled={!activeId}
              onClick={sendToChat}
            >
              <MessageSquarePlus size={14} strokeWidth={1.7} />
            </button>
          )}
          <button type="button" className="terminal-panel-close" title="清屏" aria-label="清屏" disabled={!activeId} onClick={() => activeId && clearTerminal(activeId)}>
            <Eraser size={14} strokeWidth={1.7} />
          </button>
          <button type="button" className="terminal-panel-close" title="隐藏面板（终端保持运行） Ctrl+J" aria-label="隐藏终端面板" onClick={onHide}>
            <X size={14} strokeWidth={1.7} />
          </button>
        </div>
      </header>
      <div className="terminal-tab-bodies">
        {cwd ? (
          <div ref={hostRef} className="terminal-tab-body active" />
        ) : (
          <div className="panel-empty">打开项目后即可使用终端。</div>
        )}
      </div>
    </section>
  );
}
