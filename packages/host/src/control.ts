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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PluginInstallOrigin } from "@qianji/protocol";
import { harnessFromDesktop, type DesktopMessage } from "./desktop-settings.ts";
import { HARNESS_TOGGLED_PLUGIN_IDS, pluginEnabledInHarness, readHarnessConfig } from "./harness-config.ts";
import { managedPluginDirName, managedPluginsRoot } from "./plugin-installer.ts";
import { canonicalPath, pathComparisonKey } from "./plugin-manifest.ts";
import { pluginsStorePath, readPluginsStore, updatePluginsStore } from "./plugin-store.ts";

/** The fields a desktop scheduled task shares with the host's (`@qianji/schedule`). */
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

function listRelativeFiles(rootDir: string, prefix = ""): Array<{ rel: string; full: string }> {
  const results: Array<{ rel: string; full: string }> = [];
  if (!existsSync(rootDir)) return results;
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listRelativeFiles(full, rel));
    } else if (entry.isFile()) {
      results.push({ rel, full });
    }
  }
  results.sort((a, b) => a.rel.localeCompare(b.rel));
  return results;
}

function areDirsByteIdentical(dirA: string, dirB: string): boolean {
  const filesA = listRelativeFiles(dirA);
  const filesB = listRelativeFiles(dirB);
  if (filesA.length === 0 || filesA.length !== filesB.length) return false;
  for (let index = 0; index < filesA.length; index += 1) {
    const itemA = filesA[index];
    const itemB = filesB[index];
    if (itemA === undefined || itemB === undefined || itemA.rel !== itemB.rel) return false;
    try {
      const bufA = readFileSync(itemA.full);
      const bufB = readFileSync(itemB.full);
      if (!bufA.equals(bufB)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function maxFileMtimeMs(rootDir: string): number {
  let latest = 0;
  for (const file of listRelativeFiles(rootDir)) {
    try {
      const mtime = statSync(file.full).mtimeMs;
      if (mtime > latest) latest = mtime;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
  return latest;
}

function isUnmodifiedSeededCopy(
  installedDir: string,
  bundledPluginDir: string,
  hasSeedMarker: boolean,
  origin: PluginInstallOrigin | undefined,
): boolean {
  if (areDirsByteIdentical(installedDir, bundledPluginDir)) {
    return true;
  }
  if (origin?.channel !== "local") return false;
  const normalizedSpec = origin.spec.replace(/\\/g, "/").toLowerCase();
  const fromBundledOrigin = hasSeedMarker || normalizedSpec.includes("/bundled-plugins/");
  if (!fromBundledOrigin) return false;
  const installedAtMs = Date.parse(origin.installedAt);
  if (!Number.isFinite(installedAtMs)) return false;
  return maxFileMtimeMs(installedDir) <= installedAtMs + 5_000;
}

/** Resolve read-only `bundled-plugins` directories from environment, host binary, and desktop binary paths. */
export function resolveDesktopBundledPluginRoots(desktopExe?: string): string[] {
  const candidates: string[] = [];
  const envDir = process.env.QIANJI_BUNDLED_PLUGINS_DIR?.trim();
  if (envDir) candidates.push(envDir);
  const trimmedExe = desktopExe?.trim();
  if (trimmedExe) {
    candidates.push(
      join(dirname(trimmedExe), "harness", "bundled-plugins"),
      join(dirname(trimmedExe), "resources", "harness", "bundled-plugins"),
    );
    const devRepoPlugins = resolve(dirname(trimmedExe), "..", "..", "..", "plugins");
    if (existsSync(join(devRepoPlugins, "smart-rewind", "package.json"))) {
      candidates.push(devRepoPlugins);
    }
  }
  candidates.push(join(dirname(process.execPath), "bundled-plugins"));

  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const canonical = canonicalPath(candidate);
    const key = pathComparisonKey(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push(canonical);
  }
  return resolved;
}

/** Resolve read-only `bundled-skills` directories from environment, host binary, desktop binary, and dev checkout. */
export function resolveDesktopBundledSkillRoots(desktopExe?: string): string[] {
  const candidates: string[] = [];
  const envDir = process.env.QIANJI_BUNDLED_SKILLS_DIR?.trim();
  if (envDir) candidates.push(envDir);
  const trimmedExe = desktopExe?.trim();
  if (trimmedExe) {
    candidates.push(
      join(dirname(trimmedExe), "harness", "bundled-skills"),
      join(dirname(trimmedExe), "resources", "harness", "bundled-skills"),
    );
    const devRepoSkills = resolve(dirname(trimmedExe), "..", "..", "..", "skills");
    if (existsSync(devRepoSkills)) {
      candidates.push(devRepoSkills);
    }
  }
  candidates.push(join(dirname(process.execPath), "bundled-skills"));
  if (typeof import.meta.dirname === "string") {
    const devCheckoutSkills = resolve(import.meta.dirname, "..", "..", "..", "skills");
    if (existsSync(devCheckoutSkills)) {
      candidates.push(devCheckoutSkills);
    }
  }

  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const canonical = canonicalPath(candidate);
    const key = pathComparisonKey(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push(canonical);
  }
  return resolved;
}

/** Resolve the offline TypeScript declaration directory (`plugin-types`) for scaffolded external plugins. */
export function resolveDesktopPluginTypesDir(desktopExe?: string): string | undefined {
  const candidates: string[] = [];
  const envDir = process.env.QIANJI_PLUGIN_TYPES_DIR?.trim();
  if (envDir) candidates.push(envDir);
  const trimmedExe = desktopExe?.trim();
  if (trimmedExe) {
    candidates.push(
      join(dirname(trimmedExe), "harness", "plugin-types"),
      join(dirname(trimmedExe), "resources", "harness", "plugin-types"),
      resolve(dirname(trimmedExe), "..", "..", "resources", "harness", "plugin-types"),
    );
  }
  candidates.push(join(dirname(process.execPath), "plugin-types"));
  if (typeof import.meta.dirname === "string") {
    candidates.push(resolve(import.meta.dirname, "..", "..", "..", "src-tauri", "resources", "harness", "plugin-types"));
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "tsconfig.plugin.json"))) {
      return canonicalPath(candidate);
    }
  }
  return undefined;
}

/**
 * Clean up unmodified legacy `.seeded-<id>-v1` copies under `<dataDir>/plugins`
 * now that `PluginManager` loads `bundled-plugins` directly as read-only `builtin` tier.
 * Preserves `enabled`/`config` preferences and never deletes user-modified copies.
 */
export function cleanupLegacySeededPlugins(dataDir: string, bundledRoots: readonly string[]): string[] {
  const notes: string[] = [];
  const pluginsRoot = managedPluginsRoot(dataDir);
  if (!existsSync(pluginsRoot)) return notes;

  const candidateIds = new Set<string>();
  for (const entry of readdirSync(pluginsRoot)) {
    const match = /^\.seeded-(.+)-v1$/.exec(entry);
    if (match?.[1] !== undefined) {
      candidateIds.add(match[1]);
    }
  }
  const store = readPluginsStore(dataDir);
  for (const [id, patch] of Object.entries(store.plugins)) {
    if (patch.linkedDir !== undefined) continue;
    const spec = patch.origin?.spec.replace(/\\/g, "/").toLowerCase() ?? "";
    if (patch.origin?.channel === "local" && spec.includes("/bundled-plugins/")) {
      candidateIds.add(id);
    }
  }

  for (const pluginId of candidateIds) {
    const bundledPluginDir = bundledRoots
      .map((root) => join(root, pluginId))
      .find((candidate) => existsSync(join(candidate, "package.json")));
    const seedMarker = join(pluginsRoot, `.seeded-${pluginId}-v1`);
    const hasSeedMarker = existsSync(seedMarker);
    const installedDir = join(pluginsRoot, managedPluginDirName(pluginId));
    const patch = store.plugins[pluginId];

    if (!existsSync(installedDir)) {
      if (hasSeedMarker) {
        rmSync(seedMarker, { force: true });
      }
      if (patch !== undefined && patch.linkedDir === undefined && patch.origin?.spec.replace(/\\/g, "/").toLowerCase().includes("/bundled-plugins/")) {
        updatePluginsStore(dataDir, (draft) => {
          const current = draft.plugins[pluginId];
          if (current === undefined) return;
          const preserved: { enabled?: boolean; config?: Record<string, unknown> } = {};
          if (current.enabled === false) preserved.enabled = false;
          if (current.config !== undefined && Object.keys(current.config).length > 0) preserved.config = current.config;
          if (Object.keys(preserved).length === 0) {
            delete draft.plugins[pluginId];
          } else {
            draft.plugins[pluginId] = preserved;
          }
        });
      }
      continue;
    }

    if (bundledPluginDir === undefined) {
      continue;
    }

    if (isUnmodifiedSeededCopy(installedDir, bundledPluginDir, hasSeedMarker, patch?.origin)) {
      rmSync(installedDir, { recursive: true, force: true });
      if (hasSeedMarker) {
        rmSync(seedMarker, { force: true });
      }
      updatePluginsStore(dataDir, (draft) => {
        const current = draft.plugins[pluginId];
        if (current === undefined) return;
        const preserved: { enabled?: boolean; config?: Record<string, unknown> } = {};
        if (current.enabled === false) preserved.enabled = false;
        if (current.config !== undefined && Object.keys(current.config).length > 0) preserved.config = current.config;
        if (Object.keys(preserved).length === 0) {
          delete draft.plugins[pluginId];
        } else {
          draft.plugins[pluginId] = preserved;
        }
      });
      notes.push(`cleaned unmodified legacy seeded plugin ${pluginId} (loaded from builtin bundled-plugins)`);
    } else if (hasSeedMarker) {
      rmSync(seedMarker, { force: true });
      notes.push(`preserved user-modified plugin ${pluginId} in ${installedDir}`);
    }
  }
  return notes;
}

/** Write what a desktop message says into `dataDir`; returns notes for the log. */
export function applyDesktopMessage(dataDir: string, message: DesktopMessage): string[] {
  const notes: string[] = [];
  const harnessFile = join(dataDir, "harness.json");
  const prevHarness = readHarnessConfig(harnessFile).config;
  const { config, defaultModel } = harnessFromDesktop(message);
  writeJson(harnessFile, config);

  if (existsSync(pluginsStorePath(dataDir))) {
    const flippedSet = new Set<string>(
      HARNESS_TOGGLED_PLUGIN_IDS.filter(
        (id) => pluginEnabledInHarness(prevHarness, id) !== pluginEnabledInHarness(config, id),
      ),
    );
    updatePluginsStore(dataDir, (store) => {
      for (const id of HARNESS_TOGGLED_PLUGIN_IDS) {
        const patch = store.plugins[id];
        if (patch === undefined || patch.enabled === undefined) continue;
        const nextEnabled = pluginEnabledInHarness(config, id);
        if (nextEnabled === undefined) continue;
        if (!flippedSet.has(id) && patch.enabled !== nextEnabled) continue;
        const restKeys = Object.keys(patch).filter((key) => key !== "enabled");
        if (restKeys.length === 0) {
          delete store.plugins[id];
        } else {
          delete patch.enabled;
        }
      }
    });
  }

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

  const desktopExe = message.executable?.trim();
  if (desktopExe) {
    const bundledRoots = resolveDesktopBundledPluginRoots(desktopExe);
    if (bundledRoots.length > 0) {
      notes.push(...cleanupLegacySeededPlugins(dataDir, bundledRoots));
    }
  }
  return notes;
}
