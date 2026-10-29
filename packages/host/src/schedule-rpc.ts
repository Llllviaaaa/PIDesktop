/**
 * `schedule.*` methods (ADR 0011) and the `schedule/task` and `schedule/run`
 * notifications every client gets as tasks change and runs start and finish.
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  ErrorCode,
  type ScheduleListResult,
  type ScheduleRunsResult,
  type ScheduleTaskNotification,
  type ScheduledRunInfo,
  type ScheduledTaskInfo,
} from "@pid/protocol";
import "@pid/schedule";
import { RpcError } from "./rpc.ts";

export const name = "pid-schedule-rpc";
export const inject = ["rpc", "schedule"];

export function apply(ctx: Context): void {
  ctx.on("schedule/task", (id, task) => {
    const notification: ScheduleTaskNotification = task === undefined ? { id, deleted: true } : { id, task };
    ctx.rpc.broadcast("schedule/task", notification);
  });
  ctx.on("schedule/run", (run) => ctx.rpc.broadcast("schedule/run", run));

  const id = (params: unknown): string => {
    const value = (params as { id?: unknown } | undefined)?.id;
    if (typeof value !== "string" || value === "") throw new RpcError(ErrorCode.InvalidParams, "id must be a string");
    return value;
  };
  const invalid = (fn: () => unknown) => {
    try {
      return fn();
    } catch (error) {
      throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
    }
  };

  const methods: Record<string, (params: unknown) => unknown> = {
    "schedule.list": (): ScheduleListResult => ({
      tasks: ctx.schedule.list().map((task) => ({ ...task, running: ctx.schedule.isRunning(task.id) })),
    }),
    "schedule.save": (params): { task: ScheduledTaskInfo } => {
      const task = (params as { task?: unknown } | undefined)?.task;
      if (typeof task !== "object" || task === null) throw new RpcError(ErrorCode.InvalidParams, "schedule.save needs { task }");
      const saved = invalid(() => ctx.schedule.save(task)) as ReturnType<typeof ctx.schedule.save>;
      return { task: { ...saved, running: ctx.schedule.isRunning(saved.id) } };
    },
    "schedule.delete": (params) => {
      if (!ctx.schedule.delete(id(params))) throw new RpcError(ErrorCode.InvalidParams, "No such scheduled task");
      return {};
    },
    "schedule.run": async (params): Promise<{ run: ScheduledRunInfo }> => {
      const taskId = id(params);
      try {
        return { run: await ctx.schedule.run(taskId, "manual") };
      } catch (error) {
        throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
      }
    },
    "schedule.cancel": (params) => {
      if (!ctx.schedule.cancel(id(params))) throw new RpcError(ErrorCode.InvalidParams, "That task is not running");
      return {};
    },
    "schedule.runs": (params): ScheduleRunsResult => {
      const { taskId, limit } = (params ?? {}) as { taskId?: unknown; limit?: unknown };
      return {
        runs: ctx.schedule.runs(
          typeof taskId === "string" ? taskId : undefined,
          Number.isInteger(limit) ? Math.min(500, Math.max(1, limit as number)) : 50,
        ),
      };
    },
  };
  for (const [method, handler] of Object.entries(methods)) {
    ctx.effect(() => ctx.rpc.method(method, handler), `${name}: ${method}`);
  }
}
