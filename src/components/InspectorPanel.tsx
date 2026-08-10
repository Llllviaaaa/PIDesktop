import { useState } from "react";
import { FileDiff, Globe2, LoaderCircle, RefreshCw, SearchCheck, Square, Terminal, X } from "lucide-react";
import type { BrowserState, GitSnapshot } from "../types";

export type InspectorTab = "changes" | "terminal" | "browser" | "logs";

export function InspectorPanel({
  initialTab,
  git,
  cwd,
  terminal,
  browser,
  logs,
  onClose,
  onRefreshGit,
  onReview,
  onRunCommand,
  onAbortCommand,
}: {
  initialTab: InspectorTab;
  git: GitSnapshot | null;
  cwd: string;
  terminal: { running: boolean; command: string; output: string; exitCode?: number };
  browser: BrowserState | null;
  logs: string[];
  onClose: () => void;
  onRefreshGit: () => void;
  onReview: () => void;
  onRunCommand: (command: string, excludeFromContext?: boolean) => void;
  onAbortCommand: () => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [command, setCommand] = useState("");
  const [exclude, setExclude] = useState(false);

  return (
    <aside className="inspector-panel">
      <header className="inspector-header">
        <nav>
          <button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
            更改 {git?.files.length ? <span>{git.files.length}</span> : null}
          </button>
          <button className={tab === "terminal" ? "active" : ""} onClick={() => setTab("terminal")}>终端</button>
          <button className={tab === "browser" ? "active" : ""} onClick={() => setTab("browser")}>浏览器</button>
          <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}>日志</button>
        </nav>
        <button className="icon-button" onClick={onClose}><X size={16} /></button>
      </header>

      {tab === "changes" && (
        <div className="inspector-content changes-panel">
          <div className="changes-summary">
            <span><FileDiff size={15} /> {git?.isRepository ? git.branch || "游离 HEAD" : "不是 Git 仓库"}</span>
            <div className="changes-actions">
              <button className="secondary-button compact" disabled={!git?.files.length} onClick={onReview} title="让 Pi 检查当前差异"><SearchCheck size={13} /> 检查</button>
              <button className="icon-button" onClick={onRefreshGit} title="刷新更改"><RefreshCw size={14} /></button>
            </div>
          </div>
          {git?.files.length ? (
            <div className="changed-file-list">
              {git.files.map((file) => (
                <div key={`${file.status}-${file.path}`}>
                  <span className={`git-status status-${file.status.trim().charAt(0).toLowerCase() || "u"}`}>{file.status || "?"}</span>
                  <span title={file.path}>{file.path}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="panel-empty">{git?.isRepository ? "工作区没有未提交更改" : "打开 Git 工作区以检查更改"}</div>
          )}
          {git?.diff && (
            <pre className="diff-view">
              {git.diff.split("\n").map((line, index) => (
                <span
                  key={index}
                  className={line.startsWith("+") && !line.startsWith("+++") ? "diff-add" : line.startsWith("-") && !line.startsWith("---") ? "diff-remove" : line.startsWith("@@") ? "diff-hunk" : ""}
                >
                  {line || " "}{"\n"}
                </span>
              ))}
            </pre>
          )}
        </div>
      )}

      {tab === "terminal" && (
        <div className="inspector-content terminal-panel">
          <div className="terminal-location"><Terminal size={14} /> {cwd || "未打开工作区"}</div>
          <pre className="terminal-output">
            {terminal.command && <><span className="terminal-prompt">PS&gt; {terminal.command}</span>{"\n"}</>}
            {terminal.output || "在当前 Pi 会话中运行命令。除非排除，否则输出会加入上下文。"}
            {terminal.running && <LoaderCircle className="spin" size={14} />}
          </pre>
          <div className="terminal-composer">
            <textarea
              rows={2}
              value={command}
              placeholder="输入 PowerShell 或项目命令"
              disabled={!cwd || terminal.running}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (command.trim()) {
                    onRunCommand(command, exclude);
                    setCommand("");
                  }
                }
              }}
            />
            {terminal.running ? (
              <button className="stop-button" onClick={onAbortCommand}><Square size={12} fill="currentColor" /></button>
            ) : (
              <button
                className="primary-button"
                disabled={!cwd || !command.trim()}
                onClick={() => {
                  onRunCommand(command, exclude);
                  setCommand("");
                }}
              >运行</button>
            )}
          </div>
          <label className="terminal-context-toggle">
            <input type="checkbox" checked={exclude} onChange={(event) => setExclude(event.target.checked)} />
            不把命令输出加入下一条 Pi 提示词
          </label>
        </div>
      )}

      {tab === "browser" && (
        <div className="inspector-content browser-panel">
          {browser ? <>
            <div className="browser-panel-heading">
              <Globe2 size={15} />
              <span><strong>{browser.title}</strong><small title={browser.url}>{browser.url}</small></span>
              <button className="secondary-button compact" onClick={() => void navigator.clipboard.writeText(browser.url)}>复制地址</button>
            </div>
            {browser.screenshot
              ? <img src={`data:${browser.screenshot.mimeType};base64,${browser.screenshot.data}`} alt={browser.title} />
              : <div className="panel-empty">页面已经连接。让 Pi 调用 browser 的 screenshot 操作即可在这里查看截图。</div>}
          </> : <div className="panel-empty browser-empty"><Globe2 size={24} />让 Pi 使用 browser 工具打开或检查网页，最新页面和截图会显示在这里。</div>}
        </div>
      )}

      {tab === "logs" && (
        <div className="inspector-content logs-panel">
          <pre>{logs.length ? logs.join("\n") : "暂无 Pi 进程日志。"}</pre>
        </div>
      )}
    </aside>
  );
}
