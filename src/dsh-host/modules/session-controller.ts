/**
 * Stand-in for `@deepseek-ai/dsh-api-session-controller/client`: the Session
 * object layer the UI reaches as `ctx.sessions`.
 *
 * DSH's Controller opens each Session's history over its Host protocol. The
 * copied UI only needs the object layer around it: the catalog, references
 * that keep one Client generation alive, and each generation's binding (its
 * scoped cordis Context and state source). PIDesktop backs the catalog with
 * Pi's session list; a Session's id is its session file path.
 *
 * Types follow the upstream contract (contract/sessions.ts, sessions/service.ts)
 * for the members the UI uses.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Consumer identities that hold references; packages merge their own. */
export interface SessionReferenceSourceMap {
  /** Temporary Client Controller work. */
  controllerOperation: unknown
  /** A Client Gateway invocation's synchronous Context ownership. */
  gateway: unknown
}

export type SessionReferenceSource = Extract<keyof SessionReferenceSourceMap, string>

/** Local ownership counts, independent of catalog membership and never persisted. */
export interface SessionRetainInfo {
  readonly referenceCount: number
  /** Positive source counts only; a source without references is absent. */
  readonly retainedBy: Readonly<Partial<Record<SessionReferenceSource, number>>>
}

/** Host-computed per-Session values, addressed by key; packages merge their keys. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- a declaration-merge target, empty until packages extend it
export interface SessionProjectionMap {}

/** Key-addressed projection reader delivered through the slot standard kit. */
export type UseProjection = {
  <K extends Extract<keyof SessionProjectionMap, string>>(key: K): SessionProjectionMap[K] | undefined
  <K extends Extract<keyof SessionProjectionMap, string>, S>(
    key: K,
    selector: (value: SessionProjectionMap[K] | undefined) => S,
    eq?: (a: S, b: S) => boolean,
  ): S
}

/** One catalog row. */
export interface SessionSummary {
  id: SessionId
  /** Latest durable title, absent until one is known. */
  title?: string
  /** Human-facing label: title, project basename, then id. */
  displayTitle: string
  cwd?: string
  parentId?: SessionId
  origin?: 'subagent'
  /** Running state for catalog members. */
  running: boolean
  /** Local ownership counts. */
  readonly retainedBy: SessionRetainInfo['retainedBy']
  /** A Session that has not received a prompt yet. */
  blank: boolean
  updatedAt: number
  projectionValues?: Readonly<Partial<SessionProjectionMap>>
}

export type SessionListPhase = 'pending' | 'ready'

/** Catalog metadata and local source counts. */
export interface SessionListState {
  /** Catalog order; every id has a matching byId row. */
  ids: SessionId[]
  byId: Record<SessionId, SessionSummary>
  /** `ready` once the first catalog has arrived; empty-with-ready means no sessions. */
  phase: SessionListPhase
  projectionsBySession: Readonly<Record<SessionId, unknown>>
}

/** Lifecycle and control state of one Client generation. */
export interface SessionSnapshot {
  readonly sessionId: SessionId
  readonly running: boolean
  readonly removed: boolean
  readonly openState: 'opening' | 'open' | 'failed'
  readonly blank: boolean
  readonly cwd: string | undefined
}

/** Per-key projection sources of one Session. */
export interface SessionProjectionFaces {
  /**
   * The source of one projection key.
   * @param key - projection key.
   * @returns its source, or undefined while the capability is absent.
   */
  faceOf(key: string): HostObservable<unknown> | undefined
}

/** The outward Session face: its state source plus projections. */
export interface SessionFace extends HostObservable<SessionSnapshot> {
  readonly projections: SessionProjectionFaces
}

/** A Client generation's scoped cordis Context. */
export type AgentContext = Context

/** One retained generation: identity, state, and its scoped Context. */
export interface SessionBinding {
  readonly sessionId: SessionId
  readonly session: SessionFace
  readonly ctx: AgentContext
}

