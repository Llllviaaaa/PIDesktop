/**
 * Pure dynamic client-side plugin loader, module normalizer, and zero-reload
 * Fiber HMR reconciler (ADR 0016). Bound to Qianji's unified frontend in
 * `src/lib/clientPluginBootstrap.ts`.
 */
import type {
  PluginChangedNotification,
  PluginClearClientErrorParams,
  PluginClientBundleParams,
  PluginClientBundleResult,
  PluginInfo,
  PluginReportClientErrorParams,
} from "@qianji/protocol";
import {
  reportFrontendError,
  type CrashLogLimiter,
  type FrontendLogSink,
} from "./crashLogger";

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
  on?(event: string, listener: (...args: unknown[]) => void): () => void;
}

export interface ClientPluginRuntimeMeta {
  id: string;
  etag: string;
  configKey: string;
  config: Record<string, unknown>;
  reloadEpoch: number;
}

export interface ClientPluginRenderError {
  message: string;
  stack?: string;
  failedEtag: string;
  failedConfigKey: string;
  failedReloadEpoch: number;
  failedSlots: Readonly<Record<string, string>>;
}

export interface ClientPluginActivationError {
  message: string;
  stack?: string;
  failedSourceKey: string;
  failedEtag: string;
  failedConfigKey: string;
  failedReloadEpoch: number;
}

const fiberToPluginId = new WeakMap<object, string>();

/** Associate a Cordis Fiber object with an owning plugin ID. */
export function tagFiberPluginId(fiber: object, pluginId: string): void {
  fiberToPluginId.set(fiber, pluginId);
}

/** Walk a Cordis `Context`'s fiber ancestry to determine which external plugin owns the call. */
export function resolveContextPluginId(ctx: unknown): string | undefined {
  if (typeof ctx !== "object" || ctx === null) return undefined;
  let cursor: unknown = (ctx as { fiber?: unknown }).fiber;
  let guard = 0;
  while (typeof cursor === "object" && cursor !== null && guard < 32) {
    const tagged = fiberToPluginId.get(cursor);
    if (tagged !== undefined) return tagged;
    cursor = (cursor as { parent?: { fiber?: unknown } }).parent?.fiber;
    guard += 1;
  }
  return undefined;
}

function isCssIdentChar(ch: string | undefined): boolean {
  if (ch === undefined || ch === "") return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 95 ||
    code >= 128
  );
}

/**
 * Sanitize plugin CSS body so unmatched `}`, unclosed comments, or unclosed strings
 * can never escape the enclosing `@layer plugin-ui { @scope (...) { ... } }` block,
 * and rewrite standalone `:root` selectors to `:scope` so plugin custom properties
 * resolve on `[data-qj-plugin="<id>"]` without leaking globally.
 */
