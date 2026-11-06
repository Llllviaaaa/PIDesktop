/**
 * Derived SQLite metadata and FTS5 full-text search index (`index.sqlite`,
 * ADR 0004). `.jsonl` session files remain the sole source of truth: when the
 * SQLite database is missing, outdated, or corrupted, this index rebuilds
 * itself transparently from the `.jsonl` directory.
 */
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  currentBranch,
  type SessionEvent,
  type SessionHeader,
  type SessionSearchHit,
  type SessionSearchOptions,
  type SessionSummary,
} from "@pid/session";

const SCHEMA_VERSION = 3;
const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** Insert spaces around CJK characters so SQLite FTS5 `unicode61` indexes every CJK glyph positionally. */
export function segmentForFts(text: string): string {
  return text.replace(CJK_CHAR_RE, " $& ").replace(/\s+/g, " ").trim();
}

/** Build a safe FTS5 MATCH expression supporting both CJK phrase queries and Latin/code prefix queries. */
export function buildFtsMatchQuery(rawQuery: string): string | undefined {
  const clauses: string[] = [];
  for (const part of rawQuery.trim().split(/\s+/).filter(Boolean)) {
    const runs = part.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[a-zA-Z0-9_]+/gu) ?? [];
    for (const run of runs) {
      if (/^[a-zA-Z0-9_]+$/.test(run)) {
        clauses.push(`"${run}"*`);
      } else {
        const chars = Array.from(run);
        clauses.push(`"${chars.join(" ")}"`);
      }
    }
  }
  return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}

const MAX_SEARCH_BODY_CHARS = 262_144;

function sliceSafeUtf16(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const lastCode = text.charCodeAt(maxChars - 1);
  const end = lastCode >= 0xd800 && lastCode <= 0xdbff ? maxChars - 1 : maxChars;
  return text.slice(0, end);
}

/** Extract searchable plain text from a session's active branch messages and compactions. */
export function extractSessionSearchBody(events: readonly SessionEvent[]): string {
  const parts: string[] = [];
  let activeTitle: string | undefined;
  for (const event of currentBranch(events)) {
    if (event.type === "user") {
      for (const block of event.data.content) {
        if (block.type === "text" && block.text.trim() !== "") parts.push(block.text);
      }
    } else if (event.type === "assistant") {
      for (const block of event.data.content) {
        if (block.type === "text" && block.text.trim() !== "") parts.push(block.text);
      }
    } else if (event.type === "compaction") {
      if (event.data.summary.trim() !== "") parts.push(event.data.summary);
    } else if (event.type === "label") {
      if (event.data.title !== undefined) {
        activeTitle = event.data.title;
      }
    }
  }
  // Cap per-session indexed text at 256 KB so pathological tool dumps never bloat index.sqlite,
  // while reserving space at the tail so activeTitle is never truncated on >256 KB transcripts.
  if (activeTitle === undefined || activeTitle.trim() === "") {
    return sliceSafeUtf16(parts.join("\n"), MAX_SEARCH_BODY_CHARS);
  }
  const safeTitle = sliceSafeUtf16(activeTitle, MAX_SEARCH_BODY_CHARS);
  if (parts.length === 0 || safeTitle.length >= MAX_SEARCH_BODY_CHARS - 1) {
    return safeTitle;
  }
  const bodyBudget = MAX_SEARCH_BODY_CHARS - safeTitle.length - 1;
  const truncatedBody = sliceSafeUtf16(parts.join("\n"), bodyBudget);
  return truncatedBody === "" ? safeTitle : `${truncatedBody}\n${safeTitle}`;
}

