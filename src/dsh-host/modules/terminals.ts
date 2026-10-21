/**
 * Stand-in for DSH's terminal controller Host half
 * (`@deepseek-ai/dsh-api-terminal-controller`, the `remote.terminal`
 * namespace) and the type surface of its `/remote` entry.
 *
 * DSH's Host owns each browser terminal as a subprocess PTY mirrored into a
 * headless xterm: an attachment begins with the serialized screen, then
 * ordered output, and one attachment at a time controls input. PIDesktop's
 * PTYs are the Tauri process's (`terminal_create` / `terminal_write` /
 * `terminal_resize` / `terminal_close`, output and exit as events); this
 * module keeps the same mirror and attachment protocol in the page, after
 * upstream's BrowserTerminal and TerminalFollower (api/terminal-controller
 * src/terminal.ts and src/stream.ts at deepseek-harness 5719020, MIT), with
 * Node's Buffer replaced by TextEncoder and the process handle by the Tauri
 * commands. The copied client half (src/dsh/terminal-controller/client)
 * talks to it unchanged.
 *
 * Unattended-terminal reaping (upstream's TerminalRetention) is not carried:
 * a terminal lives until its tab closes it or the app exits.
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Deque } from '@deepseek-ai/dsh-deque'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  RemoteError,
  remoteErrorOf,
  remoteResult,
  type RemoteResult,
  type RemoteStreamHandle,
  type RemoteUplinkWindow,
} from '@deepseek-ai/dsh-typert-protocol'
import type {
  TerminalCreateRequest,
  TerminalEnvironment,
  TerminalFrame,
  TerminalInput,
  TerminalRetentionFrame,
  TerminalShell,
  WebTerminalId,
  WebTerminalInfo,
} from '@deepseek-ai/dsh-api-terminal-controller/types'

/** The client face of `remote.terminal`, as DSH's generated Remote presents it. */
export interface TerminalRemoteFace {
  environment(sessionId: SessionId, signal?: AbortSignal): Promise<RemoteResult<TerminalEnvironment>>
  shells(sessionId: SessionId, signal?: AbortSignal): Promise<RemoteResult<TerminalShell[]>>
  list(sessionId: SessionId): Promise<RemoteResult<WebTerminalInfo[]>>
  create(sessionId: SessionId, request: TerminalCreateRequest, signal?: AbortSignal): Promise<RemoteResult<WebTerminalInfo>>
  retain(sessionId: SessionId, id: WebTerminalId, signal?: AbortSignal): RemoteStreamHandle<TerminalRetentionFrame, never>
  attach(sessionId: SessionId, id: WebTerminalId, signal?: AbortSignal): RemoteStreamHandle<TerminalFrame, TerminalInput>
  rename(sessionId: SessionId, id: WebTerminalId, title: string): Promise<RemoteResult<void>>
  close(sessionId: SessionId, id: WebTerminalId): Promise<RemoteResult<void>>
}

declare module '@deepseek-ai/dsh-api-remotes/client' {
  interface ClientRemote {
    terminal: TerminalRemoteFace
  }
}

/** Upstream's defaults (TerminalController.Config). */
const LIMITS = {
  maxTerminals: 8,
  maxCols: 500,
  maxRows: 200,
  scrollback: 1000,
  maxBufferedBytes: 2 * 1024 * 1024,
  maxInputBytes: 64 * 1024,
} as const

/** Uplink frames are in-page calls: no carrier overhead, and the buffer bound is the window. */
const INPUT_WINDOW: RemoteUplinkWindow = { maxBytes: LIMITS.maxBufferedBytes, frameOverheadBytes: 0 }

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).byteLength

// ── Tauri PTY events ─────────────────────────────────────────────────────

interface PtyListener {
  output(data: string): void
  exit(): void
}

const ptyListeners = new Map<string, PtyListener>()
let ptyEvents: Promise<void> | undefined

