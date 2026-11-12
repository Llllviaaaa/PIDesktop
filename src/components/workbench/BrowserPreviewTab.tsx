import { useState, type FormEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Globe, RefreshCw, ShieldAlert } from "lucide-react";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { useAppStore } from "../../store";
import { resolveWorkspacePreviewUrl, useWorkbenchStore } from "../../stores/workbenchStore";

function looksLikeWorkspaceHtmlPath(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return false;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)) return false;
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) return true;
  return /\.(?:html?|svg)(?:[?#].*)?$/i.test(trimmed);
}

function normalizePreviewUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Preserve explicit non-http(s) schemes so `sanitizePreviewUrl` blocks them instead of mangling.
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return trimmed;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

/**
 * Validate a candidate preview URL before embedding in a `sandbox="allow-scripts allow-same-origin"` iframe.
 * Allows only `http:` / `https:`, blocks internal Tauri/WebView2 IPC pseudo-hosts, and blocks same-origin with
 * the Qianji renderer shell so untrusted pages cannot access `window.parent`.
 */
export function sanitizePreviewUrl(raw: string, hostOrigin?: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    !hostname
    || hostname === "tauri.localhost"
    || hostname === "ipc.localhost"
    || hostname === "asset.localhost"
    || hostname.endsWith(".tauri.localhost")
    || hostname.endsWith(".ipc.localhost")
    || hostname.endsWith(".asset.localhost")
  ) {
    return null;
  }
  const effectiveHostOrigin = hostOrigin ?? (
    typeof window !== "undefined" && window.location ? window.location.origin : undefined
  );
  if (
    effectiveHostOrigin
    && effectiveHostOrigin !== "null"
    && parsed.origin.toLowerCase() === effectiveHostOrigin.toLowerCase()
  ) {
    return null;
  }
  return trimmed;
}

export function BrowserPreviewTab({ cwd = "" }: { cwd?: string }) {
  const previewUrl = useWorkbenchStore((state) => state.previewUrl);
  const setPreviewUrl = useWorkbenchStore((state) => state.setPreviewUrl);
  const agentBrowser = useAppStore((state) => state.agentBrowser);

  const [draftUrl, setDraftUrl] = useState(() => previewUrl);
  const [reloadNonce, setReloadNonce] = useState(0);

  useSyncOnChange([previewUrl], () => {
    setDraftUrl(previewUrl);
  });

  const rawCandidate = previewUrl.trim() || (agentBrowser?.url?.trim() ?? "");
  const activeUrl = sanitizePreviewUrl(rawCandidate) ?? "";
  const isBlockedCandidate = previewUrl.trim() !== "" && sanitizePreviewUrl(previewUrl) === null;
  const safeAgentBrowserUrl = agentBrowser?.url ? sanitizePreviewUrl(agentBrowser.url) : null;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const raw = draftUrl.trim();
    if (cwd && looksLikeWorkspaceHtmlPath(raw)) {
      const cleanPath = raw.replace(/^(?:\.\/)+/, "").replace(/[?#].*$/, "");
      void resolveWorkspacePreviewUrl(cwd, cleanPath).then((resolved) => {
        const nextUrl = resolved ?? normalizePreviewUrl(raw);
        setDraftUrl(nextUrl);
        setPreviewUrl(nextUrl);
      });
      return;
    }
    const normalized = normalizePreviewUrl(raw);
    setDraftUrl(normalized);
    setPreviewUrl(normalized);
  };

  return (
    <div className="pid-wb-pane">
      <form className="pid-wb-subbar" onSubmit={handleSubmit}>
        <div className="pid-wb-search-box">
          <Globe size={13} className="pid-wb-search-icon" />
          <input
            type="text"
            className="pid-wb-search-input"
            placeholder="输入本地或远程预览地址（如 http://localhost:5173）"
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="pid-wb-icon-btn"
          disabled={!activeUrl}
          title="重新加载预览"
          onClick={() => setReloadNonce((value) => value + 1)}
        >
          <RefreshCw size={13} />
        </button>
        <button
          type="button"
          className="pid-wb-icon-btn"
          disabled={!activeUrl}
          title="在外部浏览器中打开"
          onClick={() => {
            if (activeUrl) void openUrl(activeUrl);
          }}
        >
          <ExternalLink size={13} />
        </button>
      </form>

      {agentBrowser?.screenshot && (
        <div className="pid-wb-browser-snapshot">
          <div className="pid-wb-section-header">
            <span>Agent 浏览器最新快照：{agentBrowser.title}</span>
            {safeAgentBrowserUrl && (
              <button
                type="button"
                className="pid-wb-btn small"
                onClick={() => setPreviewUrl(safeAgentBrowserUrl)}
              >
                载入此地址
              </button>
            )}
          </div>
          <img
            className="pid-wb-browser-shot-img"
            src={`data:${agentBrowser.screenshot.mimeType};base64,${agentBrowser.screenshot.data}`}
            alt={agentBrowser.title}
          />
        </div>
      )}

      <div className="pid-wb-preview-stage">
        {isBlockedCandidate ? (
          <div className="pid-wb-empty error">
            <ShieldAlert size={22} className="pid-wb-empty-icon" />
            <p>已拦截不安全的预览地址：仅允许独立的 http:// 或 https:// 页面（禁止伪协议、内部 IPC 域名或宿主同源地址）。</p>
          </div>
        ) : activeUrl ? (
          <iframe
            key={`${activeUrl}:${reloadNonce}`}
            className="pid-wb-iframe"
            src={activeUrl}
            title="Web 预览"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        ) : (
          <div className="pid-wb-empty">
            <Globe size={22} className="pid-wb-empty-icon" />
            <p>输入开发服务器地址即可在此实时预览页面，或等待 Agent 打开页面。</p>
          </div>
        )}
      </div>
    </div>
  );
}
