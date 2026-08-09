import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FilePenLine,
  FileSearch,
  LoaderCircle,
  Terminal,
  Wrench,
} from "lucide-react";
import type { UiToolCall } from "../types";

function summary(call: UiToolCall): string {
  const name = call.name.toLowerCase();
  if (name === "bash" || name === "exec" || name === "shell") {
    return "运行了命令";
  }
  if (name === "read" || name === "write" || name === "edit") {
    return name === "read" ? "读取文件" : name === "edit" ? "编辑文件" : "写入文件";
  }
  if (name === "grep" || name === "find" || name === "search") {
    return "搜索文件";
  }
  return call.name;
}

function ToolIcon({ call }: { call: UiToolCall }) {
  const name = call.name.toLowerCase();
  if (name === "bash" || name === "exec" || name === "shell") return <Terminal size={14} />;
  if (name === "write" || name === "edit") return <FilePenLine size={14} />;
  if (name === "read" || name === "grep" || name === "find") return <FileSearch size={14} />;
  return <Wrench size={14} />;
}

export function ToolCall({ call }: { call: UiToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const duration = call.startedAt && call.finishedAt
    ? `${((call.finishedAt - call.startedAt) / 1000).toFixed(1)}s`
    : null;

  return (
    <div className={`tool-step ${call.isError ? "error" : ""}`}>
      <button className="tool-step-heading" onClick={() => setExpanded((value) => !value)}>
        <span className="tool-icon"><ToolIcon call={call} /></span>
        <span className="tool-summary">{summary(call)}</span>
        {duration && <small>{duration}</small>}
        {call.running ? (
          <LoaderCircle className="spin" size={13} />
        ) : call.isError ? (
          <CircleAlert size={13} />
        ) : (
          <Check size={13} />
        )}
        {call.result !== undefined && (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
      </button>
      {expanded && (
        <div className="tool-drawer">
          <div className="tool-section-label">输入</div>
          <pre>{JSON.stringify(call.args, null, 2)}</pre>
          {call.result !== undefined && (
            <>
              <div className="tool-section-label">输出</div>
              <pre>{call.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