/** Known Session identity. */
export type SessionTarget = SessionId

/** One independent use of an exact Client generation. */
export interface SessionReference extends Disposable {
  readonly sessionId: SessionId
  /** Shared binding; access fails after release. */
  readonly binding: SessionBinding
  /** Settles once the generation is open. */
  readonly ready: Promise<SessionBinding>
  /** Release once; the final reference disposes the generation. */
  release(): void
}

/** Consumer identity of one acquisition. */
export interface SessionRetainOptions {
  readonly source: SessionReferenceSource
  readonly signal?: AbortSignal | undefined
}

/** The sessions-service face injected as `ctx.sessions`. */
export interface ISessions {
  readonly list: ObservableSnapshot<SessionListState>
  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference
  using<T>(target: SessionTarget, options: SessionRetainOptions, operation: (reference: SessionReference) => T | Promise<T>): Promise<T>
  retainInfo(id: SessionId): ObservableSnapshot<SessionRetainInfo>
  refresh(): Promise<void>
  scope(id: SessionId): AgentContext | undefined
  scopeOf(ctx: Context): SessionId | undefined
  binding(id: SessionId): SessionBinding | undefined
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The Session a call named is not in the catalog. */
    'session/not-found': Record<string, never>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Client Session object layer and Agent scope owner. */
    sessions: ISessions
  }
}

/** One Pi session as the host reports it. */
export interface HostSessionRow {
  file: string
  cwd: string
  title?: string
  updatedAt?: number
  running: boolean
}

interface Observable<T> extends ObservableSnapshot<T> {
  set(value: T): void
}

function observable<T>(initial: T): Observable<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: (next) => {
      if (Object.is(next, value)) return
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const NO_RETAIN: SessionRetainInfo = Object.freeze({ referenceCount: 0, retainedBy: Object.freeze({}) })

interface Generation {
  readonly binding: SessionBinding
  readonly state: Observable<SessionSnapshot>
  readonly dispose: () => Promise<void>
  readonly counts: Map<SessionReferenceSource, number>
}

const scopeTag = Symbol('pid-desktop session scope')

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}

/**
 * Pi-backed Session object layer. The host pushes the catalog with
 * {@link setCatalog}; references create a generation (a scoped cordis
 * Context) on first retain and dispose it on final release.
 */
