/**
 * Stand-in for the `@deepseek-ai/dsh-llm` values better-sidebar's host imports.
 * They serve the commit-message suggestion and the side chat, both of which
 * run on DSH's `llm` and `agents` services; PIDesktop provides neither, so
 * those routes answer "unavailable" before reaching these.
 */
export interface UserMessageInput {
  content: unknown
  source?: unknown
}

export function createUserMessage(input: UserMessageInput): { role: 'user' } & UserMessageInput {
  return { role: 'user', ...input }
}

export function ReasoningEffortId(value: string): string {
  return value
}

export class BlockAssembler {
  constructor() {
    throw new Error('PIDesktop provides no DSH llm service')
  }
}
