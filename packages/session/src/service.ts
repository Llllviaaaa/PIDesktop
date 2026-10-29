import { randomBytes } from "node:crypto";
import { Context, Service } from "@deepseek-ai/cordis";
import { deriveState, forkEvents, summarize, type SessionState } from "./derive.ts";
import {
  SESSION_FORMAT,
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionEventData,
  type SessionEventType,
  type SessionHeader,
  type SessionSummary,
} from "./types.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    sessions: Sessions;
  }

  interface Events {
    "session/created"(session: Session): void;
    /** An event was appended (and handed to storage). */
    "session/event"(session: Session, event: SessionEvent): void;
    /** Live, unpersisted progress such as streamed text; `liveSeq` orders it. */
    "session/delta"(session: Session, liveSeq: number, delta: SessionDelta): void;
    /** Checkpoint: storage synced, plugins persist what they keep. */
    "session/flush"(session: Session): Promise<void>;
  }
}

/** A live update; the agent package defines the concrete kinds. */
export interface SessionDelta {
  type: string;
  [key: string]: unknown;
}

/**
 * Where logs live. `append` is called synchronously as each event commits,
 * so an event is with storage before anyone hears of it.
 */
export interface SessionStorage {
  create(header: SessionHeader, events: readonly SessionEvent[]): void;
  append(header: SessionHeader, event: SessionEvent): void;
  flush(header: SessionHeader): Promise<void>;
  load(id: string): Promise<{ header: SessionHeader; events: SessionEvent[] } | undefined>;
  list(): Promise<SessionSummary[]>;
}

/** Keeps logs in memory; the default until a persistence plugin registers. */
export class MemoryStorage implements SessionStorage {
  private readonly logs = new Map<string, { header: SessionHeader; events: SessionEvent[] }>();

  create(header: SessionHeader, events: readonly SessionEvent[]): void {
    this.logs.set(header.id, { header, events: [...events] });
  }

  append(header: SessionHeader, event: SessionEvent): void {
    this.logs.get(header.id)?.events.push(event);
  }

  async flush(): Promise<void> {}

  async load(id: string) {
    const log = this.logs.get(id);
    return log === undefined ? undefined : { header: log.header, events: [...log.events] };
  }

  async list(): Promise<SessionSummary[]> {
    return [...this.logs.values()].map(({ header, events }) => summarize(header, events));
  }
}

/** A time-ordered UUID (RFC 9562 version 7). */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class Session {
  private readonly log: SessionEvent[];
  private liveSeq = 0;
  private cached: { length: number; state: SessionState } | undefined;

  constructor(private readonly ctx: Context, private readonly owner: Sessions, readonly header: SessionHeader, events: SessionEvent[]) {
    this.log = events;
  }

  get id(): string {
    return this.header.id;
  }

  get events(): readonly SessionEvent[] {
    return this.log;
  }

  get lastSeq(): number {
    return this.log.at(-1)?.seq ?? 0;
  }

  /** Append one event: storage first, then `session/event`. */
  append<K extends SessionEventType>(type: K, data: SessionEventData[K]): Extract<SessionEvent, { type: K }> {
    const event = { seq: this.lastSeq + 1, ts: new Date().toISOString(), type, data } as Extract<SessionEvent, { type: K }>;
    this.owner.storage.append(this.header, event);
    this.log.push(event);
    this.ctx.emit("session/event", this, event);
    return event;
  }

  /** Publish live progress that is not persisted. */
  delta(delta: SessionDelta): number {
    this.liveSeq += 1;
    this.ctx.emit("session/delta", this, this.liveSeq, delta);
    return this.liveSeq;
  }

  get currentLiveSeq(): number {
    return this.liveSeq;
  }

  state(): SessionState {
    if (this.cached?.length !== this.log.length) this.cached = { length: this.log.length, state: deriveState(this.log) };
    return this.cached.state;
  }

  summary(): SessionSummary {
    return summarize(this.header, this.log);
  }

  async flush(): Promise<void> {
    await this.owner.storage.flush(this.header);
    await this.ctx.parallel("session/flush", this);
  }
}

export interface CreateSessionOptions {
  cwd: string;
  forkedFrom?: SessionHeader["forkedFrom"];
  parent?: SessionHeader["parent"];
  /** Events the session starts with, numbered from 1 (a fork's copy). */
  events?: SessionEvent[];
}

/** Opens, creates and forks sessions; one `Session` object per open log. */
export class Sessions extends Service {
  storage: SessionStorage = new MemoryStorage();
  private readonly open = new Map<string, Session>();
  private readonly loading = new Map<string, Promise<Session | undefined>>();

  constructor(ctx: Context) {
    super(ctx, "sessions");
  }

  /** Keep logs in `storage` from now on. Returns the disposer. */
  registerStorage(storage: SessionStorage): () => void {
    const previous = this.storage;
    this.storage = storage;
    this.open.clear();
    return () => {
      if (this.storage === storage) {
        this.storage = previous;
        this.open.clear();
      }
    };
  }

  create(options: CreateSessionOptions): Session {
    const header: SessionHeader = {
      format: SESSION_FORMAT,
      version: SESSION_FORMAT_VERSION,
      id: uuidv7(),
      createdAt: new Date().toISOString(),
      cwd: options.cwd,
      ...(options.forkedFrom === undefined ? {} : { forkedFrom: options.forkedFrom }),
      ...(options.parent === undefined ? {} : { parent: options.parent }),
    };
    const events = options.events ?? [];
    this.storage.create(header, events);
    const session = new Session(this.ctx, this, header, [...events]);
    this.open.set(header.id, session);
    this.ctx.emit("session/created", session);
    return session;
  }

  /** The session with `id`, loaded from storage on first use. */
  async get(id: string): Promise<Session | undefined> {
    const opened = this.open.get(id);
    if (opened !== undefined) return opened;
    let pending = this.loading.get(id);
    if (pending === undefined) {
      pending = this.storage.load(id).then((log) => {
        if (log === undefined) return undefined;
        const session = this.open.get(id) ?? new Session(this.ctx, this, log.header, log.events);
        this.open.set(id, session);
        return session;
      }).finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    return pending;
  }

  /** Every stored session, newest first; open sessions reflect their latest events. */
  async list(): Promise<SessionSummary[]> {
    const stored = new Map((await this.storage.list()).map((summary) => [summary.id, summary]));
    for (const session of this.open.values()) stored.set(session.id, session.summary());
    return [...stored.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** A new session holding `source`'s current branch up to `atSeq` (default: all of it). */
  fork(source: Session, atSeq = source.lastSeq): Session {
    return this.create({
      cwd: source.header.cwd,
      forkedFrom: { sessionId: source.id, seq: atSeq },
      events: forkEvents(source.events, atSeq),
    });
  }
}
