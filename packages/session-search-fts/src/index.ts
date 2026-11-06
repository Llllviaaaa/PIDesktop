/**
 * Pluggable asynchronous SQLite FTS5 full-text search index (`@pid/session-search-fts`).
 *
 * Decouples expensive full-conversation text extraction, CJK/identifier segmentation,
 * and SQLite FTS5 writes from the synchronous `session.append()` hot path:
 * - `session/created` and `session/event` only mark the session dirty in O(1) memory
 *   and schedule a coalesced background flush;
 * - `session/flush` and `search()` drain pending dirty sessions immediately before
 *   reading so search queries never observe stale results;
 * - Disabling this plugin closes SQLite cleanly and falls back to `@pid/session`'s
 *   lightweight scan without affecting JSONL persistence.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { summarize, type Session, type SessionSearchHit, type SessionSearchOptions } from "@pid/session";
import {
  extractSessionSearchBody,
  parseLog,
  SessionSqliteIndex,
  walkJsonlFiles,
  type IndexedSessionInput,
} from "@pid/session-jsonl";

declare module "@deepseek-ai/cordis" {
  interface Context {
    sessionSearch: AsyncSessionFtsIndexer;
  }
}

export const name = "pid-session-search-fts";
export const inject = ["sessions"];
export const provide = ["sessionSearch"];

export interface Config {
  /** Directory containing `<yyyy-mm>/<id>.jsonl` logs (`<dataDir>/sessions`). */
  sessionsDir: string;
  /** SQLite FTS5 index path (defaults to `<sessionsDir>/../sessions-index.sqlite`). */
  indexFile?: string;
  /** Debounce window in ms for background indexing after `session/event` (default `80`). */
  debounceMs?: number;
}

export class AsyncSessionFtsIndexer {
  private readonly index: SessionSqliteIndex;
  private readonly dirty = new Map<string, Session>();
  private readonly sessionsDir: string;
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private warmupTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private initialSyncDone = false;

  private readonly loadDiskFile = (filePath: string): IndexedSessionInput | undefined => {
    try {
      const parsed = parseLog(readFileSync(filePath, "utf8"));
      return {
        filePath,
        header: parsed.header,
        summary: summarize(parsed.header, parsed.events),
        body: extractSessionSearchBody(parsed.events),
      };
    } catch {
      return undefined;
    }
  };

  constructor(
    private readonly ctx: Context,
    config: Config,
  ) {
    this.sessionsDir = config.sessionsDir;
    this.debounceMs = Math.max(5, config.debounceMs ?? 80);
    const dbPath = config.indexFile ?? join(config.sessionsDir, "..", "sessions-index.sqlite");
    this.index = SessionSqliteIndex.open(dbPath);

    // Schedule initial disk catch-up asynchronously so host startup is not blocked.
    this.warmupTimer = setTimeout(() => {
      this.warmupTimer = undefined;
      if (!this.closed) this.ensureDiskSynced();
    }, 20);
    this.warmupTimer.unref?.();
  }

  markDirty(session: Session): void {
    if (this.closed) return;
    this.dirty.set(session.id, session);
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushDirty();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  remove(sessionId: string): void {
    if (this.closed) return;
    this.dirty.delete(sessionId);
    this.index.remove(sessionId);
  }

  flushDirty(targetSessionId?: string): void {
    if (this.closed) return;
    if (targetSessionId !== undefined) {
      const target = this.dirty.get(targetSessionId);
      if (target !== undefined) {
        this.dirty.delete(targetSessionId);
        this.upsertSession(target);
      }
      return;
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.dirty.size === 0) return;
    const batch = [...this.dirty.values()];
    this.dirty.clear();
    for (const session of batch) {
      this.upsertSession(session);
    }
  }

  search(query: string, options: SessionSearchOptions = {}): SessionSearchHit[] {
    if (this.closed) return [];
    this.ensureDiskSynced();
    this.flushDirty();
    return this.index.search(query, walkJsonlFiles(this.sessionsDir), this.loadDiskFile, options);
  }

  close(): void {
    if (this.closed) return;
    if (this.warmupTimer !== undefined) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = undefined;
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      this.flushDirty();
    } catch {
      // Ignore flush errors during shutdown.
    }
    this.closed = true;
    this.dirty.clear();
    this.index.close();
  }

  private ensureDiskSynced(): void {
    if (this.initialSyncDone || this.closed) return;
    this.initialSyncDone = true;
    try {
      const files = walkJsonlFiles(this.sessionsDir);
      this.index.reconcile(files, this.loadDiskFile);
      // Also index any sessions already open in memory (for example created before this plugin mounted).
      for (const openSession of this.ctx.sessions.openSessions()) {
        this.dirty.set(openSession.id, openSession);
      }
    } catch (error) {
      this.ctx.logger("session-search-fts").warn("initial FTS sync warning: %s", error);
    }
  }

  private upsertSession(session: Session): void {
    const filePath = join(this.sessionsDir, session.header.createdAt.slice(0, 7), `${session.id}.jsonl`);
    this.index.upsertFromDisk({
      filePath,
      header: session.header,
      summary: session.summary(),
      body: extractSessionSearchBody(session.events),
    });
  }
}

export function apply(ctx: Context, config: Config): void {
  let indexer: AsyncSessionFtsIndexer;
  try {
    indexer = new AsyncSessionFtsIndexer(ctx, config);
  } catch (error) {
    ctx.logger("session-search-fts").warn("SQLite FTS5 unavailable, falling back to memory search: %s", error);
    return;
  }

  ctx.provide("sessionSearch", indexer);

  ctx.on("session/created", (session) => {
    indexer.markDirty(session);
  });

  ctx.on("session/event", (session) => {
    indexer.markDirty(session);
  });

  ctx.on("session/flush", async (session) => {
    indexer.flushDirty(session.id);
  });

  ctx.on("session/deleted", (sessionId) => {
    indexer.remove(sessionId);
  });

  ctx.effect(() => {
    const unregister = ctx.sessions.registerSearcher(async (query, options) => indexer.search(query, options));
    return () => {
      unregister();
      indexer.close();
    };
  }, `${name}: searcher`);
}