function listenPty(): Promise<void> {
  ptyEvents ??= Promise.all([
    listen<{ id: string; data: string }>('terminal-output', (event) => { ptyListeners.get(event.payload.id)?.output(event.payload.data) }),
    listen<{ id: string }>('terminal-exit', (event) => { ptyListeners.get(event.payload.id)?.exit() }),
  ]).then(() => undefined)
  return ptyEvents
}

function tauriAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// ── One attachment's ordered frame queue (upstream TerminalFollower) ─────

class TerminalFollower {
  private readonly queue = new Deque<{ frame: TerminalFrame; bytes: number }>()
  private bytes = 0
  private wake: (() => void) | undefined
  private closed = false
  private finished = false
  private failure: Error | undefined

  get active(): boolean { return !this.closed && !this.finished }

  constructor(private readonly maxBytes: number) {}

  push(frame: TerminalFrame): void {
    if (this.closed || this.finished) return
    const bytes = byteLength(JSON.stringify(frame))
    if (this.bytes + bytes > this.maxBytes) {
      this.fail(new Error('Terminal output consumer exceeded its buffer; reconnect to recover the current screen'))
      return
    }
    this.queue.pushBack({ frame, bytes })
    this.bytes += bytes
    this.wake?.()
  }

  fail(error: Error): void {
    if (!this.active) return
    this.failure = error
    this.close()
  }

  finish(): void {
    this.finished = true
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.queue.clear()
    this.bytes = 0
    this.wake?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<TerminalFrame> {
    const abort = (): void => { this.close() }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      while (!this.closed) {
        const next = this.queue.popFront()
        if (next !== undefined) {
          this.bytes -= next.bytes
          yield next.frame
        } else {
          if (this.finished) break
          await new Promise<void>((resolve) => { this.wake = resolve })
          this.wake = undefined
        }
      }
      if (this.failure !== undefined) throw this.failure
    } finally {
      signal.removeEventListener('abort', abort)
      this.close()
    }
  }
}

// ── One terminal: the PTY and its screen mirror (upstream BrowserTerminal) ─

class PageTerminal {
  private readonly screen: HeadlessTerminal
  private readonly serializer = new SerializeAddon()
  private readonly followers = new Set<TerminalFollower>()
  private sequence = 0
  private operations: Promise<unknown> = Promise.resolve()
  private exited = false
  private closing: Promise<void> | undefined
  private controller: TerminalFollower | undefined

  private constructor(public info: WebTerminalInfo) {
    this.screen = new HeadlessTerminal({ cols: info.cols, rows: info.rows, scrollback: LIMITS.scrollback, allowProposedApi: true })
    this.screen.loadAddon(this.serializer)
  }

  /** Start the shell; output that arrives before this resolves is already mirrored. */
  static async start(info: WebTerminalInfo): Promise<PageTerminal> {
    await listenPty()
    const terminal = new PageTerminal(info)
    ptyListeners.set(info.id, {
      output: (data) => { void terminal.output(data) },
      exit: () => { terminal.processExited() },
    })
    try {
      await invoke('terminal_create', { id: info.id, cwd: info.cwd, shell: info.shell.path, cols: info.cols, rows: info.rows })
    } catch (error) {
      ptyListeners.delete(info.id)
      terminal.screen.dispose()
      throw error
    }
    return terminal
  }

  /** Hold this terminal for one window: the process stays until closed. */
  async *retain(signal: AbortSignal): AsyncIterable<TerminalRetentionFrame> {
    yield { type: 'retained' }
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }

  async *attach(input: AsyncIterable<TerminalInput>, signal: AbortSignal): AsyncIterable<TerminalFrame> {
    signal.throwIfAborted()
    const follower = new TerminalFollower(LIMITS.maxBufferedBytes)
    const baseline = await this.enqueue(() => {
      signal.throwIfAborted()
      this.controller = follower
      this.broadcastState()
      const snapshot: TerminalFrame = {
        type: 'snapshot', sequence: this.sequence, screen: this.serializer.serialize(), info: this.info,
        writable: this.writable(follower), inputWindow: INPUT_WINDOW,
      }
      this.followers.add(follower)
      return snapshot
    })
    const uplink = input[Symbol.asyncIterator]()
    const commands = this.consumeInput(uplink, follower, signal).catch((error: unknown) => {
      follower.fail(error instanceof Error ? error : new Error(String(error)))
    })
    try {
      yield baseline
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
      if (this.controller === follower) {
        this.controller = undefined
        this.broadcastState()
      }
      await uplink.return?.()
      await commands
    }
  }

