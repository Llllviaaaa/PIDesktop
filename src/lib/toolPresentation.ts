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

export interface ToolSearchHit {
  path: string;
  line?: number;
  text?: string;
}

export interface ToolPresentation {
  kind: ToolKind;
  heading: string;
  path?: string;
  command?: string;
  inputKind?: "command" | "script";
  query?: string;
  preview?: string;
  diff?: ToolDiffLine[];
  hits?: ToolSearchHit[];
  added?: number;
  removed?: number;
  sources: WebSearchSource[];
  plan?: TaskPlanSummary;
  expandable: boolean;
}

const PREVIEW_MAX_CHARS = 4000;
const PREVIEW_MAX_LINES = 80;
const DIFF_MAX_LINES = 48;
const HIT_MAX = 40;
const HEADING_COMMAND_MAX = 72;

const PATH_KEYS = ["path", "file", "filename", "filePath", "file_path", "target", "target_file"];
const COMMAND_KEYS = ["command", "cmd", "script", "code"];
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

function queryArg(args: Record<string, unknown>): string | undefined {
  const direct = stringArg(args, QUERY_KEYS);
  if (direct) return direct;
  const queries = args.queries;
  if (Array.isArray(queries)) {
    const first = queries.find((item) => typeof item === "string" && item.trim());
    if (typeof first === "string") return first.trim();
  }
  return undefined;
}

export function looksLikeUnifiedDiff(text: string): boolean {
  return /^(diff --git |@@ -\d+|\*\*\* (?:Add|Update|Delete) File:)/m.test(text);
}

function numberArg(args: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export function readLineRange(args: Record<string, unknown>): string | undefined {
  const offset = numberArg(args, ["offset", "start_line", "startLine", "line"]);
  const limit = numberArg(args, ["limit", "count", "max_lines", "maxLines"]);
  const end = numberArg(args, ["end_line", "endLine"]);
  if (offset != null && end != null && end >= offset) return `${offset}–${end}`;
  if (offset != null && limit != null && limit > 0) {
    const start = offset <= 0 ? 1 : offset;
    return `${start}–${start + limit - 1}`;
  }
  if (limit != null && offset == null) return `${limit} 行`;
  return undefined;
}

function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /\.\w{1,8}$/.test(value);
}

export function parseSearchHits(result: string): ToolSearchHit[] {
  const hits: ToolSearchHit[] = [];
  for (const raw of result.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const match = line.match(/^(?:([A-Za-z]:)?([^:]+)):(\d+)(?::\d+)?(?::(.*))?$/);
    if (match) {
      const path = `${match[1] ?? ""}${match[2]}`;
      if (looksLikePath(path)) {
        hits.push({
          path,
          line: Number(match[3]),
          ...(match[4] ? { text: match[4] } : {}),
        });
        if (hits.length >= HIT_MAX) break;
        continue;
      }
    }
    const trimmed = line.trim();
    if (looksLikePath(trimmed) && !/\s/.test(trimmed)) {
      hits.push({ path: trimmed });
      if (hits.length >= HIT_MAX) break;
    }
  }
  return hits;
}

function diffCounts(diff: ToolDiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff) {
    if (line.type === "add") added += 1;
    if (line.type === "del") removed += 1;
  }
  return { added, removed };
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
    || normalized === "ctx_execute"
    || normalized === "ctx_execute_file"
  ) return "shell";
  if (
    normalized === "grep"
    || normalized === "rg"
    || normalized === "glob"
    || normalized === "find"
    || normalized === "search"
    || normalized === "codebase_search"
    || normalized === "search_files"
    || normalized === "ctx_search"
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

function looksLikeScript(command: string, language?: string): boolean {
  const lang = (language || "").toLowerCase();
  if (lang === "javascript" || lang === "js" || lang === "typescript" || lang === "ts") return true;
  const trimmed = command.trim();
  return command.includes("\n")
    || command.length > HEADING_COMMAND_MAX
    || /^(const|let|var|function|import |class )\b/.test(trimmed);
}

function shellInputKind(command: string | undefined, args: Record<string, unknown>): "command" | "script" {
  return command && looksLikeScript(command, stringArg(args, ["language"])) ? "script" : "command";
}

function shellHeading(command: string | undefined, args: Record<string, unknown>): string {
  const intent = stringArg(args, ["intent", "description"]);
  if (shellInputKind(command, args) === "script") {
    return intent ? `运行脚本 · ${clipHeading(intent, 48)}` : "运行脚本";
  }
  if (command) return `运行 ${clipHeading(command)}`;
  if (intent) return `运行 ${clipHeading(intent)}`;
  return "运行了命令";
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
    : queryArg(call.args);
  const url = stringArg(call.args, ["url", "href"]);
  const sources = kind === "web-search" ? webSearchSources(call.details, call.result) : [];
  const oldText = stringArg(call.args, OLD_TEXT_KEYS);
  const newText = stringArg(call.args, NEW_TEXT_KEYS);
  const patch = typeof call.args.patch === "string" ? call.args.patch : undefined;
  const content = typeof call.args.content === "string" ? call.args.content : undefined;

  const diffSource = kind === "edit"
    ? (oldText != null && newText != null
      ? replacementDiff(oldText, newText)
      : looksLikeUnifiedDiff(patch || call.result || "")
        ? parseDiffLines(patch || call.result || "")
        : null)
    : null;
  const counts = diffSource && diffSource.length > 0 ? diffCounts(diffSource) : undefined;

  const resultText = typeof call.result === "string" ? call.result : undefined;
  const hits = kind === "search" && resultText ? parseSearchHits(resultText) : [];
  const lineRange = kind === "read" ? readLineRange(call.args) : undefined;
  const previewSource = kind === "write"
    ? (content || resultText)
    : kind === "shell"
      ? resultText
      : kind === "edit" || kind === "plan"
        ? undefined
        : kind === "search" && hits.length > 0
          ? undefined
          : kind === "web-search" && sources.length > 0
            ? undefined
            : resultText;
  const preview = previewSource ? truncatePreview(previewSource) : undefined;
  const plan = kind === "plan" ? planFromToolCall(call) ?? undefined : undefined;

  let heading: string;
  if (kind === "web-search") {
    const label = call.running ? "正在搜索网页" : call.isError ? "网页搜索失败" : "已搜索网页";
    heading = query ? `${label} · ${clipHeading(query)}` : label;
  } else if (kind === "read") {
    heading = path ? `读取 ${displayPath(path)}` : "读取文件";
    if (lineRange) heading += ` · ${lineRange}`;
  } else if (kind === "write") {
    heading = path ? `写入 ${displayPath(path)}` : "写入文件";
  } else if (kind === "edit") {
    heading = path ? `编辑 ${displayPath(path)}` : "编辑文件";
  } else if (kind === "shell") {
    heading = shellHeading(command, call.args);
  } else if (kind === "search") {
    heading = query ? `搜索 ${clipHeading(query, 48)}` : "搜索文件";
    if (path) heading += ` · ${displayPath(path)}`;
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
    || (kind === "shell" && command)
    || (kind === "read" && (path || preview))
    || (diffSource && diffSource.length > 0)
    || hits.length > 0
    || sources.length > 0
    || plan?.steps.length
    || call.images?.length,
  );

  return {
    kind,
    heading,
    path,
    command,
    inputKind: kind === "shell" ? shellInputKind(command, call.args) : undefined,
    query,
    preview,
    diff: diffSource && diffSource.length > 0 ? diffSource : undefined,
    hits: hits.length > 0 ? hits : undefined,
    added: counts?.added,
    removed: counts?.removed,
    sources,
    plan,
    expandable,
  };
}
