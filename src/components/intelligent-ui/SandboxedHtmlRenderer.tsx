import { useEffect, useMemo, useRef, useState } from "react";
import type { UiSandboxUrlResult } from "@qianji/protocol";
import { harnessRuntimes } from "../../lib/harnessRuntime";
import {
  buildSandboxedWidgetHtml,
  INTELLIGENT_UI_POSTMESSAGE_SOURCE,
  type IntelligentUiArtifact,
} from "../../lib/intelligentUi";

export type HtmlSandboxHeightPreset = "compact" | "auto" | "full";

const sandboxUrlCache = new Map<string, string>();

async function resolveSandboxFrameSrc(htmlDoc: string): Promise<string> {
  const cached = sandboxUrlCache.get(htmlDoc);
  if (cached) return cached;
  try {
    const res = await harnessRuntimes.call<UiSandboxUrlResult>("ui.sandboxUrl", { html: htmlDoc });
    if (res?.url) {
      if (sandboxUrlCache.size >= 64) {
        const oldest = sandboxUrlCache.keys().next().value;
        if (oldest !== undefined) sandboxUrlCache.delete(oldest);
      }
      sandboxUrlCache.set(htmlDoc, res.url);
      return res.url;
    }
  } catch {
    // Offline or unit-test environment without Host HTTP server: fall back to data: URL.
  }
  return `data:text/html;charset=utf-8,${encodeURIComponent(htmlDoc)}`;
}

function useDocumentDarkTheme(): boolean {
  const [isDark, setIsDark] = useState(() => {
    if (typeof document === "undefined") return false;
    return document.documentElement.dataset.theme === "dark";
  });

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const sync = () => setIsDark(document.documentElement.dataset.theme === "dark");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

export function presetHeightCap(mode: "inline" | "canvas", preset: HtmlSandboxHeightPreset): number {
  if (preset === "compact") return mode === "canvas" ? 420 : 320;
  if (preset === "full") return mode === "canvas" ? 1800 : 1200;
  return mode === "canvas" ? 960 : 640;
}

export function SandboxedHtmlRenderer({
  artifact,
  mode,
  heightPreset,
  manualHeight,
  contentHeight,
  onContentHeight,
  onManualHeight,
  onResetHeight,
  onSendPrompt,
}: {
  artifact: IntelligentUiArtifact;
  mode: "inline" | "canvas";
  heightPreset: HtmlSandboxHeightPreset;
  manualHeight: number | null;
  contentHeight: number | null;
  onContentHeight: (height: number) => void;
  onManualHeight: (height: number) => void;
  onResetHeight: () => void;
  onSendPrompt: (prompt: string) => void;
}) {
  const isDark = useDocumentDarkTheme();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const htmlDoc = useMemo(
    () =>
      buildSandboxedWidgetHtml({
        html: artifact.html ?? "",
        widgetId: artifact.id,
        title: artifact.title,
        isDark,
      }),
    [artifact.html, artifact.id, artifact.title, isDark],
  );

  const [resolvedEntry, setResolvedEntry] = useState<{ doc: string; src: string } | null>(() => {
    const cached = sandboxUrlCache.get(htmlDoc);
    return cached ? { doc: htmlDoc, src: cached } : null;
  });

  const frameSrc = useMemo(() => {
    const cached = sandboxUrlCache.get(htmlDoc);
    if (cached) return cached;
    return resolvedEntry?.doc === htmlDoc ? resolvedEntry.src : null;
  }, [htmlDoc, resolvedEntry]);

  useEffect(() => {
    if (sandboxUrlCache.has(htmlDoc)) return;
    let cancelled = false;
    void resolveSandboxFrameSrc(htmlDoc).then((url) => {
      if (!cancelled) setResolvedEntry({ doc: htmlDoc, src: url });
    });
    return () => {
      cancelled = true;
    };
  }, [htmlDoc]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const payload = event.data as Record<string, unknown> | null;
      if (!payload || payload.source !== INTELLIGENT_UI_POSTMESSAGE_SOURCE) return;
      if (payload.widgetId !== artifact.id) return;

      if (payload.kind === "resize" && typeof payload.height === "number" && Number.isFinite(payload.height)) {
        onContentHeight(Math.max(96, Math.ceil(payload.height)));
      } else if (payload.kind === "prompt" && typeof payload.prompt === "string" && payload.prompt.trim()) {
        onSendPrompt(payload.prompt.trim());
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [artifact.id, onContentHeight, onSendPrompt]);

  if (mode === "canvas") {
    return (
      <div className="pi-iui-html-frame-wrap is-canvas-stage">
        {frameSrc ? (
          <iframe
            ref={iframeRef}
            className="pi-iui-html-frame is-canvas-stage"
            sandbox="allow-scripts"
            src={frameSrc}
            title={artifact.title}
          />
        ) : (
          <div className="pi-iui-html-frame-placeholder is-canvas-stage" />
        )}
      </div>
    );
  }

  const cap = presetHeightCap(mode, heightPreset);
  const fallbackHeight = Math.min(cap, 380);
  const autoHeight = contentHeight !== null ? Math.min(cap, Math.max(112, contentHeight)) : fallbackHeight;
  const effectiveHeight = manualHeight ?? autoHeight;
  const isClipped = contentHeight !== null && contentHeight > effectiveHeight + 6;

  const minDrag = 180;
  const maxDrag = 960;

  return (
    <div className="pi-iui-html-frame-wrap">
      {frameSrc ? (
        <iframe
          ref={iframeRef}
          className="pi-iui-html-frame"
          sandbox="allow-scripts"
          src={frameSrc}
          title={artifact.title}
          style={{
            height: `${effectiveHeight}px`,
            pointerEvents: isDragging ? "none" : undefined,
          }}
        />
      ) : (
        <div className="pi-iui-html-frame-placeholder" style={{ height: `${effectiveHeight}px` }} />
      )}
      <div
        className={`pi-iui-resize-bar${isDragging ? " is-dragging" : ""}${isClipped ? " is-clipped" : ""}`}
        role="separator"
        aria-orientation="horizontal"
        aria-label="上下拖动调节沙箱高度"
        title="上下拖动调节沙箱高度（双击恢复适中高度）"
        onDoubleClick={onResetHeight}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragStartRef.current = { startY: event.clientY, startHeight: effectiveHeight };
          setIsDragging(true);
        }}
        onPointerMove={(event) => {
          if (!dragStartRef.current) return;
          const delta = event.clientY - dragStartRef.current.startY;
          const next = Math.round(Math.min(maxDrag, Math.max(minDrag, dragStartRef.current.startHeight + delta)));
          onManualHeight(next);
        }}
        onPointerUp={(event) => {
          if (!dragStartRef.current) return;
          dragStartRef.current = null;
          setIsDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={() => {
          dragStartRef.current = null;
          setIsDragging(false);
        }}
      >
        <span className="pi-iui-resize-status">
          {isClipped
            ? "内容超出当前高度 · 可拖底边或点「完整」"
            : manualHeight !== null
              ? `${effectiveHeight}px · 双击恢复适中`
              : ""}
        </span>
        <span className="pi-iui-resize-grip" aria-hidden="true" />
        <span className="pi-iui-resize-spacer" aria-hidden="true" />
      </div>
    </div>
  );
}
