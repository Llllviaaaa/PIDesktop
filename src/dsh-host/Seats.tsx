/**
 * The places PIDesktop's layout gives DSH's UI, and the one host instance
 * behind them.
 */
import { useSyncExternalStore, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { bootDshHost, type DshHost } from './boot.ts'
import { useCornerTarget, useRightbarTarget } from './Frame.tsx'
import './dsh-host.css'

/** DSH's frame keeps a 400px conversation beside a panel of at least 300px (ui-layout). */
const CENTER_MIN = 400
const RIGHTBAR_MIN = 300

const callbacks = {
  toggleSidebar: () => {},
  closeWindow: async () => {},
}

let instance: DshHost | undefined

/** The host, booted on first use; one per window, whatever React's dev double-mounting does. */
export function dshHost(): DshHost {
  instance ??= bootDshHost({
    colorScheme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    toggleSidebar: () => { callbacks.toggleSidebar() },
    closeWindow: () => callbacks.closeWindow(),
  })
  return instance
}

/** PIDesktop's own actions DSH's frame face forwards to. */
export function setDshHostCallbacks(next: Partial<typeof callbacks>): void {
  Object.assign(callbacks, next)
}

/** Mount DSH's React tree once its renderer is up; its seats portal into the places below. */
export function DshRoot(): ReactNode {
  const host = dshHost()
  const ready = useSyncExternalStore(host.ready.subscribe, host.ready.getSnapshot)
  return ready ? host.render() : null
}

interface RightbarColumnProps {
  /** The panel's preferred width (PIDesktop remembers it across runs). */
  width: number
  /** Width of the area beside PIDesktop's left sidebar; fullscreen covers it. */
  viewportWidth: number
  resize: {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => void
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
    min: number
    max: number
  }
}

/**
 * The right column. DSH's right Sidebar reports whether it is shown and
 * whether it wants a track; the column takes its width only then. In
 * fullscreen it keeps no track and the panel covers the area from here.
 */
export function DshRightbarColumn({ width, viewportWidth, resize }: RightbarColumnProps): ReactNode {
  const host = dshHost()
  const state = useSyncExternalStore(host.rightbar.subscribe, host.rightbar.getSnapshot)
  const fits = viewportWidth - CENTER_MIN
  const resolved = fits >= RIGHTBAR_MIN ? Math.min(width, fits) : 0
  const ref = useRightbarTarget({ width: resolved, viewportWidth, canShow: resolved > 0 })
  const track = state.shown && state.track ? resolved : 0
  return (
    <>
      {track > 0 && !state.fullscreen && (
        <div
          className="dsh-rightbar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧边栏宽度"
          aria-valuemin={resize.min}
          aria-valuemax={resize.max}
          aria-valuenow={Math.round(track)}
          tabIndex={0}
          onPointerDown={resize.onPointerDown}
          onKeyDown={resize.onKeyDown}
        />
      )}
      <div ref={ref} className="dsh-rightbar-col dsh-root" style={{ width: track }} data-rightbar-col />
    </>
  )
}

/** The topbar's corner: DSH's expand button appears here while the right Sidebar is collapsed. */
export function DshCorner(): ReactNode {
  const ref = useCornerTarget()
  return <div ref={ref} className="dsh-corner dsh-root" />
}
