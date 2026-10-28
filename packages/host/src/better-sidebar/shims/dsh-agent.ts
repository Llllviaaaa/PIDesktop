/**
 * Stand-in for `@deepseek-ai/dsh-agent`'s `installModelSelection`, which the
 * side chat calls on a DSH agent it created. PIDesktop provides no DSH
 * `agents` service, so the side-chat routes fail before reaching it.
 */
export function installModelSelection(): never {
  throw new Error('PIDesktop provides no DSH agents service')
}
