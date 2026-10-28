/**
 * The parts of better-sidebar's host half (src/better-sidebar) that the
 * Harness Host reaches. Its sources type-check upstream against DSH's own host
 * types (see src/better-sidebar/README.md), so tsconfig.packages.json does not
 * follow these imports into them; the bundle and vitest resolve the
 * `dsh-better-sidebar/*` specifier to the real files (dsh-aliases.ts).
 */
declare module 'dsh-better-sidebar/index.ts' {
  import type { Context } from '@deepseek-ai/cordis'

  export const name: string
  export const inject: string[]
  export function apply(ctx: Context, config?: unknown): void
}

declare module 'dsh-better-sidebar/config.ts' {
  /** Resolves a Side card preference layer to its full value; throws on invalid input. */
  export const PrefsSchema: (value: unknown) => unknown
}

declare module 'dsh-better-sidebar/context-types.ts' {
  export interface SidebarSettingsService {
    describe(options?: { redactSecrets?: boolean }): Array<{
      ns: string
      revision: number
      value?: unknown
      user?: unknown
    }>
    update(ns: string, patch: object, expectedRevision?: number): Promise<void>
    configure(presentation: { auto?: boolean }, owner?: unknown): () => void
  }
}
