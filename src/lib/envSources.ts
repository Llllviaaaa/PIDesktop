import type { UiMessage, UiToolCall } from "../types";
import { WEB_ACCESS_LABELS, webAccessKindForTool, webSearchQuery } from "./webAccess";

export type EnvSourceKind = "file" | "search" | "web-search" | "agent-browser" | "mcp" | "tool";
export type EnvSourceActivity = "read" | "searched" | "opened" | "used" | "written" | "updated";

export interface EnvSourceItem {
  id: string;
  kind: EnvSourceKind;
  label: string;
  detail?: string;
  activity: EnvSourceActivity;
  count: number;
  running: boolean;
  failed: boolean;
}

export interface TaskOutputItem {
  id: string;
  path: string;
  label: string;
  activity: "written" | "updated";
  count: number;
  running: boolean;
}

export type TaskPlanStatus = "pending" | "in_progress" | "completed";

export interface TaskPlanStep {
  id: string;
  text: string;
  status: TaskPlanStatus;
}

export interface TaskPlanSummary {
  explanation: string;
  steps: TaskPlanStep[];
  completed: number;
}

export type SubagentStatus = "queued" | "running" | "completed" | "failed";

export interface SubagentActivity {
  id: string;
  label: string;
  role: "explorer" | "planner" | "reviewer" | "worker";
  task: string;
  permission: "read-only" | "workspace-write";
  status: SubagentStatus;
  output?: string;
  error?: string;
  durationMs?: number;
}

export interface SubagentSummary {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toolPath(call: UiToolCall): string | undefined {
  const direct = argString(call.args, ["path", "file", "filename", "filePath", "target"]);
  if (direct) return direct;
  const patch = typeof call.args.patch === "string" ? call.args.patch : "";
  return patch.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/m)?.[1]?.trim();
}

function sourceActivity(name: string): EnvSourceActivity {
  if (name === "write" || name.includes("write_file")) return "written";
  if (name === "edit" || name === "apply_patch" || name.includes("edit_file")) return "updated";
  if (name.includes("grep") || name.includes("glob") || name.includes("find") || name === "rg") return "searched";
  if (name.includes("read") || name === "cat") return "read";
  if (name.includes("open") || name === "browser") return "opened";
  return "used";
}

function classifyTool(call: UiToolCall): EnvSourceItem | null {
  const name = (call.name || "").toLowerCase();
  const path = toolPath(call);
  const url = argString(call.args, ["url", "href"]);
  const query = argString(call.args, ["query", "pattern", "q", "search"]);
  const webKind = webAccessKindForTool(name);
  const base = {
    id: call.id,
    count: 1,
    running: call.running,
    failed: call.isError === true,
  };

  if (webKind === "agent-browser") {
    return {
      ...base,
      kind: webKind,
      label: WEB_ACCESS_LABELS[webKind],
      detail: url,
      activity: "opened",
    };
  }
  if (webKind === "web-search") {
    return {
      ...base,
      kind: webKind,
      label: WEB_ACCESS_LABELS[webKind],
      detail: webSearchQuery(call.args),
      activity: "searched",
    };
  }
  if (name.startsWith("mcp__") || name.startsWith("mcp_")) {
    const uri = argString(call.args, ["uri", "resource", "resourceUri"]);
    return {
      ...base,
      kind: "mcp",
      label: name.replace(/^mcp_+/, "").replace(/__/g, " / "),
      detail: uri,
      activity: name.includes("read") ? "read" : "used",
    };
  }
  if (
    name.includes("grep")
    || name.includes("glob")
    || name.includes("find")
    || name.includes("rg")
  ) {
    return {
      ...base,
      kind: "search",
      label: query || "代码搜索",
      detail: path,
      activity: "searched",
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
      ...base,
      kind: "file",
      label: path ? basename(path) : call.name,
      detail: path,
      activity: sourceActivity(name),
    };
  }
  return null;
}

/** Derive Codex-style 来源 rows from conversation tool calls. */
export function deriveEnvSources(messages: UiMessage[], limit = 8): EnvSourceItem[] {
  const items = new Map<string, EnvSourceItem>();

  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      const item = classifyTool(call);
      if (!item) continue;
      const key = `${item.kind}:${item.detail || item.label}`;
      const current = items.get(key);
      items.set(key, current ? {
        ...item,
        id: current.id,
        count: current.count + 1,
        running: current.running || item.running,
        failed: current.failed && item.failed,
      } : item);
    }
  }

  return [...items.values()].slice(-limit).reverse();
}

function outputActivity(name: string): TaskOutputItem["activity"] | null {
  if (name === "write" || name.includes("write_file")) return "written";
  if (name === "edit" || name === "apply_patch" || name.includes("edit_file")) return "updated";
  return null;
}

/** Derive files actually written by this task. Failed writes are not outputs. */
export function deriveTaskOutputs(messages: UiMessage[], limit = 40): TaskOutputItem[] {
  const outputs = new Map<string, TaskOutputItem>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      const name = call.name.toLowerCase();
      const activity = outputActivity(name);
      const path = toolPath(call);
      if (!activity || !path || call.isError) continue;
      const key = path.replace(/\\/g, "/").toLowerCase();
      const current = outputs.get(key);
      outputs.set(key, current ? {
        ...current,
        activity,
        count: current.count + 1,
        running: current.running || call.running,
      } : {
        id: call.id,
        path,
        label: basename(path),
        activity,
        count: 1,
        running: call.running,
      });
    }
  }
  return [...outputs.values()].slice(-limit).reverse();
}

