/**
 * PIDesktop's frame plugin: the occupant of DSH's built-in `root` slot.
 *
 * DSH's own frame draws the whole window and renders its child slots in
 * place. PIDesktop keeps its layout and lends DSH two places: the right
 * column, and the topbar's corner. Each registers its DOM node here; the
 * root component renders the matching slot into it through a portal, so the
 * slot content stays inside DSH's React tree (its providers and stores)
 * while it sits in PIDesktop's layout. Header seats are Session-scoped, so
 * they render inside a SessionProvider for the Session on screen.
 */
import { useCallback, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RightbarOwnerProps } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Where PIDesktop shows DSH's seats, and the right column's geometry. */
interface FrameTargets {
  readonly rightbar: HTMLElement | null
  readonly corner: HTMLElement | null
  readonly geometry: RightbarOwnerProps
  /** The Session on screen, held as the main view; header seats bind to it. */
  readonly reference: SessionReference | undefined
}

const listeners = new Set<() => void>()
let targets: FrameTargets = {
  rightbar: null,
  corner: null,
  geometry: { width: 0, viewportWidth: 0, canShow: false },
  reference: undefined,
}

function update(change: Partial<FrameTargets>): void {
  const next = { ...targets, ...change }
  const keys = Object.keys(change) as (keyof FrameTargets)[]
  if (keys.every(key => Object.is(next[key], targets[key]))) return
  targets = next
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Point the header seats at the Session on screen (the host holds its main-view reference). */
export function setFrameSession(reference: SessionReference | undefined): void {
  update({ reference })
}

/**
 * The right column's node: DSH's right Sidebar positions itself inside it,
 * at its right edge, sized from `geometry`.
 */
export function useRightbarTarget(geometry: RightbarOwnerProps): (node: HTMLElement | null) => void {
  const { width, viewportWidth, canShow } = geometry
  useLayoutEffect(() => {
    update({ geometry: { width, viewportWidth, canShow } })
  }, [width, viewportWidth, canShow])
  return useCallback((node: HTMLElement | null) => { update({ rightbar: node }) }, [])
}

/** The topbar corner's node: the right Sidebar's expand button renders into it. */
export function useCornerTarget(): (node: HTMLElement | null) => void {
  return useCallback((node: HTMLElement | null) => { update({ corner: node }) }, [])
}

type FrameProps = PropsRuntime<'root'>
  & PropsRenderSlots<'rightbar' | 'conversation.session.header.corner' | 'conversation.session.header.utilities'>

function PidFrame({ renderSlot, SessionProvider }: FrameProps): ReactNode {
  const current = useSyncExternalStore(subscribe, () => targets)
  return (
    <>
      {current.rightbar !== null && createPortal(renderSlot('rightbar', current.geometry), current.rightbar)}
      {current.corner !== null && current.reference !== undefined && createPortal(
        <SessionProvider session={current.reference}>
          {/* DSH's session header ends with its utilities, then the corner seat. */}
          {renderSlot('conversation.session.header.utilities', {})}
          {renderSlot('conversation.session.header.corner', {})}
        </SessionProvider>,
        current.corner,
      )}
    </>
  )
}

/** The frame needs the slot registry and its own face. */
export const inject = ['slots', 'layout']

/**
 * Occupy `root`, declare the seats PIDesktop hosts, and publish the
 * panel-info source every slot component reads.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.slots.provideRoot({ hooks: { panelInfo: ctx.layout.panelInfo } }), 'pid-frame: panel info')
  ctx.effect(() => ctx.slots.register({
    name: 'root',
    children: {
      'rightbar': { kind: 'single', scope: 'root' },
      'conversation.session.header.corner': { kind: 'single', scope: 'session' },
      'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    },
  }, PidFrame), 'pid-frame: root')
}
