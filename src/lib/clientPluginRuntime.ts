/**
 * Pure dynamic client-side plugin loader, module normalizer, and zero-reload
 * Fiber HMR reconciler (ADR 0016). Bound to PI-Desktop's unified frontend in
 * `src/lib/clientPluginBootstrap.ts`.
 */
import type { PluginClientBundleParams, PluginClientBundleResult, PluginInfo } from "@pid/protocol";

export type ModuleFactory = (require: (specifier: string) => unknown) => unknown;

export interface ModuleLoaderPayload {
  id: string;
  factory: ModuleFactory;
}

export interface ModuleLoaderGlobal {
  load(payload: ModuleLoaderPayload): void;
}

export interface ClientFiberLike extends Partial<PromiseLike<unknown>> {
  state?: number;
  dispose(): Promise<void>;
}

export interface ClientContextLike<P = unknown> {
  plugin(plugin: P, config?: Record<string, unknown>): ClientFiberLike;
}

/** Normalize an ES module namespace into an object compatible with both raw CJS `require()` and esbuild `__toESM`. */
export function normalizeSharedModule(raw: unknown): unknown {
  if ((typeof raw !== "object" && typeof raw !== "function") || raw === null) {
    return raw;
  }
  if (typeof raw === "function") {
    return raw;
  }
  const source = raw as Record<string, unknown>;
  const normalized: Record<string, unknown> = { __esModule: true };
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key === "string" && key !== "__esModule") {
      normalized[key] = source[key];
    }
  }
  const defaultExport = normalized.default;
  if ((typeof defaultExport === "object" || typeof defaultExport === "function") && defaultExport !== null) {
    for (const key of Object.keys(defaultExport)) {
      if (!(key in normalized)) {
        normalized[key] = (defaultExport as Record<string, unknown>)[key];
      }
    }
  } else if (!("default" in normalized)) {
    normalized.default = normalized;
  }
  return normalized;
}

/** Extract a Cordis plugin function/class/object from a CJS/ESM module's exports. */
export function resolveCordisPlugin<P = unknown>(pluginId: string, exported: unknown): P {
  if (typeof exported === "function") {
    return exported as P;
  }
  if (typeof exported === "object" && exported !== null) {
    const record = exported as Record<string, unknown>;
    if (typeof record.apply === "function") {
      return exported as P;
    }
    const def = record.default;
    if (typeof def === "function") {
      return def as P;
    }
    if (typeof def === "object" && def !== null && typeof (def as Record<string, unknown>).apply === "function") {
      return def as P;
    }
  }
  throw new Error(`客户端插件 "${pluginId}" 未导出有效的 Cordis 插件（需导出默认插件或 apply(ctx) 函数）`);
}

/** Execute a bundle string via a temporary same-origin `blob:` `<script>` tag. */
export async function executeBrowserBundleScript(code: string, pluginId: string): Promise<void> {
  if (typeof document === "undefined" || typeof Blob === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error(`当前运行环境不支持加载客户端插件 "${pluginId}" 的脚本`);
  }
  const blob = new Blob([`${code}\n//# sourceURL=pid-plugin://${encodeURIComponent(pluginId)}/client.js`], {
    type: "text/javascript",
  });
  const url = URL.createObjectURL(blob);
  const script = document.createElement("script");
  script.async = false;
  script.src = url;

  let scriptError: unknown;
  const onWindowError = (event: ErrorEvent): void => {
    if (event.filename === url || event.filename.includes(encodeURIComponent(pluginId))) {
      scriptError = event.error ?? new Error(event.message || `加载客户端插件 "${pluginId}" 脚本失败`);
      event.preventDefault();
    }
  };
  window.addEventListener("error", onWindowError);

  try {
    await new Promise<void>((resolve, reject) => {
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`无法加载客户端插件 "${pluginId}" 的脚本束`));
      document.head.appendChild(script);
    });
    if (scriptError !== undefined) {
      throw scriptError instanceof Error ? scriptError : new Error(String(scriptError));
    }
  } finally {
    window.removeEventListener("error", onWindowError);
    script.remove();
    URL.revokeObjectURL(url);
  }
}

let clientErrorsSnapshot: Readonly<Record<string, string>> = {};
const clientErrorListeners = new Set<() => void>();

function setClientPluginError(id: string, message: string | undefined): void {
  const current = clientErrorsSnapshot[id];
  if (current === message) return;
  const next = { ...clientErrorsSnapshot };
  if (message === undefined) delete next[id];
  else next[id] = message;
  clientErrorsSnapshot = next;
  for (const listener of clientErrorListeners) listener();
}

function clearMissingClientPluginErrors(validIds: ReadonlySet<string>): void {
  let changed = false;
  const next: Record<string, string> = {};
  for (const [id, message] of Object.entries(clientErrorsSnapshot)) {
    if (validIds.has(id)) next[id] = message;
    else changed = true;
  }
  if (!changed) return;
  clientErrorsSnapshot = next;
  for (const listener of clientErrorListeners) listener();
}

