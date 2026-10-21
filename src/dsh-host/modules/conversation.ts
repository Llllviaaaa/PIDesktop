/**
 * Stand-in for `@deepseek-ai/dsh-client-ui-conversation/client`: the
 * conversation header seats that the copied UI registers into. PIDesktop's
 * conversation is its own; its topbar hosts these seats for the Session on
 * screen (src/dsh-host/Frame.tsx).
 */

/** The corner occupant receives no owner-specific values. */
export interface ConversationHeaderCornerOwnerProps {
  children?: never
}

/** Header action occupants receive no owner-specific values. */
export interface ConversationHeaderActionOwnerProps {
  children?: never
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Past the header's utilities: the right Sidebar's way back while it is collapsed. */
    'conversation.session.header.corner': {
      kind: 'single'
      scope: 'session'
      owner: ConversationHeaderCornerOwnerProps
    }
    /** Header utilities of the Session on screen. */
    'conversation.session.header.utilities': {
      kind: 'list'
      scope: 'session'
      owner: ConversationHeaderActionOwnerProps
    }
  }
}
