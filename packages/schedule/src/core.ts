/**
 * Scheduled task definitions and next-run computation, ported from the
 * desktop's Rust scheduler (`src-tauri/src/scheduler.rs`,
 * `commands/schedule.rs`), which keeps serving the Pi engine until P5.
 */

export type Frequency = "hourly" | "daily" | "weekdays" | "weekly";
/** Unattended runs never get full access: nobody is there to watch. */
export type UnattendedPermission = "read-only" | "ask" | "workspace-write";

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  frequency: Frequency;
  hour: number;
  minute: number;
  /** 0 = Sunday … 6 = Saturday, for `weekly`. */
  weekday: number;
  permissionMode: UnattendedPermission;
  /** 1..240, default 30. */
  timeoutMinutes?: number;
  /** Overrides the host's default model. */
  model?: { provider: string; model: string };
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  lastStatus: string;
  lastMessage: string;
}

export type RunStatus = "running" | "success" | "error" | "cancelled" | "timed-out" | "interrupted";

export interface ScheduledRun {
  id: string;
  taskId: string;
  taskName: string;
  trigger: "scheduled" | "manual";
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  /** The session the run worked in. */
  sessionId?: string;
  output: string;
}

export const FREQUENCIES: readonly Frequency[] = ["hourly", "daily", "weekdays", "weekly"];
export const UNATTENDED_PERMISSIONS: readonly UnattendedPermission[] = ["read-only", "ask", "workspace-write"];
export const DEFAULT_TIMEOUT_MINUTES = 30;

export function timeoutMinutes(task: Pick<ScheduledTask, "timeoutMinutes">): number {
  return Math.min(240, Math.max(1, Math.round(task.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES)));
}

/** Validate an edited task; throws with the reason. Run state fields are kept from `previous`. */
export function validateTask(input: Partial<ScheduledTask>, previous?: ScheduledTask): ScheduledTask {
  const text = (value: unknown, field: string, max: number) => {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
    if (value.length > max) throw new Error(`${field} is too long`);
    return value.trim();
  };
  const integer = (value: unknown, field: string, min: number, max: number) => {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${field} must be an integer from ${min} to ${max}`);
    return value as number;
  };
  if (!FREQUENCIES.includes(input.frequency as Frequency)) throw new Error(`frequency must be one of ${FREQUENCIES.join(", ")}`);
  const permissionMode = input.permissionMode ?? "ask";
  if (!UNATTENDED_PERMISSIONS.includes(permissionMode)) throw new Error(`permissionMode must be one of ${UNATTENDED_PERMISSIONS.join(", ")}`);
  if (input.model !== undefined && (typeof input.model?.provider !== "string" || typeof input.model.model !== "string")) {
    throw new Error("model must be { provider, model }");
  }
  return {
    id: text(input.id, "id", 120),
    name: text(input.name, "name", 200),
    prompt: text(input.prompt, "prompt", 100_000),
    cwd: text(input.cwd, "cwd", 4096),
    frequency: input.frequency as Frequency,
    hour: integer(input.hour ?? 9, "hour", 0, 23),
    minute: integer(input.minute ?? 0, "minute", 0, 59),
    weekday: integer(input.weekday ?? 1, "weekday", 0, 6),
    permissionMode,
    ...(input.timeoutMinutes === undefined ? {} : { timeoutMinutes: integer(input.timeoutMinutes, "timeoutMinutes", 1, 240) }),
    ...(input.model === undefined ? {} : { model: { provider: input.model.provider, model: input.model.model } }),
    enabled: input.enabled !== false,
    ...(previous?.lastRunAt === undefined ? {} : { lastRunAt: previous.lastRunAt }),
    lastStatus: previous?.lastStatus ?? "",
    lastMessage: previous?.lastMessage ?? "",
  };
}

/** Local wall-clock time on `date`'s day. `Date` moves a time skipped by a DST change forward, as the Rust scheduler does. */
function localTime(date: Date, hour: number, minute: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** The first run strictly after `from` (epoch ms), in local time. */
export function nextScheduledRun(task: Pick<ScheduledTask, "frequency" | "hour" | "minute" | "weekday">, from: number): number {
  const origin = new Date(from);
  switch (task.frequency) {
    case "hourly": {
      const candidate = localTime(origin, origin.getHours(), task.minute);
      if (candidate.getTime() <= from) candidate.setHours(candidate.getHours() + 1);
      return candidate.getTime();
    }
    case "daily": {
      const candidate = localTime(origin, task.hour, task.minute);
      return candidate.getTime() > from ? candidate.getTime() : localTime(addDays(origin, 1), task.hour, task.minute).getTime();
    }
    case "weekdays": {
      let date = origin;
      if (localTime(date, task.hour, task.minute).getTime() <= from) date = addDays(date, 1);
      while (date.getDay() === 0 || date.getDay() === 6) date = addDays(date, 1);
      return localTime(date, task.hour, task.minute).getTime();
    }
    case "weekly": {
      const desired = Math.min(6, Math.max(0, task.weekday));
      let daysAhead = (desired - origin.getDay() + 7) % 7;
      if (daysAhead === 0 && localTime(origin, task.hour, task.minute).getTime() <= from) daysAhead = 7;
      return localTime(addDays(origin, daysAhead), task.hour, task.minute).getTime();
    }
    default:
      return from + 24 * 60 * 60 * 1000;
  }
}

export function truncateOutput(value: string, limit: number): string {
  const chars = [...value];
  return chars.length > limit ? `${chars.slice(0, limit).join("")}\n... output truncated by PIDesktop` : value;
}