export function getClientPluginErrors(): Readonly<Record<string, string>> {
  return clientErrorsSnapshot;
}

export function subscribeClientPluginErrors(listener: () => void): () => void {
  clientErrorListeners.add(listener);
  return () => {
    clientErrorListeners.delete(listener);
  };
}

export interface ClientPluginTransport {
  list(workspace?: string): Promise<PluginInfo[]>;
  clientBundle(params: PluginClientBundleParams): Promise<PluginClientBundleResult>;
  onChanged(listener: () => void): () => void;
  onTrustChanged(listener: () => void): () => void;
  onHostReconnect?(listener: () => void): () => void;
}

export interface ClientPluginRuntimeOptions {
  transport: ClientPluginTransport;
  modules: Record<string, () => Promise<unknown>>;
  executeScript?: (code: string, pluginId: string) => Promise<void>;
  targetGlobal?: { __ModuleLoader__?: ModuleLoaderGlobal };
}

interface MountedClientPlugin<P> {
  id: string;
  sourceKey: string;
  etag: string;
  configKey: string;
  config: Record<string, unknown>;
  plugin: P;
  fiber: ClientFiberLike;
}

interface CachedBundle {
  etag: string;
  code: string;
  factory: ModuleFactory;
}

function pluginSourceKey(plugin: Pick<PluginInfo, "id" | "tier" | "workspace">, fallbackWorkspace?: string): string {
  return plugin.tier === "workspace"
    ? `workspace:${plugin.workspace ?? fallbackWorkspace ?? ""}:${plugin.id}`
    : `${plugin.tier}:${plugin.id}`;
}