function sanitizePluginScopedCssBody(css: string): string {
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    const next = css[i + 1];
    if (ch === "/" && next === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) {
        out += `${css.slice(i)}*/`;
        break;
      }
      out += css.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += quote;
      i += 1;
      let closed = false;
      while (i < css.length) {
        const c = css[i];
        out += c;
        i += 1;
        if (c === "\\" && i < css.length) {
          out += css[i];
          i += 1;
          continue;
        }
        if (c === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) out += quote;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      out += "{";
      i += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        out += "}";
      }
      i += 1;
      continue;
    }
    if (
      ch === ":" &&
      css.slice(i, i + 5).toLowerCase() === ":root" &&
      !isCssIdentChar(i > 0 ? css[i - 1] : undefined) &&
      !isCssIdentChar(css[i + 5])
    ) {
      const afterRoot = css[i + 5];
      if (afterRoot !== "[" && afterRoot !== "." && afterRoot !== ":") {
        out += ":scope";
        i += 5;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  if (depth > 0) {
    out += "}".repeat(depth);
  }
  return out;
}

/** Wrap raw plugin CSS inside `@layer plugin-ui { @scope ([data-qj-plugin="<id>"]) { ... } }`. */
export function wrapPluginScopedCss(pluginId: string, css: string): string {
  const trimmed = css.trim();
  if (trimmed === "") return "";
  const escapedId = pluginId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeBody = sanitizePluginScopedCssBody(css);
  return `@layer plugin-ui {\n@scope ([data-qj-plugin="${escapedId}"]) {\n${safeBody}\n}\n}`;
}

interface TrackedPluginStyleEntry {
  el: HTMLStyleElement;
  seq: number;
}

const pluginStyleElements = new Map<string, Map<string, TrackedPluginStyleEntry>>();
let dynamicStyleSeq = 0;

/** Inject scoped CSS for `pluginId` into `document.head` and return an idempotent disposer. */
export function injectPluginScopedStyle(pluginId: string, css: string, styleKey?: string): () => void {
  if (typeof document === "undefined" || document.head === null) {
    return () => undefined;
  }
  dynamicStyleSeq += 1;
  const writeSeq = dynamicStyleSeq;
  const resolvedKey = styleKey ?? `inline-${writeSeq}`;
  let perPlugin = pluginStyleElements.get(pluginId);
  if (perPlugin === undefined) {
    perPlugin = new Map<string, TrackedPluginStyleEntry>();
    pluginStyleElements.set(pluginId, perPlugin);
  }
  let tracked = perPlugin.get(resolvedKey);
  if (tracked === undefined || !tracked.el.isConnected) {
    const styleEl = document.createElement("style");
    styleEl.setAttribute("data-qj-plugin-style", pluginId);
    styleEl.setAttribute("data-qj-style-key", resolvedKey);
    document.head.appendChild(styleEl);
    tracked = { el: styleEl, seq: writeSeq };
    perPlugin.set(resolvedKey, tracked);
  } else {
    tracked.seq = writeSeq;
  }
  const ownedEl = tracked.el;
  ownedEl.textContent = wrapPluginScopedCss(pluginId, css);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const map = pluginStyleElements.get(pluginId);
    if (map?.get(resolvedKey)?.el === ownedEl) {
      map.delete(resolvedKey);
      if (map.size === 0) pluginStyleElements.delete(pluginId);
    }
    ownedEl.remove();
  };
}

function snapshotBundleScopedStyles(pluginId: string): Map<string, { el: HTMLStyleElement; text: string; seq: number }> {
  const snap = new Map<string, { el: HTMLStyleElement; text: string; seq: number }>();
  const perPlugin = pluginStyleElements.get(pluginId);
  if (perPlugin === undefined) return snap;
  for (const [key, entry] of perPlugin.entries()) {
    if (!key.startsWith("inline-")) {
      snap.set(key, { el: entry.el, text: entry.el.textContent ?? "", seq: entry.seq });
    }
  }
  return snap;
}

function pruneStaleBundleStyles(pluginId: string, seqBefore: number): void {
  const perPlugin = pluginStyleElements.get(pluginId);
  if (perPlugin === undefined) return;
  for (const [key, entry] of [...perPlugin.entries()]) {
    if (!key.startsWith("inline-") && entry.seq <= seqBefore) {
      entry.el.remove();
      perPlugin.delete(key);
    }
  }
  if (perPlugin.size === 0) {
    pluginStyleElements.delete(pluginId);
  }
}

function rollbackBundleScopedStyles(
  pluginId: string,
  snapshot: ReadonlyMap<string, { el: HTMLStyleElement; text: string; seq: number }>,
  seqBefore: number,
): void {
  const perPlugin = pluginStyleElements.get(pluginId);
  if (perPlugin !== undefined) {
    for (const [key, entry] of [...perPlugin.entries()]) {
      if (entry.seq > seqBefore && !snapshot.has(key)) {
        entry.el.remove();
        perPlugin.delete(key);
      }
    }
  }
  if (snapshot.size === 0) {
    if (perPlugin !== undefined && perPlugin.size === 0) {
      pluginStyleElements.delete(pluginId);
    }
    return;
  }
  let targetMap = pluginStyleElements.get(pluginId);
  if (targetMap === undefined) {
    targetMap = new Map<string, TrackedPluginStyleEntry>();
    pluginStyleElements.set(pluginId, targetMap);
  }
  for (const [key, prev] of snapshot.entries()) {
    if (!prev.el.isConnected && typeof document !== "undefined" && document.head !== null) {
      document.head.appendChild(prev.el);
    }
    prev.el.textContent = prev.text;
    targetMap.set(key, { el: prev.el, seq: prev.seq });
  }
}

