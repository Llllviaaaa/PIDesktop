/**
 * Session logs as JSONL files (ADR 0004):
 * `<dir>/<YYYY-MM>/<sessionId>.jsonl`, a header line and one event per line.
 *
 * Appends are synchronous so an event is on disk (in the OS cache) before it
 * is broadcast; `flush` fsyncs, which the loop does once per turn.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  SESSION_FORMAT,
  SESSION_FORMAT_VERSION,
  isSessionEventType,
  summarize,
  type SessionEvent,
  type SessionHeader,
  type SessionStorage,
  type SessionSummary,
} from "@pid/session";

export const name = "pid-session-jsonl";
export const inject = ["sessions"];

export interface Config {
  /** The sessions directory, e.g. `~/.pid/sessions`. */
  dir: string;
}

export interface ParsedLog {
  header: SessionHeader;
  events: SessionEvent[];
  /** Lines that were skipped: unknown types, or a torn last line after a crash. */
  skipped: number;
}

/**
 * Parse a log. Throws when the file is not a session or is a newer major
 * version; skips event lines it cannot use.
 */
export function parseLog(text: string): ParsedLog {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const first = lines[0];
  if (first === undefined) throw new Error("empty session file");
  const header = JSON.parse(first) as SessionHeader;
  if (header.format !== SESSION_FORMAT || typeof header.id !== "string") throw new Error("not a pid session file");
  if (typeof header.version !== "number" || Math.floor(header.version) > SESSION_FORMAT_VERSION) {
    throw new Error(`session format ${header.version} is newer than ${SESSION_FORMAT_VERSION}`);
  }
  const events: SessionEvent[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    let event: SessionEvent;
    try {
      event = JSON.parse(line) as SessionEvent;
    } catch {
      skipped += 1;
      continue;
    }
    const expected = (events.at(-1)?.seq ?? 0) + 1;
    if (!isSessionEventType(event.type) || event.seq !== expected) {
      skipped += 1;
      continue;
    }
    events.push(event);
  }
  return { header, events, skipped };
}

function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

export class JsonlStorage implements SessionStorage {
  /** id → file, for sessions created or found in this process. */
  private readonly paths = new Map<string, string>();

  constructor(private readonly dir: string, private readonly onSkipped: (file: string, count: number) => void = () => {}) {}

  private pathFor(header: SessionHeader): string {
    let path = this.paths.get(header.id);
    if (path === undefined) {
      path = join(this.dir, monthOf(header.createdAt), `${header.id}.jsonl`);
      this.paths.set(header.id, path);
    }
    return path;
  }

  create(header: SessionHeader, events: readonly SessionEvent[]): void {
    const path = this.pathFor(header);
    mkdirSync(join(this.dir, monthOf(header.createdAt)), { recursive: true });
    writeFileSync(path, [header, ...events].map((line) => `${JSON.stringify(line)}\n`).join(""), { flag: "wx" });
  }

  append(header: SessionHeader, event: SessionEvent): void {
    appendFileSync(this.pathFor(header), `${JSON.stringify(event)}\n`);
  }

  async flush(header: SessionHeader): Promise<void> {
    const fd = openSync(this.pathFor(header), "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  async load(id: string): Promise<{ header: SessionHeader; events: SessionEvent[] } | undefined> {
    const path = this.find(id);
    if (path === undefined) return undefined;
    const parsed = parseLog(readFileSync(path, "utf8"));
    if (parsed.skipped > 0) this.onSkipped(path, parsed.skipped);
    return { header: parsed.header, events: parsed.events };
  }

  async list(): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (const path of this.files()) {
      try {
        const { header, events } = parseLog(readFileSync(path, "utf8"));
        this.paths.set(header.id, path);
        summaries.push(summarize(header, events));
      } catch {
        // Not ours, or from a newer version; listing skips it.
      }
    }
    return summaries;
  }

  async delete(id: string): Promise<boolean> {
    const path = this.find(id);
    if (path === undefined) return false;
    rmSync(path, { force: true });
    this.paths.delete(id);
    return true;
  }

  private find(id: string): string | undefined {
    const known = this.paths.get(id);
    if (known !== undefined && existsSync(known)) return known;
    if (!/^[0-9a-f-]+$/i.test(id)) return undefined;
    for (const path of this.files()) {
      if (path.endsWith(`${id}.jsonl`)) {
        this.paths.set(id, path);
        return path;
      }
    }
    return undefined;
  }

  private files(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name))
      .flatMap((month) => readdirSync(join(this.dir, month.name))
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => join(this.dir, month.name, file)));
  }
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger("sessions");
  const storage = new JsonlStorage(config.dir, (file, count) => logger.warn("skipped %d unreadable line(s) in %s", count, file));
  ctx.effect(() => ctx.sessions.registerStorage(storage), `${name}: storage`);
}
