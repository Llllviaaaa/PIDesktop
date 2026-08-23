import type { UiMessage, UiToolCall } from "../types";
import { WEB_ACCESS_LABELS, webAccessKindForTool, webSearchQuery } from "./webAccess";

export type EnvSourceKind = "file" | "search" | "web-search" | "agent-browser" | "pi" | "other";

export interface EnvSourceItem {
  id: string;
  kind: EnvSourceKind;
  label: string;
  detail?: string;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function argString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function classifyTool(call: UiToolCall): EnvSourceItem | null {
  const name = (call.name || "").toLowerCase();
  const path = argString(call.args, ["path", "file", "filename", "filePath", "target"]);
  const url = argString(call.args, ["url", "href"]);
  const query = argString(call.args, ["query", "pattern", "q", "search"]);
  const webKind = webAccessKindForTool(name);

  if (webKind === "agent-browser") {
    return {
      id: call.id,
      kind: webKind,
      label: WEB_ACCESS_LABELS[webKind],
      detail: url,
    };
  }
  if (webKind === "web-search") {
    return {
      id: call.id,
      kind: webKind,
      label: WEB_ACCESS_LABELS[webKind],
      detail: webSearchQuery(call.args),
    };
  }
  if (
    name.includes("grep")
    || name.includes("glob")
    || name.includes("find")
    || name.includes("rg")
  ) {
    return {
      id: call.id,
      kind: "search",
      label: query || "代码搜索",
      detail: path,
    };
  }
  if (
    name.includes("read")
    || name.includes("cat")
    || name.includes("open")
    || name.includes("edit")
    || name.includes("write")
    || path
  ) {
    if (!path && !name.includes("read") && !name.includes("write") && !name.includes("edit")) {
      return null;
    }
    return {
      id: call.id,
      kind: "file",
      label: path ? basename(path) : call.name,
      detail: path,
    };
  }
  return null;
}

/** Derive Codex-style 来源 rows from conversation tool calls. */
export function deriveEnvSources(messages: UiMessage[], limit = 8): EnvSourceItem[] {
  const items: EnvSourceItem[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      const item = classifyTool(call);
      if (!item) continue;
      const key = `${item.kind}:${item.detail || item.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= limit) return items;
    }
  }

  if (messages.some((message) => message.role === "assistant")) {
    const key = "pi:runtime";
    if (!seen.has(key)) {
      items.push({ id: "pi-runtime", kind: "pi", label: "Pi" });
    }
  }

  return items;
}

export function summarizeToolAgents(messages: UiMessage[]): { running: number; completed: number } {
  let running = 0;
  let completed = 0;
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.running) running += 1;
      else if (call.finishedAt || call.result !== undefined || call.isError !== undefined) completed += 1;
    }
  }
  return { running, completed };
}
