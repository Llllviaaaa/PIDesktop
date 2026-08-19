import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Code2, ExternalLink, FileText, X } from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";
import { pi } from "../lib/pi";
import { Markdown } from "./Markdown";
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

export function DocumentPane({ cwd, path, line, tabs = [], onSelectTab, onCloseTab, onBack, onClose }: DocumentPaneProps) {
  const [file, setFile] = useState<WorkspaceFileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState(false);
  const fileName = path.split(/[\\/]/).filter(Boolean).pop() || path;
  const project = cwd.split(/[\\/]/).filter(Boolean).pop() || "项目";
  const markdown = isMarkdown(path);
  const delimited = isDelimited(path);
  const table = file?.text && delimited ? parseDelimited(file.text, path) : [];

  useEffect(() => {
    if (!cwd || !path) return;
    let disposed = false;
    setFile(null);
    setError(null);
    setSource(false);
    void pi.readWorkspaceFile(cwd, path)
      .then((content) => {
        if (!disposed) setFile(content);
      })
      .catch((err) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      disposed = true;
    };
  }, [cwd, path]);

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
          {(markdown || delimited) && (
            <button
              type="button"
              className={`text-button ${source ? "active" : ""}`}
              onClick={() => setSource((value) => !value)}
            >
              <Code2 size={13} strokeWidth={1.7} />
              {source ? "查看预览" : "查看源代码"}
            </button>
          )}
          <button type="button" className="text-button" onClick={openExternally} title="用系统应用打开">
            <ExternalLink size={13} strokeWidth={1.7} />
            打开
          </button>
          <button type="button" className="icon-button" title="关闭文件面板" onClick={onClose}>
            <X size={14} strokeWidth={1.7} />
          </button>
        </div>
      </header>
      <div className="document-pane-body">
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
          ) : (
            <pre className="document-source">{file.text}{file.truncated ? "\n\n…（已截断，文件超过 512 KB）" : ""}</pre>
          )
        )}
      </div>
    </section>
  );
}
