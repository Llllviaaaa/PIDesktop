import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ScheduleListResult, ScheduleRunsResult, ScheduledRunInfo, ScheduledTaskInfo } from "@pid/protocol";
import type { ScheduledRunRecord, ScheduledRunResult, ScheduledTask } from "../types";
import { HARNESS_SESSION_PREFIX, harnessRuntimes } from "./harnessRuntime";

// On the harness engine the Harness Host runs scheduled tasks (docs/adr/0011,
// 0014); the desktop's Rust scheduler keeps running them for the Pi engine.
const onHarness = () => harnessRuntimes.getEngine() === "harness";

/** The tasks last listed from the Host, to fill in what its run records leave out. */
const hostTasks = new Map<string, ScheduledTask>();

export function taskFromHost(task: Omit<ScheduledTaskInfo, "running"> & { running?: boolean }): ScheduledTask {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    cwd: task.cwd,
    frequency: task.frequency,
    hour: task.hour,
    minute: task.minute,
    weekday: task.weekday,
    permissionMode: task.permissionMode,
    timeoutMinutes: task.timeoutMinutes ?? null,
    enabled: task.enabled,
    lastRunAt: task.lastRunAt ?? null,
    nextRunAt: task.nextRunAt ?? null,
    lastStatus: (task.lastStatus || "") as ScheduledTask["lastStatus"],
    lastMessage: task.lastMessage,
  };
}

export function taskToHost(task: ScheduledTask): Record<string, unknown> {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    cwd: task.cwd,
    frequency: task.frequency,
    hour: task.hour,
    minute: task.minute,
    weekday: task.weekday,
    permissionMode: task.permissionMode,
    ...(typeof task.timeoutMinutes === "number" ? { timeoutMinutes: task.timeoutMinutes } : {}),
    enabled: task.enabled,
  };
}

export function runFromHost(run: ScheduledRunInfo, task: ScheduledTask | undefined): ScheduledRunRecord {
  return {
    id: run.id,
    taskId: run.taskId,
    taskName: run.taskName,
    cwd: task?.cwd ?? "",
    prompt: task?.prompt ?? "",
    permissionMode: task?.permissionMode ?? "ask",
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    durationMs: run.durationMs ?? null,
    output: run.output,
    sessionFile: run.sessionId === undefined ? null : `${HARNESS_SESSION_PREFIX}${run.sessionId}`,
  };
}

async function hostList(): Promise<ScheduledTask[]> {
  const { tasks } = await harnessRuntimes.call<ScheduleListResult>("schedule.list");
  const mapped = tasks.map(taskFromHost);
  hostTasks.clear();
  for (const task of mapped) hostTasks.set(task.id, task);
  return mapped;
}

/** Listen to a desktop event and, on the harness engine, to the Host notification that stands for it. */
async function listenBoth<T>(event: string, method: string, listener: (payload: T) => void, fromHost: (params: unknown) => T): Promise<UnlistenFn> {
  const stopDesktop = await listen<T>(event, (message) => listener(message.payload));
  const stopHost = harnessRuntimes.onNotification(method, (params) => listener(fromHost(params)));
  return () => {
    stopDesktop();
    stopHost();
  };
}

export const scheduleClient = {
  list: () => (onHarness() ? hostList() : invoke<ScheduledTask[]>("list_scheduled_tasks_cmd")),
  listRuns: async (taskId?: string, limit = 80): Promise<ScheduledRunRecord[]> => {
    if (!onHarness()) return invoke<ScheduledRunRecord[]>("list_scheduled_runs_cmd", { taskId: taskId || null, limit });
    if (hostTasks.size === 0) await hostList();
    const { runs } = await harnessRuntimes.call<ScheduleRunsResult>("schedule.runs", { ...(taskId ? { taskId } : {}), limit });
    return runs.map((run) => runFromHost(run, hostTasks.get(run.taskId)));
  },
  save: async (task: ScheduledTask): Promise<ScheduledTask> => {
    if (!onHarness()) return invoke<ScheduledTask>("save_scheduled_task_cmd", { task });
    const saved = taskFromHost((await harnessRuntimes.call<{ task: ScheduledTaskInfo }>("schedule.save", { task: taskToHost(task) })).task);
    hostTasks.set(saved.id, saved);
    return saved;
  },
  delete: async (id: string): Promise<void> => {
    if (!onHarness()) return invoke<void>("delete_scheduled_task_cmd", { id });
    await harnessRuntimes.call("schedule.delete", { id });
    hostTasks.delete(id);
  },
  run: async (id: string, nextRunAt?: number | null): Promise<ScheduledRunResult> => {
    if (!onHarness()) return invoke<ScheduledRunResult>("run_scheduled_task_cmd", { id, nextRunAt: nextRunAt ?? null });
    const { run } = await harnessRuntimes.call<{ run: ScheduledRunInfo }>("schedule.run", { id });
    return { success: run.status === "success", output: run.output, run: runFromHost(run, hostTasks.get(run.taskId)) };
  },
  cancel: (id: string) => (onHarness() ? harnessRuntimes.call<void>("schedule.cancel", { id }) : invoke<void>("cancel_scheduled_task_cmd", { id })),
  /** A task changed, from the desktop's scheduler or the Host's. */
  onTaskUpdated: (listener: () => void): Promise<UnlistenFn> => listenBoth<unknown>("scheduled-task-updated", "schedule/task", () => listener(), () => undefined),
  /** A run started or finished, from the desktop's scheduler or the Host's. */
  onRunUpdated: (listener: (run: ScheduledRunRecord) => void): Promise<UnlistenFn> => listenBoth<ScheduledRunRecord>(
    "scheduled-run-updated",
    "schedule/run",
    listener,
    (params) => runFromHost(params as ScheduledRunInfo, hostTasks.get((params as ScheduledRunInfo).taskId)),
  ),
};
