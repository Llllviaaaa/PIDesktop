/**
 * Process-level crash catch-all for the Harness Host (`qianji-harness.exe`).
 *
 * Uses synchronous `appendFileSync` into `<dataDir>/logs/host-YYYY-MM-DD.log`
 * with `redactSensitiveText` so uncaught exceptions, unhandled rejections, and
 * startup failures are guaranteed to reach disk even if buffered streams have
 * not flushed or the process is about to terminate.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { redactSensitiveText } from "@qianji/protocol";

export type CrashKind = "uncaughtException" | "unhandledRejection" | "startupFailure";

function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatCrashReason(reason: unknown): string {
  let raw: string;
  if (reason instanceof Error) {
    raw = reason.stack ?? `${reason.name}: ${reason.message}`;
  } else if (typeof reason === "string") {
    raw = reason;
  } else {
    try {
      raw = JSON.stringify(reason);
    } catch {
      raw = String(reason);
    }
  }
  return redactSensitiveText(raw);
}

/**
 * Appends a redacted crash entry synchronously to `<logsDir>/host-YYYY-MM-DD.log`
 * and returns the redacted description. Never throws on I/O failure.
 */
export function writeHostCrashEntrySync(
  logsDir: string | undefined,
  kind: CrashKind,
  reason: unknown,
  now = new Date(),
  prefix = "host",
): string {
  const formatted = formatCrashReason(reason);
  if (logsDir !== undefined && logsDir.trim() !== "") {
    try {
      mkdirSync(logsDir, { recursive: true });
      const file = join(logsDir, `${prefix}-${localDay(now)}.log`);
      appendFileSync(
        file,
        `${now.toISOString()} error [crash-guard] ${kind}: ${formatted}\n`,
        "utf8",
      );
    } catch {
      // A read-only or full disk must never cause secondary crashes inside the handler.
    }
  }
  return formatted;
}

/** Best-effort scan of CLI arguments for `--data-dir <dir>` before full option parsing runs. */
export function extractDataDirFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--data-dir") {
      const next = argv[i + 1];
      if (typeof next === "string" && next.trim() !== "") {
        return resolve(next);
      }
    } else if (arg.startsWith("--data-dir=")) {
      const inline = arg.slice("--data-dir=".length).trim();
      if (inline !== "") {
        return resolve(inline);
      }
    }
  }
  return undefined;
}

export interface ProcessEventTarget {
  on(event: "uncaughtException", listener: (error: Error, origin: string) => void): unknown;
  on(event: "unhandledRejection", listener: (reason: unknown, promise: Promise<unknown>) => void): unknown;
  off(event: "uncaughtException", listener: (error: Error, origin: string) => void): unknown;
  off(event: "unhandledRejection", listener: (reason: unknown, promise: Promise<unknown>) => void): unknown;
}

export interface HostCrashGuardOptions {
  getLogsDir: () => string | undefined;
  isStarted?: () => boolean;
  stderr?: { write(chunk: string): unknown };
  proc?: ProcessEventTarget;
  exit?: (code: number) => void;
  now?: () => Date;
  stormLimit?: number;
  stormWindowMs?: number;
  /** Optional hook that attributes an error/rejection stack to an external plugin ID. */
  onPluginError?: (
    reason: unknown,
    kind: CrashKind,
  ) => { pluginId: string; alreadyCircuitBroken?: boolean } | undefined;
  /** Optional circuit-breaker invoked when a single external plugin triggers an uncaughtException storm. */
  onPluginStorm?: (pluginId: string, error: Error) => void;
}

function isUnrecoverableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "ERR_WORKER_OUT_OF_MEMORY" ||
    /out of memory/i.test(error.message)
  );
}

