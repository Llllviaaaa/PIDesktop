import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
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
import { useWorkbenchStore, type OpenWorkbenchFile } from "../../stores/workbenchStore";

const languageCache = new Map<string, Extension>();

function languageKeyForPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return "ts";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
      return "js";
    case "jsx":
      return "jsx";
    case "json":
    case "jsonc":
      return "json";
    case "md":
    case "mdx":
    case "markdown":
      return "md";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "vue":
      return "html";
    case "py":
      return "py";
    case "rs":
      return "rs";
    case "go":
      return "go";
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "cxx":
    case "hpp":
      return "cpp";
    case "java":
      return "java";
    case "php":
      return "php";
    case "sql":
      return "sql";
    case "xml":
    case "svg":
      return "xml";
    case "yml":
    case "yaml":
    case "toml":
      return "yaml";
    default:
      return "";
  }
}

async function loadLanguageExtension(filePath: string): Promise<Extension> {
  const key = languageKeyForPath(filePath);
  if (!key) return [];
  const cached = languageCache.get(key);
  if (cached) return cached;

  let ext: Extension = [];
  switch (key) {
    case "ts": {
      const { javascript } = await import("@codemirror/lang-javascript");
      ext = javascript({ typescript: true });
      break;
    }
    case "tsx": {
      const { javascript } = await import("@codemirror/lang-javascript");
      ext = javascript({ typescript: true, jsx: true });
      break;
    }
    case "js": {
      const { javascript } = await import("@codemirror/lang-javascript");
      ext = javascript();
      break;
    }
    case "jsx": {
      const { javascript } = await import("@codemirror/lang-javascript");
      ext = javascript({ jsx: true });
      break;
    }
    case "json": {
      const { json } = await import("@codemirror/lang-json");
      ext = json();
      break;
    }
    case "md": {
      const { markdown } = await import("@codemirror/lang-markdown");
      ext = markdown();
      break;
    }
    case "css": {
      const { css } = await import("@codemirror/lang-css");
      ext = css();
      break;
    }
    case "html": {
      const { html } = await import("@codemirror/lang-html");
      ext = html();
      break;
    }
    case "py": {
      const { python } = await import("@codemirror/lang-python");
      ext = python();
      break;
    }
    case "rs": {
      const { rust } = await import("@codemirror/lang-rust");
      ext = rust();
      break;
    }
    case "go": {
      const { go } = await import("@codemirror/lang-go");
      ext = go();
      break;
    }
    case "cpp": {
      const { cpp } = await import("@codemirror/lang-cpp");
      ext = cpp();
      break;
    }
    case "java": {
      const { java } = await import("@codemirror/lang-java");
      ext = java();
      break;
    }
    case "php": {
      const { php } = await import("@codemirror/lang-php");
      ext = php();
      break;
    }
    case "sql": {
      const { sql } = await import("@codemirror/lang-sql");
      ext = sql();
      break;
    }
    case "xml": {
      const { xml } = await import("@codemirror/lang-xml");
      ext = xml();
      break;
    }
    case "yaml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      ext = yaml();
      break;
    }
  }
  languageCache.set(key, ext);
  return ext;
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

export interface CodeMirrorSurfaceProps {
  cwd: string;
  file: OpenWorkbenchFile;
  onSave: () => void;
}

export default function CodeMirrorSurface({ cwd, file, onSave }: CodeMirrorSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartmentRef = useRef(new Compartment());
  const readOnlyCompartmentRef = useRef(new Compartment());
  const activePathRef = useRef(file.path);
  const activeCwdRef = useRef(file.cwd || cwd);
  const lastEmittedDocRef = useRef(file.content);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    const container = hostRef.current;
    if (!container) return;
    const langCompartment = langCompartmentRef.current;
    const readOnlyCompartment = readOnlyCompartmentRef.current;
    const effectiveCwd = file.cwd || cwd;
    activePathRef.current = file.path;
    activeCwdRef.current = effectiveCwd;
    lastEmittedDocRef.current = file.content;

    const initialLang = languageCache.get(languageKeyForPath(file.path)) ?? [];

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
        langCompartment.of(initialLang),
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
          lastEmittedDocRef.current = nextText;
          useWorkbenchStore.getState().updateFileContent(
            activePathRef.current,
            nextText,
            activeCwdRef.current,
          );
        }),
      ],
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;

    let cancelled = false;
    void loadLanguageExtension(file.path).then((ext) => {
      if (cancelled || viewRef.current !== view) return;
      view.dispatch({
        effects: langCompartment.reconfigure(ext),
      });
    });

    return () => {
      cancelled = true;
      view.destroy();
      viewRef.current = null;
    };
    // Re-create view when switching file identity (cwd + path); incremental edits stay in the same view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, file.cwd, file.path]);

  // Sync external content reloads without re-serializing on normal user keystrokes.
  useEffect(() => {
    if (file.content === lastEmittedDocRef.current) return;
    const view = viewRef.current;
    if (!view) return;
    const currentText = view.state.doc.toString();
    lastEmittedDocRef.current = file.content;
    if (currentText !== file.content) {
      view.dispatch({
        changes: { from: 0, to: currentText.length, insert: file.content },
      });
    }
  }, [file.content]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure(EditorState.readOnly.of(file.truncated)),
    });
  }, [file.truncated]);

  // Scroll to target line when opened from AI `sidebar_open` or file links (including repeated clicks).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !file.line || file.line < 1) return;
    const clampedLine = Math.min(file.line, view.state.doc.lines);
    const lineInfo = view.state.doc.line(clampedLine);
    view.dispatch({
      selection: { anchor: lineInfo.from },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }),
    });
  }, [cwd, file.cwd, file.line, file.lineNonce, file.path]);

  return <div ref={hostRef} className="pid-wb-cm-host" />;
}
