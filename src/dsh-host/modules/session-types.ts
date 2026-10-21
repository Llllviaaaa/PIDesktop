/** Stand-in for `@deepseek-ai/dsh-session/types`: the Session identity. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** A Session's identity. PIDesktop uses the Pi session file path. */
export type SessionId = Branded<'SessionId'>
