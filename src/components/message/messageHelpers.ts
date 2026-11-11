import type { TranscriptDensity } from "../../lib/transcriptDensity";
import { presentToolCall, type ToolDiffLine, type ToolKind } from "../../lib/toolPresentation";
import type { UiToolCall, WorkStep } from "../../types";

export const USER_MESSAGE_COLLAPSED_LINES = 6;
export const USER_MESSAGE_ENTRY_WINDOW_MS = 1_500;
export const USER_BUBBLE_HIDDEN = { opacity: 0, scale: 0.82, x: 14, y: 12 };
export const USER_BUBBLE_VISIBLE = { opacity: 1, scale: 1, x: 0, y: 0 };
export const USER_BUBBLE_SPRING = { type: "spring", stiffness: 520, damping: 24, mass: 0.8 } as const;
export const WAIT_OVERTIME_MS = 10_000;

export const TRANSCRIPT_POLICIES: Record<TranscriptDensity, { liveGrouping: boolean; settledReasoningPreview: boolean }> = {
  summary: { liveGrouping: true, settledReasoningPreview: false },
  normal: { liveGrouping: true, settledReasoningPreview: true },
  verbose: { liveGrouping: false, settledReasoningPreview: true },
};

export function isUserMessageOverLineLimit(contentHeight: number, lineHeight: number): boolean {
  if (!Number.isFinite(contentHeight) || !Number.isFinite(lineHeight) || contentHeight <= 0 || lineHeight <= 0) {
    return false;
  }
  return contentHeight > lineHeight * USER_MESSAGE_COLLAPSED_LINES + 2;
}

export function isLiveAssistantWork(
  working: boolean,
  content: string | undefined,
  toolCalls: Array<{ running?: boolean }> | undefined,
): boolean {
  if (!working) return false;
  if (toolCalls?.some((call) => call.running)) return true;
  return !(content ?? "").trim();
}

