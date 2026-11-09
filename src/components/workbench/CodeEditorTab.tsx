import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import {
  Code2,
  Columns2,
  ExternalLink,
  Eye,
  FileCode2,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Save,
  X,
} from "lucide-react";
import { Markdown } from "../Markdown";
import { useAppStore } from "../../store";
import {
  previewKindForPath,
  resolveWorkspacePreviewUrl,
  useWorkbenchStore,
  type OpenWorkbenchFile,
  type WorkbenchFileViewMode,
  type WorkbenchPreviewKind,
} from "../../stores/workbenchStore";

export interface CodeEditorTabProps {
  cwd: string;
}

function languageExtensionForPath(filePath: string): Extension {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ typescript: true, jsx: true });
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "json":
    case "jsonc":
      return json();
    case "md":
    case "mdx":
      return markdown();
    case "css":
    case "scss":
    case "less":
      return css();
    case "html":
    case "htm":
    case "vue":
      return html();
    case "py":
      return python();
    case "rs":
      return rust();
    case "go":
      return go();
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
      return cpp();
    case "java":
      return java();
    case "php":
      return php();
    case "sql":
      return sql();
    case "xml":
    case "svg":
      return xml();
    case "yml":
    case "yaml":
    case "toml":
      return yaml();
    default:
      return [];
  }
}

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12.5px",
    backgroundColor: "transparent",
    color: "var(--text)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, 'JetBrains Mono Variable', Consolas, monospace)",
    lineHeight: "1.55",
    overflow: "auto",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--text-3)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--panel-soft)",
    color: "var(--text-2)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--panel-soft) 65%, transparent)",
  },
  "&.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--text)",
  },
});

interface CodeMirrorSurfaceProps {
  cwd: string;
  file: OpenWorkbenchFile;
  onSave: () => void;
}

