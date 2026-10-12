import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { describeError } from "../lib/errors";
import { ChevronLeft, ChevronRight, Code2, ExternalLink, Eye, FileText, PanelRightClose, X } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { pi } from "../lib/pi";
import { queryKeys } from "../lib/queries";
import { useSyncOnChange } from "../hooks/useSyncOnChange";
import { highlightLine } from "../lib/syntaxHighlight";
import { Markdown } from "./Markdown";
import { useFileActions, WorkspaceEditorIcon } from "./WorkspaceOpeners";
import type { WorkspaceFileContent } from "../types";

interface DocumentPaneProps {
  cwd: string;
  path: string;
  line?: number;
  tabs?: Array<{ path: string; line?: number }>;
  onSelectTab?: (path: string, line?: number) => void;
  onCloseTab?: (path: string) => void;
  onBack?: () => void;
  onClose: () => void;
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

function isDelimited(path: string): boolean {
  return /\.(csv|tsv)$/i.test(path);
}

function isHtml(path: string): boolean {
  return /\.html?$/i.test(path);
}

function parseDelimited(text: string, path: string): string[][] {
  const delimiter = /\.tsv$/i.test(path) ? "\t" : ",";
  return text.split(/\r?\n/).filter(Boolean).slice(0, 300).map((line) => {
    const cells: string[] = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
        else quoted = !quoted;
      } else if (char === delimiter && !quoted) {
        cells.push(value);
        value = "";
      } else {
        value += char;
      }
    }
    cells.push(value);
    return cells.slice(0, 80);
  });
}

/** Files longer than this render without per-line highlighting, to stay responsive. */
const HIGHLIGHT_LINE_LIMIT = 4000;

/** Source with line numbers; the requested line is highlighted and scrolled into view. */
function CodeView({ text, path, line, truncated }: { text: string; path: string; line?: number; truncated: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => text.replace(/\r\n/g, "\n").split("\n"), [text]);
  const highlighted = useMemo(
    () => (lines.length <= HIGHLIGHT_LINE_LIMIT ? lines.map((item) => highlightLine(item || " ", path)) : null),
    [lines, path],
  );
  const fileActions = useFileActions();

  useEffect(() => {
    if (!line) return;
    const target = containerRef.current?.querySelector(`[data-line="${line}"]`);
    target?.scrollIntoView({ block: "center" });
  }, [line, text]);

  return (
    <div className="document-code" ref={containerRef}>
      {lines.map((content, index) => {
        const number = index + 1;
        return (
          <div
            key={number}
            data-line={number}
            className={`document-code-line${number === line ? " is-target" : ""}`}
            onContextMenu={(event) => fileActions?.showMenu(event, path, number)}
          >
            <span
              className="document-code-number"
              title={fileActions?.preferredEditor ? `Ctrl+单击在 ${fileActions.preferredEditor.name} 中打开第 ${number} 行` : undefined}
              onClick={(event) => {
                if ((event.ctrlKey || event.metaKey) && fileActions) fileActions.openInEditor(path, number);
              }}
            >
              {number}
            </span>
            {highlighted
              ? <code dangerouslySetInnerHTML={{ __html: highlighted[index] }} />
              : <code>{content || " "}</code>}
          </div>
        );
      })}
      {truncated && <div className="document-code-truncated">…（已截断，文件超过 512 KB）</div>}
    </div>
  );
}

