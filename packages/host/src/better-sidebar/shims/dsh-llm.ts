/**
 * Stand-in for the `@deepseek-ai/dsh-llm` values better-sidebar's host imports.
 * Connects commit-message generation in better-sidebar's Git panel to the
 * Harness Host's `LlmService` stream chunks.
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

export interface AssembledTextBlock {
  type: 'text'
  text: string
}

export class BlockAssembler {
  private text = ''
  finish: { kind?: string } | undefined

  push(chunk: unknown): void {
    const record = chunk as {
      type?: unknown
      text?: unknown
      delta?: unknown
      reason?: unknown
      kind?: unknown
    } | null
    if (record === null || typeof record !== 'object') return
    if (record.type === 'text-delta' && typeof record.text === 'string') {
      this.text += record.text
    } else if (record.type === 'text' && typeof record.delta === 'string') {
      this.text += record.delta
    } else if (record.type === 'finish') {
      const kind = typeof record.reason === 'string'
        ? record.reason
        : typeof record.kind === 'string'
          ? record.kind
          : 'stop'
      this.finish = { kind }
    }
  }

  blocks(): AssembledTextBlock[] {
    return this.text === '' ? [] : [{ type: 'text', text: this.text }]
  }
}
