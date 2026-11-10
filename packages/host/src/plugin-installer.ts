/**
 * Multi-channel plugin installer and updater (`local`, `archive`, `git`, `npm`)
 * for `<dataDir>/plugins` (ADR 0016).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PluginInstallOrigin, PluginInstallParams } from "@qianji/protocol";
import { HOST_SHARED_MODULES } from "./plugin-bridge.ts";
import { canonicalPath, readPluginManifest, type DiscoveredPluginManifest } from "./plugin-manifest.ts";
import { readPluginsStore, updatePluginsStore } from "./plugin-store.ts";

export interface InstalledPluginRecord {
  manifest: DiscoveredPluginManifest;
  origin: PluginInstallOrigin;
  watch: boolean;
}

export function managedPluginsRoot(dataDir: string): string {
  return join(dataDir, "plugins");
}

export function managedPluginDirName(pluginId: string): string {
  return pluginId.replace(/^@/, "at-").replace(/[^a-zA-Z0-9._-]+/g, "__");
}

function makeStagingDir(dataDir: string): string {
  const root = managedPluginsRoot(dataDir);
  mkdirSync(root, { recursive: true });
  const dir = join(root, `.staging-${Date.now()}-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function atomicReplaceDir(sourceDir: string, targetDir: string): void {
  mkdirSync(dirname(targetDir), { recursive: true });
  const backupDir = `${targetDir}.bak-${Date.now()}`;
  if (existsSync(targetDir)) {
    renameSync(targetDir, backupDir);
  }
  try {
    renameSync(sourceDir, targetDir);
  } catch (error) {
    if (existsSync(backupDir) && !existsSync(targetDir)) {
      renameSync(backupDir, targetDir);
    }
    throw error;
  }
  rmSync(backupDir, { recursive: true, force: true });
}

export function validateArchiveEntries(entriesOutput: string): void {
  const lines = entriesOutput.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 0) throw new Error("Archive is empty");
  for (const rawEntry of lines) {
    const normalized = rawEntry.replace(/\\/g, "/");
    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.includes("\0")) {
      throw new Error(`Unsafe archive entry path: ${rawEntry}`);
    }
    const segments = normalized.split("/");
    if (segments.some((segment) => segment === "..")) {
      throw new Error(`Path traversal detected in archive entry: ${rawEntry}`);
    }
  }
}

function assertNoEscapingLinks(rootDir: string, currentDir: string = rootDir): void {
  const canonicalRoot = canonicalPath(rootDir);
  for (const item of readdirSync(currentDir)) {
    const full = join(currentDir, item);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      const target = canonicalPath(full);
      const rel = relative(canonicalRoot, target);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Archive contains a symbolic link escaping the plugin root: ${item}`);
      }
      continue;
    }
    if (stat.isDirectory()) {
      assertNoEscapingLinks(rootDir, full);
    }
  }
}

function unwrapSingleTopDirectory(extractDir: string): string {
  if (existsSync(join(extractDir, "package.json"))) return extractDir;
  const children = readdirSync(extractDir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
  if (children.length === 1 && children[0] !== undefined && children[0].isDirectory()) {
    return join(extractDir, children[0].name);
  }
  return extractDir;
}

function resolveBunCommand(): { command: string; env: NodeJS.ProcessEnv } {
  if (typeof (process.versions as Record<string, string | undefined>).bun === "string") {
    return {
      command: process.execPath,
      env: { ...process.env, BUN_BE_BUN: "1" },
    };
  }
  // Node test / dev fallback: locate the workspace's pinned bun binary.
  let cursor = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(cursor, "node_modules", "bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
    if (existsSync(candidate)) {
      return { command: candidate, env: { ...process.env } };
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { command: process.platform === "win32" ? "bun.exe" : "bun", env: { ...process.env } };
}

function runChecked(command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; label: string }): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.error) {
    throw new Error(`${options.label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${options.label} exited with code ${result.status}${detail !== "" ? `: ${detail}` : ""}`);
  }
  return result.stdout ?? "";
}

function installExternalDependenciesIfNeeded(pluginDir: string): void {
  const pkgPath = join(pluginDir, "package.json");
  if (!existsSync(pkgPath) || existsSync(join(pluginDir, "node_modules"))) return;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const rawDeps = pkg.dependencies;
  if (typeof rawDeps !== "object" || rawDeps === null || Array.isArray(rawDeps)) return;
  const externalDeps = Object.keys(rawDeps).filter((dep) => !(dep in HOST_SHARED_MODULES) && !dep.startsWith("@deepseek-ai/dsh-"));
  if (externalDeps.length === 0) return;

  const bun = resolveBunCommand();
  runChecked(bun.command, ["install", "--production", "--ignore-scripts"], {
    cwd: pluginDir,
    env: bun.env,
    label: "bun install",
  });
}

export function parseGitSpec(spec: string): { url: string; ref?: string } {
  const trimmed = spec.trim();
  const githubMatch = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#(.+))?$/.exec(trimmed);
  if (githubMatch !== null && githubMatch[1] !== undefined) {
    return {
      url: `https://github.com/${githubMatch[1]}.git`,
      ...(githubMatch[2] !== undefined && githubMatch[2] !== "" ? { ref: githubMatch[2] } : {}),
    };
  }
  const cleaned = trimmed.startsWith("git+") ? trimmed.slice("git+".length) : trimmed;
  const hashIndex = cleaned.indexOf("#");
  if (hashIndex >= 0 && !existsSync(cleaned)) {
    const url = cleaned.slice(0, hashIndex);
    const ref = cleaned.slice(hashIndex + 1);
    return { url, ...(ref !== "" ? { ref } : {}) };
  }
  return { url: cleaned };
}

function installFromLocal(dataDir: string, spec: string, link: boolean, watchFlag?: boolean): InstalledPluginRecord {
  const sourceDir = canonicalPath(spec);
  const manifest = readPluginManifest(sourceDir, "user");
  const now = new Date().toISOString();
  const origin: PluginInstallOrigin = { channel: "local", spec: sourceDir, installedAt: now };

  if (link) {
    const watch = watchFlag ?? true;
    updatePluginsStore(dataDir, (store) => {
      const prev = store.plugins[manifest.id];
      store.plugins[manifest.id] = {
        ...prev,
        enabled: true,
        watch,
        linkedDir: sourceDir,
        origin,
      };
    });
    return { manifest, origin, watch };
  }

  const staging = makeStagingDir(dataDir);
  try {
    cpSync(sourceDir, staging, {
      recursive: true,
      filter: (src) => {
        const rel = relative(sourceDir, src).replace(/\\/g, "/");
        return rel !== ".git" && !rel.startsWith(".git/");
      },
    });
    const validated = readPluginManifest(staging, "user");
    const dest = join(managedPluginsRoot(dataDir), managedPluginDirName(validated.id));
    atomicReplaceDir(staging, dest);
    const finalManifest = readPluginManifest(dest, "user");
    const watch = watchFlag ?? false;
    updatePluginsStore(dataDir, (store) => {
      const prev = store.plugins[finalManifest.id];
      const next = { ...prev, enabled: true, watch, origin };
      delete next.linkedDir;
      store.plugins[finalManifest.id] = next;
    });
    return { manifest: finalManifest, origin, watch };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function installFromArchive(dataDir: string, spec: string, watchFlag?: boolean): InstalledPluginRecord {
  const archivePath = resolve(spec);
  if (!existsSync(archivePath)) throw new Error(`Archive file does not exist: ${spec}`);

  const staging = makeStagingDir(dataDir);
  try {
    const extractRoot = join(staging, "extracted");
    mkdirSync(extractRoot, { recursive: true });
    const listing = runChecked("tar", ["-tf", archivePath], { label: "tar list" });
    validateArchiveEntries(listing);
    runChecked("tar", ["-xf", archivePath, "-C", extractRoot], { label: "tar extract" });
    assertNoEscapingLinks(extractRoot);

    const unwrapped = unwrapSingleTopDirectory(extractRoot);
    installExternalDependenciesIfNeeded(unwrapped);
    const validated = readPluginManifest(unwrapped, "user");
    const dest = join(managedPluginsRoot(dataDir), managedPluginDirName(validated.id));
    atomicReplaceDir(unwrapped, dest);
    const finalManifest = readPluginManifest(dest, "user");
    const origin: PluginInstallOrigin = {
      channel: "archive",
      spec: archivePath,
      installedAt: new Date().toISOString(),
    };
    const watch = watchFlag ?? false;
    updatePluginsStore(dataDir, (store) => {
      const prev = store.plugins[finalManifest.id];
      const next = { ...prev, enabled: true, watch, origin };
      delete next.linkedDir;
      store.plugins[finalManifest.id] = next;
    });
    return { manifest: finalManifest, origin, watch };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function installFromGit(dataDir: string, spec: string, watchFlag?: boolean, previousInstalledAt?: string): InstalledPluginRecord {
  const { url, ref } = parseGitSpec(spec);
  const staging = makeStagingDir(dataDir);
  try {
    const cloneDir = join(staging, "repo");
    const args = ["clone", "--depth", "1", ...(ref !== undefined ? ["--branch", ref] : []), "--", url, cloneDir];
    runChecked("git", args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      label: "git clone",
    });
    installExternalDependenciesIfNeeded(cloneDir);
    const validated = readPluginManifest(cloneDir, "user");
    const dest = join(managedPluginsRoot(dataDir), managedPluginDirName(validated.id));
    atomicReplaceDir(cloneDir, dest);
    const finalManifest = readPluginManifest(dest, "user");
    const now = new Date().toISOString();
    const origin: PluginInstallOrigin = {
      channel: "git",
      spec,
      installedAt: previousInstalledAt ?? now,
      ...(previousInstalledAt !== undefined ? { updatedAt: now } : {}),
    };
    const watch = watchFlag ?? false;
    updatePluginsStore(dataDir, (store) => {
      const prev = store.plugins[finalManifest.id];
      const next = { ...prev, enabled: true, watch, origin };
      delete next.linkedDir;
      store.plugins[finalManifest.id] = next;
    });
    return { manifest: finalManifest, origin, watch };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function installFromNpm(dataDir: string, spec: string, watchFlag?: boolean, previousInstalledAt?: string): InstalledPluginRecord {
  const trimmed = spec.trim();
  if (trimmed === "") throw new Error("npm package specifier is required");

  const staging = makeStagingDir(dataDir);
  try {
    const wrapperDir = join(staging, "wrapper");
    mkdirSync(wrapperDir, { recursive: true });
    writeFileSync(join(wrapperDir, "package.json"), `${JSON.stringify({ name: "qianji-plugin-stage", private: true }, null, 2)}\n`, "utf8");

    const bun = resolveBunCommand();
    runChecked(bun.command, ["add", "--ignore-scripts", trimmed], {
      cwd: wrapperDir,
      env: bun.env,
      label: `bun add ${trimmed}`,
    });

    const wrapperPkg = JSON.parse(readFileSync(join(wrapperDir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const installedNames = Object.keys(wrapperPkg.dependencies ?? {});
    const pkgName = installedNames[0];
    if (pkgName === undefined) {
      throw new Error(`Could not determine installed package name for "${trimmed}"`);
    }
    const installedPkgDir = join(wrapperDir, "node_modules", ...pkgName.split("/"));
    if (!existsSync(installedPkgDir)) {
      throw new Error(`Installed package directory missing: ${installedPkgDir}`);
    }

    const assembledDir = join(staging, "assembled");
    cpSync(installedPkgDir, assembledDir, { recursive: true, dereference: true });

    // Carry over transitive dependencies installed beside the target package.
    const wrapperNodeModules = join(wrapperDir, "node_modules");
    const targetNodeModules = join(assembledDir, "node_modules");
    mkdirSync(targetNodeModules, { recursive: true });
    for (const entry of readdirSync(wrapperNodeModules, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === pkgName) continue;
      if (pkgName.startsWith("@") && entry.name === pkgName.split("/")[0]) {
        const scopeSrc = join(wrapperNodeModules, entry.name);
        const scopeDst = join(targetNodeModules, entry.name);
        mkdirSync(scopeDst, { recursive: true });
        for (const scoped of readdirSync(scopeSrc)) {
          if (`${entry.name}/${scoped}` === pkgName) continue;
          cpSync(join(scopeSrc, scoped), join(scopeDst, scoped), { recursive: true, dereference: true });
        }
        continue;
      }
      cpSync(join(wrapperNodeModules, entry.name), join(targetNodeModules, entry.name), { recursive: true, dereference: true });
    }

    const validated = readPluginManifest(assembledDir, "user");
    const dest = join(managedPluginsRoot(dataDir), managedPluginDirName(validated.id));
    atomicReplaceDir(assembledDir, dest);
    const finalManifest = readPluginManifest(dest, "user");
    const now = new Date().toISOString();
    const origin: PluginInstallOrigin = {
      channel: "npm",
      spec: trimmed,
      installedAt: previousInstalledAt ?? now,
      ...(previousInstalledAt !== undefined ? { updatedAt: now } : {}),
    };
    const watch = watchFlag ?? false;
    updatePluginsStore(dataDir, (store) => {
      const prev = store.plugins[finalManifest.id];
      const next = { ...prev, enabled: true, watch, origin };
      delete next.linkedDir;
      store.plugins[finalManifest.id] = next;
    });
    return { manifest: finalManifest, origin, watch };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function installPlugin(dataDir: string, params: PluginInstallParams): InstalledPluginRecord {
  switch (params.channel) {
    case "local":
      return installFromLocal(dataDir, params.spec, params.link !== false, params.watch);
    case "archive":
      return installFromArchive(dataDir, params.spec, params.watch);
    case "git":
      return installFromGit(dataDir, params.spec, params.watch);
    case "npm":
      return installFromNpm(dataDir, params.spec, params.watch);
  }
}

export function updateInstalledPlugin(dataDir: string, pluginId: string): InstalledPluginRecord {
  const store = readPluginsStore(dataDir);
  const patch = store.plugins[pluginId];
  const origin = patch?.origin;
  if (origin === undefined) {
    throw new Error(`Plugin "${pluginId}" has no recorded installation source to update from`);
  }
  switch (origin.channel) {
    case "git": {
      const managedDir = join(managedPluginsRoot(dataDir), managedPluginDirName(pluginId));
      if (existsSync(join(managedDir, ".git"))) {
        runChecked("git", ["-C", managedDir, "pull", "--ff-only"], {
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          label: `git pull (${pluginId})`,
        });
        installExternalDependenciesIfNeeded(managedDir);
        const manifest = readPluginManifest(managedDir, "user");
        const updatedOrigin: PluginInstallOrigin = { ...origin, updatedAt: new Date().toISOString() };
        updatePluginsStore(dataDir, (draft) => {
          const current = draft.plugins[pluginId];
          draft.plugins[pluginId] = { ...current, origin: updatedOrigin };
        });
        return { manifest, origin: updatedOrigin, watch: patch?.watch === true };
      }
      return installFromGit(dataDir, origin.spec, patch?.watch, origin.installedAt);
    }
    case "npm":
      return installFromNpm(dataDir, origin.spec, patch?.watch, origin.installedAt);
    case "local": {
      if (patch?.linkedDir !== undefined) {
        const manifest = readPluginManifest(patch.linkedDir, "user");
        const updatedOrigin: PluginInstallOrigin = { ...origin, updatedAt: new Date().toISOString() };
        updatePluginsStore(dataDir, (draft) => {
          const current = draft.plugins[pluginId];
          draft.plugins[pluginId] = { ...current, origin: updatedOrigin };
        });
        return { manifest, origin: updatedOrigin, watch: patch.watch === true };
      }
      return installFromLocal(dataDir, origin.spec, false, patch?.watch);
    }
    case "archive":
      return installFromArchive(dataDir, origin.spec, patch?.watch);
  }
}

export function removeUserPluginFiles(dataDir: string, pluginId: string, discoveredDir?: string): void {
  const store = readPluginsStore(dataDir);
  const patch = store.plugins[pluginId];
  const isLinked = patch?.linkedDir !== undefined;

  updatePluginsStore(dataDir, (draft) => {
    delete draft.plugins[pluginId];
  });

  if (isLinked) {
    // Linked local directories belong to the user; never delete their contents.
    return;
  }

  const managedRoot = canonicalPath(managedPluginsRoot(dataDir));
  const candidates = [
    join(managedPluginsRoot(dataDir), managedPluginDirName(pluginId)),
    ...(discoveredDir !== undefined ? [discoveredDir] : []),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const real = canonicalPath(dir);
    const rel = relative(managedRoot, real);
    if (!rel.startsWith("..") && !isAbsolute(rel) && rel !== "") {
      rmSync(real, { recursive: true, force: true });
    }
  }
}
