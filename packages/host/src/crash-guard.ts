/**
 * Process-level crash catch-all for the Harness Host (`qianji-harness.exe`).
 *
 * Uses synchronous `appendFileSync` into `<dataDir>/logs/host-YYYY-MM-DD.log`
 * with `redactSensitiveText` so uncaught exceptions, unhandled rejections, and
 * startup failures are guaranteed to reach disk even if buffered streams have
 * not flushed or the process is about to terminate.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { redactSensitiveText } from "@qianji/protocol";

export type CrashKind = "uncaughtException" | "unhandledRejection" | "startupFailure";

export interface HostCrashRecord {
  v: 1;
  id: string;
  timestamp: string;
  plane: "host";
  kind: CrashKind;
  summary: string;
  detail?: string;
  pluginId?: string;
  exitCode?: number;
  pid?: number;
}

export interface WriteHostCrashOptions {
  pluginId?: string;
  exitCode?: number;
  skipCrashRecord?: boolean;
  maxCrashFileBytes?: number;
}

const HOST_CRASHES_FILE = "host-crashes.jsonl";
const DEFAULT_MAX_CRASH_FILE_BYTES = 1_048_576;
const KEEP_CRASH_LINES = 200;
const MAX_SUMMARY_CHARS = 500;
const MAX_DETAIL_CHARS = 16_000;
let crashRecordSeq = 0;

function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated]`;
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

function appendHostCrashRecordSync(
  logsDir: string,
  kind: CrashKind,
  formattedReason: string,
  now: Date,
  options?: WriteHostCrashOptions,
): void {
  const pluginId = options?.pluginId?.trim() || undefined;
  const firstLine = (formattedReason.split(/\r?\n/, 1)[0] ?? "").trim() || kind;
  const prefixTag = pluginId !== undefined ? `(plugin:${pluginId}) ` : "";
  const summary = redactSensitiveText(truncateText(`${prefixTag}${kind}: ${firstLine}`, MAX_SUMMARY_CHARS));
  const detailTrimmed = formattedReason.trim();
  const detail = detailTrimmed === "" ? undefined : redactSensitiveText(truncateText(detailTrimmed, MAX_DETAIL_CHARS));

  crashRecordSeq += 1;
  const record: HostCrashRecord = {
    v: 1,
    id: `${now.getTime()}-${process.pid}-${crashRecordSeq}`,
    timestamp: now.toISOString(),
    plane: "host",
    kind,
    summary,
    ...(detail === undefined ? {} : { detail }),
    ...(pluginId === undefined ? {} : { pluginId }),
    ...(options?.exitCode === undefined ? {} : { exitCode: options.exitCode }),
    pid: process.pid,
  };
  const line = `${JSON.stringify(record)}\n`;
  const crashesPath = join(logsDir, HOST_CRASHES_FILE);
  const maxBytes = options?.maxCrashFileBytes ?? DEFAULT_MAX_CRASH_FILE_BYTES;

  let exceedsLimit: boolean;
  try {
    exceedsLimit = statSync(crashesPath).size > maxBytes;
  } catch {
    exceedsLimit = false;
  }

  if (exceedsLimit) {
    try {
      const existing = readFileSync(crashesPath, "utf8");
      const lines = existing
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter((item) => item !== "");
      const kept = lines.slice(-Math.max(0, KEEP_CRASH_LINES - 1));
      const payload = `${[...kept, JSON.stringify(record)].join("\n")}\n`;
      const tmpPath = join(logsDir, `${HOST_CRASHES_FILE}.tmp`);
      try {
        writeFileSync(tmpPath, payload, "utf8");
        renameSync(tmpPath, crashesPath);
        return;
      } catch {
        try {
          rmSync(tmpPath, { force: true });
        } catch {
          // Ignore cleanup errors.
        }
        writeFileSync(crashesPath, payload, "utf8");
        return;
      }
    } catch {
      // Fall back to direct append below.
    }
  }

  appendFileSync(crashesPath, line, "utf8");
}

/**
 * Appends a redacted crash entry synchronously to `<logsDir>/host-YYYY-MM-DD.log`
 * (and a structured `HostCrashRecord` to `<logsDir>/host-crashes.jsonl`)
 * and returns the redacted description. Never throws on I/O failure.
 */
