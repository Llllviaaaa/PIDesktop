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
  LoaderCircle,
  MonitorCog,
  Network,
  Terminal,
  Wrench,
} from "lucide-react";
import type { UiToolCall } from "../types";
import { isWebSearchTool, webSearchQuery, webSearchSources } from "../lib/webAccess";

function summary(call: UiToolCall): string {
  const name = call.name.toLowerCase();
  if (isWebSearchTool(name)) {
    const label = call.running ? "正在搜索网页" : call.isError ? "网页搜索失败" : "已搜索网页";
    const query = webSearchQuery(call.args);
    return query ? `${label} · ${query}` : label;
  }
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
    const labels: Record<string, string> = {
      open: "打开网页", inspect: "检查网页", back: "后退网页", forward: "前进网页", reload: "刷新网页",
      list_tabs: "列出浏览器标签", new_tab: "新建浏览器标签", switch_tab: "切换浏览器标签", close_tab: "关闭浏览器标签",
      hover: "悬停网页元素", click: "点击网页元素", type: "在网页中输入", press: "发送网页按键",
      select: "选择表单项", upload: "上传工作区文件", download: "下载文件到工作区",
      scroll: "滚动网页", wait: "等待网页更新", screenshot: "截取网页", close: "关闭浏览器",
    };
    return labels[action] || "操作浏览器";
  }
  if (name === "computer") {
    const action = typeof call.args.action === "string" ? call.args.action : "screenshot";
    const labels: Record<string, string> = {
      screenshot: "查看 Windows 桌面", list_windows: "列出窗口", focus_window: "切换窗口", move: "移动桌面指针",
      click: "点击桌面", double_click: "双击桌面", drag: "拖拽桌面元素", scroll: "滚动桌面",
      type: "在应用中输入", key: "发送按键", keypress: "发送按键", wait: "等待桌面更新",
    };
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
  if (isWebSearchTool(name)) return <Globe2 size={14} />;
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
  const isWebSearch = isWebSearchTool(call.name);
  const query = isWebSearch ? webSearchQuery(call.args) : undefined;
  const sources = isWebSearch ? webSearchSources(call.details, call.result) : [];
  const duration = call.startedAt && call.finishedAt
    ? `${((call.finishedAt - call.startedAt) / 1000).toFixed(1)}s`
    : null;

  return (
    <div className={`tool-step ${call.isError ? "error" : ""}`}>
      <button
        type="button"
        className="tool-step-heading"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="tool-icon"><ToolIcon call={call} /></span>
        <span className="tool-summary">{summary(call)}</span>
        {!call.running && sources.length > 0 && <small>{sources.length} 个来源</small>}
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
          <div className="tool-section-label">{isWebSearch ? "查询" : "输入"}</div>
          {query ? <div className="tool-search-query">{query}</div> : <pre>{JSON.stringify(call.args, null, 2)}</pre>}
          {sources.length > 0 && (
            <>
              <div className="tool-section-label">来源</div>
              <div className="tool-search-sources">
                {sources.map((source) => (
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
          {call.result !== undefined && (
            <>
              <div className="tool-section-label">{isWebSearch ? "搜索结果" : "输出"}</div>
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
