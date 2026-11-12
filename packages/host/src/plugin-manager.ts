/**
 * Coordinates built-in plugins, user global plugins (`<dataDir>/plugins`),
 * and active workspace-trusted project plugins (`<workspace>/.qianji/plugins`) with:
 * - dependency-aware topological mount & reverse-topological teardown (`@qianji/kernel`),
 * - true Cordis `FiberState` readiness reporting (`active` vs `pending` on unmet `inject`),
 * - isolated child Cordis scopes per active workspace (`WorkspacePluginScope`), and
 * - fiber-isolated fault tolerance with transactional HMR rollback (ADR 0016).
 */
import { existsSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context, Plugin } from "@deepseek-ai/cordis";
import {
  WorkspacePluginScope,
  extractPluginDependencyMeta,
  inspectCordisFiber,
  onCordisFiberStatusChange,
  reverseTopologicalOrder,
  topologicalSortPlugins,
} from "@qianji/kernel";
import {
  redactSensitiveText,
  type PluginChangedNotification,
  type PluginClientBundleResult,
  type PluginClientError,
  type PluginInfo,
  type PluginInstallOrigin,
  type PluginInstallParams,
  type PluginMutationResult,
  type PluginStatus,
  type PluginTier,
  type WorkspaceTrustChangedNotification,
  type WorkspaceTrustListResult,
} from "@qianji/protocol";
import "@qianji/ui";
import type { BuiltinPluginDefinition } from "./agent-plugins.ts";
import { ClientBundleRegistry, createPluginsHttpHandler, type ClientRouteTarget } from "./client-bundles.ts";
import { importExternalModule, installHostModuleBridge } from "./plugin-bridge.ts";
import { installPlugin, managedPluginsRoot, removeUserPluginFiles, updateInstalledPlugin } from "./plugin-installer.ts";
import {
  canonicalPath,
  pathComparisonKey,
  readPluginManifest,
  scanPluginsDirectory,
  type DiscoveredPluginManifest,
} from "./plugin-manifest.ts";
import {
  inspectWorkspaceTrust,
  resolveWorkspacePluginsDir,
  isWorkspaceTrusted,
  readPluginsStore,
  setWorkspaceTrust,
  updatePluginsStore,
  workspacePluginKey,
} from "./plugin-store.ts";
import "./web-server.ts";

export interface PluginManagerOptions {
  dataDir: string;
  version: string;
  builtins?: (activeTrustedWorkspace?: string) => readonly BuiltinPluginDefinition[];
  /** Optional read-only directories scanned as `builtin` tier (e.g. `resources/harness/bundled-plugins`). */
  bundledPluginsDirs?: readonly string[] | (() => readonly string[]);
  onChanged?: (notification: PluginChangedNotification) => void;
  onTrustChanged?: (notification: WorkspaceTrustChangedNotification) => void;
}

interface MountedFiber {
  id: string;
  tier: PluginTier;
  workspaceKey?: string;
  sourceKey: string;
  signature: string;
  plugin?: Plugin;
  config: unknown;
  fiber?: { dispose(): unknown };
  ctx: Context;
  inject: string[];
  provides: string[];
}

interface ResolvedCandidate {
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

interface PreparedCandidate {
  candidate: ResolvedCandidate;
  sourceKey: string;
  signature: string;
  needsMount: boolean;
  skippedDueToError: boolean;
  pluginToMount?: Plugin;
  clientEtag?: string;
}

interface WatcherEntry {
  dir: string;
  watcher: FSWatcher;
  timer?: ReturnType<typeof setTimeout>;
}

const WATCH_DEBOUNCE_MS = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function signatureOf(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, item: unknown) => (typeof item === "function" ? "[function]" : item));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorDetailWithStack(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message || error.name || "Error";
    const rawStack = error.stack?.trim();
    if (rawStack !== undefined && rawStack !== "") {
      const combined = rawStack.includes(msg) ? rawStack : `${error.name || "Error"}: ${msg}\n${rawStack}`;
      return redactSensitiveText(combined);
    }
    return redactSensitiveText(msg);
  }
  return redactSensitiveText(String(error));
}

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function shouldIgnoreWatchedPath(filename: string | null | undefined): boolean {
  if (filename == null || filename === "") return false;
  const normalized = filename.replace(/\\/g, "/");
  return normalized === ".git"
    || normalized.startsWith(".git/")
    || normalized.startsWith("node_modules/")
    || normalized === "node_modules"
    || normalized.endsWith(".tmp")
    || normalized.endsWith("~");
}

function resolveCordisPluginExport(mod: Record<string, unknown>, pluginId: string): Plugin {
  if (typeof mod.apply === "function") {
    return mod as unknown as Plugin;
  }
  const def = mod.default;
  if (typeof def === "function") {
    return def as unknown as Plugin;
  }
  if (isRecord(def) && typeof def.apply === "function") {
    return def as unknown as Plugin;
  }
  throw new Error(`Plugin "${pluginId}" host entry must export apply(ctx, config) or a default Cordis plugin`);
}

