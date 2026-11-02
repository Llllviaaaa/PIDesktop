/**
 * The desktop's control channel (ADR 0013): one JSON object per line on the
 * host's stdin, which only the desktop app holds.
 *
 * - `{"desktop": DesktopMessage}`: the desktop's settings changed (or the
 *   host just started). harness.json is rewritten from them, the default
 *   model follows the desktop's, and the plugins reload.
 * - `{"reload": true}`: reload from the files as they are.
 *
 * Writing the files keeps a headless run or a restart on the same settings
 * the desktop last sent.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { harnessFromDesktop, type DesktopMessage } from "./desktop-settings.ts";

/** The fields a desktop scheduled task shares with the host's (`@pid/schedule`). */
const TASK_FIELDS = ["id", "name", "prompt", "cwd", "frequency", "hour", "minute", "weekday", "permissionMode", "enabled", "lastRunAt", "lastStatus", "lastMessage"] as const;

/**
 * The desktop's scheduled tasks in the host's format. The next run is left
 * out so the host computes it, and a task the desktop was running counts as
 * interrupted.
 */
export function importDesktopTasks(tasks: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tasks)) return [];
  return tasks.flatMap((value) => {
    const task = value as Record<string, unknown>;
    if (typeof task?.id !== "string" || typeof task.prompt !== "string" || typeof task.cwd !== "string") return [];
    const imported: Record<string, unknown> = {};
    for (const field of TASK_FIELDS) if (task[field] !== undefined && task[field] !== null) imported[field] = task[field];
    if (typeof task.timeoutMinutes === "number") imported.timeoutMinutes = task.timeoutMinutes;
    if (imported.lastStatus === "running") imported.lastStatus = "interrupted";
    imported.lastStatus ??= "";
    imported.lastMessage ??= "";
    return [imported];
  });
}

export type ControlCommand = { desktop: DesktopMessage } | { reload: true };

export function parseControlLine(line: string): ControlCommand | undefined {
  if (line.trim() === "") return undefined;
  const value = JSON.parse(line) as Record<string, unknown>;
  if (value.reload === true) return { reload: true };
  const desktop = value.desktop as DesktopMessage | undefined;
  if (typeof desktop === "object" && desktop !== null && typeof desktop.settings === "object" && typeof desktop.configDir === "string") return { desktop };
  throw new Error("unknown control command");
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

function readJson(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Write what a desktop message says into `dataDir`; returns notes for the log. */
export function applyDesktopMessage(dataDir: string, message: DesktopMessage): string[] {
  const notes: string[] = [];
  const { config, defaultModel } = harnessFromDesktop(message);
  writeJson(join(dataDir, "harness.json"), config);

  const providersFile = join(dataDir, "providers.json");
  const providers = readJson(providersFile) ?? { providers: [] };

  const current = providers.defaultModel as { provider?: unknown; model?: unknown } | undefined;
  if (defaultModel !== undefined && (current?.provider !== defaultModel.provider || current?.model !== defaultModel.model)) {
    providers.defaultModel = defaultModel;
  }
  if (!existsSync(providersFile) || JSON.stringify(readJson(providersFile)) !== JSON.stringify(providers)) writeJson(providersFile, providers);

  // The first time the desktop runs on the harness, its scheduled tasks move here once.
  const schedulesFile = join(dataDir, "schedules.json");
  if (config.schedule.enabled && !existsSync(schedulesFile)) {
    const desktopFile = join(message.configDir, "scheduled-tasks.json");
    let desktopTasks: unknown;
    try {
      desktopTasks = existsSync(desktopFile) ? JSON.parse(readFileSync(desktopFile, "utf8")) : undefined;
    } catch {
      notes.push(`${desktopFile} is not valid JSON; no scheduled tasks imported`);
    }
    const tasks = importDesktopTasks(desktopTasks);
    writeJson(schedulesFile, tasks);
    if (tasks.length > 0) notes.push(`imported ${tasks.length} scheduled task(s) from ${desktopFile}`);
  }
  return notes;
}