  private async consumeInput(input: AsyncIterator<TerminalInput>, follower: TerminalFollower, signal: AbortSignal): Promise<void> {
    let sequence = 0
    while (true) {
      const next = await input.next()
      if (next.done === true || signal.aborted || !follower.active) return
      const command = next.value
      if (!Number.isSafeInteger(command.sequence) || command.sequence !== ++sequence) throw new Error('Terminal input sequence has a gap')
      try {
        await this.enqueue(async () => {
          signal.throwIfAborted()
          this.requireController(follower)
          if (command.type === 'write') {
            if (byteLength(command.data) > LIMITS.maxInputBytes) throw new Error('Terminal input exceeds the configured limit')
            await invoke('terminal_write', { id: this.info.id, data: command.data })
          } else {
            if (!Number.isSafeInteger(command.cols) || command.cols < 2 || command.cols > LIMITS.maxCols
              || !Number.isSafeInteger(command.rows) || command.rows < 1 || command.rows > LIMITS.maxRows) {
              throw new Error('Terminal dimensions exceed the configured limits')
            }
            await invoke('terminal_resize', { id: this.info.id, cols: command.cols, rows: command.rows })
            this.screen.resize(command.cols, command.rows)
            this.info = { ...this.info, cols: command.cols, rows: command.rows }
            this.broadcastState()
          }
        })
        follower.push({ type: 'ack', sequence })
      } catch (error) {
        const failure = remoteErrorOf(error)
        if (failure?.code === 'terminal/control-unavailable') {
          follower.push({ type: 'ack', sequence, refusal: failure.details.reason })
        } else if (this.exited) {
          follower.push({ type: 'ack', sequence, refusal: 'not-running' })
        } else throw error
      }
    }
  }

  private writable(follower: TerminalFollower): boolean {
    return !this.exited && this.closing === undefined && this.info.state === 'running' && this.controller === follower
  }

  private broadcastState(): void {
    for (const follower of this.followers) follower.push({ type: 'state', info: this.info, writable: this.writable(follower) })
  }

  rename(title: string): void {
    this.info = { ...this.info, title }
    this.broadcastState()
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closing = (async () => {
      if (!this.exited) await invoke('terminal_close', { id: this.info.id }).catch(() => { /* already gone */ })
      ptyListeners.delete(this.info.id)
      await this.enqueue(() => {
        for (const follower of this.followers) follower.finish()
        this.followers.clear()
        this.screen.dispose()
      })
    })().catch((error: unknown) => { this.closing = undefined; throw error })
    return this.closing
  }

  private requireController(follower: TerminalFollower): void {
    if (this.exited || this.closing !== undefined || this.info.state !== 'running') {
      throw new RemoteError('terminal/control-unavailable', 'Terminal is not running', { reason: 'not-running' })
    }
    if (this.controller !== follower || !follower.active) {
      throw new RemoteError('terminal/control-unavailable', 'Terminal input is controlled by another attachment', { reason: 'read-only' })
    }
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const pending = this.operations.then(operation)
    this.operations = pending.catch(() => { /* The caller owns this operation's failure; later cleanup must still run. */ })
    return pending
  }

  private output(data: string): Promise<void> {
    if (data.length === 0) return Promise.resolve()
    return this.enqueue(async () => {
      if (this.closing !== undefined) return
      await new Promise<void>((resolve) => { this.screen.write(data, resolve) })
      const frame: TerminalFrame = { type: 'output', sequence: ++this.sequence, data }
      for (const follower of this.followers) follower.push(frame)
    })
  }

