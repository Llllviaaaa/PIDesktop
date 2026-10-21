/**
 * Stand-in for `@deepseek-ai/dsh-api-remotes/client`: the remote face the UI
 * reaches through `ctx.remote`. DSH's covers every Host subsystem over its
 * typed RPC; PIDesktop's carries the members the copied UI calls, each backed
 * by a Tauri command or a Pi event, and grows as more of the UI is wired.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteStream, type RemoteStreamOptions } from './gateway/remote-stream.ts'
import { localConnection } from './connection.ts'

export type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** Host-pushed events the UI subscribes to. */
export interface ClientRemoteEvents {
  /** A Session started or stopped running. */
  'api-session/status'(sessionId: SessionId, running: boolean): void
}

export interface ClientRemote {
  /**
   * Subscribe to a Host-pushed event.
   * @param event - event name.
   * @param listener - handler.
   * @returns unsubscribe.
   */
  $on<K extends keyof ClientRemoteEvents>(event: K, listener: ClientRemoteEvents[K]): () => void
  /**
   * Open one logical stream that reopens across connection generations.
   * @param options - the domain's opener and end classification.
   */
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remote: ClientRemote
  }
}

type AnyListener = (...args: never[]) => void

/** The host side of `ctx.remote`: PIDesktop emits the events its state changes imply. */
export class HostRemote implements ClientRemote {
  /** The terminal Host (modules/terminals.ts), set when the host boots. */
  terminal!: ClientRemote['terminal']

  private readonly listeners = new Map<string, Set<AnyListener>>()

  $on<K extends keyof ClientRemoteEvents>(event: K, listener: ClientRemoteEvents[K]): () => void {
    let set = this.listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener as AnyListener)
    return () => { set.delete(listener as AnyListener) }
  }

  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item> {
    return new RemoteStream(localConnection, options)
  }

  /**
   * Deliver one event to its subscribers.
   * @param event - event name.
   * @param args - event arguments.
   */
  $emit<K extends keyof ClientRemoteEvents>(event: K, ...args: Parameters<ClientRemoteEvents[K]>): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        (listener as unknown as (...values: Parameters<ClientRemoteEvents[K]>) => void)(...args)
      } catch (error) {
        console.error(`remote event ${event} listener failed:`, error)
      }
    }
  }
}
