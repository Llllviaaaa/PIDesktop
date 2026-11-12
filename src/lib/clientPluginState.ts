/**
 * Client plugin error and runtime state (ADR 0016), re-exported by
 * clientPluginRuntime.ts: activation and render errors, reload epochs, slot
 * lockouts, and where errors are reported. Module state, shared by every
 * runtime the page creates.
 */
import type { PluginClearClientErrorParams, PluginReportClientErrorParams } from "@qianji/protocol";
import { reportFrontendError, type CrashLogLimiter, type FrontendLogSink } from "./crashLogger";
import type { ClientPluginActivationError, ClientPluginRenderError, ClientPluginRuntimeMeta } from "./clientPluginRuntime";

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

export function getPluginReloadEpoch(id: string): number {
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

export function setClientRuntimeMeta(id: string, next: Omit<ClientPluginRuntimeMeta, "reloadEpoch"> | undefined): void {
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

export function setClientActivationError(
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

export function clearMissingClientPluginErrors(validIds: ReadonlySet<string>): void {
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

/** Where client errors go, set by the runtime being created; `report` and `clear` keep the previous ones when omitted. */
export function bindClientErrorReporting(binding: {
  report?: (params: PluginReportClientErrorParams) => Promise<unknown>;
  clear?: (params: PluginClearClientErrorParams) => Promise<unknown>;
  sink: FrontendLogSink | undefined;
  limiter: CrashLogLimiter | undefined;
}): void {
  if (binding.report !== undefined) activeErrorReporter = binding.report;
  if (binding.clear !== undefined) activeErrorClearer = binding.clear;
  activeFrontendErrorSink = binding.sink;
  activeFrontendErrorLimiter = binding.limiter;
}

/** Drops the sink and limiter a disposed runtime bound, unless another runtime has replaced them. */
export function unbindClientErrorReporting(sink: FrontendLogSink | undefined, limiter: CrashLogLimiter | undefined): void {
  if (activeFrontendErrorSink === sink) activeFrontendErrorSink = undefined;
  if (activeFrontendErrorLimiter === limiter) activeFrontendErrorLimiter = undefined;
}

export function forgetPluginReloadEpoch(id: string): void {
  pluginReloadEpochs.delete(id);
}

export function getClientActivationError(id: string): ClientPluginActivationError | undefined {
  return activationErrorDetailsSnapshot[id];
}

export function hasClientActivationError(id: string): boolean {
  return activationErrorsSnapshot[id] !== undefined;
}
