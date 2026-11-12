/**
 * Candidate resolution of the plugin manager (plugin-manager.ts, ADR 0016):
 * discovers built-in, bundled, user and trusted-workspace plugins and merges
 * the tiers (`workspace` > `user` > `builtin`) into one candidate per id,
 * with its effective config from plugins.json. Reads the disk; mounts nothing.
 */
import type { Plugin } from "@deepseek-ai/cordis";
import { extractPluginDependencyMeta } from "@qianji/kernel";
import type { PluginInstallOrigin, PluginTier } from "@qianji/protocol";
import type { BuiltinPluginDefinition } from "./agent-plugins.ts";
import { managedPluginsRoot } from "./plugin-installer.ts";
import { pathComparisonKey, readPluginManifest, scanPluginsDirectory, type DiscoveredPluginManifest } from "./plugin-manifest.ts";
import { readPluginsStore, resolveWorkspacePluginsDir, workspacePluginKey } from "./plugin-store.ts";
import { errorMessage, isRecord } from "./plugin-util.ts";

export interface ResolvedCandidate {
  id: string;
  name: string;
  version: string;
  description?: string;
  tier: PluginTier;
  enabled: boolean;
  canDisable: boolean;
  overridesBuiltin: boolean;
  removable: boolean;
  hasHost: boolean;
  hasClient: boolean;
  watch: boolean;
  dir?: string;
  workspace?: string;
  workspaceKey?: string;
  hostEntry?: string;
  clientEntry?: string;
  assetsDir?: string;
  origin?: PluginInstallOrigin;
  builtinPlugin?: Plugin;
  effectiveConfig?: unknown;
  publicConfig?: Record<string, unknown>;
  configSchema?: Record<string, unknown>;
  manifestError?: string;
  inject: string[];
  provides: string[];
}

export interface CandidateInputs {
  dataDir: string;
  /** The Host version, reported for built-in plugins. */
  version: string;
  builtins: readonly BuiltinPluginDefinition[];
  bundledPluginsDirs: readonly string[];
  /** The active workspace when it is trusted; its plugins are discovered only then. */
  trustedWorkspace?: string;
  warn(format: string, ...args: unknown[]): void;
}