function CodeMirrorSurface({ file, onSave }: CodeMirrorSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartmentRef = useRef(new Compartment());
  const readOnlyCompartmentRef = useRef(new Compartment());
  const activePathRef = useRef(file.path);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;
    const langCompartment = langCompartmentRef.current;
    const readOnlyCompartment = readOnlyCompartmentRef.current;
    activePathRef.current = file.path;

    const state = EditorState.create({
      doc: file.content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        bracketMatching(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        editorTheme,
        langCompartment.of(languageExtensionForPath(file.path)),
        readOnlyCompartment.of(EditorState.readOnly.of(file.truncated)),
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              onSaveRef.current();
              return true;
            },
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const nextText = update.state.doc.toString();
          useWorkbenchStore.getState().updateFileContent(activePathRef.current, nextText);
        }),
      ],
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Re-create view when switching file path; incremental edits stay inside the same view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);

  // Sync external content reloads without resetting cursor during normal typing.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentText = view.state.doc.toString();
    if (currentText !== file.content) {
      view.dispatch({
        changes: { from: 0, to: currentText.length, insert: file.content },
      });
    }
    view.dispatch({
      effects: [
        langCompartmentRef.current.reconfigure(languageExtensionForPath(file.path)),
        readOnlyCompartmentRef.current.reconfigure(EditorState.readOnly.of(file.truncated)),
      ],
    });
  }, [file.content, file.path, file.truncated]);

  // Scroll to target line when opened from AI `sidebar_open` or file links.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !file.line || file.line < 1) return;
    const clampedLine = Math.min(file.line, view.state.doc.lines);
    const lineInfo = view.state.doc.line(clampedLine);
    view.dispatch({
      selection: { anchor: lineInfo.from },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }),
    });
  }, [file.line, file.path]);

  return <div ref={hostRef} className="pid-wb-cm-host" />;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function injectBaseTag(rawHtml: string, baseUrl: string | null): string {
  if (!baseUrl) return rawHtml;
  if (/<base\b/i.test(rawHtml)) return rawHtml;
  const baseTag = `<base href="${escapeHtmlAttr(baseUrl)}" />`;
  if (/<head(\s[^>]*)?>/i.test(rawHtml)) {
    return rawHtml.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n${baseTag}`);
  }
  if (/<html(\s[^>]*)?>/i.test(rawHtml)) {
    return rawHtml.replace(/<html(\s[^>]*)?>/i, (match) => `${match}\n<head>${baseTag}</head>`);
  }
  return `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8" />\n${baseTag}\n</head>\n<body>\n${rawHtml}\n</body>\n</html>`;
}

function buildSvgStageHtml(svgContent: string, baseUrl: string | null): string {
  const baseTag = baseUrl ? `<base href="${escapeHtmlAttr(baseUrl)}" />` : "";
  return [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8" />',
    baseTag,
    "<style>",
    "  html, body {",
    "    margin: 0;",
    "    min-height: 100vh;",
    "    display: grid;",
    "    place-items: center;",
    "    padding: 16px;",
    "    box-sizing: border-box;",
    "    background: transparent;",
    "  }",
    "  svg { max-width: 100%; height: auto; }",
    "</style>",
    "</head>",
    `<body>${svgContent}</body>`,
    "</html>",
  ].join("\n");
}

function appendCacheVersion(url: string, token: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_v=${encodeURIComponent(token)}`;
}

interface DynamicDocumentPreviewProps {
  file: OpenWorkbenchFile;
  kind: Exclude<WorkbenchPreviewKind, null>;
  previewHttpUrl: string | null;
  reloadNonce: number;
}

function DynamicDocumentPreview({
  file,
  kind,
  previewHttpUrl,
  reloadNonce,
}: DynamicDocumentPreviewProps) {
  const isDirty = file.content !== file.savedContent;
  const [debouncedContent, setDebouncedContent] = useState(file.content);

  useEffect(() => {
    if (!isDirty) return;
    const timer = window.setTimeout(() => {
      setDebouncedContent(file.content);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [file.content, file.path, isDirty]);

  const renderedContent = isDirty ? debouncedContent : file.content;

  const liveDataUrl = useMemo(() => {
    if (kind === "markdown") return "";
    const htmlDoc = kind === "svg"
      ? buildSvgStageHtml(renderedContent, previewHttpUrl)
      : injectBaseTag(renderedContent, previewHttpUrl);
    return `data:text/html;charset=utf-8,${encodeURIComponent(htmlDoc)}`;
  }, [kind, previewHttpUrl, renderedContent]);

  if (kind === "markdown") {
    return (
      <div className="pid-wb-md-preview dshc-md" data-workbench-preview="markdown">
        <Markdown content={file.content} />
      </div>
    );
  }

  if (kind === "svg" && file.isBinary && file.data) {
    return (
      <div className="pid-wb-image-preview" data-workbench-preview="svg-binary">
        <img src={`data:image/svg+xml;base64,${file.data}`} alt={file.path} />
      </div>
    );
  }

  const useLoopbackServer = !isDirty
    && previewHttpUrl !== null
    && (kind === "html" || (kind === "svg" && file.content.trim() === ""));

  const frameSrc = useLoopbackServer
    ? appendCacheVersion(previewHttpUrl, `${reloadNonce}-${file.savedContent.length}`)
    : liveDataUrl;

  const sandboxFlags = useLoopbackServer
    ? "allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
    : "allow-scripts allow-forms allow-popups allow-modals";

  return (
    <div className="pid-wb-preview-stage" data-workbench-preview={kind}>
      <iframe
        key={`${file.path}:${useLoopbackServer ? "http" : "data"}:${reloadNonce}`}
        className="pid-wb-iframe"
        src={frameSrc}
        title={`动态预览 ${file.path}`}
        sandbox={sandboxFlags}
      />
    </div>
  );
}

export function CodeEditorTab({ cwd }: CodeEditorTabProps) {
  const openFiles = useWorkbenchStore((state) => state.openFiles);
  const activeFilePath = useWorkbenchStore((state) => state.activeFilePath);
  const activeFile = openFiles.find((item) => item.path === activeFilePath) ?? openFiles[0] ?? null;

  const [previewUrlEntry, setPreviewUrlEntry] = useState<{ key: string; url: string | null } | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);

  const previewKind = activeFile ? previewKindForPath(activeFile.path) : null;
  const activePreviewKey = activeFile && cwd && (previewKind === "html" || previewKind === "svg")
    ? `${cwd}::${activeFile.path}`
    : null;
  const previewHttpUrl = activePreviewKey && previewUrlEntry?.key === activePreviewKey
    ? previewUrlEntry.url
    : null;

  useEffect(() => {
    if (!activePreviewKey || !activeFile || !cwd) return;
    let cancelled = false;
    void resolveWorkspacePreviewUrl(cwd, activeFile.path).then((url) => {
      if (!cancelled) setPreviewUrlEntry({ key: activePreviewKey, url });
    });
    return () => {
      cancelled = true;
    };
  }, [activeFile, activePreviewKey, cwd]);

  const handleSave = useCallback(async () => {
    if (!activeFile || !cwd) return;
    const saved = await useWorkbenchStore.getState().saveFile(cwd, activeFile.path);
    if (saved) {
      setPreviewNonce((n) => n + 1);
      useAppStore.getState().showToast(`已保存 ${activeFile.path.split("/").pop() ?? activeFile.path}`, "info");
      void useAppStore.getState().refreshGit();
    }
  }, [activeFile, cwd]);

  const handleReload = useCallback(() => {
    if (!activeFile || !cwd) return;
    if (
      activeFile.content !== activeFile.savedContent
      && !window.confirm(`放弃 ${activeFile.path} 的未保存修改并重新加载？`)
    ) {
      return;
    }
    setPreviewNonce((n) => n + 1);
    void useWorkbenchStore.getState().reloadFile(cwd, activeFile.path);
  }, [activeFile, cwd]);

  const handleCloseTab = useCallback((file: OpenWorkbenchFile) => {
    if (
      file.content !== file.savedContent
      && !window.confirm(`关闭 ${file.path}？未保存的修改将丢失。`)
    ) {
      return;
    }
    useWorkbenchStore.getState().closeFile(file.path);
  }, []);

  if (!activeFile) {
    return (
      <div className="pid-wb-empty">
        <FileCode2 size={22} className="pid-wb-empty-icon" />
        <p>尚未打开任何文件</p>
        <button
          type="button"
          className="pid-wb-btn"
          onClick={() => useWorkbenchStore.getState().openFilesTab()}
        >
          <FolderOpen size={13} />
          <span>从文件树选择文件</span>
        </button>
      </div>
    );
  }

  const isDirty = activeFile.content !== activeFile.savedContent;
  const canRenderPreview = previewKind !== null && (!activeFile.isBinary || previewKind === "svg");
  const defaultMode: WorkbenchFileViewMode =
    previewKind === "html" || previewKind === "svg" ? "preview" : "code";
  const effectiveMode: WorkbenchFileViewMode = !canRenderPreview
    ? "code"
    : activeFile.isBinary
      ? "preview"
      : (activeFile.viewMode ?? defaultMode);

  const setMode = (mode: WorkbenchFileViewMode) => {
    useWorkbenchStore.getState().setFileViewMode(activeFile.path, mode);
  };

  return (
    <div className="pid-wb-pane">
      <div
        className="pid-wb-editor-tabs"
        role="tablist"
        aria-label="已打开文件"
        onWheel={(event) => {
          const el = event.currentTarget;
          if (el.scrollWidth > el.clientWidth && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            el.scrollLeft += event.deltaY;
          }
        }}
      >
        {openFiles.map((file) => {
          const dirty = file.content !== file.savedContent;
          const active = file.path === activeFile.path;
          const fileName = file.path.split("/").pop() || file.path;
          return (
            <div
              key={file.path}
              role="tab"
              aria-selected={active}
              className={`pid-wb-editor-tab${active ? " active" : ""}`}
              title={file.path}
            >
              <button
                type="button"
                className="pid-wb-editor-tab-label"
                onClick={() => useWorkbenchStore.getState().selectFile(file.path)}
              >
                <span>{fileName}</span>
                {dirty && <span className="pid-wb-dirty-dot" aria-label="未保存" />}
              </button>
              <button
                type="button"
                className="pid-wb-editor-tab-close"
                title="关闭文件"
                onClick={() => handleCloseTab(file)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="pid-wb-subbar">
        <span className="pid-wb-filepath" title={activeFile.path}>{activeFile.path}</span>
        <div className="pid-wb-subbar-actions">
          {canRenderPreview && !activeFile.isBinary && (
            <div className="pid-wb-view-seg" role="tablist" aria-label="文件视图模式">
              <button
                type="button"
                role="tab"
                aria-selected={effectiveMode === "preview"}
                className={`pid-wb-view-seg-btn${effectiveMode === "preview" ? " active" : ""}`}
                title="动态渲染预览"
                onClick={() => setMode("preview")}
              >
                <Eye size={12} />
                <span>预览</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={effectiveMode === "split"}
                className={`pid-wb-view-seg-btn${effectiveMode === "split" ? " active" : ""}`}
                title="源码与实时预览分栏"
                onClick={() => setMode("split")}
              >
                <Columns2 size={12} />
                <span>分栏</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={effectiveMode === "code"}
                className={`pid-wb-view-seg-btn${effectiveMode === "code" ? " active" : ""}`}
                title="编辑源码"
                onClick={() => setMode("code")}
              >
                <Code2 size={12} />
                <span>源码</span>
              </button>
            </div>
          )}

          {effectiveMode !== "code" && (previewKind === "html" || previewKind === "svg") && (
            <>
              <button
                type="button"
                className="pid-wb-icon-btn"
                title="重新运行动态预览"
                aria-label="刷新预览"
                onClick={() => setPreviewNonce((n) => n + 1)}
              >
                <RefreshCw size={13} />
              </button>
              <button
                type="button"
                className="pid-wb-icon-btn"
                disabled={!previewHttpUrl}
                title="在外部浏览器中打开"
                aria-label="在外部浏览器中打开"
                onClick={() => {
                  if (previewHttpUrl) void openUrl(previewHttpUrl);
                }}
              >
                <ExternalLink size={13} />
              </button>
            </>
          )}

          {activeFile.truncated && (
            <span className="pid-wb-badge warn" title="大文件已截断为只读预览">只读（大文件截断）</span>
          )}
          <button
            type="button"
            className="pid-wb-icon-btn"
            title="从磁盘重新加载"
            onClick={handleReload}
          >
            <RotateCcw size={13} />
          </button>
          {!activeFile.isBinary && !activeFile.truncated && (
            <button
              type="button"
              className={`pid-wb-btn small${isDirty ? " primary" : ""}`}
              disabled={!isDirty || Boolean(activeFile.saving)}
              title="保存文件 (Ctrl+S)"
              onClick={() => void handleSave()}
            >
              <Save size={12} />
              <span>{activeFile.saving ? "保存中…" : "保存"}</span>
            </button>
          )}
        </div>
      </div>

      <div className="pid-wb-editor-body">
        {activeFile.loading ? (
          <div className="pid-wb-empty">正在读取 {activeFile.path}…</div>
        ) : activeFile.error ? (
          <div className="pid-wb-empty error">{activeFile.error}</div>
        ) : canRenderPreview && previewKind !== null && effectiveMode === "preview" ? (
          <DynamicDocumentPreview
            file={activeFile}
            kind={previewKind}
            previewHttpUrl={previewHttpUrl}
            reloadNonce={previewNonce}
          />
        ) : canRenderPreview && previewKind !== null && effectiveMode === "split" ? (
          <div className="pid-wb-split-view">
            <div className="pid-wb-split-pane is-code">
              <CodeMirrorSurface cwd={cwd} file={activeFile} onSave={() => void handleSave()} />
            </div>
            <div className="pid-wb-split-pane is-preview">
              <DynamicDocumentPreview
                file={activeFile}
                kind={previewKind}
                previewHttpUrl={previewHttpUrl}
                reloadNonce={previewNonce}
              />
            </div>
          </div>
        ) : activeFile.isBinary ? (
          activeFile.mimeType?.startsWith("image/") && activeFile.data ? (
            <div className="pid-wb-image-preview">
              <img
                src={`data:${activeFile.mimeType};base64,${activeFile.data}`}
                alt={activeFile.path}
              />
            </div>
          ) : (
            <div className="pid-wb-empty">二进制文件无法直接作为文本编辑（{(activeFile.size / 1024).toFixed(1)} KB）</div>
          )
        ) : (
          <CodeMirrorSurface cwd={cwd} file={activeFile} onSave={() => void handleSave()} />
        )}
      </div>
    </div>
  );
}
