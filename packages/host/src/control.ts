/**
 * The desktop's control channel (ADR 0013): one JSON object per line on the
 * host's stdin, which only the desktop app holds.
 *
 * - `{"desktop": DesktopMessage}`: the desktop's settings changed (or the
 *   host just started). harness.json is rewritten from them, Pi's
 *   models.json is imported into providers.json the first time, the keys of
 *   its built-in providers in auth.json once (pi-import.json records it), the default
 *   model follows the desktop's, and the plugins reload.
 * - `{"reload": true}`: reload from the files as they are.
 *
 * Writing the files keeps a headless run or a restart on the same settings
 * the desktop last sent.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { harnessFromDesktop, type DesktopMessage } from "./desktop-settings.ts";
import { importPiAuth, importPiModels, type PiImport } from "./pi-import.ts";
import { readSecretFile, writeSecretFile, type SecretCodec } from "./secrets.ts";

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

/**
 * Keep the keys of `imported` in secrets.dat. Without a secret store (not
 * Windows) the providers stay and their written keys are dropped rather than
 * written out.
 */
function storeImportedKeys(dataDir: string, imported: PiImport, codec: SecretCodec | undefined, notes: string[]): void {
  if (Object.keys(imported.secrets).length === 0) return;
  if (codec === undefined) {
    for (const entry of imported.providers) if (entry.apiKey !== undefined && "secret" in entry.apiKey) delete entry.apiKey;
    notes.push("Pi provider keys were not imported: no secret store is available on this platform");
    return;
  }
  const file = join(dataDir, "secrets.dat");
  writeSecretFile(file, { ...readSecretFile<Record<string, string>>(file, codec), ...imported.secrets }, codec);
}

/** Write what a desktop message says into `dataDir`; returns notes for the log. */
export function applyDesktopMessage(dataDir: string, message: DesktopMessage, codec: SecretCodec | undefined): string[] {
  const notes: string[] = [];
  const { config, defaultModel } = harnessFromDesktop(message);
  writeJson(join(dataDir, "harness.json"), config);

  const providersFile = join(dataDir, "providers.json");
  let providers = readJson(providersFile);
  if (providers === undefined) {
    providers = { providers: [] };
    const modelsFile = message.piAgentDir === undefined ? undefined : join(message.piAgentDir, "models.json");
    const models = modelsFile === undefined ? undefined : readJson(modelsFile);
    if (models !== undefined) {
      const imported = importPiModels(models);
      notes.push(...imported.problems.map((problem) => `Pi provider not imported: ${problem}`));
      storeImportedKeys(dataDir, imported, codec, notes);
      providers.providers = imported.providers;
      notes.push(`imported ${imported.providers.length} provider(s) from ${modelsFile}`);
    }
  }
  // Built-in providers keyed in Pi's auth.json move once; providers.json may already exist by then.
  const markerFile = join(dataDir, "pi-import.json");
  const marker = readJson(markerFile) ?? {};
  if (marker.auth === undefined && message.piAgentDir !== undefined) {
    const authFile = join(message.piAgentDir, "auth.json");
    const auth = readJson(authFile);
    if (auth !== undefined) {
      const entries: unknown[] = Array.isArray(providers.providers) ? providers.providers : [];
      const existing = new Set(entries.flatMap((entry) => {
        const id = (entry as { id?: unknown } | null)?.id;
        return typeof id === "string" ? [id] : [];
      }));
      const imported = importPiAuth(auth, existing);
      notes.push(...imported.problems.map((problem) => `Pi provider not imported: ${problem}`));
      storeImportedKeys(dataDir, imported, codec, notes);
      providers.providers = [...entries, ...imported.providers];
      if (imported.providers.length > 0) notes.push(`imported ${imported.providers.length} built-in provider(s) from ${authFile}`);
    }
    writeJson(markerFile, { ...marker, auth: new Date().toISOString() });
  }

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
