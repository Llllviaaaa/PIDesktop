import { useContext, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { UiToolCall } from "../types";
import {
  displayPath,
  normalizedToolName,
  presentToolCall,
  type ToolDiffLine,
  type ToolPresentation,
  type ToolSearchHit,
} from "../lib/toolPresentation";
import { WorkspaceFileOpenContext } from "./Markdown";
import { useFileActions } from "./WorkspaceOpeners";
import { DisclosureRow, TextShimmer } from "./TranscriptPrimitives";
import {
  IconApi,
  IconBrowse,
  IconChecklist,
  IconEdit,
  IconGlobe,
  IconSearch,
  IconSparkle,
  StateSpinner,
} from "./DshIcons";

/*
 * One tool call as DeepSeek Harness' `ToolRow` draws it (dsh-client-ui-tool,
 * MIT): a 24px disclosure header — tool glyph, title, a 2px dot, the summary
 * (a dotted file link when the call names a file), and a `+n -m` suffix — over
 * a lazily mounted result card (terminal, diff, read, search or IN/OUT).
 */

type RowState = "running" | "error" | "ok";

function clipLine(value: string, max = 96): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function headingDetail(heading: string): string | undefined {
  if (!heading.includes("·")) return undefined;
  return heading.split("·").slice(1).join("·").trim() || undefined;
}

function headingLabel(heading: string): string {
  return heading.split("·")[0]?.trim() || heading;
}

/** The row's title and summary, in the host's `tool.title.*` vocabulary. */
export function toolRowCopy(presented: ToolPresentation, call: UiToolCall): { title: string; summary: string } {
  const path = presented.path ? displayPath(presented.path) : undefined;
  const detail = headingDetail(presented.heading);
  const name = normalizedToolName(call.name);
  switch (presented.kind) {
    case "read":
      return { title: "读取", summary: path ? (detail ? `${path} · ${detail}` : path) : detail ?? "" };
    case "write":
      return { title: "写入", summary: path ?? "" };
    case "edit":
      return { title: "编辑", summary: path ?? "" };
    case "shell":
      if (presented.inputKind === "script") return { title: "运行脚本", summary: detail ?? "" };
      return {
        title: "运行命令",
        summary: presented.command ? clipLine(presented.command) : detail ?? headingLabel(presented.heading).replace(/^运行\s*/, ""),
      };
    case "search": {
      const title = name === "grep" ? "搜索文件内容" : name === "glob" || name === "find" || name === "ls" ? "查找文件" : "搜索";
      const query = presented.query ? clipLine(presented.query, 64) : "";
      return { title, summary: query && path ? `${query} · ${path}` : query || path || "" };
    }
    case "web-search":
      return {
        title: /fetch/.test(name) ? "网页获取" : "网页搜索",
        summary: presented.query ? clipLine(presented.query) : detail ?? "",
      };
    case "plan":
      return {
        title: "更新计划",
        summary: presented.plan ? `${presented.plan.completed}/${presented.plan.steps.length} 已完成` : "",
      };
    case "browser":
    case "computer":
      return { title: headingLabel(presented.heading), summary: detail ?? "" };
    case "mcp":
      return { title: "MCP", summary: detail ? `${headingLabel(presented.heading).replace(/^MCP\s*·?\s*/, "")} · ${detail}` : headingLabel(presented.heading).replace(/^MCP\s*·?\s*/, "") };
    default:
      return { title: "工具调用", summary: path ? `${call.name} · ${path}` : call.name };
  }
}

function ToolGlyph({ presented }: { presented: ToolPresentation }) {
  switch (presented.kind) {
    case "read":
      return <IconBrowse />;
    case "write":
    case "edit":
      return <IconEdit />;
    case "shell":
      return <IconApi />;
    case "search":
      return <IconSearch />;
    case "web-search":
    case "browser":
      return <IconGlobe />;
    case "plan":
      return <IconChecklist />;
    default:
      return <IconSparkle />;
  }
}

function StateDot({ state }: { state: RowState }) {
  if (state === "running") return <StateSpinner size={10} className="dshc-terminal-dot" />;
  return (
    <span
      className="dshc-state-dot dshc-terminal-dot"
      data-state={state === "error" ? "error" : "done"}
      aria-hidden="true"
    />
  );
}

function TerminalCard({ presented, state }: { presented: ToolPresentation; state: RowState }) {
  const output = (presented.preview ?? "").replace(/\s+$/, "");
  return (
    <div className="dshc-terminal tool-card is-terminal" data-body={output ? "" : undefined}>
      <div className="dshc-terminal-header">
        <div className="dshc-terminal-prompt">
          {(presented.command ?? "").split(/\r?\n/).map((line, index) => (
            <div className="dshc-terminal-prompt-line" key={index}>
              {index === 0 && <StateDot state={state} />}
              <span className="dshc-terminal-command">{line || " "}</span>
            </div>
          ))}
          <span className="dshc-visually-hidden">{presented.inputKind === "script" ? "脚本" : "命令"}</span>
        </div>
        {state === "error" && <span className="dshc-terminal-status">失败</span>}
      </div>
      {output
        ? (
          <div className="dshc-terminal-output" role="log" aria-label="输出">
            {output.split("\n").map((line, index) => (
              <div className="dshc-terminal-line" key={index}>{line || " "}</div>
            ))}
          </div>
        )
        : state !== "running" && <div className="dshc-terminal-empty">(无输出)</div>}
    </div>
  );
}

function CodeCard({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="dshc-code-card">
      {title && (
        <div className="dshc-code-card-header">
          <span className="dshc-code-card-title">{title}</span>
        </div>
      )}
      <div className="dshc-code-card-body">{children}</div>
    </div>
  );
}

function DiffCard({ lines, path }: { lines: ToolDiffLine[]; path?: string }) {
  return (
    <CodeCard title={path ? displayPath(path) : undefined}>
      <div className="dshc-diff tool-diff" role="figure" aria-label="文件变更">
        {lines.map((line, index) => (
          <div className={`dshc-diff-line is-${line.type}`} key={`${line.type}-${index}`}>{line.text}</div>
        ))}
      </div>
    </CodeCard>
  );
}

function ReadCard({ text, path }: { text: string; path?: string }) {
  return (
    <CodeCard title={path ? displayPath(path) : undefined}>
      <div className="dshc-read">
        {text.split("\n").map((line, index) => (
          <div className="dshc-read-line" key={index}>
            <span className="dshc-read-gutter" aria-hidden="true">{index + 1}</span>
            <span className="dshc-read-content">{line || " "}</span>
          </div>
        ))}
      </div>
    </CodeCard>
  );
}

function SearchCard({ hits, summary }: { hits: ToolSearchHit[]; summary: string }) {
  const openInApp = useContext(WorkspaceFileOpenContext);
  const fileActions = useFileActions();
  return (
    <div className="dshc-search">
      <div className="dshc-search-header">
        <span className="dshc-search-summary">{summary}</span>
      </div>
      <ol className="dshc-search-body tool-hits">
        {hits.map((hit, index) => (
          <li
            key={`${hit.path}-${hit.line ?? "p"}-${index}`}
            className={`dshc-search-line${hit.path ? " is-openable" : ""}`}
            title={hit.path ? "单击预览 · Ctrl+单击在编辑器中打开 · 右键查看更多" : undefined}
            onClick={(event) => {
              if (!hit.path) return;
              if ((event.ctrlKey || event.metaKey) && fileActions) fileActions.openInEditor(hit.path, hit.line ?? undefined);
              else openInApp?.(hit.path, hit.line ?? undefined);
            }}
            onContextMenu={(event) => {
              if (hit.path && fileActions) fileActions.showMenu(event, hit.path, hit.line ?? undefined);
            }}
          >
            <span className="dshc-search-path">{hit.path ? hit.path.replace(/\\/g, "/") : ""}</span>
            {hit.line != null && <span className="dshc-search-line-number">:{hit.line}</span>}
            {hit.text ? <span className="dshc-search-text"> {hit.text.trim()}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function IoCard({ input, output, error }: { input?: string; output?: string; error?: boolean }) {
  return (
    <div className="dshc-io-card">
      {input && (
        <div className="dshc-io-section">
          <span className="dshc-io-label">输入</span>
          <span className="dshc-io-text">{input}</span>
        </div>
      )}
      {input && output && <span className="dshc-io-divider" aria-hidden="true" />}
      {output && (
        <div className="dshc-io-section">
          <span className="dshc-io-label">输出</span>
          <span className="dshc-io-text" data-error={error || undefined}>{output}</span>
        </div>
      )}
    </div>
  );
}

function ToolBody({ presented, call, state }: { presented: ToolPresentation; call: UiToolCall; state: RowState }) {
  if (presented.kind === "shell") return <TerminalCard presented={presented} state={state} />;
  if (presented.diff && presented.diff.length > 0) return <DiffCard lines={presented.diff} path={presented.path} />;
  if (presented.kind === "read") {
    return <ReadCard text={(presented.preview ?? "").replace(/\s+$/, "") || "(空)"} path={presented.path} />;
  }
  if (presented.hits && presented.hits.length > 0) {
    return <SearchCard hits={presented.hits} summary={`${presented.hits.length}${presented.hits.length >= 40 ? "+" : ""} 处匹配`} />;
  }
  return (
    <>
      {presented.plan && presented.plan.steps.length > 0 && (
        <div className="dshc-io-card dshc-plan-card">
          {presented.plan.explanation && <div className="dshc-plan-explanation">{presented.plan.explanation}</div>}
          <ol className="dshc-plan-steps">
            {presented.plan.steps.map((step) => (
              <li key={step.id} className={`dshc-plan-step is-${step.status}`}>{step.text}</li>
            ))}
          </ol>
        </div>
      )}
      {presented.sources.length > 0 && (
        <div className="dshc-io-card dshc-web-card">
          {presented.sources.map((source) => (
            <a
              key={source.url}
              className="dshc-web-source"
              href={source.url}
              title={source.url}
              onClick={(event) => {
                event.preventDefault();
                void openUrl(source.url);
              }}
            >
              {source.title}
            </a>
          ))}
        </div>
      )}
      {presented.preview && <IoCard output={presented.preview} error={state === "error"} />}
      {call.images && call.images.length > 0 && (
        <div className="dshc-tool-images">
          {call.images.map((image, index) => (
            <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`浏览器截图 ${index + 1}`} />
          ))}
        </div>
      )}
    </>
  );
}

export function ToolCall({
  call,
  mergedAdded,
  mergedRemoved,
  mergedDiff,
  mergedHidden,
}: {
  call: UiToolCall;
  /** How many same-file edits this head row stands for (dsh-claude-style D62). */
  mergedCount?: number;
  mergedAdded?: number;
  mergedRemoved?: number;
  mergedDiff?: ToolDiffLine[];
  mergedHidden?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const fileActions = useFileActions();
  const openInApp = useContext(WorkspaceFileOpenContext);
  if (mergedHidden) return null;

  const base = presentToolCall(call);
  const presented: ToolPresentation = mergedDiff && mergedDiff.length > 0
    ? { ...base, diff: mergedDiff, added: mergedAdded ?? base.added, removed: mergedRemoved ?? base.removed, expandable: true }
    : base;
  const state: RowState = call.running ? "running" : call.isError ? "error" : "ok";
  const { title, summary } = toolRowCopy(presented, call);
  const expandable = presented.expandable;
  const open = expanded && expandable;
  // Reads, writes and edits name one file: the summary opens it, Ctrl+click opens it in the editor.
  const filePath = presented.path && (presented.kind === "read" || presented.kind === "write" || presented.kind === "edit") && state !== "error"
    ? presented.path
    : null;
  const added = presented.added ?? 0;
  const removed = presented.removed ?? 0;
  const diffStat = state !== "error" && (presented.kind === "edit" || presented.kind === "write") && (added > 0 || removed > 0);
  const hitSuffix = !diffStat && presented.hits && presented.hits.length > 0
    ? `${presented.hits.length}${presented.hits.length >= 40 ? "+" : ""} 处`
    : !diffStat && presented.sources.length > 0
      ? `${presented.sources.length} 个来源`
      : null;

  const openFile = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!filePath) return;
    if ((event.ctrlKey || event.metaKey) && fileActions) fileActions.openInEditor(filePath);
    else openInApp?.(filePath);
  };

  const collapsedContent = summary || diffStat || hitSuffix
    ? (
      <>
        {summary && <span className="dshc-sep" data-shimmer-decoration="" aria-hidden="true" />}
        {summary && (filePath && openInApp
          ? (
            <button
              type="button"
              className="dshc-file-link"
              title={fileActions ? "单击预览 · Ctrl+单击在编辑器中打开 · 右键查看更多" : undefined}
              onClick={openFile}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") event.stopPropagation();
              }}
            >
              {summary}
            </button>
          )
          : <span className={`dshc-tool-summary${state === "error" ? " is-error" : ""}`}>{summary}</span>)}
        {diffStat && (
          <TextShimmer className="dshc-summary-suffix dshc-diff-stat">
            <span className="dshc-diff-added tool-stat-add">+{added}</span>
            {" "}
            <span className="dshc-diff-removed tool-stat-del">-{removed}</span>
          </TextShimmer>
        )}
        {hitSuffix && <span className="dshc-summary-suffix">{hitSuffix}</span>}
      </>
    )
    : undefined;

  return (
    <div
      className="dshc-tool"
      data-variant={presented.kind}
      data-tool={call.name}
      data-state={state}
    >
      {state !== "ok" && <span className="dshc-visually-hidden">{state === "running" ? "运行中" : "失败"}</span>}
      <DisclosureRow
        rowClassName="dshc-tool-row"
        icon={<ToolGlyph presented={presented} />}
        title={title}
        running={state === "running"}
        open={open}
        expandable={expandable}
        keepContentWhenOpen
        onToggle={() => setExpanded((value) => !value)}
        collapsedContent={collapsedContent}
        onRowContextMenu={filePath && fileActions ? (event) => fileActions.showMenu(event, filePath) : undefined}
      >
        <div className="dshc-tool-body">
          <ToolBody presented={presented} call={call} state={state} />
        </div>
      </DisclosureRow>
    </div>
  );
}
