import { invoke } from "@tauri-apps/api/core";
import type { ScheduledRunRecord, ScheduledRunResult, ScheduledTask } from "../types";

export const scheduleClient = {
  list: () => invoke<ScheduledTask[]>("list_scheduled_tasks_cmd"),
  listRuns: (taskId?: string, limit = 80) =>
    invoke<ScheduledRunRecord[]>("list_scheduled_runs_cmd", { taskId: taskId || null, limit }),
  save: (task: ScheduledTask) => invoke<ScheduledTask>("save_scheduled_task_cmd", { task }),
  delete: (id: string) => invoke<void>("delete_scheduled_task_cmd", { id }),
  run: (id: string, nextRunAt?: number | null) =>
    invoke<ScheduledRunResult>("run_scheduled_task_cmd", { id, nextRunAt: nextRunAt ?? null }),
  cancel: (id: string) => invoke<void>("cancel_scheduled_task_cmd", { id }),
};