  /** The shell ended on its own; Tauri reports no exit code. Ordered after the output before it. */
  private processExited(): void {
    void this.enqueue(() => {
      this.exited = true
      ptyListeners.delete(this.info.id)
      this.info = { ...this.info, state: 'exited', exitCode: null }
      this.broadcastState()
    })
  }
}

// ── Streams as the Client holds them ─────────────────────────────────────

/** An uplink queue the Host side iterates. */
class Uplink<T> implements AsyncIterable<T> {
  private readonly items = new Deque<T>()
  private wake: (() => void) | undefined
  private ended = false

  push(item: T): void {
    if (this.ended) throw new Error('Remote stream uplink has ended')
    this.items.pushBack(item)
    this.wake?.()
  }

  end(): void {
    this.ended = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const next = this.items.popFront()
      if (next !== undefined) { yield next; continue }
      if (this.ended) return
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
  }
}

/**
 * One Remote stream handle: iterating opens the Host side, whose failures
 * (including opening ones) surface from the iteration, as over DSH's wire.
 */
function streamHandle<Out, In>(
  signal: AbortSignal | undefined,
  open: (uplink: AsyncIterable<In>, signal: AbortSignal) => AsyncIterable<Out>,
): RemoteStreamHandle<Out, In> {
  const uplink = new Uplink<In>()
  const lifetime = new AbortController()
  const scope = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
  return {
    send: item => { uplink.push(item) },
    end: () => { uplink.end() },
    async *[Symbol.asyncIterator]() {
      try {
        yield* open(uplink, scope)
      } catch (error) {
        throw remoteErrorOf(error) ?? new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}, { cause: error })
      } finally {
        uplink.end()
        lifetime.abort(new Error('Remote stream closed'))
      }
    },
  }
}

// ── The `remote.terminal` namespace ──────────────────────────────────────

interface OwnedSession {
  readonly terminals: Map<WebTerminalId, PageTerminal>
  readonly pending: Map<WebTerminalId, Promise<PageTerminal>>
  readonly closedIds: Set<WebTerminalId>
}

/**
 * PIDesktop's terminal Host: one owner per Session, terminals rooted in the
 * Session's working directory.
 */
export class PidTerminalHost implements TerminalRemoteFace {
  private readonly owners = new Map<SessionId, OwnedSession>()

  /**
   * @param cwdOf - the working directory of a Session, when it has one.
   */
  constructor(private readonly cwdOf: (sessionId: SessionId) => string | undefined) {}

  environment(sessionId: SessionId): Promise<RemoteResult<TerminalEnvironment>> {
    return remoteResult(() => ({
      cwd: this.requireCwd(sessionId),
      maxInputBytes: LIMITS.maxInputBytes,
      maxBufferedBytes: LIMITS.maxBufferedBytes,
      maxCols: LIMITS.maxCols,
      maxRows: LIMITS.maxRows,
      scrollback: LIMITS.scrollback,
    }))
  }

  shells(): Promise<RemoteResult<TerminalShell[]>> {
    return remoteResult(async () => {
      if (!tauriAvailable()) return []
      const labels = await invoke<string[]>('terminal_shells')
      return labels.map(label => ({ path: label, args: [], name: label }))
    })
  }

  list(sessionId: SessionId): Promise<RemoteResult<WebTerminalInfo[]>> {
    return remoteResult(() => [...(this.owners.get(sessionId)?.terminals.values() ?? [])].map(terminal => terminal.info))
  }

