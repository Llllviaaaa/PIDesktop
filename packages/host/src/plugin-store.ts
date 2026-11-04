/**
 * Persistent user plugin patches (`<dataDir>/plugins.json`) and workspace trust
 * records (`<dataDir>/trusted-workspaces.json`) (ADR 0016).
 *
 * Kept separate from `<dataDir>/harness.json`, which `desktop-settings.ts`
 * rewrites whenever desktop settings change.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginInstallOrigin, WorkspaceTrustEntry, WorkspaceTrustListResult } from "@pid/protocol";
import { canonicalPath, pathComparisonKey, scanPluginsDirectory } from "./plugin-manifest.ts";

export interface StoredPluginPatch {
  enabled?: boolean;
  watch?: boolean;
  config?: Record<string, unknown>;
  /** Present when a `local` plugin is linked in place rather than copied into `<dataDir>/plugins`. */
  linkedDir?: string;
  origin?: PluginInstallOrigin;
}

export interface StoredWorkspacePluginPatch {
  enabled?: boolean;
  watch?: boolean;
  config?: Record<string, unknown>;
}

export interface PluginsStoreData {
  version: 1;
  plugins: Record<string, StoredPluginPatch>;
  workspacePlugins: Record<string, StoredWorkspacePluginPatch>;
}

interface TrustedWorkspacesFile {
  version: 1;
  trusted: WorkspaceTrustEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeJsonAtomically(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

export function pluginsStorePath(dataDir: string): string {
  return join(dataDir, "plugins.json");
}

export function trustedWorkspacesPath(dataDir: string): string {
  return join(dataDir, "trusted-workspaces.json");
}

export function workspacePluginKey(workspace: string, pluginId: string): string {
  return `${pathComparisonKey(workspace)}::${pluginId}`;
}

function sanitizeOrigin(raw: unknown): PluginInstallOrigin | undefined {
  if (!isRecord(raw)) return undefined;
  const channel = raw.channel;
  if (channel !== "local" && channel !== "archive" && channel !== "git" && channel !== "npm") return undefined;
  if (typeof raw.spec !== "string" || typeof raw.installedAt !== "string") return undefined;
  return {
    channel,
    spec: raw.spec,
    installedAt: raw.installedAt,
    ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
  };
}

export function readPluginsStore(dataDir: string): PluginsStoreData {
  const file = pluginsStorePath(dataDir);
  const empty: PluginsStoreData = { version: 1, plugins: {}, workspacePlugins: {} };
  if (!existsSync(file)) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return empty;
  }
  if (!isRecord(parsed)) return empty;

  const plugins: Record<string, StoredPluginPatch> = {};
  if (isRecord(parsed.plugins)) {
    for (const [id, entry] of Object.entries(parsed.plugins)) {
      if (!isRecord(entry)) continue;
      const origin = sanitizeOrigin(entry.origin);
      plugins[id] = {
        ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
        ...(typeof entry.watch === "boolean" ? { watch: entry.watch } : {}),
        ...(isRecord(entry.config) ? { config: entry.config } : {}),
        ...(typeof entry.linkedDir === "string" && entry.linkedDir.trim() !== "" ? { linkedDir: entry.linkedDir } : {}),
        ...(origin === undefined ? {} : { origin }),
      };
    }
  }

  const workspacePlugins: Record<string, StoredWorkspacePluginPatch> = {};
  if (isRecord(parsed.workspacePlugins)) {
    for (const [key, entry] of Object.entries(parsed.workspacePlugins)) {
      if (!isRecord(entry)) continue;
      workspacePlugins[key] = {
        ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
        ...(typeof entry.watch === "boolean" ? { watch: entry.watch } : {}),
        ...(isRecord(entry.config) ? { config: entry.config } : {}),
      };
    }
  }

  return { version: 1, plugins, workspacePlugins };
}

export function writePluginsStore(dataDir: string, store: PluginsStoreData): void {
  writeJsonAtomically(pluginsStorePath(dataDir), store);
}

export function updatePluginsStore(dataDir: string, mutator: (draft: PluginsStoreData) => void): PluginsStoreData {
  const store = readPluginsStore(dataDir);
  mutator(store);
  writePluginsStore(dataDir, store);
  return store;
}

export function listTrustedWorkspaces(dataDir: string): WorkspaceTrustEntry[] {
  const file = trustedWorkspacesPath(dataDir);
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.trusted)) return [];
  const entries: WorkspaceTrustEntry[] = [];
  const seen = new Set<string>();
  for (const item of parsed.trusted) {
    if (!isRecord(item) || typeof item.path !== "string" || typeof item.trustedAt !== "string") continue;
    const normalized = canonicalPath(item.path);
    const key = pathComparisonKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ path: normalized, trustedAt: item.trustedAt });
  }
  return entries;
}

export function isWorkspaceTrusted(dataDir: string, workspacePath: string): boolean {
  const targetKey = pathComparisonKey(workspacePath);
  return listTrustedWorkspaces(dataDir).some((entry) => pathComparisonKey(entry.path) === targetKey);
}

export function setWorkspaceTrust(dataDir: string, workspacePath: string, trusted: boolean): WorkspaceTrustEntry[] {
  const normalized = canonicalPath(workspacePath);
  const targetKey = pathComparisonKey(normalized);
  const existing = listTrustedWorkspaces(dataDir).filter((entry) => pathComparisonKey(entry.path) !== targetKey);
  if (trusted) {
    existing.push({ path: normalized, trustedAt: new Date().toISOString() });
  }
  const payload: TrustedWorkspacesFile = { version: 1, trusted: existing };
  writeJsonAtomically(trustedWorkspacesPath(dataDir), payload);
  return existing;
}

export function inspectWorkspaceTrust(dataDir: string, workspacePath?: string): WorkspaceTrustListResult {
  const trusted = listTrustedWorkspaces(dataDir);
  if (workspacePath === undefined || workspacePath.trim() === "") {
    return { trusted };
  }
  const normalized = canonicalPath(workspacePath);
  const targetKey = pathComparisonKey(normalized);
  const isTrusted = trusted.some((entry) => pathComparisonKey(entry.path) === targetKey);
  const pluginsDir = join(normalized, ".pid", "plugins");
  const configPath = join(normalized, ".pid", "harness.json");
  const scanned = scanPluginsDirectory(pluginsDir, "workspace", normalized);
  return {
    trusted,
    current: {
      workspace: normalized,
      trusted: isTrusted,
      hasProjectPlugins: scanned.manifests.length > 0 || scanned.errors.length > 0,
      hasProjectConfig: existsSync(configPath),
      pluginIds: scanned.manifests.map((manifest) => manifest.id),
    },
  };
}
