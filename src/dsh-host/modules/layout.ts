/**
 * Stand-in for `@deepseek-ai/dsh-client-ui-layout/client`: the frame's face
 * (`ctx.layout`) and the slots it owns. DSH's frame is a grid it draws itself;
 * PIDesktop keeps its own layout and lends DSH the right column, so this
 * face reports the right panel's wishes (shown, track, fullscreen) to
 * PIDesktop, which sizes its column from them.
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

export type MainPanelId = Branded<'MainPanelId'>

/** Root-scoped navigation state exposed to panel-aware components. */
export interface PanelInfo {
  /** Selected global panel; null displays the current Conversation. */
  readonly activePanelId: MainPanelId | null
}

/** Panel navigation and geometry actions exposed through ctx.layout. */
export interface ILayout {
  readonly panelInfo: HostObservable<PanelInfo>
  selectPanel(panelId: MainPanelId | null): void
  beginNavigation(): AbortSignal
  toggleSidebar(): void
  /**
   * The right panel is shown.
   * @param track - whether it takes a column beside the conversation.
   * @param fullscreen - whether it covers the window.
   */
  openRightbar(track: boolean, fullscreen: boolean): void
  closeRightbar(): void
}

export type UsePanelInfo = SnapshotSelectorHook<PanelInfo>

/** Right column owner share: resolved normal geometry and opening eligibility. */
export interface RightbarOwnerProps {
  /** Resolved normal panel width in px; zero if it cannot fit. */
  width: number
  /** Current frame width in px. */
  viewportWidth: number
  /** Whether a normal right panel can fit beside the conversation. */
  canShow: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    layout: ILayout
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** Subscribe to the selected main panel independently of parent renders. */
    usePanelInfo: UsePanelInfo
  }

  interface SlotMap {
    /** The right column. Occupied by the right Sidebar. */
    'rightbar': { kind: 'single'; scope: 'root'; owner: RightbarOwnerProps }
  }
}

/** What the right panel asked the frame for. */
export interface RightbarState {
  readonly shown: boolean
  readonly track: boolean
  readonly fullscreen: boolean
}

const HIDDEN: RightbarState = Object.freeze({ shown: false, track: false, fullscreen: false })

function source<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: T) {
      if (Object.is(next, value)) return
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** PIDesktop's frame face. */
export class HostLayout implements ILayout {
  private readonly panel = source<PanelInfo>(Object.freeze({ activePanelId: null }))
  private readonly rightbarSource = source<RightbarState>(HIDDEN)
  private navigation = new AbortController()

  readonly panelInfo: HostObservable<PanelInfo> = this.panel
  /** The right panel's last report; PIDesktop's layout follows it. */
  readonly rightbar: HostObservable<RightbarState> = this.rightbarSource

  /**
   * @param toggleSidebarImpl - toggles PIDesktop's left sidebar.
   */
  constructor(private readonly toggleSidebarImpl: () => void) {}

  selectPanel(panelId: MainPanelId | null): void {
    this.navigation.abort()
    this.setPanel(panelId)
  }

  /**
   * Follow PIDesktop's main page: a hub page (pull requests, plugins) is not a conversation.
   * @param panelId - the hub page shown, or null for the conversation.
   */
  setPanel(panelId: string | null): void {
    if (this.panel.getSnapshot().activePanelId === panelId) return
    this.panel.set(Object.freeze({ activePanelId: panelId as MainPanelId | null }))
  }

  beginNavigation(): AbortSignal {
    this.navigation.abort()
    this.navigation = new AbortController()
    return this.navigation.signal
  }

  toggleSidebar(): void {
    this.toggleSidebarImpl()
  }

  openRightbar(track: boolean, fullscreen: boolean): void {
    const current = this.rightbarSource.getSnapshot()
    if (current.shown && current.track === track && current.fullscreen === fullscreen) return
    this.rightbarSource.set(Object.freeze({ shown: true, track, fullscreen }))
  }

  closeRightbar(): void {
    this.rightbarSource.set(HIDDEN)
  }
}