/** One candidate per plugin id, in mount-independent order: workspace, user, broken, built-in, bundled. */
export function resolveCandidates(inputs: CandidateInputs): ResolvedCandidate[] {
  const builtins = inputs.builtins;
  const builtinsById = new Map(builtins.map((entry) => [entry.id, entry]));
  const bundledById = new Map<string, DiscoveredPluginManifest>();
  for (const bundledRoot of inputs.bundledPluginsDirs) {
    const scanned = scanPluginsDirectory(bundledRoot, "builtin");
    for (const manifest of scanned.manifests) {
      if (!builtinsById.has(manifest.id) && !bundledById.has(manifest.id)) {
        bundledById.set(manifest.id, manifest);
      }
    }
    for (const scanErr of scanned.errors) {
      inputs.warn("skipping invalid bundled plugin %s: %s", scanErr.dir, scanErr.error);
    }
  }
  const hasBuiltinId = (id: string): boolean => builtinsById.has(id) || bundledById.has(id);
  const store = readPluginsStore(inputs.dataDir);

  // 1. Discover user plugins (`<dataDir>/plugins/*` + linked local dirs in `plugins.json`).
  const userById = new Map<string, DiscoveredPluginManifest>();
  const manifestErrors = new Map<string, { tier: PluginTier; dir: string; message: string }>();

  const managedScan = scanPluginsDirectory(managedPluginsRoot(inputs.dataDir), "user");
  for (const manifest of managedScan.manifests) {
    userById.set(manifest.id, manifest);
  }
  for (const scanErr of managedScan.errors) {
    inputs.warn("skipping invalid plugin dir %s: %s", scanErr.dir, scanErr.error);
  }

  for (const [id, patch] of Object.entries(store.plugins)) {
    if (patch.linkedDir === undefined) continue;
    try {
      const manifest = readPluginManifest(patch.linkedDir, "user");
      userById.set(manifest.id, manifest);
    } catch (error) {
      manifestErrors.set(id, { tier: "user", dir: patch.linkedDir, message: errorMessage(error) });
    }
  }

  // 2. Discover workspace plugins strictly from the SINGLE active trusted workspace.
  const workspaceById = new Map<string, DiscoveredPluginManifest>();
  if (inputs.trustedWorkspace !== undefined) {
    const scanned = scanPluginsDirectory(resolveWorkspacePluginsDir(inputs.trustedWorkspace), "workspace", inputs.trustedWorkspace);
    for (const manifest of scanned.manifests) {
      workspaceById.set(manifest.id, manifest);
    }
    for (const scanErr of scanned.errors) {
      inputs.warn("skipping invalid workspace plugin %s: %s", scanErr.dir, scanErr.error);
    }
  }

  // 3. Merge tiers (`workspace` > `user` > `builtin`).
  const allIds: string[] = [];
  const seenIds = new Set<string>();
  const pushId = (id: string): void => {
    if (seenIds.has(id)) return;
    seenIds.add(id);
    allIds.push(id);
  };
  for (const id of [...workspaceById.keys()].sort()) pushId(id);
  for (const id of [...userById.keys()].sort()) pushId(id);
  for (const id of [...manifestErrors.keys()].sort()) pushId(id);
  for (const builtin of builtins) pushId(builtin.id);
  for (const id of [...bundledById.keys()].sort()) pushId(id);

  const candidates: ResolvedCandidate[] = [];
  for (const id of allIds) {
    const protectedBuiltin = builtinsById.get(id);
    if (protectedBuiltin !== undefined && protectedBuiltin.canDisable === false) {
      const depMeta = extractPluginDependencyMeta(protectedBuiltin.plugin, {
        ...(protectedBuiltin.inject === undefined ? {} : { inject: protectedBuiltin.inject }),
        ...(protectedBuiltin.provides === undefined ? {} : { provides: protectedBuiltin.provides }),
      });
      candidates.push({
        id: protectedBuiltin.id,
        name: protectedBuiltin.name,
        version: inputs.version,
        description: protectedBuiltin.description,
        tier: "builtin",
        enabled: true,
        canDisable: false,
        overridesBuiltin: false,
        removable: false,
        hasHost: protectedBuiltin.hasHost,
        hasClient: protectedBuiltin.hasClient,
        watch: false,
        builtinPlugin: protectedBuiltin.plugin,
        effectiveConfig: protectedBuiltin.config,
        inject: depMeta.inject,
        provides: depMeta.provides,
      });
      continue;
    }

    const wsManifest = workspaceById.get(id);
    if (wsManifest !== undefined && wsManifest.workspace !== undefined) {
      const wsPatch = store.workspacePlugins[workspacePluginKey(wsManifest.workspace, id)];
      const mergedConfig = { ...(wsManifest.defaultConfig ?? {}), ...(wsPatch?.config ?? {}) };
      candidates.push({
        id,
        name: wsManifest.name,
        version: wsManifest.version,
        ...(wsManifest.description === undefined ? {} : { description: wsManifest.description }),
        tier: "workspace",
        enabled: wsPatch?.enabled !== false,
        canDisable: true,
        overridesBuiltin: hasBuiltinId(id),
        removable: false,
        hasHost: wsManifest.hostEntry !== undefined,
        hasClient: wsManifest.clientEntry !== undefined,
        watch: wsPatch?.watch ?? true,
        dir: wsManifest.dir,
        workspace: wsManifest.workspace,
        workspaceKey: pathComparisonKey(wsManifest.workspace),
        ...(wsManifest.hostEntry === undefined ? {} : { hostEntry: wsManifest.hostEntry }),
        ...(wsManifest.clientEntry === undefined ? {} : { clientEntry: wsManifest.clientEntry }),
        ...(wsManifest.assetsDir === undefined ? {} : { assetsDir: wsManifest.assetsDir }),
        effectiveConfig: mergedConfig,
        publicConfig: mergedConfig,
        ...(wsManifest.configSchema === undefined ? {} : { configSchema: wsManifest.configSchema }),
        inject: [...(wsManifest.inject ?? [])],
        provides: [...(wsManifest.provides ?? [])],
      });
      continue;
    }

    const userManifest = userById.get(id);
    if (userManifest !== undefined) {
      const patch = store.plugins[id];
      const mergedConfig = { ...(userManifest.defaultConfig ?? {}), ...(patch?.config ?? {}) };
      candidates.push({
        id,
        name: userManifest.name,
        version: userManifest.version,
        ...(userManifest.description === undefined ? {} : { description: userManifest.description }),
        tier: "user",
        enabled: patch?.enabled !== false,
        canDisable: true,
        overridesBuiltin: hasBuiltinId(id),
        removable: true,
        hasHost: userManifest.hostEntry !== undefined,
        hasClient: userManifest.clientEntry !== undefined,
        watch: patch?.watch === true,
        dir: userManifest.dir,
        ...(userManifest.hostEntry === undefined ? {} : { hostEntry: userManifest.hostEntry }),
        ...(userManifest.clientEntry === undefined ? {} : { clientEntry: userManifest.clientEntry }),
        ...(userManifest.assetsDir === undefined ? {} : { assetsDir: userManifest.assetsDir }),
        ...(patch?.origin === undefined ? {} : { origin: patch.origin }),
        effectiveConfig: mergedConfig,
        publicConfig: mergedConfig,
        ...(userManifest.configSchema === undefined ? {} : { configSchema: userManifest.configSchema }),
        inject: [...(userManifest.inject ?? [])],
        provides: [...(userManifest.provides ?? [])],
      });
      continue;
    }

    const broken = manifestErrors.get(id);
    if (broken !== undefined) {
      const patch = store.plugins[id];
      candidates.push({
        id,
        name: id,
        version: "0.0.0",
        tier: broken.tier,
        enabled: patch?.enabled !== false,
        canDisable: true,
        overridesBuiltin: hasBuiltinId(id),
        removable: true,
        hasHost: false,
        hasClient: false,
        watch: patch?.watch === true,
        dir: broken.dir,
        ...(patch?.origin === undefined ? {} : { origin: patch.origin }),
        manifestError: broken.message,
        inject: [],
        provides: [],
      });
      continue;
    }

    const builtin = builtinsById.get(id);
    if (builtin !== undefined) {
      const patch = store.plugins[id];
      const canDisable = builtin.canDisable !== false;
      const enabled = canDisable ? (patch?.enabled ?? builtin.enabled) : true;
      const effectiveConfig = patch?.config !== undefined
        ? (isRecord(builtin.config) ? { ...builtin.config, ...patch.config } : patch.config)
        : builtin.config;
      const depMeta = extractPluginDependencyMeta(builtin.plugin, {
        ...(builtin.inject === undefined ? {} : { inject: builtin.inject }),
        ...(builtin.provides === undefined ? {} : { provides: builtin.provides }),
      });
      candidates.push({
        id: builtin.id,
        name: builtin.name,
        version: inputs.version,
        description: builtin.description,
        tier: "builtin",
        enabled,
        canDisable,
        overridesBuiltin: false,
        removable: patch !== undefined,
        hasHost: builtin.hasHost,
        hasClient: builtin.hasClient,
        watch: false,
        builtinPlugin: builtin.plugin,
        effectiveConfig,
        ...(patch?.config === undefined ? {} : { publicConfig: patch.config }),
        inject: depMeta.inject,
        provides: depMeta.provides,
      });
      continue;
    }

    const bundledManifest = bundledById.get(id);
    if (bundledManifest !== undefined) {
      const patch = store.plugins[id];
      const mergedConfig = { ...(bundledManifest.defaultConfig ?? {}), ...(patch?.config ?? {}) };
      candidates.push({
        id,
        name: bundledManifest.name,
        version: bundledManifest.version,
        ...(bundledManifest.description === undefined ? {} : { description: bundledManifest.description }),
        tier: "builtin",
        enabled: patch?.enabled !== false,
        canDisable: true,
        overridesBuiltin: false,
        removable: patch !== undefined,
        hasHost: bundledManifest.hostEntry !== undefined,
        hasClient: bundledManifest.clientEntry !== undefined,
        watch: false,
        dir: bundledManifest.dir,
        ...(bundledManifest.hostEntry === undefined ? {} : { hostEntry: bundledManifest.hostEntry }),
        ...(bundledManifest.clientEntry === undefined ? {} : { clientEntry: bundledManifest.clientEntry }),
        ...(bundledManifest.assetsDir === undefined ? {} : { assetsDir: bundledManifest.assetsDir }),
        effectiveConfig: mergedConfig,
        publicConfig: mergedConfig,
        ...(bundledManifest.configSchema === undefined ? {} : { configSchema: bundledManifest.configSchema }),
        inject: [...(bundledManifest.inject ?? [])],
        provides: [...(bundledManifest.provides ?? [])],
      });
    }
  }
  return candidates;
}
