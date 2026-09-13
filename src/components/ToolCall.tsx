import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  FilePenLine,
  FileSearch,
  Globe2,
  ListChecks,
  LoaderCircle,
  MonitorCog,
  Network,
  Terminal,
  Wrench,
} from "lucide-react";
import type { UiToolCall } from "../types";
import { presentToolCall, type ToolKind } from "../lib/toolPresentation";

function ToolIcon({ kind }: { kind: ToolKind }) {
  if (kind === "web-search" || kind === "browser") return <Globe2 size={14} />;
  if (kind === "shell") return <Terminal size={14} />;
  if (kind === "write" || kind === "edit") return <FilePenLine size={14} />;
  if (kind === "read" || kind === "search") return <FileSearch size={14} />;
  if (kind === "computer") return <MonitorCog size={14} />;
  if (kind === "mcp") return <Network size={14} />;
  if (kind === "plan") return <ListChecks size={14} />;
  return <Wrench size={14} />;
}

export function ToolCall({ call }: { call: UiToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const presented = presentToolCall(call);
  const duration = call.startedAt && call.finishedAt
    ? `${((call.finishedAt - call.startedAt) / 1000).toFixed(1)}s`
    : null;
  const canExpand = presented.expandable;

  return (
    <div className={`tool-step ${call.isError ? "error" : ""}`}>
      <button
        type="button"
        className="tool-step-heading"
        aria-expanded={canExpand ? expanded : undefined}
        disabled={!canExpand}
        onClick={() => {
          if (canExpand) setExpanded((value) => !value);
        }}
      >
        <span className="tool-icon"><ToolIcon kind={presented.kind} /></span>
        <span className="tool-summary">{presented.heading}</span>
        {!call.running && presented.sources.length > 0 && <small>{presented.sources.length} 个来源</small>}
        {duration && <small>{duration}</small>}
        {call.running ? (
          <LoaderCircle className="spin" size={13} />
        ) : call.isError ? (
          <CircleAlert size={13} />
        ) : (
          <Check size={13} />
        )}
        {canExpand && (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
      </button>
      {expanded && canExpand && (
        <div className="tool-drawer">
          {presented.kind === "web-search" && presented.query && (
            <>
              <div className="tool-section-label">查询</div>
              <div className="tool-search-query">{presented.query}</div>
            </>
          )}
          {presented.kind === "shell" && presented.command && (
            <>
              <div className="tool-section-label">命令</div>
              <pre className="tool-command">{presented.command}</pre>
            </>
          )}
          {presented.kind === "search" && presented.query && (
            <>
              <div className="tool-section-label">查询</div>
              <div className="tool-search-query">{presented.query}</div>
            </>
          )}
          {presented.path && (presented.kind === "read" || presented.kind === "write" || presented.kind === "edit") && (
            <>
              <div className="tool-section-label">文件</div>
              <div className="tool-file-path">{presented.path}</div>
            </>
          )}
          {presented.diff && presented.diff.length > 0 && (
            <>
              <div className="tool-section-label">变更</div>
              <div className="tool-diff" role="figure" aria-label="文件变更">
                {presented.diff.map((line, index) => (
                  <div className={`tool-diff-line is-${line.type}`} key={`${line.type}-${index}`}>
                    <span className="tool-diff-gutter" aria-hidden="true">
                      {line.type === "add" ? "+" : line.type === "del" ? "−" : line.type === "hunk" ? "@" : " "}
                    </span>
                    <span>{line.text}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {presented.sources.length > 0 && (
            <>
              <div className="tool-section-label">来源</div>
              <div className="tool-search-sources">
                {presented.sources.map((source) => (
                  <a
                    key={source.url}
                    href={source.url}
                    title={source.url}
                    onClick={(event) => {
                      event.preventDefault();
                      void openUrl(source.url);
                    }}
                  >
                    <span>{source.title}</span>
                    <ExternalLink size={12} strokeWidth={1.7} />
                  </a>
                ))}
              </div>
            </>
          )}
          {presented.plan && presented.plan.steps.length > 0 && (
            <>
              <div className="tool-section-label">步骤</div>
              {presented.plan.explanation && <div className="tool-search-query">{presented.plan.explanation}</div>}
              <ol className="tool-plan-steps">
                {presented.plan.steps.map((step) => (
                  <li key={step.id} className={`tool-plan-step is-${step.status}`}>
                    <span>{step.text}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
          {presented.preview && (
            <>
              <div className="tool-section-label">
                {presented.kind === "web-search" ? "搜索结果" : presented.kind === "shell" ? "输出" : "内容"}
              </div>
              <pre className="tool-preview">{presented.preview}</pre>
            </>
          )}
          {call.images && call.images.length > 0 && (
            <div className="tool-result-images">
              {call.images.map((image, index) => <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`浏览器截图 ${index + 1}`} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
