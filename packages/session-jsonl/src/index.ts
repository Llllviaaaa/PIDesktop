/**
 * Session logs as append-only JSONL files (ADR 0004):
 * `<dir>/<YYYY-MM>/<sessionId>.jsonl`, a header line and one event per line.
 *
 * By default (`indexFile` omitted), `JsonlStorage` performs pure append-only
 * JSONL I/O with an in-memory mtime/size summary cache — zero SQLite or FTS
 * tokenization overhead on the synchronous `append()` hot path. Full-text
 * indexing is handled asynchronously by `@qianji/session-search-fts` (or opt-in
 * via explicit `config.indexFile` for standalone callers).
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  SESSION_FORMAT,
  SESSION_FORMAT_VERSION,
  isSessionEventType,
  summarize,
  type SessionEvent,
  type SessionHeader,
  type SessionSearchHit,
  type SessionSearchOptions,
  type SessionStorage,
  type SessionSummary,
} from "@qianji/session";
import { extractSessionSearchBody, SessionSqliteIndex, type IndexedSessionInput } from "./sqlite-index.ts";

export {
  buildFtsMatchQuery,
  extractMatchSnippet,
  extractSessionSearchBody,
  segmentForFts,
  SessionSqliteIndex,
  type IndexedSessionInput,
} from "./sqlite-index.ts";

export const name = "qianji-session-jsonl";
export const inject = ["sessions"];

export interface Config {
  /** The sessions directory, e.g. `~/.pid/sessions`. */
  dir: string;
  /**
   * Optional explicit SQLite index file path for legacy combined storage+FTS mode.
   * When omitted, `JsonlStorage` runs pure fast JSONL-only persistence so
   * `@qianji/session-search-fts` can index asynchronously off the hot path.
   */
  indexFile?: string;
}

export interface ParsedLog {
  header: SessionHeader;
  events: SessionEvent[];
  /** Lines that were skipped: unknown types, or a torn last line after a crash. */
  skipped: number;
}

const LIVE_LOG_CACHE_MAX = 32;

/** Enumerate all `<dir>/<YYYY-MM>/*.jsonl` files on disk. */
export function walkJsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name))
    .flatMap((month) =>
      readdirSync(join(dir, month.name))
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => join(dir, month.name, file)),
    );
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

interface CachedFileSummary {
  mtimeMs: number;
  size: number;
  summary: SessionSummary;
}

export class JsonlStorage implements SessionStorage {
  /** id → file, for sessions created or found in this process. */
  private readonly paths = new Map<string, string>();
  /** Small bounded LRU of active logs for optional inline index mode. */
  private readonly recentLogs = new Map<string, SessionEvent[]>();
  /** Lightweight metadata cache keyed by filePath so `list()` avoids re-parsing unchanged `.jsonl` files. */
  private readonly summaryCache = new Map<string, CachedFileSummary>();
  private readonly index: SessionSqliteIndex | undefined;
  readonly search?: (query: string, options?: SessionSearchOptions) => Promise<SessionSearchHit[]>;

  constructor(
    private readonly dir: string,
    private readonly onSkipped: (file: string, count: number) => void = () => {},
    indexFile?: string,
  ) {
    if (indexFile !== undefined && indexFile.trim() !== "") {
      const sqliteIndex = new SessionSqliteIndex(indexFile);
      this.index = sqliteIndex;
      this.search = async (query: string, options: SessionSearchOptions = {}): Promise<SessionSearchHit[]> =>
        sqliteIndex.search(query, this.files(), this.parseIndexedFile, options);
    }
  }

  close(): void {
    this.recentLogs.clear();
    this.summaryCache.clear();
    this.index?.close();
  }

