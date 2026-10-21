/**
 * Boot DSH's client UI inside PIDesktop.
 *
 * One cordis root context carries PIDesktop's host services (session
 * catalog, frame face, copy, shortcuts, theme, remote events); the copied DSH
 * plugins then load as DSH's own boot would load them, each activating once
 * the services it injects are present. PIDesktop drives the host through the
 * returned handle: which sessions exist, which one is on screen, the theme,
 * and whether a hub page covers the conversation.
 */
import type { ReactNode } from 'react'
import { Context } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import * as renderer from '@deepseek-ai/dsh-client-ui-renderer/client'
import * as resources from '@deepseek-ai/dsh-client-resources/client'
import * as uiSession from '@deepseek-ai/dsh-client-ui-session/client'
import * as sidebarRight from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import * as sidebarBrowser from '../dsh/sidebar-browser/client/index.ts'
import * as terminalController from '@deepseek-ai/dsh-api-terminal-controller/client'
import * as sidebarTerminal from '@deepseek-ai/dsh-client-ui-sidebar-terminal/client'
import * as frame from './Frame.tsx'
import { startBetterSidebar } from './better-sidebar.ts'
import { setFrameSession } from './Frame.tsx'
import { LocaleRuntime } from './modules/locale.ts'
import { HostShortcuts } from './modules/shortcuts.ts'
import { HostTheme } from './modules/theme.ts'
import { HostLayout, type RightbarState } from './modules/layout.ts'
import { HostRemote } from './modules/remotes.ts'
import { localRemoteAccess } from './modules/remote-access.ts'
import { PiSessions, type HostSessionRow } from './modules/session-controller.ts'
import { PidTerminalHost } from './modules/terminals.ts'

export type { HostSessionRow } from './modules/session-controller.ts'
export type { RightbarState } from './modules/layout.ts'

export interface DshHostOptions {
  colorScheme: 'light' | 'dark'
  /** Toggles PIDesktop's left sidebar. */
  toggleSidebar: () => void
  /** Closes the app window. */
  closeWindow: () => Promise<void>
}

export interface DshHost {
  readonly ctx: Context
  /** Whether the slot renderer is up, so {@link render} can be called. */
  readonly ready: HostObservable<boolean>
  /** What the right panel asked the frame for; PIDesktop sizes its column from it. */
  readonly rightbar: HostObservable<RightbarState>
  /** The React tree of DSH's UI; mount it once, anywhere (its seats portal into place). */
  render(): ReactNode
  /** Replace the session catalog with Pi's list. */
  setSessions(rows: readonly HostSessionRow[]): void
  /** The session on screen, or none (new task page). */
  showSession(file: string | undefined): void
  setColorScheme(colorScheme: 'light' | 'dark'): void
  /** A hub page (pull requests, plugins) covers the conversation, or null. */
  setPanel(panelId: string | null): void
  /** Open or close better-sidebar's bottom workbench (a new terminal while its toggle is hidden). */
  toggleBottomPanel(): void
  /** Open a new terminal in better-sidebar's bottom workbench. */
  openBottomTerminal(): void
  dispose(): void
}

/** Loading order: each plugin's injected services come from those before it. */
const PLUGINS = [renderer, resources, uiSession, frame, sidebarRight, sidebarBrowser, terminalController, sidebarTerminal] as const

export function bootDshHost(options: DshHostOptions): DshHost {
  const root = new Context()
  const locale = new LocaleRuntime(root)
  const shortcuts = new HostShortcuts(options.closeWindow)
  const theme = new HostTheme(root, options.colorScheme)
  const layout = new HostLayout(options.toggleSidebar)
  const remote = new HostRemote()
  const sessions = new PiSessions(root)
  const terminals = new PidTerminalHost(id => sessions.list.getSnapshot().byId[id]?.cwd)
  remote.terminal = terminals

  const disposers: (() => unknown)[] = []
  const provide = (name: string, value: unknown): void => {
    const dispose = root.reflect.provide(name, value)
    disposers.push(() => dispose())
  }
  provide('locale', locale)
  provide('shortcuts', shortcuts)
  provide('theme', theme)
  provide('layout', layout)
  provide('remote', remote)
  provide('remoteAccess', localRemoteAccess)
  provide('sessions', sessions)
  provide('remote.terminal', terminals)
  disposers.push(() => terminals.dispose())
  disposers.push(shortcuts.listen())

  let readyValue = false
  const readyListeners = new Set<() => void>()
  const ready: HostObservable<boolean> = {
    getSnapshot: () => readyValue,
    subscribe: (listener) => {
      readyListeners.add(listener)
      return () => { readyListeners.delete(listener) }
    },
  }
  // The renderer reads copy through the locale face; install it before the first render.
  const slotsFiber = root.inject(['slots'], (ctx) => {
    ctx.slots.installLocale(locale.face())
    readyValue = true
    for (const listener of [...readyListeners]) listener()
  })
  const fibers = [slotsFiber, ...PLUGINS.map(plugin => root.plugin(plugin))]
  disposers.push(startBetterSidebar(root, remote))

  const openBottomTerminal = (): void => {
    const service = root.get('betterSidebar') as { openTab(seed: { type: string }): void } | undefined
    service?.openTab({ type: 'terminal-bottom' })
  }

  let mainView: SessionReference | undefined
  const showSession = (file: string | undefined): void => {
    const id = file as SessionId | undefined
    if (mainView?.sessionId === id) return
    const previous = mainView
    mainView = id === undefined ? undefined : sessions.retain(id, { source: 'mainView' })
    setFrameSession(mainView)
    previous?.release()
  }

  return {
    ctx: root,
    ready,
    rightbar: layout.rightbar,
    render: () => root.slots.renderSlot('root', {}),
    setSessions: rows => { sessions.setCatalog(rows) },
    showSession,
    setColorScheme: scheme => { theme.setColorScheme(scheme) },
    setPanel: panelId => { layout.setPanel(panelId) },
    toggleBottomPanel: () => {
      // better-sidebar keeps the workbench state in its own store; its header
      // toggle is the public way in, and it hides while the right panel is open.
      const toggle = [...document.querySelectorAll<HTMLButtonElement>('[data-dsh-bottom-toggle]')]
        .find(button => button.closest('[data-dsh-dock-fallback]') === null)
      if (toggle !== undefined) toggle.click()
      else openBottomTerminal()
    },
    openBottomTerminal,
    dispose: () => {
      showSession(undefined)
      for (const fiber of fibers.reverse()) void fiber.dispose()
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}