export class PiSessions implements ISessions {
  private readonly listSource = observable<SessionListState>({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} })
  private readonly generations = new Map<SessionId, Generation>()
  private readonly retainSources = new Map<SessionId, Observable<SessionRetainInfo>>()
  private rows = new Map<SessionId, HostSessionRow>()

  readonly list: ObservableSnapshot<SessionListState> = this.listSource

  /**
   * @param root - client root context; each generation's scope is a plugin fiber below it.
   */
  constructor(private readonly root: Context) {}

  /**
   * Replace the catalog with Pi's current session list.
   * @param rows - every known session, most recent first.
   */
  setCatalog(rows: readonly HostSessionRow[]): void {
    this.rows = new Map(rows.map(row => [row.file as SessionId, row]))
    for (const [id, generation] of this.generations) {
      const row = this.rows.get(id)
      const current = generation.state.getSnapshot()
      const running = row?.running ?? false
      const cwd = row?.cwd ?? current.cwd
      if (current.running !== running || current.cwd !== cwd) {
        generation.state.set({ ...current, running, cwd })
      }
    }
    this.publishList()
  }

  retain(target: SessionTarget, options: SessionRetainOptions): SessionReference {
    const generation = this.generations.get(target) ?? this.openGeneration(target)
    generation.counts.set(options.source, (generation.counts.get(options.source) ?? 0) + 1)
    this.publishRetain(target)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      const count = (generation.counts.get(options.source) ?? 1) - 1
      if (count > 0) generation.counts.set(options.source, count)
      else generation.counts.delete(options.source)
      if (generation.counts.size === 0 && this.generations.get(target) === generation) {
        this.generations.delete(target)
        void generation.dispose()
      }
      this.publishRetain(target)
    }
    const binding = generation.binding
    return {
      sessionId: target,
      get binding() {
        if (released) throw new Error(`session ${target}: reference already released`)
        return binding
      },
      ready: Promise.resolve(binding),
      release,
      [Symbol.dispose]: release,
    }
  }

  async using<T>(target: SessionTarget, options: SessionRetainOptions, operation: (reference: SessionReference) => T | Promise<T>): Promise<T> {
    const reference = this.retain(target, options)
    try {
      return await operation(reference)
    } finally {
      reference.release()
    }
  }

  retainInfo(id: SessionId): ObservableSnapshot<SessionRetainInfo> {
    let source = this.retainSources.get(id)
    if (source === undefined) {
      source = observable(this.retainInfoOf(id))
      this.retainSources.set(id, source)
    }
    return source
  }

  async refresh(): Promise<void> {}

  scope(id: SessionId): AgentContext | undefined {
    return this.generations.get(id)?.binding.ctx
  }

  scopeOf(ctx: Context): SessionId | undefined {
    return (ctx as unknown as Record<symbol, SessionId | undefined>)[scopeTag]
  }

  binding(id: SessionId): SessionBinding | undefined {
    return this.generations.get(id)?.binding
  }

  private openGeneration(id: SessionId): Generation {
    const fiber = this.root.plugin({ name: `session ${basename(id)}`, apply: () => {} })
    const ctx = fiber.ctx.extend({ [scopeTag]: id })
    const row = this.rows.get(id)
    const state = observable<SessionSnapshot>({
      sessionId: id,
      running: row?.running ?? false,
      removed: false,
      openState: 'open',
      blank: false,
      cwd: row?.cwd,
    })
    const session: SessionFace = {
      getSnapshot: state.getSnapshot,
      subscribe: state.subscribe,
      projections: { faceOf: () => undefined },
    }
    const generation: Generation = {
      binding: { sessionId: id, session, ctx },
      state,
      dispose: () => fiber.dispose(),
      counts: new Map(),
    }
    this.generations.set(id, generation)
    return generation
  }

  private retainInfoOf(id: SessionId): SessionRetainInfo {
    const generation = this.generations.get(id)
    if (generation === undefined || generation.counts.size === 0) return NO_RETAIN
    let referenceCount = 0
    const retainedBy: Partial<Record<SessionReferenceSource, number>> = {}
    for (const [source, count] of generation.counts) {
      referenceCount += count
      retainedBy[source] = count
    }
    return { referenceCount, retainedBy }
  }

  private publishRetain(id: SessionId): void {
    this.retainSources.get(id)?.set(this.retainInfoOf(id))
    this.publishList()
  }

  private publishList(): void {
    const ids: SessionId[] = []
    const byId: Record<SessionId, SessionSummary> = {}
    for (const [id, row] of this.rows) {
      ids.push(id)
      byId[id] = this.summaryOf(id, row)
    }
    // Retained sessions stay listed, so a reference never points at a missing row.
    for (const id of this.generations.keys()) {
      if (byId[id] !== undefined) continue
      byId[id] = this.summaryOf(id, undefined)
    }
    this.listSource.set({ ids, byId, phase: 'ready', projectionsBySession: {} })
  }

  private summaryOf(id: SessionId, row: HostSessionRow | undefined): SessionSummary {
    const cwd = row?.cwd
    return {
      id,
      title: row?.title,
      displayTitle: row?.title || (cwd ? basename(cwd) : '') || id,
      cwd,
      running: row?.running ?? false,
      retainedBy: this.retainInfoOf(id).retainedBy,
      blank: false,
      updatedAt: row?.updatedAt ?? 0,
    }
  }
}
