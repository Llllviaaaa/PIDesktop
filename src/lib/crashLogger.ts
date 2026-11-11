import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { redactSensitiveText } from "@qianji/protocol";
import { useAppStore } from "../store";

const DEDUPE_WINDOW_MS = 10_000;
const RATE_WINDOW_MS = 60_000;
const MAX_LOGS_PER_WINDOW = 20;

export class CrashLogLimiter {
  private readonly recentFingerprints = new Map<string, number>();
  private readonly timestamps: number[] = [];

  constructor(
    private readonly dedupeWindowMs = DEDUPE_WINDOW_MS,
    private readonly rateWindowMs = RATE_WINDOW_MS,
    private readonly maxPerWindow = MAX_LOGS_PER_WINDOW,
  ) {}

  allow(fingerprint: string, now = Date.now()): boolean {
    while (this.timestamps.length > 0 && now - (this.timestamps[0] ?? now) > this.rateWindowMs) {
      this.timestamps.shift();
    }
    for (const [key, seenAt] of this.recentFingerprints) {
      if (now - seenAt > this.dedupeWindowMs) {
        this.recentFingerprints.delete(key);
      }
    }
    const lastSeen = this.recentFingerprints.get(fingerprint);
    if (lastSeen !== undefined && now - lastSeen <= this.dedupeWindowMs) {
      return false;
    }
    if (this.timestamps.length >= this.maxPerWindow) {
      return false;
    }
    this.recentFingerprints.set(fingerprint, now);
    this.timestamps.push(now);
    return true;
  }
}

export function isIgnorableBrowserError(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) return true;
  return (
    normalized.includes("ResizeObserver loop completed with undelivered notifications") ||
    normalized.includes("ResizeObserver loop limit exceeded")
  );
}

export function extractErrorDetails(
  error: unknown,
  extraStack?: string,
): { message: string; stack?: string } {
  let rawMessage: string;
  let rawStack = "";

  if (error instanceof Error) {
    rawMessage = `${error.name || "Error"}: ${error.message || "(empty error message)"}`;
    rawStack = error.stack ?? "";
  } else if (typeof error === "string") {
    rawMessage = error;
  } else if (error !== null && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) {
      rawMessage = record.message;
    } else {
      try {
        rawMessage = JSON.stringify(error);
      } catch {
        rawMessage = Object.prototype.toString.call(error);
      }
    }
    if (typeof record.stack === "string") {
      rawStack = record.stack;
    }
  } else {
    rawMessage = String(error);
  }

  const combinedStack = [rawStack.trim(), (extraStack ?? "").trim()]
    .filter((part) => part.length > 0)
    .join("\n");

  const message = redactSensitiveText(rawMessage.trim() || "Unknown renderer error");
  const stack = combinedStack ? redactSensitiveText(combinedStack) : undefined;
  return stack === undefined ? { message } : { message, stack };
}

const defaultLimiter = new CrashLogLimiter();
let handlersInstalled = false;

export interface FrontendLogSink {
  (payload: {
    level: "error" | "warn";
    source: string;
    message: string;
    stack?: string;
  }): Promise<void>;
}

const defaultTauriSink: FrontendLogSink = async (payload) => {
  try {
    await invoke("log_frontend_error", payload);
  } catch {
    // Running outside Tauri (e.g. unit tests or plain browser dev server).
  }
};

export async function reportFrontendError(
  source: string,
  error: unknown,
  options: {
    extraStack?: string;
    level?: "error" | "warn";
    limiter?: CrashLogLimiter;
    sink?: FrontendLogSink;
    now?: number;
  } = {},
): Promise<boolean> {
  const details = extractErrorDetails(error, options.extraStack);
  if (isIgnorableBrowserError(details.message)) {
    return false;
  }

  const limiter = options.limiter ?? defaultLimiter;
  const fingerprint = `${source}:${details.message.slice(0, 240)}`;
  if (!limiter.allow(fingerprint, options.now)) {
    return false;
  }

  const level = options.level ?? "error";
  try {
    useAppStore.getState().appendLog(`[${source}] ${details.message}`);
  } catch {
    // Store may not be initialized yet during early boot.
  }

  const sink = options.sink ?? defaultTauriSink;
  await sink({
    level,
    source,
    message: details.message,
    ...(details.stack === undefined ? {} : { stack: details.stack }),
  });
  return true;
}

interface WebviewProcessFailedEvent {
  label?: string;
  kind?: string;
  reason?: string;
  exitCode?: number;
  recoveryAction?: string;
}

export interface GlobalErrorHandlerOptions {
  targetWindow?: Pick<Window, "addEventListener" | "removeEventListener">;
  sink?: FrontendLogSink;
  limiter?: CrashLogLimiter;
}

/**
 * Install window-level `error`, `unhandledrejection`, and WebView2 diagnostic
 * listeners once per renderer lifecycle.
 */
export function installGlobalErrorHandlers(options: GlobalErrorHandlerOptions = {}): () => void {
  const win = options.targetWindow ?? (typeof window !== "undefined" ? window : undefined);
  if (!win) {
    return () => {};
  }
  const isDefaultWindow = options.targetWindow === undefined;
  if (isDefaultWindow) {
    if (handlersInstalled) {
      return () => {};
    }
    handlersInstalled = true;
  }

  const reportOpts = {
    ...(options.sink === undefined ? {} : { sink: options.sink }),
    ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
  };

  const onError = (event: Event): void => {
    const target = event.target as unknown;
    if (target && target !== win) {
      const elem = target as { tagName?: unknown; src?: unknown; href?: unknown };
      const tag = typeof elem.tagName === "string" ? elem.tagName.toUpperCase() : "";
      if (tag === "SCRIPT" || tag === "LINK") {
        const rawUrl = tag === "SCRIPT" ? elem.src : elem.href;
        const url = typeof rawUrl === "string" ? rawUrl : "";
        if (url) {
          void reportFrontendError(
            "window.resource_error",
            new Error(`Failed to load ${tag.toLowerCase()}: ${url}`),
            reportOpts,
          );
        }
      }
      return;
    }

    const errEvent = event as ErrorEvent;
    const location = errEvent.filename
      ? `${errEvent.filename}:${errEvent.lineno ?? 0}:${errEvent.colno ?? 0}`
      : undefined;
    void reportFrontendError("window.onerror", errEvent.error ?? errEvent.message, {
      ...reportOpts,
      ...(location === undefined ? {} : { extraStack: location }),
    });
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    void reportFrontendError("window.unhandledrejection", event.reason, reportOpts);
  };

  win.addEventListener("error", onError as EventListener, true);
  win.addEventListener("unhandledrejection", onUnhandledRejection as EventListener);

  if (isDefaultWindow) {
    try {
      void listen<WebviewProcessFailedEvent>("webview-process-failed", (event) => {
        const info = event.payload;
        const summary = `[webview] ${info.label ?? "unknown"} ${info.kind ?? "process_failed"} (reason=${info.reason ?? "unknown"}, exit=${info.exitCode ?? 0}, recovery=${info.recoveryAction ?? "none"})`;
        console.warn(summary);
        try {
          useAppStore.getState().appendLog(summary);
        } catch {
          // Ignore if store is unavailable.
        }
      }).catch(() => undefined);
    } catch {
      // Ignore when Tauri event bridge is unavailable (e.g. unit tests).
    }
  }

  return () => {
    win.removeEventListener("error", onError as EventListener, true);
    win.removeEventListener("unhandledrejection", onUnhandledRejection as EventListener);
    if (isDefaultWindow) {
      handlersInstalled = false;
    }
  };
}
