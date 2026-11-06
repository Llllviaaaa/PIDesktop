import { useState, type FormEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Globe, RefreshCw } from "lucide-react";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { agentBrowserFromMessages } from "../../lib/toolPanels";
import { useAppStore } from "../../store";
import { useWorkbenchStore } from "../../stores/workbenchStore";

function normalizePreviewUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

export function BrowserPreviewTab() {
  const previewUrl = useWorkbenchStore((state) => state.previewUrl);
  const setPreviewUrl = useWorkbenchStore((state) => state.setPreviewUrl);
  const messages = useAppStore((state) => state.messages);
  const agentBrowser = agentBrowserFromMessages(messages);

  const [draftUrl, setDraftUrl] = useState(() => previewUrl);
  const [reloadNonce, setReloadNonce] = useState(0);

  useSyncOnChange([previewUrl], () => {
    setDraftUrl(previewUrl);
  });

  const activeUrl = previewUrl || (
    agentBrowser?.url && /^https?:\/\//i.test(agentBrowser.url) ? agentBrowser.url : ""
  );

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizePreviewUrl(draftUrl);
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
            {/^https?:\/\//i.test(agentBrowser.url) && (
              <button
                type="button"
                className="pid-wb-btn small"
                onClick={() => setPreviewUrl(agentBrowser.url)}
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
        {activeUrl ? (
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
