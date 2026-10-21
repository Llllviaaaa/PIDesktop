/**
 * Stand-in for `@deepseek-ai/dsh-api-workspace-controller/client`. DSH groups
 * Sessions into Workspaces; PIDesktop's project folders play that part. Only
 * the source type is needed so far (DSH's Electron browser keys storage by it,
 * a path PIDesktop does not take).
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

export interface WorkspaceItem {
  readonly path: string
  readonly sessionIds: readonly string[]
}

export interface WorkspaceListState {
  readonly phase: 'pending' | 'ready'
  readonly items: readonly WorkspaceItem[]
}

/** Authoritative Workspace membership. */
export type WorkspaceSource = ObservableSnapshot<WorkspaceListState>

export interface WorkspacesService {
  readonly list: WorkspaceSource
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaces: WorkspacesService
  }
}
