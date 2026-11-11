/**
 * Reads and validates external plugin manifests (`package.json` or bare plugin
 * folders) under `<dataDir>/plugins/*` and trusted `<workspace>/.qianji/plugins/*`
 * (ADR 0016).
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PluginTier } from "@qianji/protocol";

export interface DiscoveredPluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  tier: PluginTier;
  dir: string;
  workspace?: string;
  hostEntry?: string;
  clientEntry?: string;
  assetsDir?: string;
  dshClientCompat: boolean;
  configSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  inject?: string[];
  provides?: string[];
}

const HOST_CANDIDATES = [
  "src/index.ts",
  "src/index.js",
  "src/index.mjs",
  "index.ts",
  "index.js",
  "index.mjs",
  "lib/index.js",
  "lib/index.mjs",
  "dist/index.js",
] as const;

const CLIENT_CANDIDATES = [
  "src/client.tsx",
  "src/client.ts",
  "src/client/index.tsx",
  "src/client/index.ts",
  "client.tsx",
  "client.ts",
  "client.js",
  "lib/client.js",
  "dist/client.js",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a filesystem path on disk so Windows casing, 8.3 short names
 * (e.g. `RUNNER~1` -> `runneradmin`), and junctions compare consistently even
 * when leaf segments do not exist yet.
 */
export function canonicalPath(input: string): string {
  const resolved = resolve(input);
  try {
    return realpathSync.native(resolved);
  } catch {
    const tail: string[] = [];
    let current = resolved;
    while (true) {
      const parent = dirname(current);
      if (parent === current) {
        return resolved;
      }
      tail.unshift(basename(current));
      current = parent;
      try {
        const realParent = realpathSync.native(current);
        return join(realParent, ...tail);
      } catch {
        // Keep walking up until an existing ancestor resolves.
      }
    }
  }
}

