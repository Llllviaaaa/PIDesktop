/**
 * PIDesktop: the host's own Side Chat view. When the host registers one, the
 * Side Chat tab renders it instead of {@link ./SideChatView.tsx}, whose
 * `sidechat.*` routes need DSH's agent registry.
 */
import type { ReactNode } from 'react'

export interface HostSideChatProps {
  /** The conversation the tab belongs to. */
  sessionId: string
  /** The tab's id: one side chat per tab. */
  tabId: string
  visible: boolean
}

let hostSideChat: ((props: HostSideChatProps) => ReactNode) | undefined

export function setHostSideChat(render: ((props: HostSideChatProps) => ReactNode) | undefined): void {
  hostSideChat = render
}

export function getHostSideChat(): ((props: HostSideChatProps) => ReactNode) | undefined {
  return hostSideChat
}