export function installHostCrashGuards(options: HostCrashGuardOptions): { dispose(): void } {
  const proc: ProcessEventTarget = options.proc ?? process;
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const now = options.now ?? (() => new Date());
  const isStarted = options.isStarted ?? (() => true);
  const stormLimit = options.stormLimit ?? 10;
  const stormWindowMs = options.stormWindowMs ?? 2_000;
  const recentExceptions: number[] = [];
  const pluginExceptions = new Map<string, number[]>();
  const trippedPlugins = new Set<string>();

  const onUnhandledRejection = (reason: unknown): void => {
    const timestamp = now();
    let attributed: { pluginId: string; alreadyCircuitBroken?: boolean } | undefined;
    try {
      attributed = options.onPluginError?.(reason, "unhandledRejection");
    } catch {
      attributed = undefined;
    }
    const formatted = writeHostCrashEntrySync(options.getLogsDir(), "unhandledRejection", reason, timestamp);
    const tag = attributed ? ` (plugin:${attributed.pluginId})` : "";
    stderr.write(`[harness] unhandledRejection${tag}: ${formatted}\n`);
  };

  const onUncaughtException = (error: Error): void => {
    const timestamp = now();
    let attributed: { pluginId: string; alreadyCircuitBroken?: boolean } | undefined;
    try {
      attributed = options.onPluginError?.(error, "uncaughtException");
    } catch {
      attributed = undefined;
    }
    const formatted = writeHostCrashEntrySync(options.getLogsDir(), "uncaughtException", error, timestamp);
    const tag = attributed ? ` (plugin:${attributed.pluginId})` : "";
    stderr.write(`[harness] uncaughtException${tag}: ${formatted}\n`);

    const ts = timestamp.getTime();
    if (isStarted() && !isUnrecoverableError(error) && attributed !== undefined) {
      if (attributed.alreadyCircuitBroken === false) {
        trippedPlugins.delete(attributed.pluginId);
      }
      const alreadyTripped =
        attributed.alreadyCircuitBroken === true || trippedPlugins.has(attributed.pluginId);
      const bucket = pluginExceptions.get(attributed.pluginId) ?? [];
      while (bucket.length > 0 && ts - (bucket[0] ?? ts) > stormWindowMs) {
        bucket.shift();
      }
      bucket.push(ts);
      pluginExceptions.set(attributed.pluginId, bucket);
      if (bucket.length >= stormLimit) {
        bucket.length = 0;
        if (alreadyTripped) {
          const reason = `circuit-broken plugin "${attributed.pluginId}" continued uncaughtException storm`;
          writeHostCrashEntrySync(
            options.getLogsDir(),
            "uncaughtException",
            `${reason}; exiting for restart`,
            timestamp,
          );
          stderr.write(`[harness] ${reason}; exiting(1)\n`);
          exit(1);
          return;
        }
        trippedPlugins.add(attributed.pluginId);
        writeHostCrashEntrySync(
          options.getLogsDir(),
          "uncaughtException",
          `plugin "${attributed.pluginId}" triggered uncaughtException storm; circuit-breaking plugin`,
          timestamp,
        );
        stderr.write(`[harness] circuit-breaking rogue plugin "${attributed.pluginId}" after storm\n`);
        try {
          options.onPluginStorm?.(attributed.pluginId, error);
        } catch {
          // Never allow storm callback to rethrow inside uncaughtException handler.
        }
      }
      return;
    }

    while (recentExceptions.length > 0 && ts - (recentExceptions[0] ?? ts) > stormWindowMs) {
      recentExceptions.shift();
    }
    recentExceptions.push(ts);

    if (!isStarted() || isUnrecoverableError(error) || recentExceptions.length >= stormLimit) {
      const reason = !isStarted()
        ? "uncaughtException before host finished starting"
        : isUnrecoverableError(error)
          ? "unrecoverable out-of-memory error"
          : `uncaughtException storm (${recentExceptions.length} within ${stormWindowMs}ms)`;
      writeHostCrashEntrySync(options.getLogsDir(), "uncaughtException", `${reason}; exiting for restart`, timestamp);
      stderr.write(`[harness] ${reason}; exiting(1)\n`);
      exit(1);
    }
  };

  proc.on("unhandledRejection", onUnhandledRejection);
  proc.on("uncaughtException", onUncaughtException);

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      proc.off("unhandledRejection", onUnhandledRejection);
      proc.off("uncaughtException", onUncaughtException);
    },
  };
}
