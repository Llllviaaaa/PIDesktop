/**
 * The sandboxed HTML engine of Intelligent UI widgets (re-exported by
 * intelligentUi.ts): the widget source and the `sandbox="allow-scripts"`,
 * `connect-src 'none'` document an html widget is rendered in.
 */
import type { IntelligentUiArtifact } from "./intelligentUi";

export const INTELLIGENT_UI_POSTMESSAGE_SOURCE = "pi-intelligent-ui";

export function serializeWidgetSource(artifact: IntelligentUiArtifact): string {
  if (artifact.engine === "html") {
    return artifact.html ?? "";
  }
  return JSON.stringify(
    {
      id: artifact.id,
      title: artifact.title,
      ...(artifact.subtitle ? { subtitle: artifact.subtitle } : {}),
      engine: "declarative",
      spec: artifact.spec,
    },
    null,
    2,
  );
}

/* ============================================================================
 * Sandboxed HTML Escape Pod (`sandbox="allow-scripts"` + `data:text/html`)
 * ========================================================================== */

export function buildSandboxedWidgetHtml(options: {
  html: string;
  widgetId: string;
  title: string;
  isDark: boolean;
}): string {
  const { html, widgetId, title, isDark } = options;
  const paletteCss = isDark
    ? `
      --pi-bg: #141619;
      --pi-surface: #191c20;
      --pi-surface-soft: #1f2328;
      --pi-text: #e6e8ec;
      --pi-muted: #9aa1ac;
      --pi-subtle: #6b7280;
      --pi-border: rgba(255, 255, 255, 0.08);
      --pi-border-strong: rgba(255, 255, 255, 0.14);
      --pi-accent: #6687a8;
      --pi-accent-soft: rgba(102, 135, 168, 0.16);
      --pi-accent-text: #ffffff;
      --pi-good: #4ca378;
      --pi-warn: #c79a4b;
      --pi-bad: #c96565;
      color-scheme: dark;
    `
    : `
      --pi-bg: #ffffff;
      --pi-surface: #f7f8fa;
      --pi-surface-soft: #f0f2f5;
      --pi-text: #181a1e;
      --pi-muted: #5c6370;
      --pi-subtle: #8b93a1;
      --pi-border: rgba(15, 23, 42, 0.08);
      --pi-border-strong: rgba(15, 23, 42, 0.15);
      --pi-accent: #4c6a88;
      --pi-accent-soft: rgba(76, 106, 136, 0.12);
      --pi-accent-text: #ffffff;
      --pi-good: #2d7a56;
      --pi-warn: #9c6b19;
      --pi-bad: #b44444;
      color-scheme: light;
    `;

  const escapedTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const bridgeScript = `
(function () {
  var WIDGET_ID = ${JSON.stringify(widgetId)};
  var SOURCE = ${JSON.stringify(INTELLIGENT_UI_POSTMESSAGE_SOURCE)};
  var lastHeight = 0;
  var rafId = 0;
  function post(payload) {
    try {
      window.parent.postMessage(Object.assign({ source: SOURCE, widgetId: WIDGET_ID }, payload), "*");
    } catch (_) {}
  }
  function measure() {
    var root = document.getElementById("pi-widget-root") || document.body;
    if (!root) return;
    var rect = root.getBoundingClientRect();
    var h = Math.ceil(Math.max(root.scrollHeight, root.offsetHeight, rect.height, 96));
    if (Math.abs(h - lastHeight) > 1) {
      lastHeight = h;
      post({ kind: "resize", height: h });
    }
  }
  function scheduleMeasure() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      measure();
    });
  }
  window.piUI = Object.freeze({
    sendPrompt: function (text) {
      if (typeof text === "string" && text.trim()) {
        post({ kind: "prompt", prompt: text.trim() });
      }
    },
    notifyResize: measure
  });
  document.addEventListener("click", function (e) {
    var target = e.target && e.target.closest ? e.target.closest("[data-pi-prompt]") : null;
    if (!target) return;
    var promptText = target.getAttribute("data-pi-prompt");
    if (promptText && promptText.trim()) {
      e.preventDefault();
      window.piUI.sendPrompt(promptText);
    }
  });
  window.addEventListener("message", function (e) {
    var data = e && e.data;
    if (data && data.source === SOURCE && data.widgetId === WIDGET_ID && data.kind === "remeasure") {
      lastHeight = 0;
      measure();
    }
  });
  function attachObservers() {
    var root = document.getElementById("pi-widget-root") || document.body;
    if (typeof ResizeObserver !== "undefined" && root) {
      var ro = new ResizeObserver(scheduleMeasure);
      ro.observe(root);
      if (document.body && document.body !== root) ro.observe(document.body);
    }
    if (typeof MutationObserver !== "undefined" && root) {
      var mo = new MutationObserver(scheduleMeasure);
      mo.observe(root, { childList: true, subtree: true, attributes: true });
    }
    measure();
    setTimeout(measure, 60);
    setTimeout(measure, 240);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attachObservers);
  } else {
    attachObservers();
  }
  window.addEventListener("load", measure);
})();
`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; connect-src 'none';" />
<title>${escapedTitle}</title>
<style>
  :root {
    ${paletteCss}
    --pi-radius: 8px;
    --pi-font: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    --pi-mono: "JetBrains Mono", "Cascadia Mono", Consolas, monospace;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    color: var(--pi-text);
    font: 13px/1.55 var(--pi-font);
    -webkit-font-smoothing: antialiased;
  }
  #pi-widget-root {
    display: flow-root;
    padding: 14px 16px;
  }
  button, input, select, textarea {
    font: inherit;
    color: inherit;
  }
  button {
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--pi-border-strong);
    background: var(--pi-surface);
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
  }
  button:hover {
    background: var(--pi-surface-soft);
  }
  button.primary {
    background: var(--pi-accent);
    border-color: var(--pi-accent);
    color: var(--pi-accent-text);
  }
  input[type="text"], input[type="number"], select, textarea {
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--pi-border-strong);
    background: var(--pi-surface);
    outline: none;
  }
  input[type="range"] {
    accent-color: var(--pi-accent);
  }
  code, pre {
    font-family: var(--pi-mono);
  }
</style>
<script>${bridgeScript}</script>
</head>
<body>
<div id="pi-widget-root">${html}</div>
</body>
</html>`;
}

export function buildSandboxedWidgetDataUrl(options: {
  html: string;
  widgetId: string;
  title: string;
  isDark: boolean;
}): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildSandboxedWidgetHtml(options))}`;
}
