/**
 * The Host's log on disk (docs/archive/REFACTOR_V2_P7.md, 3.3): one file a day,
 * `<dir>/host-YYYY-MM-DD.log`, kept for a week. Every line is redacted, and
 * debug messages (RPC traces) are kept, which stderr leaves out.
 */
import { createWriteStream, mkdirSync, readdirSync, rmSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { Logger, type Exporter } from "@deepseek-ai/cordis";
import { redactSensitiveText } from "@qianji/protocol";

export const LOG_KEEP_DAYS = 7;
const DEBUG = 3;
const DAY_MS = 24 * 60 * 60_000;

/** Settings → 日志等级: the least severe kind of message the file keeps. */
export type LogFileLevel = "error" | "warn" | "info" | "debug";

/**
 * Severity by message type. Cordis numbers WARN (2) above INFO (1), so its own
 * threshold cannot keep warnings while dropping info; the file filters by type.
 */
const SEVERITY: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** A setting the file does not know keeps everything, as before the setting was read. */
function severityLimit(level: string | undefined): number {
  return level !== undefined && level in SEVERITY ? SEVERITY[level] : SEVERITY.debug;
}

export interface LogFileOptions {
  /** The file name before the date: `host` writes `host-YYYY-MM-DD.log`. */
  prefix?: string;
  keepDays?: number;
  now?: () => Date;
  /** The starting level; `setLevel` changes it. Everything is kept by default. */
  level?: LogFileLevel;
}

/** The local date, as the file name shows it. */
function day(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Remove `prefix-YYYY-MM-DD.log` files older than `keepDays` days. */
export function pruneLogs(dir: string, prefix: string, keepDays: number, now: Date): string[] {
  const oldest = day(new Date(now.getTime() - (keepDays - 1) * DAY_MS));
  const pattern = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})\\.log$`);
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    const date = pattern.exec(name)?.[1];
    if (date === undefined || date >= oldest) continue;
    rmSync(join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}

/** An exporter writing to today's file in `dir`; `close` ends the file, `setLevel` filters it. */
export function logFileExporter(
  dir: string,
  options: LogFileOptions = {},
): Exporter & { close(): Promise<void>; setLevel(level: string | undefined): void } {
  const prefix = options.prefix ?? "host";
  const keepDays = options.keepDays ?? LOG_KEEP_DAYS;
  const now = options.now ?? (() => new Date());
  let limit = severityLimit(options.level);
  mkdirSync(dir, { recursive: true });
  let current: { day: string; stream: WriteStream } | undefined;

  const streamFor = (date: Date): WriteStream => {
    const today = day(date);
    if (current?.day === today) return current.stream;
    current?.stream.end();
    try {
      pruneLogs(dir, prefix, keepDays, date);
    } catch {
      // An old file in use or gone already: it goes next time.
    }
    const stream = createWriteStream(join(dir, `${prefix}-${today}.log`), { flags: "a" });
    // A full disk or a removed directory must not take the Host down.
    stream.on("error", () => undefined);
    current = { day: today, stream };
    return stream;
  };

  const exporter: Exporter & { close(): Promise<void>; setLevel(level: string | undefined): void } = {
    colors: false,
    // Cordis passes everything; the type filter below decides what the file keeps.
    levels: { default: DEBUG },
    export(message) {
      if ((SEVERITY[message.type] ?? SEVERITY.debug) > limit) return;
      const date = now();
      const text = redactSensitiveText(Logger.format(exporter, message));
      streamFor(date).write(`${date.toISOString()} ${message.type.padEnd(5)} [${message.name}] ${text}\n`);
    },
    setLevel(level) {
      limit = severityLimit(level);
    },
    close() {
      const stream = current?.stream;
      current = undefined;
      return new Promise((resolve) => (stream === undefined ? resolve() : stream.end(resolve)));
    },
  };
  return exporter;
}