  private rememberRecent(id: string, events: SessionEvent[]): void {
    this.recentLogs.delete(id);
    this.recentLogs.set(id, events);
    while (this.recentLogs.size > LIVE_LOG_CACHE_MAX) {
      const oldest = this.recentLogs.keys().next().value;
      if (oldest === undefined) break;
      this.recentLogs.delete(oldest);
    }
  }

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
    if (this.index !== undefined) {
      const copy = [...events];
      this.rememberRecent(header.id, copy);
      this.index.upsertFromDisk({
        filePath: path,
        header,
        summary: summarize(header, copy),
        body: extractSessionSearchBody(copy),
      });
    }
  }

  adopt(header: SessionHeader, events: readonly SessionEvent[]): void {
    const path = this.pathFor(header);
    mkdirSync(join(this.dir, monthOf(header.createdAt)), { recursive: true });
    if (!existsSync(path)) {
      writeFileSync(path, [header, ...events].map((line) => `${JSON.stringify(line)}\n`).join(""));
    } else {
      try {
        const existing = parseLog(readFileSync(path, "utf8"));
        const diskSeq = existing.events.at(-1)?.seq ?? 0;
        const missing = events.filter((event) => event.seq > diskSeq);
        if (missing.length > 0) {
          appendFileSync(path, missing.map((line) => `${JSON.stringify(line)}\n`).join(""));
        }
      } catch {
        // Leave unreadable file untouched rather than clobbering user data.
      }
    }
    this.summaryCache.delete(path);
    if (this.index !== undefined) {
      const copy = [...events];
      this.rememberRecent(header.id, copy);
      this.index.upsertFromDisk({
        filePath: path,
        header,
        summary: summarize(header, copy),
        body: extractSessionSearchBody(copy),
      });
    }
  }

  append(header: SessionHeader, event: SessionEvent): void {
    const path = this.pathFor(header);
    if (!existsSync(path)) {
      mkdirSync(join(this.dir, monthOf(header.createdAt)), { recursive: true });
      writeFileSync(path, `${JSON.stringify(header)}\n${JSON.stringify(event)}\n`);
    } else {
      appendFileSync(path, `${JSON.stringify(event)}\n`);
    }
    this.summaryCache.delete(path);

    if (this.index !== undefined) {
      let events = this.recentLogs.get(header.id);
      if (events === undefined) {
        try {
          events = parseLog(readFileSync(path, "utf8")).events;
        } catch {
          return;
        }
      } else {
        events.push(event);
      }
      this.rememberRecent(header.id, events);
      this.index.upsertFromDisk({
        filePath: path,
        header,
        summary: summarize(header, events),
        body: extractSessionSearchBody(events),
      });
    }
  }

  async flush(header: SessionHeader): Promise<void> {
    const path = this.pathFor(header);
    if (!existsSync(path)) return;
    const fd = openSync(path, "r+");
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
    if (this.index !== undefined) {
      this.rememberRecent(id, [...parsed.events]);
    }
    return { header: parsed.header, events: parsed.events };
  }

  private parseIndexedFile = (path: string): IndexedSessionInput | undefined => {
    try {
      const { header, events } = parseLog(readFileSync(path, "utf8"));
      this.paths.set(header.id, path);
      return {
        filePath: path,
        header,
        summary: summarize(header, events),
        body: extractSessionSearchBody(events),
      };
    } catch {
      return undefined;
    }
  };

  async list(): Promise<SessionSummary[]> {
    const diskFiles = this.files();
    if (this.index !== undefined) {
      const rows = this.index.reconcile(diskFiles, this.parseIndexedFile);
      for (const row of rows) this.paths.set(row.summary.id, row.filePath);
      return rows.map((row) => row.summary);
    }

    const activePaths = new Set(diskFiles);
    for (const cachedPath of this.summaryCache.keys()) {
      if (!activePaths.has(cachedPath)) {
        this.summaryCache.delete(cachedPath);
      }
    }

    const summaries: SessionSummary[] = [];
    for (const path of diskFiles) {
      try {
        const st = statSync(path);
        const cached = this.summaryCache.get(path);
        if (cached !== undefined && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          this.paths.set(cached.summary.id, path);
          summaries.push(cached.summary);
          continue;
        }
        const { header, events, skipped } = parseLog(readFileSync(path, "utf8"));
        if (skipped > 0) this.onSkipped(path, skipped);
        const summary = summarize(header, events);
        this.paths.set(header.id, path);
        this.summaryCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, summary });
        summaries.push(summary);
      } catch {
        // Ignore non-session or unreadable files during directory listing.
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string): Promise<boolean> {
    const path = this.find(id);
    if (path === undefined) return false;
    rmSync(path, { force: true });
    this.paths.delete(id);
    this.recentLogs.delete(id);
    this.summaryCache.delete(path);
    this.index?.remove(id);
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
    return walkJsonlFiles(this.dir);
  }
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger("sessions");
  const storage = new JsonlStorage(
    config.dir,
    (file, count) => logger.warn("skipped %d unreadable line(s) in %s", count, file),
    config.indexFile,
  );
  ctx.effect(() => {
    const unregister = ctx.sessions.registerStorage(storage);
    return () => {
      unregister();
      storage.close();
    };
  }, `${name}: storage`);
}
