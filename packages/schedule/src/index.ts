/**
 * Scheduled tasks run by the host (ADR 0011). Each run is an ordinary
 * session in the task's directory: the prompt goes to the agent loop with the
 * task's permission mode, nobody can be asked to confirm anything (the
 * session is unattended, so a call that needs confirmation is denied), and
 * the run stops at its timeout.
 *
 * Tasks live in `<dataDir>/schedules.json`, run history in
 * `<dataDir>/schedule-runs.jsonl`. These are the host's own: the desktop's
 * Rust scheduler keeps its own tasks for the Pi engine until P5, so the two
 * never fire the same task.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Context, Service } from "@deepseek-ai/cordis";
import type { RunOutcome } from "@pid/agent";
import type { Session } from "@pid/session";
import "@pid/ui";
import {
  nextScheduledRun,
  timeoutMinutes,
  truncateOutput,
  validateTask,
  type RunStatus,
  type ScheduledRun,
  type ScheduledTask,
} from "./core.ts";

export * from "./core.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    schedule: Schedule;
  }

  interface Events {
    /** A task changed (saved, started, finished) or was deleted (`task` undefined). */
    "schedule/task"(id: string, task: ScheduledTask | undefined): void;
    "schedule/run"(run: ScheduledRun): void;
  }
}

export interface Config {
  /** `<dataDir>/schedules.json`. */
  tasksFile: string;
  /** `<dataDir>/schedule-runs.jsonl`. */
  runsFile: string;
  /** Model for tasks that name none. */
  defaultModel?: { provider: string; model: string };
  /** How often to look for due tasks. Default 30 s. */
  tickMs?: number;
  /** Runs at once. Default 2, as in the Rust scheduler. */
  maxConcurrent?: number;
  /** Clock, for tests. */
  now?: () => number;
}

const RUN_HISTORY_LIMIT = 500;

function readTasks(file: string): ScheduledTask[] {
  if (!existsSync(file)) return [];
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(parsed) ? (parsed as ScheduledTask[]) : [];
}

function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

export class Schedule extends Service {
  static inject = ["sessions", "agents", "ui"];