function planStatus(value: unknown): TaskPlanStatus | null {
  return value === "pending" || value === "in_progress" || value === "completed" ? value : null;
}

/** Return the latest valid update_plan payload for the active conversation branch. */
export function deriveTaskPlan(messages: UiMessage[]): TaskPlanSummary | null {
  const calls = messages.flatMap((message) => message.toolCalls ?? []);
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call.name.toLowerCase() !== "update_plan" || call.isError) continue;
    const rawItems = Array.isArray(call.details?.items)
      ? call.details.items
      : Array.isArray(call.args.items) ? call.args.items : null;
    if (!rawItems) continue;
    const steps = rawItems.flatMap((value, stepIndex) => {
      const item = recordValue(value);
      const text = typeof item?.text === "string" ? item.text.trim() : "";
      const status = planStatus(item?.status);
      if (!text || !status) return [];
      return [{
        id: typeof item?.id === "string" && item.id.trim() ? item.id.trim() : `step-${stepIndex + 1}`,
        text,
        status,
      }];
    });
    if (steps.length === 0) return null;
    const explanation = typeof call.details?.explanation === "string"
      ? call.details.explanation.trim()
      : typeof call.args.explanation === "string" ? call.args.explanation.trim() : "";
    return { explanation, steps, completed: steps.filter((step) => step.status === "completed").length };
  }
  return null;
}

function subagentRole(value: unknown): SubagentActivity["role"] {
  return value === "planner" || value === "reviewer" || value === "worker" ? value : "explorer";
}

function subagentStatus(value: unknown): SubagentStatus | null {
  return value === "queued" || value === "running" || value === "completed" || value === "failed"
    ? value
    : value === "pending" ? "queued" : null;
}

function delegatedTasks(call: UiToolCall): Array<Omit<SubagentActivity, "id" | "status">> {
  const batchTasks: unknown[] | null = Array.isArray(call.args.tasks) ? call.args.tasks : null;
  const rawTasks: unknown[] = batchTasks
    ? batchTasks
    : typeof call.args.task === "string"
      ? [{ label: call.args.role || "subagent", role: call.args.role || "explorer", task: call.args.task }]
      : [];
  const permission = call.args.permission === "workspace-write" ? "workspace-write" : "read-only";

  return rawTasks.flatMap((value, index) => {
    const task = recordValue(value);
    if (!task || typeof task.task !== "string" || !task.task.trim()) return [];
    const role = subagentRole(task.role);
    const label = typeof task.label === "string" && task.label.trim()
      ? task.label.trim()
      : `${role}-${index + 1}`;
    return [{ label, role, task: task.task.trim(), permission }];
  });
}

/** Derive actual child-agent tasks from delegate_task calls only. */
export function deriveSubagentActivities(messages: UiMessage[]): SubagentActivity[] {
  const activities: SubagentActivity[] = [];
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.name.toLowerCase() !== "delegate_task") continue;
      const inputs = delegatedTasks(call);
      const progress = Array.isArray(call.details?.tasks) ? call.details.tasks : [];
      const results = Array.isArray(call.details?.results) ? call.details.results : [];
      const legacyCompleted = typeof call.details?.completed === "number"
        ? Math.max(0, Math.floor(call.details.completed))
        : 0;

      inputs.forEach((input, index) => {
        const progressItem = recordValue(progress[index]);
        const resultItem = recordValue(results[index]);
        const detail = progressItem ?? resultItem;
        const role = subagentRole(detail?.role ?? input.role);
        const label = typeof detail?.label === "string" && detail.label.trim() ? detail.label.trim() : input.label;
        const task = typeof detail?.task === "string" && detail.task.trim() ? detail.task.trim() : input.task;
        const explicitStatus = subagentStatus(progressItem?.status);
        const status = explicitStatus
          ?? (resultItem ? (resultItem.ok === true ? "completed" : "failed") : null)
          ?? (call.running ? (index < legacyCompleted ? "completed" : "running") : null)
          ?? (call.finishedAt || call.result !== undefined || call.isError !== undefined
            ? (call.isError ? "failed" : "completed")
            : "queued");
        activities.push({
          id: `${call.id}:${index}`,
          label,
          role,
          task,
          permission: detail?.permission === "workspace-write" ? "workspace-write" : input.permission,
          status,
          output: typeof resultItem?.output === "string" && resultItem.output.trim() ? resultItem.output.trim() : undefined,
          error: typeof resultItem?.error === "string" && resultItem.error.trim() ? resultItem.error.trim() : undefined,
          durationMs: call.startedAt && call.finishedAt ? Math.max(0, call.finishedAt - call.startedAt) : undefined,
        });
      });
    }
  }
  return activities;
}

export function summarizeSubagents(activities: SubagentActivity[]): SubagentSummary {
  const summary: SubagentSummary = { total: activities.length, queued: 0, running: 0, completed: 0, failed: 0 };
  for (const activity of activities) summary[activity.status] += 1;
  return summary;
}