export function extractMatchSnippet(query: string, summary: SessionSummary, rawBody: string): string {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const fullText = [summary.title ?? "", summary.firstMessage ?? "", rawBody].filter(Boolean).join(" · ");
  if (fullText === "") return summary.cwd;
  const lower = fullText.toLowerCase();
  let matchIndex = -1;
  let matchLen = 0;
  for (const term of terms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
      matchIndex = idx;
      matchLen = term.length;
    }
  }
  if (matchIndex === -1) {
    const compact = fullText.replace(/\s+/g, " ").trim();
    return compact.length > 96 ? `${compact.slice(0, 96)}…` : compact;
  }
  const start = Math.max(0, matchIndex - 28);
  const end = Math.min(fullText.length, matchIndex + matchLen + 56);
  const slice = fullText.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < fullText.length ? "…" : ""}`;
}

export interface IndexedSessionInput {
  filePath: string;
  header: SessionHeader;
  summary: SessionSummary;
  body: string;
}

interface StoredMetaRow {
  id: string;
  file_path: string;
  mtime_ms: number;
  size_bytes: number;
}

export class SessionSqliteIndex {
  private db: DatabaseSync | undefined;
  private reconciled = false;
  private stmtUpsertSession: StatementSync | undefined;
  private stmtDeleteFts: StatementSync | undefined;
  private stmtInsertFts: StatementSync | undefined;
  private stmtDeleteSession: StatementSync | undefined;
  private stmtListAll: StatementSync | undefined;

  constructor(private readonly dbPath: string) {}

  static open(dbPath: string): SessionSqliteIndex {
    const instance = new SessionSqliteIndex(dbPath);
    instance.ensureOpen();
    return instance;
  }

  private ensureOpen(): DatabaseSync {
    if (this.db !== undefined) return this.db;
    mkdirSync(dirname(this.dbPath), { recursive: true });
    try {
      this.db = this.openAndInit();
    } catch {
      this.resetFiles();
      this.db = this.openAndInit();
    }
    return this.db;
  }

  private openAndInit(): DatabaseSync {
    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA synchronous = NORMAL;");
      const versionRow = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
      const currentVersion = versionRow?.user_version ?? 0;
      if (currentVersion !== 0 && currentVersion !== SCHEMA_VERSION) {
        db.exec("DROP TABLE IF EXISTS sessions_fts; DROP TABLE IF EXISTS sessions;");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          mtime_ms REAL NOT NULL,
          size_bytes INTEGER NOT NULL,
          cwd TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived INTEGER NOT NULL,
          is_subagent INTEGER NOT NULL,
          is_side INTEGER NOT NULL,
          summary_json TEXT NOT NULL,
          raw_text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
        CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
          session_id UNINDEXED,
          title,
          cwd,
          body,
          tokenize = 'unicode61'
        );
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      this.stmtUpsertSession = db.prepare(`
        INSERT INTO sessions (
          id, file_path, mtime_ms, size_bytes, cwd, updated_at, archived, is_subagent, is_side, summary_json, raw_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          file_path = excluded.file_path,
          mtime_ms = excluded.mtime_ms,
          size_bytes = excluded.size_bytes,
          cwd = excluded.cwd,
          updated_at = excluded.updated_at,
          archived = excluded.archived,
          is_subagent = excluded.is_subagent,
          is_side = excluded.is_side,
          summary_json = excluded.summary_json,
          raw_text = excluded.raw_text
      `);
      this.stmtDeleteFts = db.prepare("DELETE FROM sessions_fts WHERE session_id = ?");
      this.stmtInsertFts = db.prepare("INSERT INTO sessions_fts (session_id, title, cwd, body) VALUES (?, ?, ?, ?)");
      this.stmtDeleteSession = db.prepare("DELETE FROM sessions WHERE id = ?");
      this.stmtListAll = db.prepare("SELECT id, file_path, summary_json FROM sessions ORDER BY updated_at DESC");
      return db;
    } catch (error) {
      try {
        db.close();
      } catch {
        // Ignore close error on broken database.
      }
      throw error;
    }
  }

  private resetFiles(): void {
    this.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${this.dbPath}${suffix}`, { force: true });
    }
  }

  close(): void {
    const current = this.db;
    this.db = undefined;
    this.stmtUpsertSession = undefined;
    this.stmtDeleteFts = undefined;
    this.stmtInsertFts = undefined;
    this.stmtDeleteSession = undefined;
    this.stmtListAll = undefined;
    this.reconciled = false;
    if (current !== undefined) {
      try {
        current.close();
      } catch {
        // Ignore double-close.
      }
    }
  }

  private writeEntry(input: IndexedSessionInput, mtimeMs: number, sizeBytes: number): void {
    this.ensureOpen();
    const { summary, header, filePath, body } = input;
    const titleText = `${summary.title ?? ""} ${summary.firstMessage ?? ""}`.trim();
    this.stmtUpsertSession?.run(
      summary.id,
      filePath,
      mtimeMs,
      sizeBytes,
      summary.cwd,
      summary.updatedAt,
      summary.archived ? 1 : 0,
      header.parent !== undefined ? 1 : 0,
      header.side === true ? 1 : 0,
      JSON.stringify(summary),
      body,
    );
    this.stmtDeleteFts?.run(summary.id);
    this.stmtInsertFts?.run(
      summary.id,
      segmentForFts(titleText),
      segmentForFts(summary.cwd),
      segmentForFts(body),
    );
  }

  upsertFromDisk(input: IndexedSessionInput): void {
    try {
      const st = existsSync(input.filePath) ? statSync(input.filePath) : { mtimeMs: Date.now(), size: 0 };
      const db = this.ensureOpen();
      db.exec("BEGIN IMMEDIATE");
      try {
        this.writeEntry(input, st.mtimeMs, st.size);
        db.exec("COMMIT");
      } catch (inner) {
        db.exec("ROLLBACK");
        throw inner;
      }
    } catch {
      this.reconciled = false;
    }
  }

  remove(id: string): void {
    if (this.db === undefined && !existsSync(this.dbPath)) return;
    try {
      const db = this.ensureOpen();
      db.exec("BEGIN IMMEDIATE");
      try {
        this.stmtDeleteFts?.run(id);
        this.stmtDeleteSession?.run(id);
        db.exec("COMMIT");
      } catch (inner) {
        db.exec("ROLLBACK");
        throw inner;
      }
    } catch {
      this.reconciled = false;
    }
  }

  /** Synchronize the SQLite index with the `.jsonl` files on disk, reading only new or modified files. */
  reconcile(
    files: readonly string[],
    loadFile: (filePath: string) => IndexedSessionInput | undefined,
  ): Array<{ filePath: string; summary: SessionSummary }> {
    const runOnce = (): Array<{ filePath: string; summary: SessionSummary }> => {
      const db = this.ensureOpen();
      if (!this.reconciled) {
        const existingRows = db.prepare("SELECT id, file_path, mtime_ms, size_bytes FROM sessions").all() as unknown as StoredMetaRow[];
        const byPath = new Map(existingRows.map((row) => [row.file_path, row]));
        const seenIds = new Set<string>();
        const toWrite: Array<{ input: IndexedSessionInput; mtimeMs: number; sizeBytes: number }> = [];

        for (const filePath of files) {
          let st: { mtimeMs: number; size: number };
          try {
            st = statSync(filePath);
          } catch {
            continue;
          }
          const prev = byPath.get(filePath);
          if (prev !== undefined && prev.mtime_ms === st.mtimeMs && prev.size_bytes === st.size) {
            seenIds.add(prev.id);
            continue;
          }
          const loaded = loadFile(filePath);
          if (loaded === undefined) continue;
          seenIds.add(loaded.summary.id);
          toWrite.push({ input: loaded, mtimeMs: st.mtimeMs, sizeBytes: st.size });
        }

        const toDelete = existingRows.filter((row) => !seenIds.has(row.id)).map((row) => row.id);
        if (toWrite.length > 0 || toDelete.length > 0) {
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const id of toDelete) {
              this.stmtDeleteFts?.run(id);
              this.stmtDeleteSession?.run(id);
            }
            for (const item of toWrite) {
              this.writeEntry(item.input, item.mtimeMs, item.sizeBytes);
            }
            db.exec("COMMIT");
          } catch (inner) {
            db.exec("ROLLBACK");
            throw inner;
          }
        }
        this.reconciled = true;
      }

      const rows = (this.stmtListAll?.all() ?? []) as Array<{ id: string; file_path: string; summary_json: string }>;
      return rows.map((row) => ({
        filePath: row.file_path,
        summary: JSON.parse(row.summary_json) as SessionSummary,
      }));
    };

    try {
      return runOnce();
    } catch {
      this.resetFiles();
      return runOnce();
    }
  }

  search(
    query: string,
    files: readonly string[],
    loadFile: (filePath: string) => IndexedSessionInput | undefined,
    options: SessionSearchOptions = {},
  ): SessionSearchHit[] {
    this.reconcile(files, loadFile);
    const trimmed = query.trim();
    if (trimmed === "") return [];
    const limit = Math.max(1, Math.min(options.limit ?? 30, 100));
    const includeArchived = options.includeArchived === true;
    const cwdFilter = options.cwd?.trim();
    const db = this.ensureOpen();
    const ftsQuery = buildFtsMatchQuery(trimmed);

    type SearchRow = { summary_json: string; raw_text: string };
    let rows: SearchRow[] = [];

    if (ftsQuery !== undefined) {
      const sql = [
        "SELECT s.summary_json, s.raw_text",
        "FROM sessions_fts f",
        "JOIN sessions s ON s.id = f.session_id",
        "WHERE sessions_fts MATCH ?",
        "AND s.is_subagent = 0 AND s.is_side = 0",
        ...(includeArchived ? [] : ["AND s.archived = 0"]),
        ...(cwdFilter ? ["AND lower(s.cwd) = lower(?)"] : []),
        "ORDER BY bm25(sessions_fts, 0.0, 5.0, 2.0, 1.0), s.updated_at DESC",
        "LIMIT ?",
      ].join(" ");
      const params: Array<string | number> = [ftsQuery];
      if (cwdFilter) params.push(cwdFilter);
      params.push(limit);
      rows = db.prepare(sql).all(...params) as unknown as SearchRow[];
    }

    if (rows.length === 0) {
      const likePattern = `%${trimmed.replace(/[%_\\]/g, "\\$&")}%`;
      const sql = [
        "SELECT summary_json, raw_text",
        "FROM sessions",
        "WHERE is_subagent = 0 AND is_side = 0",
        ...(includeArchived ? [] : ["AND archived = 0"]),
        ...(cwdFilter ? ["AND lower(cwd) = lower(?)"] : []),
        "AND (",
        "  COALESCE(json_extract(summary_json, '$.title'), '') LIKE ? ESCAPE '\\'",
        "  OR COALESCE(json_extract(summary_json, '$.firstMessage'), '') LIKE ? ESCAPE '\\'",
        "  OR cwd LIKE ? ESCAPE '\\'",
        "  OR raw_text LIKE ? ESCAPE '\\'",
        ")",
        "ORDER BY updated_at DESC",
        "LIMIT ?",
      ].join(" ");
      const params: Array<string | number> = [];
      if (cwdFilter) params.push(cwdFilter);
      params.push(likePattern, likePattern, likePattern, likePattern, limit);
      rows = db.prepare(sql).all(...params) as unknown as SearchRow[];
    }

    return rows.map((row) => {
      const summary = JSON.parse(row.summary_json) as SessionSummary;
      return {
        session: summary,
        snippet: extractMatchSnippet(trimmed, summary, row.raw_text),
      };
    });
  }
}
