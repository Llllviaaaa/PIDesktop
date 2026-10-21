/**
 * Stand-in for `@deepseek-ai/dsh-api-remote-access/client`. DSH answers
 * per-Peer access to remote endpoints; PIDesktop has one local user, who may
 * do everything.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'

/** A remote endpoint name. */
export type RemoteEndpoint = string

export interface ClientRemoteAccess {
  /**
   * Whether the current Peer may call `action` on one resource.
   * @param kind - resource kind.
   * @param id - resource id.
   * @param action - endpoint name.
   * @returns an observable answer.
   */
  source(kind: string, id: string, action: string): HostObservable<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteAccess: ClientRemoteAccess
  }
}

const ALLOWED: HostObservable<boolean> = {
  getSnapshot: () => true,
  subscribe: () => () => {},
}

/** Every action is allowed for the local user. */
export const localRemoteAccess: ClientRemoteAccess = {
  source: () => ALLOWED,
}
