import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe2, MessageSquarePlus, RefreshCw, SendHorizontal, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { resolveWorkspaceBrowserAddress } from "../lib/webAccess";
import type { AgentBrowserState } from "../types";

interface BrowserWorkspacePanelProps {
  recentAgentPage: AgentBrowserState | null;
  onComment?: (url: string, comment: string) => void;
  onClose: () => void;
}

export function BrowserWorkspacePanel({ recentAgentPage, onComment, onClose }: BrowserWorkspacePanelProps) {
  const [address, setAddress] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const nativeWebviewRef = useRef<Webview | null>(null);
  const nativeLabelRef = useRef(`workspace-browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

  useEffect(() => {
    if (!isTauri || !currentUrl) return;
    const existing = nativeWebviewRef.current;
    if (existing) {
      setLoading(true);
      setNativeError(null);
      void invoke("browser_webview_action", {
        label: nativeLabelRef.current,
        action: "navigate",
        url: currentUrl,
      }).then(() => setLoading(false)).catch((error) => {
        setLoading(false);
        setNativeError(error instanceof Error ? error.message : String(error));
      });
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    setLoading(true);
    setNativeError(null);
    const webview = new Webview(getCurrentWindow(), nativeLabelRef.current, {
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
  }, [currentUrl, isTauri, placeNativeWebview]);

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

  const navigate = (raw: string) => {
    const next = resolveWorkspaceBrowserAddress(raw);
    if (!next) {
      setAddressError("请输入完整网址");
      inputRef.current?.focus();
      return;
    }
    setAddressError(null);
    setNativeError(null);
    const base = history.slice(0, historyIndex + 1);
    setHistory([...base, next]);
    setHistoryIndex(base.length);
    setAddress(next);
    setLoading(true);
  };

  const moveHistory = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= history.length) return;
    setAddressError(null);
    setHistoryIndex(nextIndex);
    setAddress(history[nextIndex]);
    setLoading(true);
  };

  const nativeHistoryAction = (action: "back" | "forward" | "reload") => {
    if (!nativeWebviewRef.current) return;
    setLoading(true);
    void invoke("browser_webview_action", {
      label: nativeLabelRef.current,
      action,
    }).then(() => setLoading(false)).catch((error) => {
      setLoading(false);
      setNativeError(error instanceof Error ? error.message : String(error));
    });
  };

  return (
    <section className="workspace-browser-pane" aria-label="应用内浏览器">
      <header className="workspace-browser-toolbar">
        <button type="button" className="icon-button" title="返回" disabled={!currentUrl || (!isTauri && historyIndex <= 0)} onClick={() => isTauri ? nativeHistoryAction("back") : moveHistory(historyIndex - 1)}>
          <ArrowLeft size={15} strokeWidth={1.8} />
        </button>
        <button type="button" className="icon-button" title="前进" disabled={!currentUrl || (!isTauri && (historyIndex < 0 || historyIndex >= history.length - 1))} onClick={() => isTauri ? nativeHistoryAction("forward") : moveHistory(historyIndex + 1)}>
          <ArrowRight size={15} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="重新加载"
          disabled={!currentUrl}
          onClick={() => {
            if (isTauri) nativeHistoryAction("reload");
            else { setReloadKey((value) => value + 1); setLoading(true); }
          }}
        >
          <RefreshCw size={14} strokeWidth={1.8} />
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
            placeholder="输入网址"
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
        <button type="button" className="icon-button" title="在默认浏览器中打开" disabled={!currentUrl} onClick={() => void openUrl(currentUrl)}>
          <ExternalLink size={14} strokeWidth={1.75} />
        </button>
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
        <button type="button" className="icon-button" title="关闭浏览器" onClick={onClose}>
          <X size={14} strokeWidth={1.75} />
        </button>
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
            <span>输入 URL 以打开页面</span>
            {recentAgentPage?.url && (
              <button type="button" onClick={() => navigate(recentAgentPage.url)} title={recentAgentPage.url}>
                打开最近页面{recentLabel ? ` · ${recentLabel}` : ""}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