export class PluginManager {
  readonly bundles = new ClientBundleRegistry();
  private readonly mounted = new Map<string, MountedFiber>();
  private readonly errors = new Map<string, string>();
  private readonly circuitBroken = new Set<string>();
  private readonly clientErrors = new Map<string, PluginClientError>();
  private readonly loggedClientErrorKeys = new Set<string>();
  private readonly clientEtags = new Map<string, string>();
  private readonly extraBundledDirs = new Set<string>();
  private readonly watchers = new Map<string, WatcherEntry>();
  private readonly workspaceScope: WorkspacePluginScope;
  private readonly httpRouteFiber: { dispose(): unknown };
  private readonly offStatusListener: () => void;
  private latestCandidates: ResolvedCandidate[] = [];
  private latestSnapshot: PluginInfo[] = [];
  private activeWorkspace?: string;
  private importCounter = 0;
  private syncing = false;
  private statusRefreshTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctx: Context,
    private readonly options: PluginManagerOptions,
  ) {
    this.workspaceScope = new WorkspacePluginScope(ctx);
    const httpBridgePlugin = {
      name: "qianji-plugins-http-bridge",
      inject: ["webServer"],
      apply: (innerCtx: Context) => {
        innerCtx.effect(
          () => innerCtx.webServer.register({
            kind: "prefix",
            path: "/plugins",
            handler: createPluginsHttpHandler(
              this.bundles,
              (pluginId, workspace) => this.resolveClientTarget(pluginId, workspace),
            ),
          }),
          "plugins /plugins/* http handler",
        );
      },
    };
    this.httpRouteFiber = ctx.plugin(httpBridgePlugin);
    this.offStatusListener = onCordisFiberStatusChange(ctx, () => {
      if (this.disposed || this.syncing) return;
      if (this.statusRefreshTimer !== undefined) clearTimeout(this.statusRefreshTimer);
      this.statusRefreshTimer = setTimeout(() => {
        this.statusRefreshTimer = undefined;
        if (this.disposed || this.syncing || this.latestCandidates.length === 0) return;
        const prevById = new Map(this.latestSnapshot.map((item) => [item.id, `${item.status}:${(item.missingInject ?? []).join(",")}`]));
        const nextSnapshot = this.buildSnapshot(this.latestCandidates);
        const changedIds = nextSnapshot
          .filter((item) => prevById.get(item.id) !== `${item.status}:${(item.missingInject ?? []).join(",")}`)
          .map((item) => item.id);
        if (changedIds.length > 0) {
          this.latestSnapshot = nextSnapshot;
          const publicPlugins = this.activeWorkspace !== undefined
            ? this.withUntrustedWorkspaceOverlay(this.latestSnapshot, this.activeWorkspace)
            : [...this.latestSnapshot];
          this.options.onChanged?.({
            reason: "reloaded",
            changedIds,
            plugins: publicPlugins,
          });
        }
      }, 0);
    });
  }

  /** Return the currently active workspace path (if any). */
  get currentWorkspace(): string | undefined {
    return this.activeWorkspace;
  }

  /** Return the currently active workspace path only when it exists and is trusted. */
  get currentTrustedWorkspace(): string | undefined {
    if (this.activeWorkspace === undefined || !existsSync(this.activeWorkspace)) return undefined;
    return isWorkspaceTrusted(this.options.dataDir, this.activeWorkspace) ? this.activeWorkspace : undefined;
  }

  /** Register an additional read-only `bundled-plugins` directory at runtime (e.g. from desktop handshake). */
  addBundledPluginsDir(dir: string): boolean {
    if (dir.trim() === "" || !existsSync(dir)) return false;
    const normalized = canonicalPath(dir);
    const key = pathComparisonKey(normalized);
    for (const existing of this.extraBundledDirs) {
      if (pathComparisonKey(existing) === key) return false;
    }
    this.extraBundledDirs.add(normalized);
    return true;
  }

  private resolveBundledPluginsDirs(): string[] {
    const raw = typeof this.options.bundledPluginsDirs === "function"
      ? this.options.bundledPluginsDirs()
      : (this.options.bundledPluginsDirs ?? []);
    const seen = new Set<string>();
    const dirs: string[] = [];
    for (const entry of [...raw, ...this.extraBundledDirs]) {
      if (entry.trim() === "" || !existsSync(entry)) continue;
      const normalized = canonicalPath(entry);
      const key = pathComparisonKey(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      dirs.push(normalized);
    }
    return dirs;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private notifyUserWarning(message: string): void {
    const ui = this.ctx.get("ui");
    ui?.notify(undefined, message, "warning");
  }

  /**
   * Synchronously inspect an uncaught exception or unhandled rejection stack and
   * attribute it to a mounted disk-backed plugin directory if any frame matches.
   */
  attributeExternalPluginError(
    reason: unknown,
  ): { pluginId: string; alreadyCircuitBroken: boolean } | undefined {
    if (this.disposed || this.latestCandidates.length === 0) return undefined;
    const stackText = reason instanceof Error
      ? `${reason.name}: ${reason.message}\n${reason.stack ?? ""}`
      : String(reason);
    const haystack = process.platform === "win32" ? stackText.toLowerCase() : stackText;
    let frameKeys: string[] | undefined;

    let bestMatch: { id: string; len: number } | undefined;
    for (const candidate of this.latestCandidates) {
      if (!candidate.enabled || candidate.dir === undefined || candidate.builtinPlugin !== undefined) continue;
      const fsDir = candidate.dir.replace(/[\\/]+$/, "");
      if (fsDir === "") continue;
      const slashDir = fsDir.replace(/\\/g, "/");
      const rawFileUrl = pathToFileURL(fsDir).href.replace(/\/+$/, "");
      const boundaryNeedles = [
        `${slashDir}/`,
        `${rawFileUrl}/`,
        ...(process.platform === "win32" ? [`${fsDir}\\`] : []),
      ].map((item) => (process.platform === "win32" ? item.toLowerCase() : item));
      let matched = false;
      for (const needle of boundaryNeedles) {
        if (needle.length > 1 && haystack.includes(needle)) {
          matched = true;
          if (bestMatch === undefined || fsDir.length > bestMatch.len) {
            bestMatch = { id: candidate.id, len: fsDir.length };
          }
        }
      }
      if (!matched) {
        frameKeys ??= extractStackFrameComparisonKeys(stackText);
        if (frameKeys.length > 0) {
          const dirKey = pathComparisonKey(fsDir);
          if (dirKey !== "" && frameKeys.some((fk) => fk === dirKey || fk.startsWith(`${dirKey}/`))) {
            if (bestMatch === undefined || dirKey.length > bestMatch.len) {
              bestMatch = { id: candidate.id, len: dirKey.length };
            }
          }
        }
      }
    }
    if (bestMatch === undefined) return undefined;

    const pluginId = bestMatch.id;
    const alreadyCircuitBroken = this.circuitBroken.has(pluginId);
    if (alreadyCircuitBroken) {
      return { pluginId, alreadyCircuitBroken: true };
    }

    this.errors.set(pluginId, `Unhandled async error: ${errorDetailWithStack(reason)}`);
    this.latestSnapshot = this.buildSnapshot(this.latestCandidates);
    const snapshot = this.activeWorkspace !== undefined
      ? this.withUntrustedWorkspaceOverlay(this.latestSnapshot, this.activeWorkspace)
      : [...this.latestSnapshot];
    setImmediate(() => {
      if (this.disposed) return;
      this.options.onChanged?.({
        reason: "clientError",
        changedIds: [pluginId],
        plugins: snapshot,
      });
    });
    return { pluginId, alreadyCircuitBroken: false };
  }

  private clearLoggedClientErrorKeys(id?: string): void {
    if (id === undefined) {
      this.loggedClientErrorKeys.clear();
      return;
    }
    const prefix = `${id}\0`;
    for (const key of [...this.loggedClientErrorKeys]) {
      if (key.startsWith(prefix)) {
        this.loggedClientErrorKeys.delete(key);
      }
    }
  }

  /** Circuit-break a rogue plugin that triggered an uncaught exception storm without killing the Host. */
  circuitBreakPlugin(pluginId: string, reason: unknown): void {
    if (this.disposed) return;
    this.circuitBroken.add(pluginId);
    void this.enqueue(async () => {
      if (this.disposed) return;
      const mounted = this.mounted.get(pluginId);
      if (mounted !== undefined) {
        try {
          await mounted.fiber?.dispose();
        } catch {
          // Best-effort teardown of rogue plugin fiber.
        }
        this.mounted.delete(pluginId);
      }
      const candidate = this.latestCandidates.find((entry) => entry.id === pluginId);
      if (candidate !== undefined && candidate.canDisable) {
        candidate.enabled = false;
        if (candidate.tier === "workspace" && candidate.workspace !== undefined) {
          const wsKey = workspacePluginKey(candidate.workspace, pluginId);
          updatePluginsStore(this.options.dataDir, (draft) => {
            (draft.workspacePlugins[wsKey] ??= {}).enabled = false;
          });
        } else {
          updatePluginsStore(this.options.dataDir, (draft) => {
            (draft.plugins[pluginId] ??= {}).enabled = false;
          });
        }
      }
      this.errors.set(pluginId, `Circuit-broken after uncaught exception storm: ${errorDetailWithStack(reason)}`);
      this.latestSnapshot = this.buildSnapshot(this.latestCandidates);
      this.notifyUserWarning(`插件 ${pluginId} 因高频未捕获异常已被自动熔断隔离`);
      const snapshot = this.activeWorkspace !== undefined
        ? this.withUntrustedWorkspaceOverlay(this.latestSnapshot, this.activeWorkspace)
        : [...this.latestSnapshot];
      this.options.onChanged?.({
        reason: "toggled",
        changedIds: [pluginId],
        plugins: snapshot,
      });
    });
  }

  async reportClientError(id: string, err: PluginClientError, workspace?: string): Promise<PluginMutationResult> {
    await this.enqueue(async () => {
      if (this.latestCandidates.length === 0 && !this.disposed) {
        await this.syncNow(workspace === undefined ? {} : { workspace });
      }
      const dedupeKey = `${id}\0${err.phase}\0${err.etag ?? ""}\0${err.message}`;
      if (!this.loggedClientErrorKeys.has(dedupeKey)) {
        if (this.loggedClientErrorKeys.size >= 500) {
          this.loggedClientErrorKeys.clear();
        }
        this.loggedClientErrorKeys.add(dedupeKey);
        const cleanMessage = redactSensitiveText(err.message);
        const cleanStack = err.stack !== undefined && err.stack.trim() !== ""
          ? `\n${redactSensitiveText(err.stack.trim())}`
          : "";
        this.ctx.logger("plugins").error(
          "[client:%s] plugin=%s: %s%s",
          err.phase,
          id,
          cleanMessage,
          cleanStack,
        );
      }
      this.clientErrors.set(id, err);
      if (this.latestCandidates.length > 0) {
        this.latestSnapshot = this.buildSnapshot(this.latestCandidates);
        const snapshot = this.activeWorkspace !== undefined
          ? this.withUntrustedWorkspaceOverlay(this.latestSnapshot, this.activeWorkspace)
          : [...this.latestSnapshot];
        this.options.onChanged?.({
          reason: "clientError",
          changedIds: [id],
          plugins: snapshot,
        });
      }
    });
    const plugins = await this.list(workspace);
    const plugin = plugins.find((entry) => entry.id === id);
    return { ...(plugin === undefined ? {} : { plugin }), plugins };
  }

  async clearClientError(id: string, workspace?: string): Promise<PluginMutationResult> {
    await this.enqueue(async () => {
      this.clearLoggedClientErrorKeys(id);
      const removed = this.clientErrors.delete(id);
      if (removed && this.latestCandidates.length > 0) {
        this.latestSnapshot = this.buildSnapshot(this.latestCandidates);
        const snapshot = this.activeWorkspace !== undefined
          ? this.withUntrustedWorkspaceOverlay(this.latestSnapshot, this.activeWorkspace)
          : [...this.latestSnapshot];
        this.options.onChanged?.({
          reason: "clientError",
          changedIds: [id],
          plugins: snapshot,
        });
      }
    });
    const plugins = await this.list(workspace);
    const plugin = plugins.find((entry) => entry.id === id);
    return { ...(plugin === undefined ? {} : { plugin }), plugins };
  }

  private resolveClientTarget(pluginId: string, workspace?: string): ClientRouteTarget | undefined {
    const info = this.latestSnapshot.find((entry) =>
      entry.id === pluginId
      && entry.enabled
      && entry.status === "active"
      && entry.hasClient
      && entry.dir !== undefined
      && (workspace === undefined || entry.workspace === undefined || pathComparisonKey(entry.workspace) === pathComparisonKey(workspace)),
    );
    if (info === undefined || info.dir === undefined) return undefined;
    try {
      const manifest = readPluginManifest(info.dir, info.tier, info.workspace);
      if (manifest.clientEntry === undefined) return undefined;
      return {
        id: manifest.id,
        dir: manifest.dir,
        clientEntry: manifest.clientEntry,
        ...(manifest.assetsDir === undefined ? {} : { assetsDir: manifest.assetsDir }),
      };
    } catch {
      return undefined;
    }
  }

  /** Synchronize mounted plugins with disk manifests, `plugins.json`, and `harness.json`. */
  sync(params: {
    workspace?: string;
    reason?: PluginChangedNotification["reason"];
    forceIds?: ReadonlySet<string>;
  } = {}): Promise<string[]> {
    return this.enqueue(() => this.syncNow(params));
  }

  async list(workspace?: string): Promise<PluginInfo[]> {
    if (workspace !== undefined) {
      if (workspace.trim() === "") {
        if (this.activeWorkspace !== undefined || (this.latestSnapshot.length === 0 && !this.disposed)) {
          await this.sync({ workspace: "" });
        }
        return [...this.latestSnapshot];
      }
      const normalized = canonicalPath(workspace);
      if (this.activeWorkspace === undefined || pathComparisonKey(this.activeWorkspace) !== pathComparisonKey(normalized)) {
        await this.sync({ workspace: normalized });
      } else {
        return this.enqueue(async () => this.withUntrustedWorkspaceOverlay(this.latestSnapshot, normalized));
      }
      return this.withUntrustedWorkspaceOverlay(this.latestSnapshot, normalized);
    }
    if (this.latestSnapshot.length === 0 && !this.disposed) {
      await this.sync();
    }
    return this.activeWorkspace !== undefined
      ? this.withUntrustedWorkspaceOverlay(this.latestSnapshot, this.activeWorkspace)
      : [...this.latestSnapshot];
  }

  private isProtectedBuiltin(id: string): boolean {
    const builtinDef = (this.options.builtins?.(this.currentTrustedWorkspace) ?? []).find((entry) => entry.id === id);
    return builtinDef?.canDisable === false;
  }

  async setEnabled(id: string, enabled: boolean, options: { workspace?: string; watch?: boolean } = {}): Promise<PluginMutationResult> {
    await this.enqueue(async () => {
      if (options.workspace !== undefined && options.workspace.trim() !== "") {
        const ws = canonicalPath(options.workspace);
        if (!isWorkspaceTrusted(this.options.dataDir, ws)) {
          throw new Error(`Workspace is not trusted: ${ws}`);
        }
        const key = workspacePluginKey(ws, id);
        updatePluginsStore(this.options.dataDir, (store) => {
          const prev = store.workspacePlugins[key];
          store.workspacePlugins[key] = {
            ...prev,
            enabled,
            ...(options.watch === undefined ? {} : { watch: options.watch }),
          };
        });
        this.activeWorkspace = ws;
      } else {
        if (!enabled && this.isProtectedBuiltin(id)) {
          throw new Error(`Plugin "${id}" is an essential host transport gateway and cannot be disabled`);
        }
        updatePluginsStore(this.options.dataDir, (store) => {
          const prev = store.plugins[id];
          store.plugins[id] = {
            ...prev,
            enabled,
            ...(options.watch === undefined ? {} : { watch: options.watch }),
          };
        });
      }
      this.circuitBroken.delete(id);
      if (!enabled) {
        this.errors.delete(id);
        this.clientErrors.delete(id);
        this.clearLoggedClientErrorKeys(id);
      }
      await this.syncNow({ reason: "toggled", forceIds: new Set([id]), ...(options.workspace === undefined ? {} : { workspace: options.workspace }) });
    });
    const plugins = await this.list(options.workspace);
    const plugin = plugins.find((entry) => entry.id === id);
    return { ...(plugin === undefined ? {} : { plugin }), plugins };
  }

  async configure(id: string, config: Record<string, unknown>, options: { workspace?: string; watch?: boolean } = {}): Promise<PluginMutationResult> {
    await this.enqueue(async () => {
      if (options.workspace !== undefined && options.workspace.trim() !== "") {
        const ws = canonicalPath(options.workspace);
        if (!isWorkspaceTrusted(this.options.dataDir, ws)) {
          throw new Error(`Workspace is not trusted: ${ws}`);
        }
        const key = workspacePluginKey(ws, id);
        updatePluginsStore(this.options.dataDir, (store) => {
          const prev = store.workspacePlugins[key];
          store.workspacePlugins[key] = {
            ...prev,
            config,
            ...(options.watch === undefined ? {} : { watch: options.watch }),
          };
        });
        this.activeWorkspace = ws;
      } else {
        if (this.isProtectedBuiltin(id)) {
          throw new Error(`Plugin "${id}" is an essential host transport gateway and cannot be reconfigured`);
        }
        updatePluginsStore(this.options.dataDir, (store) => {
          const prev = store.plugins[id];
          store.plugins[id] = {
            ...prev,
            config,
            ...(options.watch === undefined ? {} : { watch: options.watch }),
          };
        });
      }
      this.clientErrors.delete(id);
      this.clearLoggedClientErrorKeys(id);
      await this.syncNow({ reason: "configured", forceIds: new Set([id]), ...(options.workspace === undefined ? {} : { workspace: options.workspace }) });
    });
    const plugins = await this.list(options.workspace);
    const plugin = plugins.find((entry) => entry.id === id);
    return { ...(plugin === undefined ? {} : { plugin }), plugins };
  }

  async reload(id?: string, workspace?: string): Promise<PluginMutationResult> {
    await this.enqueue(async () => {
      if (id !== undefined) {
        const existing = this.latestSnapshot.find((entry) => entry.id === id);
        if (existing?.dir !== undefined) this.bundles.invalidateDir(existing.dir);
        this.circuitBroken.delete(id);
        this.errors.delete(id);
        this.clientErrors.delete(id);
        this.clearLoggedClientErrorKeys(id);
        const forceIds = this.isProtectedBuiltin(id) ? undefined : new Set([id]);
        await this.syncNow({
          reason: "reloaded",
          ...(forceIds === undefined ? {} : { forceIds }),
          ...(workspace === undefined ? {} : { workspace }),
        });
      } else {
        this.bundles.clear();
        this.circuitBroken.clear();
        this.errors.clear();
        this.clientErrors.clear();
        this.clearLoggedClientErrorKeys();
        const reloadableIds = new Set(
          this.latestSnapshot
            .filter((entry) => entry.canDisable !== false)
            .map((entry) => entry.id),
        );
        await this.syncNow({ reason: "reloaded", forceIds: reloadableIds, ...(workspace === undefined ? {} : { workspace }) });
      }
    });
    const plugins = await this.list(workspace);
    const plugin = id === undefined ? undefined : plugins.find((entry) => entry.id === id);
    return { ...(plugin === undefined ? {} : { plugin }), plugins };
  }

  async install(params: PluginInstallParams): Promise<PluginMutationResult> {
    let installedId = "";
    await this.enqueue(async () => {
      const installed = installPlugin(this.options.dataDir, params);
      installedId = installed.manifest.id;
      this.bundles.invalidateDir(installed.manifest.dir);
      this.circuitBroken.delete(installedId);
      this.errors.delete(installedId);
      this.clientErrors.delete(installedId);
      this.clearLoggedClientErrorKeys(installedId);
      await this.syncNow({ reason: "installed", forceIds: new Set([installedId]) });
    });
    const plugins = await this.list();
    const plugin = plugins.find((entry) => entry.id === installedId);
    return { ...(plugin === undefined ? {} : { plugin }), plugins };
  }

  async update(id?: string): Promise<PluginMutationResult> {
    let targetId: string | undefined = id;
    await this.enqueue(async () => {
      const store = readPluginsStore(this.options.dataDir);
      const ids = id !== undefined
        ? [id]
        : Object.entries(store.plugins)
          .filter(([, patch]) => patch.origin !== undefined)
          .map(([pluginId]) => pluginId);
      if (ids.length === 0) return;

      const updatedIds = new Set<string>();
      for (const pluginId of ids) {
        const updated = updateInstalledPlugin(this.options.dataDir, pluginId);
        this.bundles.invalidateDir(updated.manifest.dir);
        this.circuitBroken.delete(updated.manifest.id);
        this.errors.delete(updated.manifest.id);
        this.clientErrors.delete(updated.manifest.id);
        this.clearLoggedClientErrorKeys(updated.manifest.id);
        updatedIds.add(updated.manifest.id);
        targetId ??= updated.manifest.id;
      }
      await this.syncNow({ reason: "updated", forceIds: updatedIds });
    });
    const plugins = await this.list();
    const plugin = targetId === undefined ? undefined : plugins.find((entry) => entry.id === targetId);
    return { ...(plugin === undefined ? {} : { plugin }), plugins };
  }

  async remove(id: string, workspace?: string): Promise<PluginMutationResult> {
    await this.enqueue(async () => {
      const current = this.latestSnapshot.find((entry) => entry.id === id);
      removeUserPluginFiles(this.options.dataDir, id, current?.tier === "user" ? current.dir : undefined);
      if (current?.dir !== undefined) this.bundles.invalidateDir(current.dir);
      this.circuitBroken.delete(id);
      this.errors.delete(id);
      this.clientErrors.delete(id);
      this.clearLoggedClientErrorKeys(id);
      this.clientEtags.delete(id);
      await this.syncNow({ reason: "removed", forceIds: new Set([id]), ...(workspace === undefined ? {} : { workspace }) });
    });
    const plugins = await this.list(workspace);
    const plugin = plugins.find((entry) => entry.id === id);
    return { ...(plugin === undefined ? {} : { plugin }), plugins };
  }

  async clientBundle(id: string, options: { workspace?: string; ifNoneMatch?: string } = {}): Promise<PluginClientBundleResult> {
    if (this.latestSnapshot.length === 0 && !this.disposed) {
      await this.sync(options.workspace === undefined ? {} : { workspace: options.workspace });
    }
    const target = this.resolveClientTarget(id, options.workspace);
    if (target === undefined || target.clientEntry === undefined) {
      throw new Error(`No active client bundle for plugin "${id}"`);
    }
    let compiled: { etag: string; code: string };
    try {
      compiled = await this.bundles.compile(target.id, target.dir, target.clientEntry);
    } catch (error) {
      this.ctx.logger("plugins").error(
        "plugin=%s client bundle compile failed: %s",
        target.id,
        errorDetailWithStack(error),
      );
      throw error;
    }
    if (options.ifNoneMatch !== undefined && options.ifNoneMatch === compiled.etag) {
      return { notModified: true, etag: compiled.etag };
    }
    return { notModified: false, etag: compiled.etag, code: compiled.code };
  }

  workspaceTrustList(workspace?: string): WorkspaceTrustListResult {
    return inspectWorkspaceTrust(this.options.dataDir, workspace);
  }

  async workspaceTrustSet(workspace: string, trusted: boolean): Promise<WorkspaceTrustListResult> {
    const normalized = canonicalPath(workspace);
    await this.enqueue(async () => {
      const trustedList = setWorkspaceTrust(this.options.dataDir, normalized, trusted);
      this.activeWorkspace = normalized;
      this.options.onTrustChanged?.({
        workspace: normalized,
        trusted,
        trustedList,
      });
      const scanned = scanPluginsDirectory(resolveWorkspacePluginsDir(normalized), "workspace", normalized);
      const affectedIds = new Set(scanned.manifests.map((item) => item.id));
      await this.syncNow({ workspace: normalized, reason: "trust", forceIds: affectedIds });
    });
    return inspectWorkspaceTrust(this.options.dataDir, normalized);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.offStatusListener();
    if (this.statusRefreshTimer !== undefined) {
      clearTimeout(this.statusRefreshTimer);
      this.statusRefreshTimer = undefined;
    }
    await this.enqueue(async () => {
      for (const watcher of this.watchers.values()) {
        if (watcher.timer !== undefined) clearTimeout(watcher.timer);
        watcher.watcher.close();
      }
      this.watchers.clear();
      const orderedTeardown = reverseTopologicalOrder([...this.mounted.values()]);
      for (const mounted of orderedTeardown) {
        await mounted.fiber?.dispose();
      }
      this.mounted.clear();
      await this.workspaceScope.dispose();
      await this.httpRouteFiber.dispose();
      this.bundles.clear();
      this.clientErrors.clear();
      this.clearLoggedClientErrorKeys();
      this.latestCandidates = [];
      this.latestSnapshot = [];
    });
  }

  private withUntrustedWorkspaceOverlay(base: readonly PluginInfo[], workspacePath: string): PluginInfo[] {
    if (isWorkspaceTrusted(this.options.dataDir, workspacePath)) {
      return [...base];
    }
    const pluginsDir = resolveWorkspacePluginsDir(workspacePath);
    const scanned = scanPluginsDirectory(pluginsDir, "workspace", workspacePath);
    if (scanned.manifests.length === 0) return [...base];
    const builtins = new Set([
      ...(this.options.builtins?.(undefined) ?? []).map((item) => item.id),
      ...this.latestCandidates.filter((item) => item.tier === "builtin").map((item) => item.id),
    ]);
    const extras: PluginInfo[] = scanned.manifests
      .filter(
        (manifest) =>
          !base.some(
            (existing) =>
              existing.id === manifest.id
              && (existing.tier === "workspace"
                || (existing.dir !== undefined && pathComparisonKey(existing.dir) === pathComparisonKey(manifest.dir))),
          ),
      )
      .map((manifest) => ({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        ...(manifest.description === undefined ? {} : { description: manifest.description }),
        tier: "workspace",
        status: "untrusted",
        enabled: false,
        overridesBuiltin: builtins.has(manifest.id),
        removable: false,
        hasHost: manifest.hostEntry !== undefined,
        hasClient: manifest.clientEntry !== undefined,
        dir: manifest.dir,
        workspace: workspacePath,
        watch: false,
        ...(manifest.configSchema === undefined ? {} : { configSchema: manifest.configSchema }),
        ...(manifest.inject !== undefined && manifest.inject.length > 0 ? { inject: [...manifest.inject] } : {}),
        ...(manifest.provides !== undefined && manifest.provides.length > 0 ? { provides: [...manifest.provides] } : {}),
      }));
    return [...extras, ...base];
  }

  private buildSnapshot(candidates: readonly ResolvedCandidate[]): PluginInfo[] {
    return candidates.map((candidate): PluginInfo => {
      const err = this.errors.get(candidate.id);
      const clientErr = candidate.enabled ? this.clientErrors.get(candidate.id) : undefined;
      const mounted = this.mounted.get(candidate.id);
      let status: PluginStatus;
      let missingInject: string[] | undefined;

      if (!candidate.enabled) {
        status = "disabled";
      } else if (mounted === undefined || err?.startsWith("Unhandled async error:")) {
        status = "errored";
      } else if (!candidate.hasHost || mounted.fiber === undefined) {
        status = "active";
      } else {
        const readiness = inspectCordisFiber(mounted.ctx, mounted.fiber, mounted.inject);
        if (readiness.status === "active") {
          status = "active";
        } else if (readiness.status === "pending") {
          status = "pending";
          if (readiness.missingInject.length > 0) {
            missingInject = readiness.missingInject;
          }
        } else {
          status = "errored";
        }
      }

      const clientEtag = this.clientEtags.get(candidate.id);
      const clientPath = candidate.hasClient && candidate.clientEntry !== undefined
        ? `/plugins/${encodeURIComponent(candidate.id)}/client.js`
        : undefined;
      return {
        id: candidate.id,
        name: candidate.name,
        version: candidate.version,
        ...(candidate.description === undefined ? {} : { description: candidate.description }),
        tier: candidate.tier,
        status,
        enabled: candidate.enabled,
        ...(candidate.canDisable ? {} : { canDisable: false }),
        overridesBuiltin: candidate.overridesBuiltin,
        removable: candidate.removable,
        hasHost: candidate.hasHost,
        hasClient: candidate.hasClient,
        ...(clientPath === undefined ? {} : { clientPath }),
        ...(clientEtag === undefined ? {} : { clientEtag }),
        ...(candidate.dir === undefined ? {} : { dir: candidate.dir }),
        ...(candidate.workspace === undefined ? {} : { workspace: candidate.workspace }),
        watch: candidate.watch,
        ...(candidate.origin === undefined ? {} : { origin: candidate.origin }),
        ...(candidate.publicConfig === undefined ? {} : { config: candidate.publicConfig }),
        ...(candidate.configSchema === undefined ? {} : { configSchema: candidate.configSchema }),
        ...(candidate.inject.length > 0 ? { inject: [...candidate.inject] } : {}),
        ...(candidate.provides.length > 0 ? { provides: [...candidate.provides] } : {}),
        ...(missingInject === undefined ? {} : { missingInject }),
        ...(err === undefined ? {} : { error: err }),
        ...(clientErr === undefined ? {} : { clientError: clientErr }),
      };
    });
  }

  private async syncNow(params: {
    workspace?: string;
    reason?: PluginChangedNotification["reason"];
    forceIds?: ReadonlySet<string>;
  }): Promise<string[]> {
    if (this.disposed) return [];
    this.syncing = true;
    try {
      if (params.workspace !== undefined) {
        this.activeWorkspace = params.workspace.trim() === "" ? undefined : canonicalPath(params.workspace);
      }

      const activeTrustedWs = this.currentTrustedWorkspace;
      const activeWsKey = activeTrustedWs !== undefined ? pathComparisonKey(activeTrustedWs) : undefined;

      const builtins = this.options.builtins?.(activeTrustedWs) ?? [];
      const builtinsById = new Map(builtins.map((entry) => [entry.id, entry]));
      const bundledById = new Map<string, DiscoveredPluginManifest>();
      for (const bundledRoot of this.resolveBundledPluginsDirs()) {
        const scanned = scanPluginsDirectory(bundledRoot, "builtin");
        for (const manifest of scanned.manifests) {
          if (!builtinsById.has(manifest.id) && !bundledById.has(manifest.id)) {
            bundledById.set(manifest.id, manifest);
          }
        }
        for (const scanErr of scanned.errors) {
          this.ctx.logger("plugins").warn("skipping invalid bundled plugin %s: %s", scanErr.dir, scanErr.error);
        }
      }
      const hasBuiltinId = (id: string): boolean => builtinsById.has(id) || bundledById.has(id);
      const store = readPluginsStore(this.options.dataDir);

      // 1. Discover user plugins (`<dataDir>/plugins/*` + linked local dirs in `plugins.json`).
      const userById = new Map<string, DiscoveredPluginManifest>();
      const manifestErrors = new Map<string, { tier: PluginTier; dir: string; message: string }>();

      const managedScan = scanPluginsDirectory(managedPluginsRoot(this.options.dataDir), "user");
      for (const manifest of managedScan.manifests) {
        userById.set(manifest.id, manifest);
      }
      for (const scanErr of managedScan.errors) {
        this.ctx.logger("plugins").warn("skipping invalid plugin dir %s: %s", scanErr.dir, scanErr.error);
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
      if (activeTrustedWs !== undefined) {
        const scanned = scanPluginsDirectory(resolveWorkspacePluginsDir(activeTrustedWs), "workspace", activeTrustedWs);
        for (const manifest of scanned.manifests) {
          workspaceById.set(manifest.id, manifest);
        }
        for (const scanErr of scanned.errors) {
          this.ctx.logger("plugins").warn("skipping invalid workspace plugin %s: %s", scanErr.dir, scanErr.error);
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
            version: this.options.version,
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
            version: this.options.version,
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

      // 4. Unmount removed, disabled, tier-switched, or inactive-workspace fibers in reverse topological order.
      const changed: string[] = [];
      const candidateById = new Map(candidates.map((c) => [c.id, c]));
      const toUnmount: MountedFiber[] = [];
      for (const mounted of this.mounted.values()) {
        const target = candidateById.get(mounted.id);
        const stillWanted = target !== undefined
          && target.enabled
          && target.manifestError === undefined
          && target.tier === mounted.tier
          && (mounted.tier !== "workspace" || mounted.workspaceKey === activeWsKey);
        if (!stillWanted) {
          toUnmount.push(mounted);
        }
      }

      for (const mounted of reverseTopologicalOrder(toUnmount)) {
        await mounted.fiber?.dispose();
        this.mounted.delete(mounted.id);
        this.clientEtags.delete(mounted.id);
        this.clientErrors.delete(mounted.id);
        changed.push(mounted.id);
      }

      const currentScopeWs = this.workspaceScope.activeWorkspacePath;
      if (currentScopeWs !== undefined && (activeWsKey === undefined || pathComparisonKey(currentScopeWs) !== activeWsKey)) {
        await this.workspaceScope.dispose();
      }

      // 5. Prepare external bundles & imports, extract dependency metadata, and topologically sort before mounting.
      const externalNeeded = candidates.some(
        (c) => c.enabled && c.builtinPlugin === undefined && c.hasHost && c.hostEntry !== undefined,
      );
      if (externalNeeded) {
        await installHostModuleBridge();
      }

      const preparedList: PreparedCandidate[] = [];
      for (const candidate of candidates) {
        if (candidate.manifestError !== undefined) {
          this.errors.set(candidate.id, candidate.manifestError);
          continue;
        }
        if (!candidate.enabled) {
          continue;
        }

        const sourceKey = `${candidate.tier}:${candidate.dir ?? "builtin"}:${candidate.hostEntry ?? ""}:${candidate.clientEntry ?? ""}`;
        const sig = signatureOf(candidate.effectiveConfig);
        const pinnedGateway = candidate.tier === "builtin" && !candidate.canDisable;
        const force = !pinnedGateway && params.forceIds?.has(candidate.id) === true;
        if (this.circuitBroken.has(candidate.id) && !force) {
          continue;
        }
        if (force) {
          this.circuitBroken.delete(candidate.id);
        }
        const current = this.mounted.get(candidate.id);

        if (current !== undefined && (pinnedGateway || (!force && current.sourceKey === sourceKey && current.signature === sig))) {
          candidate.inject = current.inject;
          candidate.provides = current.provides;
          preparedList.push({
            candidate,
            sourceKey,
            signature: sig,
            needsMount: false,
            skippedDueToError: false,
          });
          continue;
        }

        if (candidate.builtinPlugin !== undefined || (candidate.tier === "builtin" && candidate.dir === undefined)) {
          preparedList.push({
            candidate,
            sourceKey,
            signature: sig,
            needsMount: true,
            skippedDueToError: false,
            ...(candidate.builtinPlugin === undefined ? {} : { pluginToMount: candidate.builtinPlugin }),
          });
          continue;
        }

        let clientEtag: string | undefined;
        if (candidate.clientEntry !== undefined && candidate.dir !== undefined) {
          try {
            const compiled = await this.bundles.compile(candidate.id, candidate.dir, candidate.clientEntry);
            clientEtag = compiled.etag;
          } catch (error) {
            const msg = redactSensitiveText(errorMessage(error));
            const detail = errorDetailWithStack(error);
            if (current !== undefined && force) {
              const rollbackMsg = `Client bundle error (kept previous state): ${detail}`;
              this.errors.set(candidate.id, rollbackMsg);
              this.ctx.logger("plugins").error(
                "plugin=%s client bundle compile failed (kept previous state): %s",
                candidate.id,
                detail,
              );
              this.notifyUserWarning(`插件 ${candidate.name} 前端热更新失败：${msg}`);
              changed.push(candidate.id);
              candidate.inject = current.inject;
              candidate.provides = current.provides;
              preparedList.push({ candidate, sourceKey, signature: sig, needsMount: false, skippedDueToError: true });
              continue;
            }
            if (current !== undefined) {
              await current.fiber?.dispose();
              this.mounted.delete(candidate.id);
            }
            this.errors.set(candidate.id, detail);
            this.ctx.logger("plugins").error("plugin=%s client bundle compile failed: %s", candidate.id, detail);
            this.notifyUserWarning(`插件 ${candidate.name} 前端编译失败：${msg}`);
            changed.push(candidate.id);
            preparedList.push({ candidate, sourceKey, signature: sig, needsMount: false, skippedDueToError: true });
            continue;
          }
        }

        if (!candidate.hasHost || candidate.hostEntry === undefined) {
          preparedList.push({
            candidate,
            sourceKey,
            signature: sig,
            needsMount: true,
            skippedDueToError: false,
            ...(clientEtag === undefined ? {} : { clientEtag }),
          });
          continue;
        }

        let nextPlugin: Plugin;
        try {
          this.importCounter += 1;
          const mod = await importExternalModule(
            candidate.hostEntry,
            `${Date.now()}-${this.importCounter}`,
            candidate.dir,
          );
          nextPlugin = resolveCordisPluginExport(mod, candidate.id);
          const depMeta = extractPluginDependencyMeta(mod, {
            inject: candidate.inject,
            provides: candidate.provides,
          });
          candidate.inject = depMeta.inject;
          candidate.provides = depMeta.provides;
        } catch (error) {
          const msg = redactSensitiveText(errorMessage(error));
          const detail = errorDetailWithStack(error);
          if (current !== undefined && current.plugin !== undefined) {
            this.errors.set(candidate.id, `HMR reload failed (rolled back): ${detail}`);
            this.ctx.logger("plugins").error(
              "plugin=%s reload import failed, keeping previous fiber: %s",
              candidate.id,
              detail,
            );
            this.notifyUserWarning(`插件 ${candidate.name} 热重载失败（已回滚旧版本）：${msg}`);
            changed.push(candidate.id);
            candidate.inject = current.inject;
            candidate.provides = current.provides;
            preparedList.push({ candidate, sourceKey, signature: sig, needsMount: false, skippedDueToError: true });
            continue;
          }
          if (current !== undefined) {
            await current.fiber?.dispose();
            this.mounted.delete(candidate.id);
          }
          this.errors.set(candidate.id, detail);
          this.ctx.logger("plugins").error("plugin=%s import failed: %s", candidate.id, detail);
          this.notifyUserWarning(`插件 ${candidate.name} 加载失败：${msg}`);
          changed.push(candidate.id);
          preparedList.push({ candidate, sourceKey, signature: sig, needsMount: false, skippedDueToError: true });
          continue;
        }

        preparedList.push({
          candidate,
          sourceKey,
          signature: sig,
          needsMount: true,
          skippedDueToError: false,
          pluginToMount: nextPlugin,
          ...(clientEtag === undefined ? {} : { clientEtag }),
        });
      }

      const preparedById = new Map(preparedList.map((item) => [item.candidate.id, item]));
      const { ordered, cycles } = topologicalSortPlugins(preparedList.map((item) => item.candidate));
      for (const cycle of cycles) {
        this.ctx.logger("plugins").warn("plugin dependency cycle detected: %s", cycle.join(" -> "));
      }

      for (const orderedCandidate of ordered) {
        const prepared = preparedById.get(orderedCandidate.id);
        if (prepared === undefined || !prepared.needsMount || prepared.skippedDueToError) {
          continue;
        }

        const { candidate, sourceKey, signature: sig, pluginToMount, clientEtag } = prepared;
        const previous = this.mounted.get(candidate.id);
        const targetCtx = candidate.tier === "workspace" && candidate.workspace !== undefined && candidate.workspaceKey !== undefined
          ? await this.workspaceScope.ensure(candidate.workspaceKey, candidate.workspace)
          : this.ctx;

        if (!candidate.hasHost || pluginToMount === undefined) {
          if (previous !== undefined) {
            await previous.fiber?.dispose();
          }
          this.mounted.set(candidate.id, {
            id: candidate.id,
            tier: candidate.tier,
            ...(candidate.workspaceKey === undefined ? {} : { workspaceKey: candidate.workspaceKey }),
            sourceKey,
            signature: sig,
            config: candidate.effectiveConfig,
            ctx: targetCtx,
            inject: candidate.inject,
            provides: candidate.provides,
          });
          if (clientEtag !== undefined) {
            if (this.clientEtags.get(candidate.id) !== clientEtag) {
              this.clientErrors.delete(candidate.id);
              this.clearLoggedClientErrorKeys(candidate.id);
            }
            this.clientEtags.set(candidate.id, clientEtag);
          }
          this.errors.delete(candidate.id);
          if (!changed.includes(candidate.id)) changed.push(candidate.id);
          continue;
        }

        if (previous !== undefined) {
          await previous.fiber?.dispose();
          this.mounted.delete(candidate.id);
        }

        let nextFiber: { dispose(): unknown } | undefined;
        try {
          nextFiber = targetCtx.plugin(pluginToMount, candidate.effectiveConfig);
          await nextFiber;
          this.mounted.set(candidate.id, {
            id: candidate.id,
            tier: candidate.tier,
            ...(candidate.workspaceKey === undefined ? {} : { workspaceKey: candidate.workspaceKey }),
            sourceKey,
            signature: sig,
            plugin: pluginToMount,
            config: candidate.effectiveConfig,
            fiber: nextFiber,
            ctx: targetCtx,
            inject: candidate.inject,
            provides: candidate.provides,
          });
          if (clientEtag !== undefined) {
            if (this.clientEtags.get(candidate.id) !== clientEtag) {
              this.clientErrors.delete(candidate.id);
              this.clearLoggedClientErrorKeys(candidate.id);
            }
            this.clientEtags.set(candidate.id, clientEtag);
          }
          this.errors.delete(candidate.id);
          if (!changed.includes(candidate.id)) changed.push(candidate.id);
        } catch (error) {
          const msg = redactSensitiveText(errorMessage(error));
          const detail = errorDetailWithStack(error);
          await nextFiber?.dispose();
          if (candidate.tier !== "builtin" && previous?.plugin !== undefined) {
            try {
              const restored = previous.ctx.plugin(previous.plugin, previous.config);
              await restored;
              this.mounted.set(candidate.id, { ...previous, fiber: restored });
              this.errors.set(candidate.id, `HMR reload failed (rolled back): ${detail}`);
              this.ctx.logger("plugins").error(
                "plugin=%s apply failed, restored previous fiber: %s",
                candidate.id,
                detail,
              );
              this.notifyUserWarning(`插件 ${candidate.name} 热重载失败（已回滚旧版本）：${msg}`);
              if (!changed.includes(candidate.id)) changed.push(candidate.id);
              continue;
            } catch (restoreError) {
              this.ctx.logger("plugins").error(
                "plugin=%s rollback failed: %s",
                candidate.id,
                errorDetailWithStack(restoreError),
              );
            }
          }
          this.errors.set(candidate.id, detail);
          this.ctx.logger("plugins").error("plugin=%s apply failed: %s", candidate.id, detail);
          if (candidate.tier !== "builtin") {
            this.notifyUserWarning(`插件 ${candidate.name} 启动失败：${msg}`);
          }
          if (!changed.includes(candidate.id)) changed.push(candidate.id);
        }
      }

      // Let Cordis settle cross-fiber `inject` activations/suspensions before inspecting `FiberState`.
      await flushImmediate();

      // 6. Build public snapshot and reconcile file watchers.
      this.latestCandidates = candidates;
      this.latestSnapshot = this.buildSnapshot(candidates);
      this.reconcileWatchers(candidates);

      if (params.reason !== undefined && (changed.length > 0 || params.reason === "trust" || params.reason === "toggled" || params.reason === "configured")) {
        const snapshot = this.activeWorkspace !== undefined
          ? this.withUntrustedWorkspaceOverlay(this.latestSnapshot, this.activeWorkspace)
          : [...this.latestSnapshot];
        this.options.onChanged?.({
          reason: params.reason,
          changedIds: changed.length > 0 ? changed : [...(params.forceIds ?? [])],
          plugins: snapshot,
        });
      }

      return changed;
    } finally {
      this.syncing = false;
    }
  }

  private reconcileWatchers(candidates: readonly ResolvedCandidate[]): void {
    const wanted = new Map<string, string>();
    for (const candidate of candidates) {
      if (candidate.enabled && candidate.watch && candidate.tier !== "builtin" && candidate.dir !== undefined && existsSync(candidate.dir)) {
        wanted.set(candidate.id, candidate.dir);
      }
    }

    for (const [id, entry] of this.watchers) {
      const targetDir = wanted.get(id);
      if (targetDir !== undefined && targetDir === entry.dir) continue;
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.watcher.close();
      this.watchers.delete(id);
    }

    for (const [id, dir] of wanted) {
      if (this.watchers.has(id)) continue;
      try {
        const watcher = fsWatch(dir, { recursive: true }, (_eventType, filename) => {
          if (this.disposed || shouldIgnoreWatchedPath(filename)) return;
          const active = this.watchers.get(id);
          if (active === undefined) return;
          if (active.timer !== undefined) clearTimeout(active.timer);
          active.timer = setTimeout(() => {
            active.timer = undefined;
            if (this.disposed) return;
            this.bundles.invalidateDir(dir);
            void this.sync({ reason: "hmr", forceIds: new Set([id]) }).catch((error: unknown) => {
              this.ctx.logger("plugins").error("HMR sync failed for %s: %s", id, error);
            });
          }, WATCH_DEBOUNCE_MS);
        });
        watcher.on("error", (error) => {
          this.ctx.logger("plugins").warn("watcher error for %s (%s): %s", id, dir, error);
        });
        this.watchers.set(id, { dir, watcher });
      } catch (error) {
        this.ctx.logger("plugins").warn("could not watch plugin %s (%s): %s", id, dir, error);
      }
    }
  }
}

function extractBalancedCallSiteLocation(trimmedLine: string): string | undefined {
  if (!trimmedLine.endsWith(")")) return undefined;
  let depth = 0;
  for (let i = trimmedLine.length - 1; i >= 0; i -= 1) {
    const ch = trimmedLine[i];
    if (ch === ")") {
      depth += 1;
    } else if (ch === "(") {
      depth -= 1;
      if (depth === 0) {
        const inner = trimmedLine.slice(i + 1, -1).trim();
        return inner !== "" ? inner : undefined;
      }
    }
  }
  return undefined;
}

function addNormalizedLocationKey(rawToken: string, keys: Set<string>): void {
  const trimmed = rawToken.trim().replace(/^['"`]+|[,;'"`]+$/g, "");
  if (trimmed === "") return;
  const withoutLineCol = trimmed.replace(/(?::\d+){1,2}$/, "");
  if (/^file:\/\//i.test(withoutLineCol)) {
    try {
      keys.add(pathComparisonKey(fileURLToPath(new URL(withoutLineCol))));
    } catch {
      // Ignore malformed file URLs in arbitrary user error strings.
    }
    return;
  }
  const withoutQuery = withoutLineCol.split(/[?#]/, 1)[0] ?? withoutLineCol;
  if (/^[a-zA-Z]:[\\/]/.test(withoutQuery) && withoutQuery.length > 3) {
    keys.add(pathComparisonKey(withoutQuery));
  } else if (withoutQuery.startsWith("/") && !withoutQuery.startsWith("//") && withoutQuery.length > 1) {
    keys.add(pathComparisonKey(withoutQuery));
  }
}

function extractStackFrameComparisonKeys(stackText: string): string[] {
  const keys = new Set<string>();
  for (const rawLine of stackText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const parenLoc = extractBalancedCallSiteLocation(line);
    if (parenLoc !== undefined) {
      addNormalizedLocationKey(parenLoc, keys);
    }
    const atMatch = /^at\s+(?:async\s+)?(.+)$/.exec(line);
    if (atMatch?.[1] !== undefined && !atMatch[1].endsWith(")")) {
      addNormalizedLocationKey(atMatch[1], keys);
    }
    const jscAtIdx = line.indexOf("@");
    if (jscAtIdx >= 0 && jscAtIdx + 1 < line.length) {
      addNormalizedLocationKey(line.slice(jscAtIdx + 1), keys);
    }
  }
  for (const match of stackText.matchAll(/file:\/\/\/[^\s"'`<>|]+/gi)) {
    const token = match[0].replace(/\)+$/, "");
    addNormalizedLocationKey(token, keys);
  }
  return [...keys];
}
