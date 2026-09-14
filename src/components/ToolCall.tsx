import { useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
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
import {
  displayPath,
  presentToolCall,
  type ToolDiffLine,
  type ToolKind,
  type ToolPresentation,
  type ToolSearchHit,
} from "../lib/toolPresentation";

function ToolIcon({ kind }: { kind: ToolKind }) {
  if (kind === "web-search" || kind === "browser") return <Globe2 size={13} />;
  if (kind === "shell") return <Terminal size={13} />;
  if (kind === "write" || kind === "edit") return <FilePenLine size={13} />;
  if (kind === "read" || kind === "search") return <FileSearch size={13} />;
  if (kind === "computer") return <MonitorCog size={13} />;
  if (kind === "mcp") return <Network size={13} />;
  if (kind === "plan") return <ListChecks size={13} />;
  return <Wrench size={13} />;
}

function clipLine(value: string, max = 72): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function headingParts(presented: ToolPresentation): { verb: string; target?: string; asCommand?: boolean } {
  const path = presented.path ? displayPath(presented.path) : undefined;
  const extra = presented.heading.includes("·")
    ? presented.heading.split("·").slice(1).join("·").trim()
    : undefined;

  switch (presented.kind) {
    case "read":
      return { verb: "读取", target: extra && path ? `${path} · ${extra}` : path ?? "文件" };
    case "write":
      return { verb: "写入", target: path ?? "文件" };
    case "edit":
      return { verb: "编辑", target: path ?? "文件" };
    case "shell":
      if (presented.inputKind === "script") {
        return { verb: "运行脚本", target: extra };
      }
      return {
        verb: "运行",
        target: presented.command ? clipLine(presented.command) : extra ?? "命令",
        asCommand: true,
      };
    case "search":
      return {
        verb: "搜索",
        target: presented.query
          ? (path ? `${clipLine(presented.query, 48)} · ${path}` : clipLine(presented.query, 48))
          : "文件",
      };
    case "web-search":
      return {
        verb: presented.heading.split("·")[0]?.trim() || "搜索网页",
        target: presented.query ? clipLine(presented.query) : extra,
      };
    default:
      if (extra) {
        return {
          verb: presented.heading.split("·")[0]?.trim() || presented.heading,
          target: extra,
        };
      }
      return { verb: presented.heading };
  }
}

function DiffBlock({ lines }: { lines: ToolDiffLine[] }) {
  return (
    <div className="tool-diff" role="figure" aria-label="文件变更">
      {lines.map((line, index) => (
        <div className={`tool-diff-line is-${line.type}`} key={`${line.type}-${index}`}>
          <span className="tool-diff-gutter" aria-hidden="true">
            {line.type === "add" ? "+" : line.type === "del" ? "−" : line.type === "hunk" ? "@" : " "}
          </span>
          <span>{line.text}</span>
        </div>
      ))}
    </div>
  );
}

function HitList({ hits }: { hits: ToolSearchHit[] }) {
  return (
    <ol className="tool-hits">
      {hits.map((hit, index) => (
        <li key={`${hit.path}-${hit.line ?? "p"}-${index}`} className="tool-hit">
          <span className="tool-hit-loc">
            {hit.path ? hit.path.replace(/\\/g, "/") : ""}
            {hit.line != null ? `:${hit.line}` : ""}
          </span>
          {hit.text ? <span className="tool-hit-text">{hit.text.trim()}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function IoSection({ label, text }: { label: string; text: string }) {
  return (
    <div className="tool-io-section">
      <div className="tool-io-label">{label}</div>
      <pre className="tool-io-text">{text}</pre>
    </div>
  );
}

function ToolCard({
  variant,
  children,
}: {
  variant: "terminal" | "excerpt";
  children: ReactNode;
}) {
  return (
    <div className={`tool-card is-${variant}${variant === "terminal" ? " tool-terminal" : ""}`}>
      {children}
    </div>
  );
}

function SpecializedBody({ presented, call }: { presented: ToolPresentation; call: UiToolCall }) {
  if (presented.kind === "shell") {
    const inputLabel = presented.inputKind === "script" ? "脚本" : "命令";
    const output = (presented.preview ?? "").trim() || "(无输出)";
    return (
      <ToolCard variant="terminal">
        {presented.command && <IoSection label={inputLabel} text={presented.command} />}
        <IoSection label="输出" text={output} />
      </ToolCard>
    );
  }
  if (presented.kind === "read") {
    return (
      <ToolCard variant="excerpt">
        <pre className="tool-io-text">{(presented.preview ?? "").trim() || "(空)"}</pre>
      </ToolCard>
    );
  }
  return (
    <div className="tool-body">
      {presented.diff && presented.diff.length > 0 && <DiffBlock lines={presented.diff} />}
      {presented.hits && presented.hits.length > 0 && (
        <ToolCard variant="excerpt">
          <HitList hits={presented.hits} />
        </ToolCard>
      )}
      {presented.kind === "search" && !presented.hits?.length && presented.preview && (
        <ToolCard variant="excerpt">
          <pre className="tool-io-text">{presented.preview}</pre>
        </ToolCard>
      )}
      {presented.plan && presented.plan.steps.length > 0 && (
        <>
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
      {presented.sources.length > 0 && (
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
      )}
      {presented.kind !== "search" && presented.preview && (
        <ToolCard variant="excerpt">
          <pre className="tool-io-text">{presented.preview}</pre>
        </ToolCard>
      )}
      {call.images && call.images.length > 0 && (
        <div className="tool-result-images">
          {call.images.map((image, index) => (
            <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`浏览器截图 ${index + 1}`} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ToolCall({ call }: { call: UiToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const presented = presentToolCall(call);
  const elapsed = call.startedAt && call.finishedAt
    ? (call.finishedAt - call.startedAt) / 1000
    : null;
  const duration = elapsed != null && elapsed >= 0.5
    ? `${elapsed.toFixed(1)}s`
    : null;
  const inlineEdit = presented.kind === "edit" && Boolean(presented.diff?.length);
  const canExpand = presented.expandable && !inlineEdit;
  const showBody = presented.expandable && (expanded || call.running || inlineEdit);
  const parts = headingParts(presented);
  const hitLabel = presented.hits && presented.hits.length > 0
    ? `${presented.hits.length}${presented.hits.length >= 40 ? "+" : ""} 处`
    : presented.sources.length > 0
      ? `${presented.sources.length} 个来源`
      : null;

  return (
    <div className={`tool-step is-${presented.kind}${call.running ? " is-running" : ""}${call.isError ? " error" : ""}`}>
      <button
        type="button"
        className="tool-step-heading"
        aria-label={presented.heading}
        aria-expanded={canExpand ? showBody : undefined}
        disabled={!canExpand}
        onClick={() => {
          if (!canExpand) return;
          setExpanded((value) => !value);
        }}
      >
        <span className="tool-icon"><ToolIcon kind={presented.kind} /></span>
        <span className="tool-summary">
          <span className="tool-verb">{parts.verb}</span>
          {parts.target ? (
            <span className={`tool-target${parts.asCommand ? " is-command" : ""}`}>{parts.target}</span>
          ) : null}
        </span>
        {presented.added ? <small className="tool-stat-add">+{presented.added}</small> : null}
        {presented.removed ? <small className="tool-stat-del">−{presented.removed}</small> : null}
        {hitLabel && <small>{hitLabel}</small>}
        {duration && <small className="tool-duration">{duration}</small>}
        <span className="tool-status" aria-hidden="true">
          {call.running ? (
            <LoaderCircle className="spin" size={12} />
          ) : call.isError ? (
            <CircleAlert size={12} />
          ) : canExpand ? (
            showBody ? <ChevronDown size={12} /> : <ChevronRight size={12} />
          ) : null}
        </span>
      </button>
      {showBody && <SpecializedBody presented={presented} call={call} />}
    </div>
  );
}
