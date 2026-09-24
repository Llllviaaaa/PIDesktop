import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeError } from "../lib/errors";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Check,
  ExternalLink,
  Globe2,
  MessageSquarePlus,
  MoreHorizontal,
  RefreshCw,
  SearchCheck,
  SendHorizontal,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSyncOnChange } from "../hooks/useSyncOnChange";
import { isLocalWebAddress, resolveWorkspaceBrowserAddress } from "../lib/webAccess";
import type { AgentBrowserState } from "../types";

/** Per-viewer toggles; App reads the auto-verify one when a turn ends. */
export const BROWSER_AUTO_RELOAD_KEY = "pid-desktop:browser-auto-reload";
export const BROWSER_AUTO_VERIFY_KEY = "pid-desktop:browser-auto-verify";

export function readBrowserToggle(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}

function writeBrowserToggle(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Blocked storage keeps the toggle for this session only.
  }
}

interface BrowserWorkspacePanelProps {
  recentAgentPage: AgentBrowserState | null;
  /** False while another dock tool is showing or the dock is closed. */
  active: boolean;
  /** Navigate here (a localhost link clicked in the terminal, the agent's page). */
  navigateRequest?: { url: string; nonce: number } | null;
  /** Bumps when an agent turn finishes, so a local page can reload. */
  turnCompletedAt?: number;
  onComment?: (url: string, comment: string) => void;
  /** Ask Pi to open the page with its own browser tool and check it. */
  onVerify?: (url: string) => void;
  onUrlChange?: (url: string) => void;
}