export function writeHostCrashEntrySync(
  logsDir: string | undefined,
  kind: CrashKind,
  reason: unknown,
  now = new Date(),
  prefix = "host",
  options?: WriteHostCrashOptions,
): string {
  const formatted = formatCrashReason(reason);
  if (logsDir !== undefined && logsDir.trim() !== "") {
    const cleanPluginId = options?.pluginId?.trim() || undefined;
    const pluginTag = cleanPluginId !== undefined ? ` (plugin:${cleanPluginId})` : "";
    try {
      mkdirSync(logsDir, { recursive: true });
      const file = join(logsDir, `${prefix}-${localDay(now)}.log`);
      appendFileSync(
        file,
        `${now.toISOString()} error [crash-guard] ${kind}${pluginTag}: ${formatted}\n`,
        "utf8",
      );
      if (options?.skipCrashRecord !== true) {
        appendHostCrashRecordSync(logsDir, kind, formatted, now, {
          ...options,
          ...(cleanPluginId === undefined ? {} : { pluginId: cleanPluginId }),
        });
      }
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

  const handleAttributedPluginStorm = (
    attributed: { pluginId: string; alreadyCircuitBroken?: boolean },
    kind: "uncaughtException" | "unhandledRejection",
    errorObj: Error,
    timestamp: Date,
  ): void => {
    const ts = timestamp.getTime();
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
    if (bucket.length < stormLimit) {
      return;
    }

    bucket.length = 0;
    if (alreadyTripped) {
      if (kind === "uncaughtException") {
        const reason = `circuit-broken plugin "${attributed.pluginId}" continued uncaughtException storm`;
        writeHostCrashEntrySync(
          options.getLogsDir(),
          "uncaughtException",
          `${reason}; exiting for restart`,
          timestamp,
          "host",
          { pluginId: attributed.pluginId, exitCode: 1, skipCrashRecord: true },
        );
        stderr.write(`[harness] ${reason}; exiting(1)\n`);
        exit(1);
      }
      return;
    }

    trippedPlugins.add(attributed.pluginId);
    writeHostCrashEntrySync(
      options.getLogsDir(),
      kind,
      `plugin "${attributed.pluginId}" triggered ${kind} storm; circuit-breaking plugin`,
      timestamp,
      "host",
      { pluginId: attributed.pluginId, skipCrashRecord: true },
    );
    stderr.write(`[harness] circuit-breaking rogue plugin "${attributed.pluginId}" after storm\n`);
    try {
      options.onPluginStorm?.(attributed.pluginId, errorObj);
    } catch {
      // Never allow storm callback to rethrow inside crash-guard handler.
    }
  };

  const onUnhandledRejection = (reason: unknown): void => {
    const timestamp = now();
    let attributed: { pluginId: string; alreadyCircuitBroken?: boolean } | undefined;
    try {
      attributed = options.onPluginError?.(reason, "unhandledRejection");
    } catch {
      attributed = undefined;
    }
    const formatted = writeHostCrashEntrySync(
      options.getLogsDir(),
      "unhandledRejection",
      reason,
      timestamp,
      "host",
      attributed === undefined ? undefined : { pluginId: attributed.pluginId },
    );
    const tag = attributed !== undefined ? ` (plugin:${attributed.pluginId})` : "";
    stderr.write(`[harness] unhandledRejection${tag}: ${formatted}\n`);

    if (isStarted() && !isUnrecoverableError(reason) && attributed !== undefined) {
      const errObj = reason instanceof Error ? reason : new Error(formatted);
      handleAttributedPluginStorm(attributed, "unhandledRejection", errObj, timestamp);
    }
  };

  const onUncaughtException = (error: Error): void => {
    const timestamp = now();
    let attributed: { pluginId: string; alreadyCircuitBroken?: boolean } | undefined;
    try {
      attributed = options.onPluginError?.(error, "uncaughtException");
    } catch {
      attributed = undefined;
    }
    const formatted = writeHostCrashEntrySync(
      options.getLogsDir(),
      "uncaughtException",
      error,
      timestamp,
      "host",
      attributed === undefined ? undefined : { pluginId: attributed.pluginId },
    );
    const tag = attributed !== undefined ? ` (plugin:${attributed.pluginId})` : "";
    stderr.write(`[harness] uncaughtException${tag}: ${formatted}\n`);

    const ts = timestamp.getTime();
    if (isStarted() && !isUnrecoverableError(error) && attributed !== undefined) {
      handleAttributedPluginStorm(attributed, "uncaughtException", error, timestamp);
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
      writeHostCrashEntrySync(
        options.getLogsDir(),
        "uncaughtException",
        `${reason}; exiting for restart`,
        timestamp,
        "host",
        { exitCode: 1, skipCrashRecord: true },
      );
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
