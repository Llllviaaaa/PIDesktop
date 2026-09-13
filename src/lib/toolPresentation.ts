import type { UiToolCall } from "../types";
import { planFromToolCall, type TaskPlanSummary } from "./envSources";
import { isWebSearchTool, webSearchQuery, webSearchSources, type WebSearchSource } from "./webAccess";

export type ToolKind =
  | "read"
  | "write"
  | "edit"
  | "shell"
  | "search"
  | "web-search"
  | "browser"
  | "computer"
  | "mcp"
  | "plan"
  | "other";

export type ToolDiffLineType = "add" | "del" | "ctx" | "hunk" | "meta";

export interface ToolDiffLine {
  type: ToolDiffLineType;
  text: string;
}

export interface ToolPresentation {
  kind: ToolKind;
  heading: string;
  path?: string;
  command?: string;
  query?: string;
  preview?: string;
  diff?: ToolDiffLine[];
  sources: WebSearchSource[];
  plan?: TaskPlanSummary;
  expandable: boolean;
}

const PREVIEW_MAX_CHARS = 4000;
const PREVIEW_MAX_LINES = 80;
const DIFF_MAX_LINES = 48;
const HEADING_COMMAND_MAX = 72;

const PATH_KEYS = ["path", "file", "filename", "filePath", "file_path", "target", "target_file"];
const COMMAND_KEYS = ["command", "cmd", "script"];
const QUERY_KEYS = ["query", "pattern", "q", "search", "search_query", "glob", "regex"];
const OLD_TEXT_KEYS = ["old_string", "oldString", "old_text", "oldText"];
const NEW_TEXT_KEYS = ["new_string", "newString", "new_text", "newText"];

export function normalizedToolName(name: string): string {
  const snakeCase = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  const segments = snakeCase.split(/__|[.:/]/).filter(Boolean);
  return segments[segments.length - 1] ?? snakeCase;
}

function stringArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function commandArg(args: Record<string, unknown>): string | undefined {
  const direct = stringArg(args, COMMAND_KEYS);
  if (direct) return direct;
  for (const key of COMMAND_KEYS) {
    const value = args[key];
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      const joined = value.join(" ").trim();
      if (joined) return joined;
    }
  }
  return undefined;
}

export function toolPathFromArgs(args: Record<string, unknown>): string | undefined {
  const direct = stringArg(args, PATH_KEYS);
  if (direct) return direct;
  const patch = typeof args.patch === "string" ? args.patch : "";
  return patch.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/m)?.[1]?.trim();
}

export function displayPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) return normalized;
  return parts.slice(-3).join("/");
}

export function truncatePreview(text: string, maxChars = PREVIEW_MAX_CHARS, maxLines = PREVIEW_MAX_LINES): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let cut = lines.slice(0, maxLines).join("\n");
  if (cut.length > maxChars) cut = cut.slice(0, maxChars);
  if (cut.length < normalized.length) return `${cut.replace(/\s+$/, "")}\n…`;
  return normalized;
}

function firstLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipHeading(value: string, max = HEADING_COMMAND_MAX): string {
  const compact = firstLine(value);
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

export function parseDiffLines(text: string): ToolDiffLine[] | null {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const out: ToolDiffLine[] = [];
  let sawChange = false;
  for (const line of lines) {
    if (
      line.startsWith("diff ")
      || line.startsWith("index ")
      || line.startsWith("+++")
      || line.startsWith("---")
      || line.startsWith("*** ")
    ) {
      if (out.length < DIFF_MAX_LINES) out.push({ type: "meta", text: line });
      continue;
    }
    if (line.startsWith("@@")) {
      if (out.length < DIFF_MAX_LINES) out.push({ type: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      sawChange = true;
      if (out.length < DIFF_MAX_LINES) out.push({ type: "add", text: line.slice(1) });
      continue;
    }
    if (line.startsWith("-")) {
      sawChange = true;
      if (out.length < DIFF_MAX_LINES) out.push({ type: "del", text: line.slice(1) });
      continue;
    }
    if (sawChange && out.length < DIFF_MAX_LINES && (line.startsWith(" ") || line === "")) {
      out.push({ type: "ctx", text: line.startsWith(" ") ? line.slice(1) : line });
    }
  }
  return sawChange ? out : null;
}

function replacementDiff(oldText: string, newText: string): ToolDiffLine[] {
  const oldLines = oldText.replace(/\r\n/g, "\n").split("\n");
  const newLines = newText.replace(/\r\n/g, "\n").split("\n");
  return [
    ...oldLines.map((text) => ({ type: "del" as const, text })),
    ...newLines.map((text) => ({ type: "add" as const, text })),
  ].slice(0, DIFF_MAX_LINES);
}

export function classifyToolKind(name: string): ToolKind {
  if (isWebSearchTool(name)) return "web-search";
  const lower = name.toLowerCase();
  if (lower === "browser" || lower.startsWith("browser_")) return "browser";
  if (lower === "computer" || lower.startsWith("computer_")) return "computer";
  if (lower.startsWith("mcp__") || lower.startsWith("mcp_")) return "mcp";

  const normalized = normalizedToolName(name);
  if (normalized === "read" || normalized === "cat" || normalized === "read_file" || normalized === "read_text_file") return "read";
  if (normalized === "write" || normalized === "write_file" || normalized === "write_text_file") return "write";
  if (
    normalized === "edit"
    || normalized === "str_replace"
    || normalized === "apply_patch"
    || normalized === "edit_file"
    || normalized === "replace"
  ) return "edit";
  if (
    normalized === "bash"
    || normalized === "exec"
    || normalized === "shell"
    || normalized === "run_command"
    || normalized === "run_terminal_cmd"
  ) return "shell";
  if (
    normalized === "grep"
    || normalized === "rg"
    || normalized === "glob"
    || normalized === "find"
    || normalized === "search"
    || normalized === "codebase_search"
    || normalized === "search_files"
  ) return "search";
  if (normalized.includes("web_search") || normalized.includes("search_web")) return "web-search";
  if (normalized === "update_plan") return "plan";
  return "other";
}

function browserHeading(name: string, url?: string): string {
  const labels: Record<string, string> = {
    browser_navigate: "打开网页",
    browser_inspect: "检查网页",
    browser_screenshot: "截取网页",
    browser_click: "点击网页元素",
    browser_type: "在网页中输入",
    browser_press: "发送网页按键",
    browser_scroll: "滚动网页",
    browser_select: "选择表单项",
    browser_wait: "等待网页更新",
    browser_tabs: "管理浏览器标签",
    browser_upload: "上传工作区文件",
  };
  const label = labels[name.toLowerCase()] || "操作浏览器";
  return url ? `${label} · ${clipHeading(url, 48)}` : label;
}

function computerHeading(name: string): string {
  const labels: Record<string, string> = {
    computer_sources: "列出桌面源",
    computer_state: "查看计算机会话",
    computer_start: "开始计算机会话",
    computer_stop: "停止计算机会话",
    computer_screenshot: "查看 Windows 桌面",
    computer_inspect: "检查前台窗口",
    computer_click: "点击桌面",
    computer_move: "移动桌面指针",
    computer_scroll: "滚动桌面",
    computer_type: "在应用中输入",
    computer_key: "发送按键",
  };
  return labels[name.toLowerCase()] || "操作计算机";
}

export function presentToolCall(call: UiToolCall): ToolPresentation {
  const kind = classifyToolKind(call.name);
  const path = toolPathFromArgs(call.args);
  const command = commandArg(call.args);
  const query = kind === "web-search"
    ? webSearchQuery(call.args)
    : stringArg(call.args, QUERY_KEYS);
  const url = stringArg(call.args, ["url", "href"]);
  const sources = kind === "web-search" ? webSearchSources(call.details, call.result) : [];
  const oldText = stringArg(call.args, OLD_TEXT_KEYS);
  const newText = stringArg(call.args, NEW_TEXT_KEYS);
  const patch = typeof call.args.patch === "string" ? call.args.patch : undefined;
  const content = typeof call.args.content === "string" ? call.args.content : undefined;

  const diff = kind === "edit"
    ? (oldText != null && newText != null
      ? replacementDiff(oldText, newText)
      : parseDiffLines(patch || call.result || ""))
    : (kind === "write" ? null : parseDiffLines(call.result || ""));

  const resultText = typeof call.result === "string" ? call.result : undefined;
  const previewSource = kind === "write"
    ? (content || resultText)
    : kind === "shell"
      ? resultText
      : kind === "edit"
        ? undefined
        : resultText;
  const preview = kind === "plan" ? undefined : (previewSource ? truncatePreview(previewSource) : undefined);
  const plan = kind === "plan" ? planFromToolCall(call) ?? undefined : undefined;

  let heading: string;
  if (kind === "web-search") {
    const label = call.running ? "正在搜索网页" : call.isError ? "网页搜索失败" : "已搜索网页";
    heading = query ? `${label} · ${clipHeading(query)}` : label;
  } else if (kind === "read") {
    heading = path ? `读取 ${displayPath(path)}` : "读取文件";
  } else if (kind === "write") {
    heading = path ? `写入 ${displayPath(path)}` : "写入文件";
  } else if (kind === "edit") {
    heading = path ? `编辑 ${displayPath(path)}` : "编辑文件";
  } else if (kind === "shell") {
    heading = command ? `运行 ${clipHeading(command)}` : "运行了命令";
  } else if (kind === "search") {
    heading = query ? `搜索 ${clipHeading(query, 48)}` : "搜索文件";
  } else if (kind === "browser") {
    heading = browserHeading(call.name, url);
  } else if (kind === "computer") {
    heading = computerHeading(call.name);
  } else if (kind === "plan") {
    heading = plan ? `计划 ${plan.completed}/${plan.steps.length}` : "更新计划";
  } else if (kind === "mcp") {
    const parts = call.name.split("__");
    const label = `MCP · ${(parts[parts.length - 1] || call.name).replace(/_/g, " ")}`;
    heading = path ? `${label} · ${displayPath(path)}` : label;
  } else {
    heading = path ? `${call.name} · ${displayPath(path)}` : call.name;
  }

  const expandable = Boolean(
    preview
    || (diff && diff.length > 0)
    || sources.length > 0
    || command
    || query
    || plan?.steps.length
    || call.images?.length,
  );

  return {
    kind,
    heading,
    path,
    command,
    query,
    preview,
    diff: diff && diff.length > 0 ? diff : undefined,
    sources,
    plan,
    expandable,
  };
}
