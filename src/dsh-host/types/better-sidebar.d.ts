/**
 * What PIDesktop's host reaches in better-sidebar's client
 * (src/better-sidebar/client): the plugin entry, the chunk loader's script
 * seam, and the lazy chunk entries. Every `dsh-better-sidebar/*` import
 * type-checks against this one module (tsconfig.json `paths`); at runtime the
 * same specifiers resolve to the sources (dsh-aliases.ts).
 *
 * The sources themselves type-check upstream against DSH's own host types,
 * which their context-types.ts restates structurally; PIDesktop's host types
 * differ in detail (branded ids, optional members), so checking them here
 * would report the gap between the two hosts rather than defects in either.
 */

/** Plugin entry (`client/index.tsx`). */
export const name: string | undefined
export const inject: string[]
export function apply(ctx: unknown): void

/** Chunk loader (`client/chunk-loader.ts`). */
export type ChunkName = 'editor' | 'mermaid' | 'locale' | 'terminal'
export type ChunkExports = Record<string, unknown>
export function setChunkScriptLoaderForTests(loader: ((src: string) => Promise<void>) | null): void