export function foldWorkingLabel(workingLabel: string | undefined): string {
  const label = workingLabel?.trim();
  if (!label || /正在工作/.test(label)) return "正在工作…";
  return label;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatMessageClock(time: number, now = Date.now()): string {
  const date = new Date(time);
  const today = new Date(now);
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()) {
    return clock;
  }
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear() === today.getFullYear() ? monthDay : `${date.getFullYear()}年${monthDay}`} ${clock}`;
}

export interface DurationPart {
  text: string;
  numeric: boolean;
}

export function formatRunDuration(durationMs: number): DurationPart[] {
  const total = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  const parts: DurationPart[] = [];
  if (hours > 0) parts.push({ text: String(hours), numeric: true }, { text: "小时", numeric: false });
  if (total >= 60) parts.push({ text: String(minutes), numeric: true }, { text: "分", numeric: false });
  parts.push({ text: String(seconds), numeric: true }, { text: "秒", numeric: false });
  return parts;
}

export function durationText(durationMs: number): string {
  return formatRunDuration(durationMs).map((part) => part.text).join("");
}

export function workDurationMs(toolCalls: UiToolCall[]): number | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const call of toolCalls) {
    if (typeof call.startedAt === "number") start = start === null ? call.startedAt : Math.min(start, call.startedAt);
    if (typeof call.finishedAt === "number") end = end === null ? call.finishedAt : Math.max(end, call.finishedAt);
  }
  if (start === null || end === null || end <= start) return null;
  return end - start;
}

export function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return (newline === -1 ? text : text.slice(0, newline)).trim();
}

export function latestCompletedParagraphFirstLine(text: string): string {
  let summary = "";
  let paragraphStart = 0;
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
  for (;;) {
    const nextParagraph = separator.exec(text);
    const paragraphEnd = nextParagraph === null ? text.length : nextParagraph.index + nextParagraph[0].indexOf("\n");
    const newline = text.indexOf("\n", paragraphStart);
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim();
      if (candidate !== "") summary = candidate;
    }
    if (nextParagraph === null) return summary;
    paragraphStart = nextParagraph.index + nextParagraph[0].length;
  }
}

export function buildProcessSummary(thinking: number, outputs: number, tools: number): string {
  const parts: string[] = [];
  if (thinking > 0) parts.push(`执行 ${thinking} 次思考`);
  if (outputs > 0) parts.push(`输出 ${outputs} 次`);
  if (tools > 0) parts.push(`调用 ${tools} 次工具`);
  return parts.join("，") || "执行 1 次思考";
}

export function summarizeProcessGroup(thinking: number, calls: UiToolCall[]): string {
  const parts: string[] = [];
  if (thinking > 0) parts.push(`执行 ${thinking} 次思考`);
  const buckets = new Map<string, { label: (count: number) => string; keys: Set<string> }>();
  const bucket = (id: string, label: (count: number) => string, key: string) => {
    const entry = buckets.get(id) ?? { label, keys: new Set<string>() };
    entry.keys.add(key);
    buckets.set(id, entry);
  };
  for (const call of calls) {
    const presented = presentToolCall(call);
    const fileKey = presented.path?.replace(/\\/g, "/") || call.id;
    switch (presented.kind) {
      case "read":
        bucket("read", (count) => `读取 ${count} 个文件`, fileKey);
        break;
      case "write":
      case "edit":
        bucket("edit", (count) => `编辑 ${count} 个文件`, fileKey);
        break;
      case "shell":
        bucket("shell", (count) => `运行 ${count} 条命令`, call.id);
        break;
      case "search":
        bucket("search", (count) => `搜索 ${count} 次`, call.id);
        break;
      case "web-search":
      case "browser":
        bucket("web", (count) => `访问网页 ${count} 次`, call.id);
        break;
      case "plan":
        bucket("plan", () => "更新计划", call.id);
        break;
      default:
        bucket("other", (count) => `调用 ${count} 次工具`, call.id);
    }
  }
  const toolParts = [...buckets.values()].map(({ label, keys }) => label(keys.size));
  parts.push(...(toolParts.length > 3 ? [...toolParts.slice(0, 3), "等"] : toolParts));
  return parts.join("，").replace("，等", " 等") || "执行 1 次思考";
}

export type ProcessSegment =
  | { kind: "text"; key: string; text: string }
  | {
    kind: "group";
    key: string;
    members: Array<{ step: WorkStep; index: number }>;
    thinking: number;
    tools: number;
    activity: ToolKind | "thinking";
  };

export function processSegments(steps: WorkStep[]): ProcessSegment[] {
  const segments: ProcessSegment[] = [];
  let pending: Array<{ step: WorkStep; index: number }> = [];
  const flush = () => {
    const first = pending[0];
    if (!first) return;
    segments.push({
      kind: "group",
      key: `group-${first.index}`,
      members: pending,
      thinking: pending.filter(({ step }) => step.kind === "thinking").length,
      tools: pending.filter(({ step }) => step.kind === "tool").length,
      activity: first.step.kind === "tool" ? presentToolCall(first.step.call).kind : "thinking",
    });
    pending = [];
  };
  steps.forEach((step, index) => {
    if (step.kind === "note") {
      flush();
      segments.push({ kind: "text", key: `text-${index}`, text: step.text });
      return;
    }
    pending.push({ step, index });
  });
  flush();
  return segments;
}

export function liveActivityLabel(
  workingLabel: string | undefined,
  hasRunningTool: boolean,
  reasoning: boolean,
  writing: boolean,
): string {
  const explicit = workingLabel?.trim();
  if (explicit && !/正在工作/.test(explicit)) return explicit;
  if (hasRunningTool) return "正在调用工具";
  if (writing) return "正在写回答";
  if (reasoning) return "正在思考";
  return "正在工作…";
}

export interface MergedFileToolMeta {
  headId: string;
  count: number;
  added: number;
  removed: number;
  diff: ToolDiffLine[];
}

export function computeMergedFileTools(calls: UiToolCall[]): Map<string, MergedFileToolMeta> {
  const byPath = new Map<string, Array<{ call: UiToolCall; presented: ReturnType<typeof presentToolCall> }>>();
  for (const call of calls) {
    if (call.isError) continue;
    const presented = presentToolCall(call);
    if ((presented.kind !== "edit" && presented.kind !== "write") || !presented.path || !presented.diff?.length) {
      continue;
    }
    const key = presented.path.replace(/\\/g, "/").toLowerCase();
    const list = byPath.get(key) ?? [];
    list.push({ call, presented });
    byPath.set(key, list);
  }
  const result = new Map<string, MergedFileToolMeta>();
  for (const group of byPath.values()) {
    const firstItem = group[0];
    if (group.length <= 1 || !firstItem) continue;
    const headId = firstItem.call.id;
    let added = 0;
    let removed = 0;
    const diff: ToolDiffLine[] = [];
    for (const item of group) {
      added += item.presented.added ?? 0;
      removed += item.presented.removed ?? 0;
      if (item.presented.diff) diff.push(...item.presented.diff);
    }
    for (const item of group) {
      result.set(item.call.id, { headId, count: group.length, added, removed, diff });
    }
  }
  return result;
}
