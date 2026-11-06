import { useCallback, useEffect, useRef } from "react";
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
import { FileCode2, FolderOpen, RotateCcw, Save, X } from "lucide-react";
import { useAppStore } from "../../store";
import { useWorkbenchStore, type OpenWorkbenchFile } from "../../stores/workbenchStore";

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

export function CodeEditorTab({ cwd }: CodeEditorTabProps) {
  const openFiles = useWorkbenchStore((state) => state.openFiles);
  const activeFilePath = useWorkbenchStore((state) => state.activeFilePath);
  const activeFile = openFiles.find((item) => item.path === activeFilePath) ?? openFiles[0] ?? null;

  const handleSave = useCallback(async () => {
    if (!activeFile || !cwd) return;
    const saved = await useWorkbenchStore.getState().saveFile(cwd, activeFile.path);
    if (saved) {
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

  return (
    <div className="pid-wb-pane">
      <div className="pid-wb-editor-tabs" role="tablist" aria-label="已打开文件">
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
