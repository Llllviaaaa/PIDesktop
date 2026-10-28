/**
 * Stand-in for `@deepseek-ai/dsh-tools`'s `defineTool`. better-sidebar's host
 * builds its model-facing `sidebar_open` tool with it; PIDesktop's `tools`
 * service accepts the definition and does not hand it to a model (Pi owns the
 * agent's tools), so the definition passes through unchanged.
 */
export function defineTool<T>(definition: T): T {
  return definition
}
