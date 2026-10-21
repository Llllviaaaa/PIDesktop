/**
 * Stand-in for `@deepseek-ai/dsh-subagent`'s `snapshotSubagentDescriptor`,
 * which the side chat uses to describe a DSH child agent. PIDesktop provides
 * no DSH `agents` service, so the side-chat routes fail before reaching it.
 */
export function snapshotSubagentDescriptor(): never {
  throw new Error('PIDesktop provides no DSH agents service')
}