  private tasks: ScheduledTask[] = [];
  private readonly running = new Map<string, { cancelled: boolean; sessionId?: string }>();
  private readonly now: () => number;

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, "schedule");
    this.now = config.now ?? Date.now;
    this.load();
    const timer = setInterval(() => this.tick(), config.tickMs ?? 30_000);
    ctx.effect(() => () => clearInterval(timer), "schedule: timer");
    ctx.effect(() => () => {
      for (const [id, run] of this.running) {
        run.cancelled = true;
        if (run.sessionId !== undefined) void ctx.agents.abort(run.sessionId);
        this.running.delete(id);
      }
    }, "schedule: stop runs");
  }

  list(): ScheduledTask[] {
    return this.tasks.map((task) => ({ ...task }));
  }

  /** Create or replace a task; returns it with its next run. */
  save(input: Partial<ScheduledTask>): ScheduledTask {
    const id = typeof input.id === "string" && input.id !== "" ? input.id : randomUUID();
    const previous = this.tasks.find((task) => task.id === id);
    const task = validateTask({ ...input, id }, previous);
    if (task.enabled) task.nextRunAt = nextScheduledRun(task, this.now());
    this.tasks = previous === undefined ? [...this.tasks, task] : this.tasks.map((item) => (item.id === id ? task : item));
    this.persist();
    this.ctx.emit("schedule/task", id, { ...task });
    return { ...task };
  }

  delete(id: string): boolean {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((task) => task.id !== id);
    if (this.tasks.length === before) return false;
    this.persist();
    this.cancel(id);
    this.ctx.emit("schedule/task", id, undefined);
    return true;
  }

  /** The latest runs, newest first, optionally of one task. */
  runs(taskId?: string, limit = 50): ScheduledRun[] {
    if (!existsSync(this.config.runsFile)) return [];
    const latest = new Map<string, ScheduledRun>();
    for (const line of readFileSync(this.config.runsFile, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const run = JSON.parse(line) as ScheduledRun;
        latest.set(run.id, run);
      } catch {
        // A torn last line after a crash.
      }
    }
    return [...latest.values()]
      .filter((run) => taskId === undefined || run.taskId === taskId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  cancel(id: string): boolean {
    const run = this.running.get(id);
    if (run === undefined) return false;
    run.cancelled = true;
    if (run.sessionId !== undefined) void this.ctx.agents.abort(run.sessionId);
    return true;
  }

  /** Start every due task, within the concurrency limit. Called by the timer. */
  tick(): void {
    const available = (this.config.maxConcurrent ?? 2) - this.running.size;
    if (available <= 0) return;
    const now = this.now();
    const due = this.tasks.filter((task) => task.enabled && !this.running.has(task.id) && task.nextRunAt !== undefined && task.nextRunAt <= now);
    for (const task of due.slice(0, available)) void this.run(task.id, "scheduled").catch((error: unknown) => {
      this.ctx.logger("schedule").error("task %s failed to run: %s", task.id, error);
    });
  }

  /** Run a task now and resolve with the finished run. */
  async run(id: string, trigger: ScheduledRun["trigger"]): Promise<ScheduledRun> {
    if (this.running.has(id)) throw new Error("scheduled task is already running");
    if (this.running.size >= (this.config.maxConcurrent ?? 2)) throw new Error("scheduled runner is at its concurrency limit");
    const task = this.tasks.find((item) => item.id === id);
    if (task === undefined) throw new Error("scheduled task not found");
    const handle: { cancelled: boolean; sessionId?: string } = { cancelled: false };
    this.running.set(id, handle);

    const startedAt = this.now();
    const run: ScheduledRun = { id: randomUUID(), taskId: id, taskName: task.name, trigger, status: "running", startedAt, output: "" };
    this.updateTask(id, (entry) => {
      entry.lastRunAt = startedAt;
      if (trigger === "scheduled") entry.nextRunAt = entry.enabled ? nextScheduledRun(entry, startedAt + 1_000) : undefined;
      else if (entry.enabled && entry.nextRunAt === undefined) entry.nextRunAt = nextScheduledRun(entry, startedAt);
      entry.lastStatus = "running";
      entry.lastMessage = "";
    });
    this.recordRun(run);

    try {
      const { status, output, sessionId } = await this.execute(task, handle);
      run.status = status;
      run.output = truncateOutput(output, 100_000);
      if (sessionId !== undefined) run.sessionId = sessionId;
    } catch (error) {
      run.status = "error";
      run.output = error instanceof Error ? error.message : String(error);
    } finally {
      this.running.delete(id);
    }
    run.finishedAt = this.now();
    run.durationMs = run.finishedAt - startedAt;
    this.recordRun(run);
    this.updateTask(id, (entry) => {
      entry.lastStatus = run.status;
      entry.lastMessage = truncateOutput(run.output, 2_000);
    });
    return { ...run };
  }

  private async execute(task: ScheduledTask, handle: { cancelled: boolean; sessionId?: string }): Promise<{ status: RunStatus; output: string; sessionId?: string }> {
    const model = task.model ?? this.config.defaultModel;
    if (model === undefined) return { status: "error", output: "No model: set the task's model or defaultModel in providers.json" };
    if (!existsSync(task.cwd)) return { status: "error", output: `The task's directory does not exist: ${task.cwd}` };
    const session = this.ctx.sessions.create({ cwd: task.cwd });
    handle.sessionId = session.id;
    session.append("model", model);
    session.append("label", { title: `${task.name}（定时）` });
    const permissions = this.ctx.get("permissions") as { set(session: Session, change: { permission: string; agentMode: string }): number } | undefined;
    permissions?.set(session, { permission: task.permissionMode, agentMode: "agent" });
    const unattended = this.ctx.ui.markUnattended(session.id);

    let outcome: RunOutcome | undefined;
    const off = this.ctx.on("agent/settled", async (settled, result) => {
      if (settled === session) outcome = result;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void this.ctx.agents.abort(session.id);
    }, timeoutMinutes(task) * 60_000);
    try {
      if (handle.cancelled) return { status: "cancelled", output: "PIDesktop cancelled this scheduled task.", sessionId: session.id };
      this.ctx.agents.prompt(session, [{ type: "text", text: task.prompt }]);
      await this.ctx.agents.idle(session.id);
    } finally {
      clearTimeout(timer);
      off();
      unattended();
    }
    const reply = session.events.findLast((event) => event.type === "assistant");
    const text = reply?.type === "assistant"
      ? reply.data.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim()
      : "";
    const error = reply?.type === "assistant" ? reply.data.error?.message : undefined;
    if (handle.cancelled) return { status: "cancelled", output: "PIDesktop cancelled this scheduled task.", sessionId: session.id };
    if (timedOut) return { status: "timed-out", output: `Scheduled task exceeded its ${timeoutMinutes(task)} minute timeout.`, sessionId: session.id };
    if (outcome === "done") return { status: "success", output: text, sessionId: session.id };
    return { status: "error", output: error ?? (text || `The run ended: ${outcome ?? "unknown"}`), sessionId: session.id };
  }

  private load(): void {
    try {
      this.tasks = readTasks(this.config.tasksFile);
    } catch (error) {
      this.ctx.logger("schedule").warn("could not read %s: %s", this.config.tasksFile, error);
      this.tasks = [];
    }
    const now = this.now();
    for (const task of this.tasks) {
      if (task.lastStatus === "running") {
        task.lastStatus = "interrupted";
        task.lastMessage = "PIDesktop exited before this run completed.";
      }
      if (!task.enabled) delete task.nextRunAt;
      else if (task.nextRunAt === undefined) task.nextRunAt = nextScheduledRun(task, now);
    }
    // Runs that were running when the host stopped.
    const recent = this.runs(undefined, RUN_HISTORY_LIMIT);
    for (const run of recent) {
      if (run.status === "running") this.recordRun({ ...run, status: "interrupted", finishedAt: now, output: "PIDesktop exited before this run completed." });
    }
    // The history is append-only (a run is written when it starts and when it
    // ends); keep it to the latest runs once it has grown well past that.
    if (existsSync(this.config.runsFile) && readFileSync(this.config.runsFile, "utf8").split("\n").length > RUN_HISTORY_LIMIT * 4) {
      const kept = this.runs(undefined, RUN_HISTORY_LIMIT).reverse();
      writeFileSync(this.config.runsFile, kept.map((run) => `${JSON.stringify(run)}\n`).join(""));
    }
    if (this.tasks.length > 0) this.persist();
  }

  private persist(): void {
    writeJsonAtomic(this.config.tasksFile, this.tasks);
  }

  private updateTask(id: string, change: (task: ScheduledTask) => void): void {
    const task = this.tasks.find((item) => item.id === id);
    if (task === undefined) return;
    change(task);
    this.persist();
    this.ctx.emit("schedule/task", id, { ...task });
  }

  private recordRun(run: ScheduledRun): void {
    mkdirSync(dirname(this.config.runsFile), { recursive: true });
    appendFileSync(this.config.runsFile, `${JSON.stringify(run)}\n`);
    this.ctx.emit("schedule/run", { ...run });
  }
}