export function DocumentPane({ cwd, path, line, tabs = [], onSelectTab, onCloseTab, onBack, onClose }: DocumentPaneProps) {
  const [source, setSource] = useState(false);
  const fileActions = useFileActions();
  const editor = fileActions?.preferredEditor ?? null;
  const fileQuery = useQuery({
    queryKey: queryKeys.file(cwd, path),
    queryFn: () => pi.readWorkspaceFile(cwd, path),
    enabled: Boolean(cwd && path),
  });
  const file: WorkspaceFileContent | null = fileQuery.data ?? null;
  const error = fileQuery.error ? describeError(fileQuery.error) : null;
  // Each file opens in its rendered view, unless a specific line was asked for.
  useSyncOnChange([cwd, path, line], () => setSource(Boolean(line)));
  const fileName = path.split(/[\\/]/).filter(Boolean).pop() || path;
  const project = cwd.split(/[\\/]/).filter(Boolean).pop() || "项目";
  const markdown = isMarkdown(path);
  const delimited = isDelimited(path);
  const html = isHtml(path);
  const table = file?.text && delimited ? parseDelimited(file.text, path) : [];

  const openExternally = () => {
    const absolute = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)
      ? path
      : `${cwd.replace(/[\\/]+$/, "")}\\${path.replace(/\//g, "\\")}`;
    void openPath(absolute).catch(() => undefined);
  };

  return (
    <section className="document-pane" aria-label={fileName}>
      <header className="document-pane-header">
        {onBack && (
          <button type="button" className="icon-button document-back" title="返回文件" aria-label="返回文件" onClick={onBack}>
            <ChevronLeft size={15} strokeWidth={1.75} />
          </button>
        )}
        {tabs.length > 0 ? (
          <div className="document-tabs" role="tablist" aria-label="打开的文件">
            {tabs.map((tab) => {
              const name = tab.path.split(/[\\/]/).filter(Boolean).pop() || tab.path;
              return (
                <div key={tab.path} className={`document-tab ${tab.path === path ? "active" : ""}`} role="tab" aria-selected={tab.path === path}>
                  <button type="button" title={tab.path} onClick={() => onSelectTab?.(tab.path, tab.line)}>{name}</button>
                  <button type="button" className="document-tab-close" title={`关闭 ${name}`} aria-label={`关闭 ${name}`} onClick={() => onCloseTab?.(tab.path)}>
                    <X size={11} strokeWidth={1.8} />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <nav className="document-breadcrumb" title={path}>
            <span>{project}</span>
            <ChevronRight size={12} strokeWidth={1.8} />
            <strong>{fileName}</strong>
            {line ? <em>:{line}</em> : null}
          </nav>
        )}
        <div className="document-pane-actions">
          {(markdown || delimited || html) && (
            <button
              type="button"
              className={`icon-button document-action ${source ? "active" : ""}`}
              onClick={() => setSource((value) => !value)}
              title={source ? "查看预览" : "查看源代码"}
              aria-label={source ? "查看预览" : "查看源代码"}
              aria-pressed={source}
            >
              {source ? <Eye size={15} strokeWidth={1.75} /> : <Code2 size={15} strokeWidth={1.75} />}
            </button>
          )}
          {editor && fileActions && (
            <button
              type="button"
              className="icon-button document-action"
              onClick={() => fileActions.openInEditor(path, line)}
              onContextMenu={(event) => fileActions.showMenu(event, path, line)}
              title={`在 ${editor.name} 中打开${line && editor.supportsLine ? `（第 ${line} 行）` : ""} · 右键查看更多`}
              aria-label={`在 ${editor.name} 中打开`}
            >
              <WorkspaceEditorIcon editorId={editor.id} size={14} />
            </button>
          )}
          <button
            type="button"
            className="icon-button document-action"
            onClick={openExternally}
            title="用系统默认应用打开"
            aria-label="用系统默认应用打开"
          >
            <ExternalLink size={15} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className="icon-button document-action document-pane-close"
            title="关闭所有文件，回到文件列表"
            aria-label="关闭所有文件"
            onClick={onClose}
          >
            <PanelRightClose size={15} strokeWidth={1.75} />
          </button>
        </div>
      </header>
      <div className={`document-pane-body ${html && !source ? "html-preview-mode" : ""}`}>
        {error && <div className="panel-empty">{error}</div>}
        {!error && !file && <div className="panel-empty">正在读取…</div>}
        {file?.mimeType?.startsWith("image/") && file.data && (
          <div className="document-media-preview"><img src={`data:${file.mimeType};base64,${file.data}`} alt={fileName} /></div>
        )}
        {file?.mimeType === "application/pdf" && file.data && (
          <iframe className="document-pdf-preview" src={`data:application/pdf;base64,${file.data}`} title={fileName} />
        )}
        {file?.isBinary && !file.data && <div className="panel-empty"><FileText size={20} />此文件无法在面板中预览，可使用「打开」。</div>}
        {file && !file.isBinary && file.text !== null && (
          delimited && !source ? (
            <div className="document-table-wrap">
              <table className="document-table">
                <tbody>
                  {table.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => rowIndex === 0
                        ? <th key={cellIndex}>{cell}</th>
                        : <td key={cellIndex}>{cell}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : markdown && !source ? (
            <div className="document-markdown">
              <Markdown content={file.text} />
            </div>
          ) : html && !source ? (
            <iframe
              className="document-html-preview"
              srcDoc={file.text}
              sandbox=""
              referrerPolicy="no-referrer"
              title={fileName}
            />
          ) : (
            <CodeView text={file.text} path={path} line={line} truncated={file.truncated} />
          )
        )}
      </div>
    </section>
  );
}
