import type { ScheduledTask } from "../types";

function atConfiguredTime(source: Date, task: ScheduledTask): Date {
  const result = new Date(source);
  result.setHours(task.hour, task.minute, 0, 0);
  return result;
}

export function nextScheduledRun(task: ScheduledTask, from = Date.now()): number {
  const origin = new Date(from);
  if (task.frequency === "hourly") {
    const next = new Date(origin);
    next.setMinutes(task.minute, 0, 0);
    if (next.getTime() <= from) next.setHours(next.getHours() + 1);
    return next.getTime();
  }

  if (task.frequency === "daily") {
    const next = atConfiguredTime(origin, task);
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  if (task.frequency === "weekdays") {
    const next = atConfiguredTime(origin, task);
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  const next = atConfiguredTime(origin, task);
  const daysAhead = (task.weekday - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + daysAhead);
  if (next.getTime() <= from) next.setDate(next.getDate() + 7);
  return next.getTime();
}

export function scheduleSummary(task: ScheduledTask): string {
  const time = `${String(task.hour).padStart(2, "0")}:${String(task.minute).padStart(2, "0")}`;
  if (task.frequency === "hourly") return `每小时的 ${String(task.minute).padStart(2, "0")} 分`;
  if (task.frequency === "daily") return `每天 ${time}`;
  if (task.frequency === "weekdays") return `工作日 ${time}`;
  return `每周${["日", "一", "二", "三", "四", "五", "六"][task.weekday]} ${time}`;
}

export function formatScheduleTime(timestamp?: number | null): string {
  if (!timestamp) return "尚未安排";
  return new Date(timestamp).toLocaleString([], {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
