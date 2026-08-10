import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FilePenLine,
  FileSearch,
  Globe2,
  LoaderCircle,
  MonitorCog,
  Network,
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
  if (name === "browser") {
    const action = typeof call.args.action === "string" ? call.args.action : "inspect";
    const labels: Record<string, string> = { open: "打开网页", inspect: "检查网页", click: "点击网页元素", type: "在网页中输入", screenshot: "截取网页", close: "关闭浏览器" };
    return labels[action] || "操作浏览器";
  }
  if (name === "computer") {
    const action = typeof call.args.action === "string" ? call.args.action : "screenshot";
    const labels: Record<string, string> = { screenshot: "查看 Windows 桌面", list_windows: "列出窗口", focus_window: "切换窗口", click: "点击桌面", type: "在应用中输入", key: "发送按键" };
    return labels[action] || "操作计算机";
  }
  if (name.startsWith("mcp__")) {
    const parts = call.name.split("__");
    return `MCP · ${parts[parts.length - 1]?.replace(/_/g, " ") || call.name}`;
  }
  return call.name;
}

function ToolIcon({ call }: { call: UiToolCall }) {
  const name = call.name.toLowerCase();
  if (name === "bash" || name === "exec" || name === "shell") return <Terminal size={14} />;
  if (name === "write" || name === "edit") return <FilePenLine size={14} />;
  if (name === "read" || name === "grep" || name === "find") return <FileSearch size={14} />;
  if (name === "browser") return <Globe2 size={14} />;
  if (name === "computer") return <MonitorCog size={14} />;
  if (name.startsWith("mcp__")) return <Network size={14} />;
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
        {(call.result !== undefined || call.images?.length) && (expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />)}
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