export function BrowserWorkspacePanel({
  recentAgentPage,
  active,
  navigateRequest = null,
  turnCompletedAt = 0,
  onComment,
  onVerify,
  onUrlChange,
}: BrowserWorkspacePanelProps) {
  const [address, setAddress] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [autoReload, setAutoReload] = useState(() => readBrowserToggle(BROWSER_AUTO_RELOAD_KEY, true));
  const [autoVerify, setAutoVerify] = useState(() => readBrowserToggle(BROWSER_AUTO_VERIFY_KEY, false));
  const inputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const nativeWebviewRef = useRef<Webview | null>(null);
  const [nativeLabel] = useState(() => `workspace-browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const disposedRef = useRef(false);
  const isTauri = "__TAURI_INTERNALS__" in window;
  const currentUrl = historyIndex >= 0 ? history[historyIndex] : "";
  const recentLabel = useMemo(() => recentAgentPage?.title || recentAgentPage?.url || "", [recentAgentPage]);

  const placeNativeWebview = useCallback(async (webview = nativeWebviewRef.current) => {
    const viewport = viewportRef.current;
    if (!webview || !viewport) return;
    const rect = viewport.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    await Promise.all([
      webview.setPosition(new LogicalPosition(rect.left, rect.top)),
      webview.setSize(new LogicalSize(rect.width, rect.height)),
    ]);
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      const webview = nativeWebviewRef.current;
      nativeWebviewRef.current = null;
      if (webview) void webview.close().catch(() => undefined);
    };
  }, []);

  // Each history entry is navigated once; re-showing the tool must not reload the page.
  const navigatedRef = useRef("");
  useEffect(() => {
    if (!isTauri || !currentUrl || !active) return;
    const navigation = `${historyIndex}:${currentUrl}`;
    if (navigatedRef.current === navigation) return;
    navigatedRef.current = navigation;
    const existing = nativeWebviewRef.current;
    if (existing) {
      void invoke("browser_webview_action", {
        label: nativeLabel,
        action: "navigate",
        url: currentUrl,
      }).then(() => setLoading(false)).catch((error) => {
        setLoading(false);
        setNativeError(describeError(error));
      });
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const webview = new Webview(getCurrentWindow(), nativeLabel, {
      url: currentUrl,
      x: rect.left,
      y: rect.top,
      width: Math.max(2, rect.width),
      height: Math.max(2, rect.height),
      focus: true,
      dragDropEnabled: false,
      zoomHotkeysEnabled: true,
    });
    nativeWebviewRef.current = webview;
    void webview.once("tauri://created", () => {
      if (disposedRef.current) {
        void webview.close().catch(() => undefined);
        return;
      }
      setLoading(false);
      void placeNativeWebview(webview).catch(() => undefined);
    });
    void webview.once<string>("tauri://error", (event) => {
      setLoading(false);
      setNativeError(String(event.payload || "无法创建内嵌浏览器"));
    });
  }, [active, currentUrl, historyIndex, isTauri, nativeLabel, placeNativeWebview]);

  // The native webview floats above the page, so a hidden tool must hide it explicitly.
  useEffect(() => {
    if (!isTauri || !nativeWebviewRef.current) return;
    void invoke("browser_webview_action", { label: nativeLabel, action: active ? "show" : "hide" }).catch(() => undefined);
    if (active) {
      const frame = window.requestAnimationFrame(() => void placeNativeWebview().catch(() => undefined));
      return () => window.cancelAnimationFrame(frame);
    }
  }, [active, isTauri, nativeLabel, placeNativeWebview]);

  useEffect(() => {
    if (!isTauri) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    let frame = 0;
    const reposition = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => void placeNativeWebview().catch(() => undefined));
    };
    const observer = new ResizeObserver(reposition);
    observer.observe(viewport);
    window.addEventListener("resize", reposition);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", reposition);
    };
  }, [isTauri, placeNativeWebview]);

  useEffect(() => {
    onUrlChange?.(currentUrl);
  }, [currentUrl, onUrlChange]);

  // After an agent turn, reload a local page so the change is visible without a click.
  const seenTurnRef = useRef(turnCompletedAt);
  useEffect(() => {
    if (seenTurnRef.current === turnCompletedAt) return;
    seenTurnRef.current = turnCompletedAt;
    if (!autoReload || !currentUrl || !isLocalWebAddress(currentUrl) || !nativeWebviewRef.current) return;
    void invoke("browser_webview_action", { label: nativeLabel, action: "reload" }).catch(() => undefined);
  }, [autoReload, currentUrl, nativeLabel, turnCompletedAt]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  /** Resolves and records an address. Only sets state, so it is safe during render. */
  const goTo = (raw: string): boolean => {
    const next = resolveWorkspaceBrowserAddress(raw);
    if (!next) {
      setAddressError("请输入完整网址");
      return false;
    }
    setAddressError(null);
    setNativeError(null);
    const base = history.slice(0, historyIndex + 1);
    setHistory([...base, next]);
    setHistoryIndex(base.length);
    setAddress(next);
    setLoading(true);
    return true;
  };

  const navigate = (raw: string) => {
    if (!goTo(raw)) inputRef.current?.focus();
  };

  useSyncOnChange([navigateRequest?.nonce], () => {
    if (navigateRequest?.url) goTo(navigateRequest.url);
  });

  const moveHistory = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= history.length) return;
    setAddressError(null);
    setHistoryIndex(nextIndex);
    setAddress(history[nextIndex]);
    setLoading(true);
  };

  const nativeAction = (action: "back" | "forward" | "reload" | "devtools") => {
    if (!nativeWebviewRef.current) return;
    if (action !== "devtools") setLoading(true);
    void invoke("browser_webview_action", {
      label: nativeLabel,
      action,
    }).then(() => setLoading(false)).catch((error) => {
      setLoading(false);
      setNativeError(describeError(error));
    });
  };

  const toggle = (key: string, value: boolean, set: (value: boolean) => void) => {
    writeBrowserToggle(key, value);
    set(value);
  };

  return (
    <section className="workspace-browser-pane" aria-label="应用内浏览器">
      <header className="workspace-browser-toolbar">
        <button type="button" className="icon-button" title="返回" disabled={!currentUrl || (!isTauri && historyIndex <= 0)} onClick={() => isTauri ? nativeAction("back") : moveHistory(historyIndex - 1)}>
          <ArrowLeft size={15} strokeWidth={1.8} />
        </button>
        <button type="button" className="icon-button" title="前进" disabled={!currentUrl || (!isTauri && (historyIndex < 0 || historyIndex >= history.length - 1))} onClick={() => isTauri ? nativeAction("forward") : moveHistory(historyIndex + 1)}>
          <ArrowRight size={15} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="重新加载"
          disabled={!currentUrl}
          onClick={() => {
            if (isTauri) nativeAction("reload");
            else { setReloadKey((value) => value + 1); setLoading(true); }
          }}
        >
          <RefreshCw size={14} strokeWidth={1.8} className={loading ? "spin" : ""} />
        </button>
        <form
          className="workspace-browser-address"
          onSubmit={(event) => { event.preventDefault(); navigate(address); }}
        >
          <Globe2 size={13} strokeWidth={1.7} />
          <input
            ref={inputRef}
            value={address}
            aria-label="浏览器地址"
            aria-invalid={Boolean(addressError)}
            placeholder="输入网址，如 localhost:5173"
            spellCheck={false}
            onChange={(event) => {
              setAddress(event.target.value);
              if (addressError) setAddressError(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              navigate(address);
            }}
          />
        </form>
        {onVerify && (
          <button type="button" className="icon-button" title="让 Pi 用浏览器检查这个页面（渲染、控制台错误）并修复问题" disabled={!currentUrl} onClick={() => onVerify(currentUrl)}>
            <SearchCheck size={14} strokeWidth={1.75} />
          </button>
        )}
        <button
          type="button"
          className={`icon-button ${commentOpen ? "active" : ""}`}
          title="对当前页面添加反馈"
          disabled={!currentUrl}
          aria-pressed={commentOpen}
          onClick={() => setCommentOpen((value) => !value)}
        >
          <MessageSquarePlus size={14} strokeWidth={1.75} />
        </button>
        <div className="workspace-browser-menu-wrap" ref={menuRef}>
          <button type="button" className={`icon-button ${menuOpen ? "active" : ""}`} title="更多" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>
            <MoreHorizontal size={15} strokeWidth={1.75} />
          </button>
          {menuOpen && (
            <div className="workspace-browser-menu" role="menu">
              <button type="button" role="menuitem" disabled={!currentUrl || !isTauri} onClick={() => { setMenuOpen(false); nativeAction("devtools"); }}>
                <Bug size={14} /><span>开发者工具（控制台、网络）</span>
              </button>
              <button type="button" role="menuitem" disabled={!currentUrl} onClick={() => { setMenuOpen(false); void openUrl(currentUrl); }}>
                <ExternalLink size={14} /><span>在默认浏览器中打开</span>
              </button>
              <div className="workspace-browser-menu-separator" role="separator" />
              <button type="button" role="menuitemcheckbox" aria-checked={autoReload} onClick={() => toggle(BROWSER_AUTO_RELOAD_KEY, !autoReload, setAutoReload)}>
                <RefreshCw size={14} /><span>每轮结束后刷新本地页面</span>{autoReload && <Check size={13} />}
              </button>
              <button type="button" role="menuitemcheckbox" aria-checked={autoVerify} disabled={!onVerify} onClick={() => toggle(BROWSER_AUTO_VERIFY_KEY, !autoVerify, setAutoVerify)}>
                <SearchCheck size={14} /><span>改动后让 Pi 自动验证本地页面</span>{autoVerify && <Check size={13} />}
              </button>
            </div>
          )}
        </div>
      </header>

      {addressError && <div className="workspace-browser-address-error" role="alert">{addressError}</div>}

      {commentOpen && currentUrl && (
        <form
          className="workspace-browser-comment"
          onSubmit={(event) => {
            event.preventDefault();
            const note = comment.trim();
            if (!note) return;
            onComment?.(currentUrl, note);
            setComment("");
            setCommentOpen(false);
          }}
        >
          <div>
            <strong>页面反馈</strong>
            <span title={currentUrl}>{currentUrl}</span>
          </div>
          <textarea autoFocus rows={2} value={comment} placeholder="描述要修改或检查的页面内容" onChange={(event) => setComment(event.target.value)} />
          <button type="submit" className="icon-button" title="发送到对话" disabled={!comment.trim()}>
            <SendHorizontal size={14} strokeWidth={1.8} />
          </button>
        </form>
      )}

      <div ref={viewportRef} className="workspace-browser-content">
        {currentUrl ? (
          <>
            {loading && <div className="workspace-browser-loading">正在加载…</div>}
            {nativeError && <div className="workspace-browser-native-error">{nativeError}</div>}
            {!isTauri && (
              <iframe
                key={`${currentUrl}-${reloadKey}`}
                src={currentUrl}
                title={currentUrl}
                referrerPolicy="strict-origin-when-cross-origin"
                onLoad={() => setLoading(false)}
              />
            )}
          </>
        ) : (
          <div className="workspace-browser-empty">
            <Globe2 size={24} strokeWidth={1.4} />
            <strong>开始浏览</strong>
            <span>输入 URL，或在终端里点击 localhost 链接</span>
            {recentAgentPage?.url && (
              <button type="button" onClick={() => navigate(recentAgentPage.url)} title={recentAgentPage.url}>
                打开 Agent 最近访问的页面{recentLabel ? ` · ${recentLabel}` : ""}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
