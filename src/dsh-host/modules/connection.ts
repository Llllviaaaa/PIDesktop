/**
 * Stand-in for `@deepseek-ai/dsh-client-connection/client`: the Host
 * connection's generation, which Remote streams pace their retries on. DSH's
 * page reaches its Host over a socket that can drop; PIDesktop's Host is the
 * page itself and the Tauri process, so the connection is always on its first
 * generation.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** The connection face Remote streams read. */
export interface ConnectionHandle {
  /** The current connection generation, or undefined while disconnected. */
  readonly generation: HostObservable<number | undefined>
}

/** PIDesktop's connection: connected from the start, never replaced. */
export const localConnection: ConnectionHandle = {
  generation: { getSnapshot: () => 1, subscribe: () => () => {} },
}
