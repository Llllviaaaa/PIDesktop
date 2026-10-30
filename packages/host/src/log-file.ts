/**
 * The Host's log on disk (docs/REFACTOR_V2_P7.md, 3.3): one file a day,
 * `<dir>/host-YYYY-MM-DD.log`, kept for a week. Every line is redacted, and
 * debug messages (RPC traces) are kept, which stderr leaves out.
 */
import { createWriteStream, mkdirSync, readdirSync, rmSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { Logger, type Exporter } from "@deepseek-ai/cordis";
import { redactSensitiveText } from "@pid/protocol";

export const LOG_KEEP_DAYS = 7;
const DEBUG = 3;
const DAY_MS = 24 * 60 * 60_000;

export interface LogFileOptions {
  /** The file name before the date: `host` writes `host-YYYY-MM-DD.log`. */
  prefix?: string;
  keepDays?: number;
  now?: () => Date;
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

/** An exporter writing to today's file in `dir`; `close` ends the file. */
export function logFileExporter(dir: string, options: LogFileOptions = {}): Exporter & { close(): Promise<void> } {
  const prefix = options.prefix ?? "host";
  const keepDays = options.keepDays ?? LOG_KEEP_DAYS;
  const now = options.now ?? (() => new Date());
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

  const exporter: Exporter & { close(): Promise<void> } = {
    colors: false,
    levels: { default: DEBUG },
    export(message) {
      const date = now();
      const text = redactSensitiveText(Logger.format(exporter, message));
      streamFor(date).write(`${date.toISOString()} ${message.type.padEnd(5)} [${message.name}] ${text}\n`);
    },
    close() {
      const stream = current?.stream;
      current = undefined;
      return new Promise((resolve) => (stream === undefined ? resolve() : stream.end(resolve)));
    },
  };
  return exporter;
}