export function pathComparisonKey(input: string): string {
  const canonical = canonicalPath(input).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/** Resolve `subpath` inside `rootDir`, refusing anything that escapes `rootDir`. */
export function resolveInsideDir(rootDir: string, subpath: string): string | undefined {
  if (subpath.trim() === "") return undefined;
  const normalizedRoot = canonicalPath(rootDir);
  const rootKey = pathComparisonKey(normalizedRoot);
  const rawCandidate = isAbsolute(subpath)
    ? canonicalPath(subpath)
    : resolve(normalizedRoot, subpath);
  const rel = relative(normalizedRoot, rawCandidate);
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  if (!existsSync(rawCandidate)) return undefined;
  const realCandidate = canonicalPath(rawCandidate);
  const realKey = pathComparisonKey(realCandidate);
  if (realKey !== rootKey && !realKey.startsWith(`${rootKey}/`)) return undefined;
  return realCandidate;
}

function extractExportTarget(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (!isRecord(entry)) return undefined;
  for (const key of ["bun", "import", "default", "browser", "require"]) {
    const candidate = entry[key];
    if (typeof candidate === "string") return candidate;
    if (isRecord(candidate)) {
      const nested = extractExportTarget(candidate);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function isValidPluginId(id: string): boolean {
  if (id.length === 0 || id.length > 128) return false;
  if (id.includes("\0") || id.includes("..") || id.includes("\\")) return false;
  return /^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(id);
}

function isDshEcosystemPackage(pkg: Record<string, unknown>): boolean {
  if (isRecord(pkg.qianji) || isRecord(pkg.pid)) return false;
  if (isRecord(pkg.dsh) || typeof pkg.dsh === "string") return true;
  const name = typeof pkg.name === "string" ? pkg.name : "";
  if (name.startsWith("dsh-") || name.startsWith("@dsh-external/") || name.includes("/dsh-")) return true;
  for (const field of ["dependencies", "peerDependencies"]) {
    const deps = pkg[field];
    if (!isRecord(deps)) continue;
    if (Object.keys(deps).some((dep) => dep === "dsh-better-sidebar" || dep.startsWith("@deepseek-ai/dsh-"))) {
      return true;
    }
  }
  return false;
}

/** Read a single plugin directory into a validated manifest, or throw a descriptive Error. */
export function readPluginManifest(dir: string, tier: PluginTier, workspace?: string): DiscoveredPluginManifest {
  const rootDir = canonicalPath(dir);
  let stat;
  try {
    stat = statSync(rootDir);
  } catch {
    throw new Error(`Plugin directory does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) throw new Error(`Plugin path is not a directory: ${dir}`);

  const pkgPath = join(rootDir, "package.json");
  let pkg: Record<string, unknown> = {};
  if (existsSync(pkgPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      throw new Error(`Invalid JSON in ${pkgPath}`);
    }
    if (!isRecord(parsed)) throw new Error(`${pkgPath} must contain a JSON object`);
    pkg = parsed;
  }

  const pidField = isRecord(pkg.qianji) ? pkg.qianji : isRecord(pkg.pid) ? pkg.pid : undefined;
  const dshField = isRecord(pkg.dsh) ? pkg.dsh : undefined;
  const exportsField = isRecord(pkg.exports) ? pkg.exports : undefined;

  const rawId = typeof pidField?.id === "string" && pidField.id.trim() !== ""
    ? pidField.id.trim()
    : typeof pkg.name === "string" && pkg.name.trim() !== ""
      ? pkg.name.trim()
      : basename(rootDir);

  if (!isValidPluginId(rawId)) {
    throw new Error(`Invalid plugin id "${rawId}" in ${rootDir}`);
  }

  const name = typeof pidField?.name === "string" && pidField.name.trim() !== ""
    ? pidField.name.trim()
    : typeof dshField?.name === "string" && dshField.name.trim() !== ""
      ? dshField.name.trim()
      : typeof pkg.name === "string" && pkg.name.trim() !== ""
        ? pkg.name.trim()
        : rawId;

  const version = typeof pkg.version === "string" && pkg.version.trim() !== "" ? pkg.version.trim() : "0.0.0";
  const description = typeof pidField?.description === "string"
    ? pidField.description
    : typeof pkg.description === "string"
      ? pkg.description
      : undefined;

  const dshCompat = isDshEcosystemPackage(pkg);

  // Resolve host entry. DSH community packages without a `pid.host` declaration
  // run in client-compat mode so DSH-private host services are never required.
  let hostEntry: string | undefined;
  if (pidField?.host === false) {
    hostEntry = undefined;
  } else if (typeof pidField?.host === "string") {
    hostEntry = resolveInsideDir(rootDir, pidField.host);
    if (hostEntry === undefined) throw new Error(`Plugin "${rawId}" host entry not found: ${pidField.host}`);
  } else if (!dshCompat) {
    const exportedRoot = exportsField !== undefined
      ? extractExportTarget(exportsField["."])
      : typeof pkg.exports === "string"
        ? pkg.exports
        : undefined;
    const declaredHost = exportedRoot
      ?? (typeof pkg.module === "string" ? pkg.module : undefined)
      ?? (typeof pkg.main === "string" ? pkg.main : undefined);
    if (declaredHost !== undefined) {
      hostEntry = resolveInsideDir(rootDir, declaredHost);
    } else {
      for (const candidate of HOST_CANDIDATES) {
        const resolved = resolveInsideDir(rootDir, candidate);
        if (resolved !== undefined) {
          hostEntry = resolved;
          break;
        }
      }
    }
  }

  // Resolve client entry (`pid.client`, `dsh.client`, `exports["./client"]`, or standard filenames).
  let clientEntry: string | undefined;
  if (pidField?.client === false) {
    clientEntry = undefined;
  } else if (typeof pidField?.client === "string") {
    clientEntry = resolveInsideDir(rootDir, pidField.client);
    if (clientEntry === undefined) throw new Error(`Plugin "${rawId}" client entry not found: ${pidField.client}`);
  } else {
    const dshClientSpec = typeof dshField?.client === "string"
      ? dshField.client
      : isRecord(dshField?.client) && typeof dshField.client.entry === "string"
        ? dshField.client.entry
        : undefined;
    const exportedClient = exportsField !== undefined ? extractExportTarget(exportsField["./client"]) : undefined;
    const declaredClient = exportedClient ?? dshClientSpec;
    if (declaredClient !== undefined) {
      // `dsh.client: "./client"` may refer to `exports["./client"]` or a file path.
      const viaExport = declaredClient === "./client" && exportedClient !== undefined ? exportedClient : declaredClient;
      clientEntry = resolveInsideDir(rootDir, viaExport)
        ?? resolveInsideDir(rootDir, `${viaExport}.js`)
        ?? resolveInsideDir(rootDir, `${viaExport}.tsx`)
        ?? resolveInsideDir(rootDir, `${viaExport}.ts`)
        ?? resolveInsideDir(rootDir, join(viaExport, "index.js"))
        ?? resolveInsideDir(rootDir, join(viaExport, "index.tsx"))
        ?? resolveInsideDir(rootDir, join(viaExport, "index.ts"));
    }
    if (clientEntry === undefined) {
      for (const candidate of CLIENT_CANDIDATES) {
        const resolved = resolveInsideDir(rootDir, candidate);
        if (resolved !== undefined) {
          clientEntry = resolved;
          break;
        }
      }
    }
  }

  if (hostEntry === undefined && clientEntry === undefined) {
    throw new Error(`Plugin "${rawId}" in ${rootDir} defines neither a host entry nor a client entry`);
  }

  const assetsSpec = typeof pidField?.assets === "string" ? pidField.assets : "assets";
  const resolvedAssets = resolveInsideDir(rootDir, assetsSpec);
  const assetsDir = resolvedAssets !== undefined && statSync(resolvedAssets).isDirectory() ? resolvedAssets : undefined;

  const configSchema = isRecord(pidField?.configSchema) ? pidField.configSchema : undefined;
  const defaultConfig = isRecord(pidField?.defaultConfig) ? pidField.defaultConfig : undefined;
  const inject = Array.isArray(pidField?.inject)
    ? pidField.inject.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : undefined;
  const provides = Array.isArray(pidField?.provides)
    ? pidField.provides.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : undefined;

  return {
    id: rawId,
    name,
    version,
    ...(description === undefined ? {} : { description }),
    tier,
    dir: rootDir,
    ...(workspace === undefined ? {} : { workspace: canonicalPath(workspace) }),
    ...(hostEntry === undefined ? {} : { hostEntry }),
    ...(clientEntry === undefined ? {} : { clientEntry }),
    ...(assetsDir === undefined ? {} : { assetsDir }),
    dshClientCompat: dshCompat,
    ...(configSchema === undefined ? {} : { configSchema }),
    ...(defaultConfig === undefined ? {} : { defaultConfig }),
    ...(inject === undefined || inject.length === 0 ? {} : { inject }),
    ...(provides === undefined || provides.length === 0 ? {} : { provides }),
  };
}

export interface ScanPluginsResult {
  manifests: DiscoveredPluginManifest[];
  errors: Array<{ dir: string; error: string }>;
}

/** Scan all immediate child plugin directories under `pluginsRoot` (for example `<dataDir>/plugins`). */
export function scanPluginsDirectory(pluginsRoot: string, tier: PluginTier, workspace?: string): ScanPluginsResult {
  if (!existsSync(pluginsRoot)) return { manifests: [], errors: [] };
  let entries;
  try {
    entries = readdirSync(pluginsRoot, { withFileTypes: true });
  } catch {
    return { manifests: [], errors: [] };
  }
  const manifests: DiscoveredPluginManifest[] = [];
  const errors: Array<{ dir: string; error: string }> = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullDir = join(pluginsRoot, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory() && !existsSync(join(fullDir, "package.json"))) {
      // Support scoped directory layout `<pluginsRoot>/@scope/<pkg>`.
      const scopedChildren = readdirSync(fullDir, { withFileTypes: true });
      for (const child of scopedChildren) {
        if (child.name.startsWith(".") || !child.isDirectory()) continue;
        const scopedDir = join(fullDir, child.name);
        try {
          manifests.push(readPluginManifest(scopedDir, tier, workspace));
        } catch (error) {
          errors.push({ dir: scopedDir, error: error instanceof Error ? error.message : String(error) });
        }
      }
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      manifests.push(readPluginManifest(fullDir, tier, workspace));
    } catch (error) {
      errors.push({ dir: fullDir, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { manifests, errors };
}