/** Remove all injected `<style>` elements belonging to `pluginId`. */
export function removeAllPluginScopedStyles(pluginId: string): void {
  const perPlugin = pluginStyleElements.get(pluginId);
  if (perPlugin !== undefined) {
    for (const entry of perPlugin.values()) {
      entry.el.remove();
    }
    pluginStyleElements.delete(pluginId);
  }
  if (typeof document !== "undefined") {
    const selector = `style[data-qj-plugin-style="${pluginId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
    for (const orphan of Array.from(document.querySelectorAll(selector))) {
      orphan.remove();
    }
  }
}

const globalStyleHost = globalThis as unknown as {
  __qianjiInjectPluginStyle?: (pluginId: string, css: string, styleKey?: string) => () => void;
};
globalStyleHost.__qianjiInjectPluginStyle ??= injectPluginScopedStyle;

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
  const blob = new Blob([`${code}\n//# sourceURL=qianji-plugin://${encodeURIComponent(pluginId)}/client.js`], {
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

let activationErrorsSnapshot: Readonly<Record<string, string>> = {};
let activationErrorDetailsSnapshot: Readonly<Record<string, ClientPluginActivationError>> = {};
let renderErrorsSnapshot: Readonly<Record<string, ClientPluginRenderError>> = {};
let clientErrorsSnapshot: Readonly<Record<string, string>> = {};
let runtimeMetaSnapshot: Readonly<Record<string, ClientPluginRuntimeMeta>> = {};
const pluginReloadEpochs = new Map<string, number>();
const clientErrorListeners = new Set<() => void>();

let activeErrorReporter: ((params: PluginReportClientErrorParams) => Promise<unknown>) | undefined;
let activeErrorClearer: ((params: PluginClearClientErrorParams) => Promise<unknown>) | undefined;
let activeFrontendErrorSink: FrontendLogSink | undefined;
let activeFrontendErrorLimiter: CrashLogLimiter | undefined;

function getPluginReloadEpoch(id: string): number {
  return pluginReloadEpochs.get(id) ?? runtimeMetaSnapshot[id]?.reloadEpoch ?? 0;
}

function bumpPluginReloadEpoch(id: string): number {
  const nextEpoch = getPluginReloadEpoch(id) + 1;
  pluginReloadEpochs.set(id, nextEpoch);
  const prevMeta = runtimeMetaSnapshot[id];
  if (prevMeta !== undefined) {
    runtimeMetaSnapshot = {
      ...runtimeMetaSnapshot,
      [id]: { ...prevMeta, reloadEpoch: nextEpoch },
    };
  }
  return nextEpoch;
}

function notifyClientStateListeners(): void {
  const combined: Record<string, string> = {};
  for (const [id, msg] of Object.entries(renderErrorsSnapshot)) {
    combined[id] = msg.message;
  }
  for (const [id, msg] of Object.entries(activationErrorsSnapshot)) {
    combined[id] = msg;
  }
  clientErrorsSnapshot = combined;
  for (const listener of clientErrorListeners) listener();
}

function setClientRuntimeMeta(id: string, next: Omit<ClientPluginRuntimeMeta, "reloadEpoch"> | undefined): void {
  const prev = runtimeMetaSnapshot[id];
  if (next === undefined) {
    if (prev === undefined) return;
    const copy = { ...runtimeMetaSnapshot };
    delete copy[id];
    runtimeMetaSnapshot = copy;
    notifyClientStateListeners();
    return;
  }
  const reloadEpoch = getPluginReloadEpoch(id);
  if (
    prev !== undefined &&
    prev.etag === next.etag &&
    prev.configKey === next.configKey &&
    prev.config === next.config &&
    prev.reloadEpoch === reloadEpoch
  ) {
    return;
  }
  runtimeMetaSnapshot = {
    ...runtimeMetaSnapshot,
    [id]: { ...next, reloadEpoch },
  };
  const existingRenderErr = renderErrorsSnapshot[id];
  if (
    existingRenderErr !== undefined &&
    (existingRenderErr.failedEtag !== next.etag || existingRenderErr.failedConfigKey !== next.configKey)
  ) {
    const nextRender = { ...renderErrorsSnapshot };
    delete nextRender[id];
    renderErrorsSnapshot = nextRender;
  }
  notifyClientStateListeners();
}

function setClientActivationError(
  id: string,
  error:
    | {
        message: string;
        stack?: string;
        etag?: string;
        failedSourceKey?: string;
        failedConfigKey?: string;
        failedReloadEpoch?: number;
      }
    | undefined,
): void {
  const current = activationErrorsSnapshot[id];
  const prevDetail = activationErrorDetailsSnapshot[id];
  const nextMessage = error?.message;
  const nextDetail: ClientPluginActivationError | undefined =
    error === undefined
      ? undefined
      : {
          message: error.message,
          ...(error.stack === undefined ? {} : { stack: error.stack }),
          failedSourceKey: error.failedSourceKey ?? "",
          failedEtag: error.etag ?? "",
          failedConfigKey: error.failedConfigKey ?? "{}",
          failedReloadEpoch: error.failedReloadEpoch ?? getPluginReloadEpoch(id),
        };

  const detailUnchanged =
    prevDetail?.message === nextDetail?.message &&
    prevDetail?.failedSourceKey === nextDetail?.failedSourceKey &&
    prevDetail?.failedEtag === nextDetail?.failedEtag &&
    prevDetail?.failedConfigKey === nextDetail?.failedConfigKey &&
    prevDetail?.failedReloadEpoch === nextDetail?.failedReloadEpoch;
  if (current === nextMessage && detailUnchanged) return;

  const next = { ...activationErrorsSnapshot };
  const nextDetails = { ...activationErrorDetailsSnapshot };
  if (nextMessage === undefined || nextDetail === undefined) {
    delete next[id];
    delete nextDetails[id];
  } else {
    next[id] = nextMessage;
    nextDetails[id] = nextDetail;
  }
  activationErrorsSnapshot = next;
  activationErrorDetailsSnapshot = nextDetails;
  notifyClientStateListeners();

  if (error !== undefined) {
    if (current !== nextMessage || prevDetail?.failedEtag !== nextDetail?.failedEtag) {
      void reportFrontendError(`plugin-load:${id}`, error.message, {
        ...(error.stack === undefined ? {} : { extraStack: error.stack }),
        ...(activeFrontendErrorSink === undefined ? {} : { sink: activeFrontendErrorSink }),
        ...(activeFrontendErrorLimiter === undefined ? {} : { limiter: activeFrontendErrorLimiter }),
      }).catch(() => undefined);
      void activeErrorReporter?.({
        id,
        phase: "load",
        message: error.message,
        ...(error.stack === undefined ? {} : { stack: error.stack }),
        ...(error.etag === undefined || error.etag === "" ? {} : { etag: error.etag }),
      }).catch(() => undefined);
    }
  } else if (renderErrorsSnapshot[id] === undefined) {
    void activeErrorClearer?.({ id }).catch(() => undefined);
  }
}

function clearMissingClientPluginErrors(validIds: ReadonlySet<string>): void {
  let changed = false;
  const nextActivation: Record<string, string> = {};
  for (const [id, message] of Object.entries(activationErrorsSnapshot)) {
    if (validIds.has(id)) nextActivation[id] = message;
    else changed = true;
  }
  const nextActivationDetails: Record<string, ClientPluginActivationError> = {};
  for (const [id, detail] of Object.entries(activationErrorDetailsSnapshot)) {
    if (validIds.has(id)) nextActivationDetails[id] = detail;
    else changed = true;
  }
  const nextRender: Record<string, ClientPluginRenderError> = {};
  for (const [id, entry] of Object.entries(renderErrorsSnapshot)) {
    if (validIds.has(id)) nextRender[id] = entry;
    else changed = true;
  }
  const nextMeta: Record<string, ClientPluginRuntimeMeta> = {};
  for (const [id, meta] of Object.entries(runtimeMetaSnapshot)) {
    if (validIds.has(id)) nextMeta[id] = meta;
    else changed = true;
  }
  for (const id of [...pluginReloadEpochs.keys()]) {
    if (!validIds.has(id)) pluginReloadEpochs.delete(id);
  }
  if (!changed) return;
  activationErrorsSnapshot = nextActivation;
  activationErrorDetailsSnapshot = nextActivationDetails;
  renderErrorsSnapshot = nextRender;
  runtimeMetaSnapshot = nextMeta;
  notifyClientStateListeners();
}

/** Record a UI slot or handler error for `pluginId` without triggering a Fiber remount loop. */
export function recordClientRenderError(pluginId: string | undefined, slotId: string, error: unknown): void {
  if (pluginId === undefined || pluginId === "") return;
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const meta = runtimeMetaSnapshot[pluginId];
  const failedEtag = meta?.etag ?? "";
  const failedConfigKey = meta?.configKey ?? "{}";
  const failedReloadEpoch = getPluginReloadEpoch(pluginId);

  const prev = renderErrorsSnapshot[pluginId];
  const sameCycle =
    prev !== undefined &&
    prev.failedEtag === failedEtag &&
    prev.failedConfigKey === failedConfigKey &&
    prev.failedReloadEpoch === failedReloadEpoch;
  if (sameCycle && prev.failedSlots[slotId] === message) {
    return;
  }

  const nextEntry: ClientPluginRenderError = {
    message,
    ...(stack === undefined ? {} : { stack }),
    failedEtag,
    failedConfigKey,
    failedReloadEpoch,
    failedSlots: {
      ...(sameCycle ? prev.failedSlots : {}),
      [slotId]: message,
    },
  };
  renderErrorsSnapshot = {
    ...renderErrorsSnapshot,
    [pluginId]: nextEntry,
  };
  notifyClientStateListeners();

  void activeErrorReporter?.({
    id: pluginId,
    phase: "render",
    message,
    ...(stack === undefined ? {} : { stack }),
    ...(failedEtag === "" ? {} : { etag: failedEtag }),
  }).catch(() => undefined);
}

/** Clear render and activation lockout state for `pluginId` (e.g. when user clicks manual Reload). */
export function clearClientRenderError(pluginId: string, bumpEpoch = true): void {
  const hadRender = pluginId in renderErrorsSnapshot;
  const hadActivation = pluginId in activationErrorsSnapshot;
  const prevMeta = runtimeMetaSnapshot[pluginId];
  if (!hadRender && !hadActivation && (!bumpEpoch || prevMeta === undefined)) {
    if (bumpEpoch && pluginId !== "") {
      bumpPluginReloadEpoch(pluginId);
    }
    return;
  }

  if (hadRender) {
    const nextRender = { ...renderErrorsSnapshot };
    delete nextRender[pluginId];
    renderErrorsSnapshot = nextRender;
  }
  if (bumpEpoch) {
    bumpPluginReloadEpoch(pluginId);
    if (hadActivation) {
      const nextAct = { ...activationErrorsSnapshot };
      const nextActDetails = { ...activationErrorDetailsSnapshot };
      delete nextAct[pluginId];
      delete nextActDetails[pluginId];
      activationErrorsSnapshot = nextAct;
      activationErrorDetailsSnapshot = nextActDetails;
    }
  }
  notifyClientStateListeners();
  if (activationErrorsSnapshot[pluginId] === undefined) {
    void activeErrorClearer?.({ id: pluginId }).catch(() => undefined);
  }
}

/** Check whether a specific slot of `pluginId` crashed on the current `(etag, configKey, reloadEpoch)` cycle. */
export function getClientSlotLockout(
  pluginId: string | undefined,
  slotId: string,
): { locked: boolean; message?: string; stack?: string } {
  if (pluginId === undefined || pluginId === "") return { locked: false };
  const err = renderErrorsSnapshot[pluginId];
  if (err === undefined) return { locked: false };
  const slotMessage = err.failedSlots[slotId];
  if (slotMessage === undefined) return { locked: false };
  const meta = runtimeMetaSnapshot[pluginId];
  const currentEtag = meta?.etag ?? "";
  const currentConfigKey = meta?.configKey ?? "{}";
  const currentEpoch = getPluginReloadEpoch(pluginId);
  if (
    err.failedEtag === currentEtag &&
    err.failedConfigKey === currentConfigKey &&
    err.failedReloadEpoch === currentEpoch
  ) {
    return {
      locked: true,
      message: slotMessage,
      ...(err.stack === undefined ? {} : { stack: err.stack }),
    };
  }
  return { locked: false };
}

export function getClientPluginRuntimeMetaSnapshot(): Readonly<Record<string, ClientPluginRuntimeMeta>> {
  return runtimeMetaSnapshot;
}

export function getClientPluginRuntimeMeta(pluginId: string): ClientPluginRuntimeMeta | undefined {
  return runtimeMetaSnapshot[pluginId];
}

export function getClientRenderErrors(): Readonly<Record<string, ClientPluginRenderError>> {
  return renderErrorsSnapshot;
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
  reportClientError?(params: PluginReportClientErrorParams): Promise<unknown>;
  clearClientError?(params: PluginClearClientErrorParams): Promise<unknown>;
  onChanged(listener: (payload?: PluginChangedNotification) => void): () => void;
  onTrustChanged(listener: () => void): () => void;
  onHostReconnect?(listener: () => void): () => void;
}

export interface ClientPluginRuntimeOptions {
  transport: ClientPluginTransport;
  modules: Record<string, () => Promise<unknown>>;
  executeScript?: (code: string, pluginId: string) => Promise<void>;
  frontendErrorSink?: FrontendLogSink;
  frontendErrorLimiter?: CrashLogLimiter;
  targetGlobal?: {
    __ModuleLoader__?: ModuleLoaderGlobal;
    __qianjiInjectPluginStyle?: (pluginId: string, css: string, styleKey?: string) => () => void;
  };
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
  const targetGlobal = options.targetGlobal ?? (globalThis as unknown as {
    __ModuleLoader__?: ModuleLoaderGlobal;
    __qianjiInjectPluginStyle?: (pluginId: string, css: string, styleKey?: string) => () => void;
  });

  if (transport.reportClientError !== undefined) {
    activeErrorReporter = (params) => transport.reportClientError?.(params) ?? Promise.resolve();
  }
  if (transport.clearClientError !== undefined) {
    activeErrorClearer = (params) => transport.clearClientError?.(params) ?? Promise.resolve();
  }
  activeFrontendErrorSink = options.frontendErrorSink;
  activeFrontendErrorLimiter = options.frontendErrorLimiter;

  const resolvedModules = new Map<string, unknown>();
  let preloadPromise: Promise<void> | undefined;

  const factories = new Map<string, ModuleFactory>();
  const capture: { payload?: ModuleLoaderPayload } = {};
  const latestCapturedFactory = (): ModuleFactory | undefined => capture.payload?.factory;

  const previousLoader = targetGlobal.__ModuleLoader__;
  const previousStyleInjector = targetGlobal.__qianjiInjectPluginStyle;
  targetGlobal.__qianjiInjectPluginStyle = injectPluginScopedStyle;
  targetGlobal.__ModuleLoader__ = {
    load(payload: ModuleLoaderPayload) {
      if (typeof payload?.id === "string" && typeof payload.factory === "function") {
        factories.set(payload.id, payload.factory);
        capture.payload = payload;
      }
      previousLoader?.load(payload);
    },
  };

  let mountingPluginId: string | undefined;
  const offInternalPlugin = typeof root.on === "function"
    ? root.on("internal/plugin", (fiber: unknown) => {
        if (typeof fiber !== "object" || fiber === null) return;
        if (mountingPluginId !== undefined) {
          fiberToPluginId.set(fiber, mountingPluginId);
          return;
        }
        let cursor: unknown = (fiber as { parent?: { fiber?: unknown } }).parent?.fiber;
        let guard = 0;
        while (typeof cursor === "object" && cursor !== null && guard < 32) {
          const inherited = fiberToPluginId.get(cursor);
          if (inherited !== undefined) {
            fiberToPluginId.set(fiber, inherited);
            return;
          }
          cursor = (cursor as { parent?: { fiber?: unknown } }).parent?.fiber;
          guard += 1;
        }
      })
    : undefined;

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
  const seenPluginIds = new Set<string>();
  let workspace: string | undefined;
  let disposed = false;
  let syncChain: Promise<void> = Promise.resolve();

  const loadFactory = async (
    plugin: PluginInfo,
    sourceKey: string,
  ): Promise<{ etag: string; code: string; factory: ModuleFactory; executedFreshScript: boolean }> => {
    const cached = bundleCache.get(sourceKey);
    if (cached !== undefined && plugin.clientEtag !== undefined && cached.etag === plugin.clientEtag) {
      return { ...cached, executedFreshScript: false };
    }
    const effectiveWorkspace = plugin.tier === "workspace" ? (plugin.workspace ?? workspace) : workspace;
    const response = await transport.clientBundle({
      id: plugin.id,
      ...(effectiveWorkspace === undefined || effectiveWorkspace === "" ? {} : { workspace: effectiveWorkspace }),
      ...(cached === undefined ? {} : { ifNoneMatch: cached.etag }),
    });
    if (response.notModified === true && cached !== undefined) {
      return { ...cached, executedFreshScript: false };
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
    return { ...entry, executedFreshScript: true };
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
    for (const id of validIds) seenPluginIds.add(id);
    const validKeys = new Set(plugins.map((item) => pluginSourceKey(item, workspace)));
    clearMissingClientPluginErrors(validIds);

    const desired = plugins.filter(
      (item) =>
        item.hasClient &&
        item.status === "active" &&
        (item.tier !== "builtin" || item.clientPath !== undefined || item.clientEtag !== undefined),
    );
    const desiredKeys = new Set(desired.map((item) => pluginSourceKey(item, workspace)));
    const desiredIds = new Set(desired.map((item) => item.id));

    for (const [key, active] of [...mounted.entries()]) {
      if (!desiredKeys.has(key)) {
        mounted.delete(key);
        if (!desiredIds.has(active.id)) {
          setClientActivationError(active.id, undefined);
          clearClientRenderError(active.id, false);
          setClientRuntimeMeta(active.id, undefined);
          removeAllPluginScopedStyles(active.id);
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
      const reloadEpoch = getPluginReloadEpoch(item.id);

      const actErr = activationErrorDetailsSnapshot[item.id];
      if (
        actErr !== undefined &&
        item.clientEtag !== undefined &&
        item.clientEtag !== "" &&
        actErr.failedSourceKey === sourceKey &&
        actErr.failedEtag === item.clientEtag &&
        actErr.failedConfigKey === configKey &&
        actErr.failedReloadEpoch === reloadEpoch
      ) {
        continue;
      }

      const current = mounted.get(sourceKey);
      if (
        current !== undefined &&
        item.clientEtag !== undefined &&
        current.etag === item.clientEtag &&
        current.configKey === configKey &&
        activationErrorsSnapshot[item.id] === undefined
      ) {
        continue;
      }

      const bundleStyleSnap = snapshotBundleScopedStyles(item.id);
      const seqBefore = dynamicStyleSeq;
      let loadedEtag = item.clientEtag;

      try {
        const loaded = await loadFactory(item, sourceKey);
        loadedEtag = loaded.etag;
        if (disposed) return;
        const exported = loaded.factory(requireShared);
        const nextPlugin = resolveCordisPlugin<P>(item.id, exported);

        if (current !== undefined) {
          await current.fiber.dispose().catch(() => undefined);
        }
        let nextFiber: ClientFiberLike | undefined;
        try {
          mountingPluginId = item.id;
          try {
            nextFiber = root.plugin(nextPlugin, config);
            if (typeof nextFiber === "object" && nextFiber !== null) {
              fiberToPluginId.set(nextFiber, item.id);
            }
          } finally {
            mountingPluginId = undefined;
          }
          if (typeof nextFiber.then === "function") {
            if (nextFiber.state === 0) {
              const asyncFiber = nextFiber;
              nextFiber.then(undefined, (err: unknown) => {
                void asyncFiber.dispose().catch(() => undefined);
                if (mounted.get(sourceKey)?.fiber === asyncFiber) {
                  mounted.delete(sourceKey);
                }
                const msg = err instanceof Error ? err.message : String(err);
                const stack = err instanceof Error ? err.stack : undefined;
                setClientActivationError(item.id, {
                  message: msg,
                  ...(stack === undefined ? {} : { stack }),
                  etag: loaded.etag,
                  failedSourceKey: sourceKey,
                  failedConfigKey: configKey,
                  failedReloadEpoch: reloadEpoch,
                });
              });
            } else {
              await (nextFiber as PromiseLike<unknown>);
            }
          }
          if (loaded.executedFreshScript) {
            pruneStaleBundleStyles(item.id, seqBefore);
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
          setClientRuntimeMeta(item.id, {
            id: item.id,
            etag: loaded.etag,
            configKey,
            config,
          });
          setClientActivationError(item.id, undefined);
        } catch (mountError) {
          await nextFiber?.dispose().catch(() => undefined);
          rollbackBundleScopedStyles(item.id, bundleStyleSnap, seqBefore);
          if (current !== undefined) {
            try {
              mountingPluginId = item.id;
              let restoredFiber: ClientFiberLike;
              try {
                restoredFiber = root.plugin(current.plugin, current.config);
                if (typeof restoredFiber === "object" && restoredFiber !== null) {
                  fiberToPluginId.set(restoredFiber, item.id);
                }
              } finally {
                mountingPluginId = undefined;
              }
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
        rollbackBundleScopedStyles(item.id, bundleStyleSnap, seqBefore);
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        setClientActivationError(item.id, {
          message,
          ...(stack === undefined ? {} : { stack }),
          ...(loadedEtag === undefined ? {} : { etag: loadedEtag }),
          failedSourceKey: sourceKey,
          failedConfigKey: configKey,
          failedReloadEpoch: reloadEpoch,
        });
        console.error(`[qianji-client-plugins] failed to load "${item.id}":`, error);
      }
    }
  };

  const sync = (): Promise<void> => {
    syncChain = syncChain.then(reconcileOnce, reconcileOnce);
    return syncChain;
  };

  const unsubscribers = [
    transport.onChanged((payload) => {
      if (payload?.reason === "clientError") return;
      if (payload?.reason === "reloaded") {
        const ids = payload.changedIds.length > 0 ? payload.changedIds : [...seenPluginIds];
        for (const id of ids) {
          clearClientRenderError(id, true);
          for (const key of [...bundleCache.keys()]) {
            if (key.endsWith(`:${id}`)) bundleCache.delete(key);
          }
        }
      }
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
      offInternalPlugin?.();
      for (const unsub of unsubscribers) unsub();
      if (targetGlobal.__ModuleLoader__ !== undefined && previousLoader === undefined) {
        delete targetGlobal.__ModuleLoader__;
      } else if (previousLoader !== undefined) {
        targetGlobal.__ModuleLoader__ = previousLoader;
      }
      if (previousStyleInjector === undefined) {
        delete targetGlobal.__qianjiInjectPluginStyle;
      } else {
        targetGlobal.__qianjiInjectPluginStyle = previousStyleInjector;
      }
      const activeList = [...mounted.values()].reverse();
      mounted.clear();
      for (const active of activeList) {
        removeAllPluginScopedStyles(active.id);
        await active.fiber.dispose().catch(() => undefined);
      }
      for (const id of seenPluginIds) {
        setClientActivationError(id, undefined);
        clearClientRenderError(id, false);
        setClientRuntimeMeta(id, undefined);
        pluginReloadEpochs.delete(id);
      }
      seenPluginIds.clear();
      if (activeFrontendErrorSink === options.frontendErrorSink) {
        activeFrontendErrorSink = undefined;
      }
      if (activeFrontendErrorLimiter === options.frontendErrorLimiter) {
        activeFrontendErrorLimiter = undefined;
      }
    },
  };
}