export interface ClientPluginRuntimeHandle {
  setWorkspace(workspace: string | undefined): void;
  sync(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Install `window.__ModuleLoader__`, reconcile active external client plugins
 * onto `root`, and hot-swap individual Cordis Fibers when bundles or configs change.
 */
export function createClientPluginRuntime<P = unknown>(
  root: ClientContextLike<P>,
  options: ClientPluginRuntimeOptions,
): ClientPluginRuntimeHandle {
  const { transport, modules: moduleLoaders } = options;
  const executeScript = options.executeScript ?? executeBrowserBundleScript;
  const targetGlobal = options.targetGlobal ?? (globalThis as unknown as { __ModuleLoader__?: ModuleLoaderGlobal });

  const resolvedModules = new Map<string, unknown>();
  let preloadPromise: Promise<void> | undefined;

  const factories = new Map<string, ModuleFactory>();
  const capture: { payload?: ModuleLoaderPayload } = {};
  const latestCapturedFactory = (): ModuleFactory | undefined => capture.payload?.factory;

  const previousLoader = targetGlobal.__ModuleLoader__;
  targetGlobal.__ModuleLoader__ = {
    load(payload: ModuleLoaderPayload) {
      if (typeof payload?.id === "string" && typeof payload.factory === "function") {
        factories.set(payload.id, payload.factory);
        capture.payload = payload;
      }
      previousLoader?.load(payload);
    },
  };

  const ensureSharedModules = (): Promise<void> => {
    preloadPromise ??= (async () => {
      const entries = await Promise.all(
        Object.entries(moduleLoaders).map(async ([specifier, load]) => [specifier, normalizeSharedModule(await load())] as const),
      );
      for (const [specifier, value] of entries) {
        resolvedModules.set(specifier, value);
      }
    })();
    return preloadPromise;
  };

  const requireShared = (specifier: string): unknown => {
    if (resolvedModules.has(specifier)) {
      return resolvedModules.get(specifier);
    }
    throw new Error(`客户端插件请求了未注册的共享模块 "${specifier}"`);
  };

  const mounted = new Map<string, MountedClientPlugin<P>>();
  const bundleCache = new Map<string, CachedBundle>();
  let workspace: string | undefined;
  let disposed = false;
  let syncChain: Promise<void> = Promise.resolve();

  const loadFactory = async (plugin: PluginInfo, sourceKey: string): Promise<{ etag: string; code: string; factory: ModuleFactory }> => {
    const cached = bundleCache.get(sourceKey);
    if (cached !== undefined && plugin.clientEtag !== undefined && cached.etag === plugin.clientEtag) {
      return cached;
    }
    const effectiveWorkspace = plugin.tier === "workspace" ? (plugin.workspace ?? workspace) : workspace;
    const response = await transport.clientBundle({
      id: plugin.id,
      ...(effectiveWorkspace === undefined || effectiveWorkspace === "" ? {} : { workspace: effectiveWorkspace }),
      ...(cached === undefined ? {} : { ifNoneMatch: cached.etag }),
    });
    if (response.notModified === true && cached !== undefined) {
      return cached;
    }
    const code = response.code;
    if (typeof code !== "string" || code.trim() === "") {
      throw new Error(`客户端插件 "${plugin.id}" 返回了空脚本内容`);
    }
    capture.payload = undefined;
    factories.delete(plugin.id);
    await executeScript(code, plugin.id);
    const factory = factories.get(plugin.id) ?? latestCapturedFactory();
    if (factory === undefined) {
      throw new Error(`客户端插件 "${plugin.id}" 未通过 window.__ModuleLoader__.load 注册模块工厂`);
    }
    factories.set(plugin.id, factory);
    const entry: CachedBundle = { etag: response.etag, code, factory };
    bundleCache.set(sourceKey, entry);
    return entry;
  };

  const reconcileOnce = async (): Promise<void> => {
    if (disposed) return;
    let plugins: PluginInfo[];
    try {
      plugins = await transport.list(workspace);
    } catch {
      return;
    }
    if (disposed) return;

    const validIds = new Set(plugins.map((item) => item.id));
    const validKeys = new Set(plugins.map((item) => pluginSourceKey(item, workspace)));
    clearMissingClientPluginErrors(validIds);

    const desired = plugins.filter(
      (item) => item.hasClient && item.status === "active" && item.tier !== "builtin",
    );
    const desiredKeys = new Set(desired.map((item) => pluginSourceKey(item, workspace)));
    const desiredIds = new Set(desired.map((item) => item.id));

    for (const [key, active] of [...mounted.entries()]) {
      if (!desiredKeys.has(key)) {
        mounted.delete(key);
        if (!desiredIds.has(active.id)) {
          setClientPluginError(active.id, undefined);
        }
        await active.fiber.dispose().catch(() => undefined);
      }
    }
    for (const key of [...bundleCache.keys()]) {
      if (!validKeys.has(key)) bundleCache.delete(key);
    }

    if (desired.length === 0) return;
    await ensureSharedModules();
    if (disposed) return;

    for (const item of desired) {
      const sourceKey = pluginSourceKey(item, workspace);
      const config = item.config ?? {};
      const configKey = JSON.stringify(config);
      const current = mounted.get(sourceKey);
      if (
        current !== undefined &&
        item.clientEtag !== undefined &&
        current.etag === item.clientEtag &&
        current.configKey === configKey &&
        clientErrorsSnapshot[item.id] === undefined
      ) {
        continue;
      }

      try {
        const loaded = await loadFactory(item, sourceKey);
        if (disposed) return;
        const exported = loaded.factory(requireShared);
        const nextPlugin = resolveCordisPlugin<P>(item.id, exported);

        if (current !== undefined) {
          await current.fiber.dispose().catch(() => undefined);
        }
        let nextFiber: ClientFiberLike | undefined;
        try {
          nextFiber = root.plugin(nextPlugin, config);
          if (typeof nextFiber.then === "function") {
            if (nextFiber.state === 0) {
              nextFiber.then(undefined, (err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                setClientPluginError(item.id, msg);
              });
            } else {
              await (nextFiber as PromiseLike<unknown>);
            }
          }
          mounted.set(sourceKey, {
            id: item.id,
            sourceKey,
            etag: loaded.etag,
            configKey,
            config,
            plugin: nextPlugin,
            fiber: nextFiber,
          });
          setClientPluginError(item.id, undefined);
        } catch (mountError) {
          await nextFiber?.dispose().catch(() => undefined);
          if (current !== undefined) {
            try {
              const restoredFiber = root.plugin(current.plugin, current.config);
              if (typeof restoredFiber.then === "function" && restoredFiber.state !== 0) {
                await (restoredFiber as PromiseLike<unknown>);
              }
              mounted.set(sourceKey, { ...current, fiber: restoredFiber });
            } catch {
              mounted.delete(sourceKey);
            }
          }
          throw mountError;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setClientPluginError(item.id, message);
        console.error(`[pid-client-plugins] failed to load "${item.id}":`, error);
      }
    }
  };

  const sync = (): Promise<void> => {
    syncChain = syncChain.then(reconcileOnce, reconcileOnce);
    return syncChain;
  };

  const unsubscribers = [
    transport.onChanged(() => {
      void sync();
    }),
    transport.onTrustChanged(() => {
      void sync();
    }),
  ];
  if (transport.onHostReconnect !== undefined) {
    unsubscribers.push(
      transport.onHostReconnect(() => {
        void sync();
      }),
    );
  }

  void sync();

  return {
    setWorkspace(nextWorkspace: string | undefined) {
      const normalized = nextWorkspace?.trim() || undefined;
      if (workspace === normalized) return;
      workspace = normalized;
      void sync();
    },
    sync,
    async dispose() {
      disposed = true;
      for (const unsub of unsubscribers) unsub();
      if (targetGlobal.__ModuleLoader__ !== undefined && previousLoader === undefined) {
        delete targetGlobal.__ModuleLoader__;
      } else if (previousLoader !== undefined) {
        targetGlobal.__ModuleLoader__ = previousLoader;
      }
      const activeList = [...mounted.values()].reverse();
      mounted.clear();
      for (const active of activeList) {
        await active.fiber.dispose().catch(() => undefined);
      }
    },
  };
}