  create(sessionId: SessionId, request: TerminalCreateRequest): Promise<RemoteResult<WebTerminalInfo>> {
    return remoteResult(async () => {
      if (!/^[\w-]{1,128}$/u.test(request.id)) throw new Error('Invalid terminal identity')
      if (!tauriAvailable()) throw new RemoteError('terminal/unavailable', 'Terminals need the desktop app', {})
      const owner = this.owner(sessionId)
      if (owner.closedIds.has(request.id)) throw new RemoteError('terminal/unavailable', 'Terminal is closing or unavailable', {})
      const existing = owner.terminals.get(request.id)
      if (existing !== undefined) return existing.info
      const pending = owner.pending.get(request.id)
      if (pending !== undefined) return (await pending).info
      if (owner.terminals.size + owner.pending.size >= LIMITS.maxTerminals) {
        throw new RemoteError('terminal/limit-reached', 'Session terminal limit reached', { limit: LIMITS.maxTerminals })
      }
      const shells = await invoke<string[]>('terminal_shells')
      const shellName = request.shellPath !== undefined && shells.includes(request.shellPath) ? request.shellPath : shells[0]
      if (shellName === undefined) throw new Error('No shell is available on this machine')
      const shell: TerminalShell = { path: shellName, args: [], name: shellName }
      const allocation = PageTerminal.start({
        id: request.id, title: shell.name, shell, cwd: this.requireCwd(sessionId),
        cols: Math.max(2, Math.min(request.cols, LIMITS.maxCols)), rows: Math.max(1, Math.min(request.rows, LIMITS.maxRows)),
        state: 'running', exitCode: null,
      })
      owner.pending.set(request.id, allocation)
      try {
        const terminal = await allocation
        owner.terminals.set(request.id, terminal)
        return terminal.info
      } finally {
        owner.pending.delete(request.id)
      }
    })
  }

  retain(sessionId: SessionId, id: WebTerminalId, signal?: AbortSignal): RemoteStreamHandle<TerminalRetentionFrame, never> {
    return streamHandle<TerminalRetentionFrame, never>(signal, (_uplink, scope) => this.terminal(sessionId, id).retain(scope))
  }

  attach(sessionId: SessionId, id: WebTerminalId, signal?: AbortSignal): RemoteStreamHandle<TerminalFrame, TerminalInput> {
    return streamHandle<TerminalFrame, TerminalInput>(signal, (uplink, scope) => this.terminal(sessionId, id).attach(uplink, scope))
  }

  rename(sessionId: SessionId, id: WebTerminalId, title: string): Promise<RemoteResult<void>> {
    return remoteResult(() => {
      if (title.trim().length === 0 || title.length > 120) throw new Error('Terminal title must contain 1–120 characters')
      this.terminal(sessionId, id).rename(title.trim())
    })
  }

  close(sessionId: SessionId, id: WebTerminalId): Promise<RemoteResult<void>> {
    return remoteResult(async () => {
      const owner = this.owner(sessionId)
      owner.closedIds.add(id)
      await owner.pending.get(id)?.catch(() => { /* Creation reports its failure; close still owns any allocated process. */ })
      const terminal = owner.terminals.get(id)
      if (terminal === undefined) return
      await terminal.close()
      owner.terminals.delete(id)
    })
  }

  /** End every terminal (app teardown). */
  async dispose(): Promise<void> {
    const terminals = [...this.owners.values()].flatMap(owner => [...owner.terminals.values()])
    this.owners.clear()
    await Promise.allSettled(terminals.map(terminal => terminal.close()))
  }

  private owner(sessionId: SessionId): OwnedSession {
    let owner = this.owners.get(sessionId)
    if (owner === undefined) {
      owner = { terminals: new Map(), pending: new Map(), closedIds: new Set() }
      this.owners.set(sessionId, owner)
    }
    return owner
  }

  private terminal(sessionId: SessionId, id: WebTerminalId): PageTerminal {
    const owner = this.owners.get(sessionId)
    const terminal = owner?.terminals.get(id)
    if (terminal === undefined || owner?.closedIds.has(id) === true) {
      throw new RemoteError('terminal/unavailable', 'Terminal is closing or unavailable', {})
    }
    return terminal
  }

  private requireCwd(sessionId: SessionId): string {
    const cwd = this.cwdOf(sessionId)
    if (cwd === undefined || cwd === '') throw new RemoteError('terminal/unavailable', 'This conversation has no working directory', {})
    return cwd
  }
}
