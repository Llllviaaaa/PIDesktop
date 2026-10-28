/**
 * better-sidebar's client half (src/better-sidebar/client, MIT, © 2026
 * dsh-external) on PIDesktop's DSH host.
 *
 * DSH loads the plugin's client bundle into its page and serves the plugin's
 * routes from its own host process. PIDesktop serves those routes from the
 * Harness Host (packages/host, which loads the plugin's host half), so this
 * module points the client's transport at it, hands the client's lazy chunks to
 * Vite's code splitting, provides the client services DSH's page would
 * (module table, connection, the remote session namespace, the composer
 * draft), and then loads the plugin unchanged.
 */
import type { Context } from '@deepseek-ai/cordis'
import { invoke } from '@tauri-apps/api/core'
import { openPath } from '@tauri-apps/plugin-opener'
import * as betterSidebar from 'dsh-better-sidebar/client/index.tsx'
import { setChunkScriptLoaderForTests, type ChunkExports, type ChunkName } from 'dsh-better-sidebar/client/chunk-loader.ts'
import { pi } from '../lib/pi'

/** Each lazy chunk's entry, split out by Vite. */
const CHUNKS: Record<ChunkName, () => Promise<ChunkExports>> = {
  editor: () => import('dsh-better-sidebar/client/chunks/editor.tsx'),
  mermaid: () => import('dsh-better-sidebar/client/chunks/mermaid.tsx'),
  locale: () => import('dsh-better-sidebar/client/chunks/locale.tsx'),
  terminal: () => import('dsh-better-sidebar/client/chunks/terminal.tsx'),
}

/** The client module table chunks resolve their externals through (`ctx.modules`). */
const MODULES: Record<string, () => Promise<unknown>> = {
  'react': () => import('react'),
  'react/jsx-runtime': () => import('react/jsx-runtime'),
  'react-dom': () => import('react-dom'),
  'react-dom/client': () => import('react-dom/client'),
  'cordis': () => import('@deepseek-ai/cordis'),
  '@deepseek-ai/dsh-client-ui-slots': () => import('@deepseek-ai/dsh-client-ui-slots'),
  '@deepseek-ai/dsh-client-ui-primitives': () => import('@deepseek-ai/dsh-client-ui-primitives'),
}

/** Where the Vite dev server's page finds a Harness Host started by hand (scripts/prepare-harness-host.mjs). */
const DEV_SIDECAR = 'http://127.0.0.1:47100/'

async function sidecarBase(): Promise<string | undefined> {
  if ('__TAURI_INTERNALS__' in window) return invoke<string>('sidebar_host_base')
  return import.meta.env.DEV ? (import.meta.env.VITE_SIDEBAR_HOST_URL as string | undefined) ?? DEV_SIDECAR : undefined
}

/** The chunk loader fetches `sidebar/bundle/<name>.js`; Vite has already split each chunk out. */
function installChunkLoader(): void {
  setChunkScriptLoaderForTests(async (src) => {
    const name = /\/sidebar\/bundle\/([a-z0-9-]+)\.js$/.exec(new URL(src).pathname)?.[1] as ChunkName | undefined
    const load = name === undefined ? undefined : CHUNKS[name]
    if (name === undefined || load === undefined) throw new Error(`[pid-better-sidebar] unknown chunk ${src}`)
    const exports = await load()
    const registry = ((globalThis as { __dshChunks__?: Record<string, unknown> }).__dshChunks__ ??= {})
    registry[name] = () => exports
  })
}

interface FileApplication {
  id: string
  name: string
  default: boolean
  icon: string | null
}

/** The operating system's own choice for a path. */
const SYSTEM_DEFAULT = 'system-default'

/** `ctx.remote.session`'s workspace-path members, backed by PIDesktop's openers. */
const sessionRemote = {
  async canOpenWorkspacePath() {
    return { ok: true, value: '__TAURI_INTERNALS__' in window }
  },
  async workspacePathApplications(_request: { path: string }) {
    try {
      const editors = await pi.listWorkspaceEditors()
      const value: FileApplication[] = [
        { id: SYSTEM_DEFAULT, name: '默认应用', default: true, icon: null },
        ...editors.map(editor => ({ id: editor.id, name: editor.name, default: false, icon: null })),
      ]
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: { message: String(error) } }
    }
  },
  async openWorkspacePath(request: { path: string; action?: 'reveal'; application?: string }) {
    try {
      if (request.action === 'reveal') await pi.revealPathInFileManager(request.path)
      else if (request.application === undefined || request.application === SYSTEM_DEFAULT) await openPath(request.path)
      else await pi.openFileInEditor(request.path, request.application)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: { message: String(error) } }
    }
  },
}

/** The composer's textarea, located the way better-sidebar's caret probe does. */
function composerTextarea(): HTMLTextAreaElement | null {
  const column = document.querySelector('#root [data-slot="conversation"]')
  return column?.querySelector<HTMLTextAreaElement>('textarea[data-phase]') ?? null
}

/**
 * `ctx.conversation`'s composer draft: PIDesktop's composer is a controlled
 * textarea, so a write goes through the native value setter and an input
 * event, the path a keystroke takes.
 */
const conversation = {
  input: {
    for(_scope: Context) {
      return {
        state: { getSnapshot: () => ({ draft: composerTextarea()?.value ?? '' }) },
        setDraft(text: string) {
          const textarea = composerTextarea()
          if (textarea === null) throw new Error('no composer on screen')
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, text)
          textarea.dispatchEvent(new Event('input', { bubbles: true }))
        },
      }
    },
  },
}

/** PIDesktop's page talks to the sidecar directly; there is no reconnecting transport. */
const connection = {
  state: { getSnapshot: () => 'connected' as const, subscribe: () => () => {} },
  reconnect() {},
}

/**
 * Provide better-sidebar's client services on the root and load the plugin
 * once the sidecar answers.
 * @param root - the DSH host's client root.
 * @param remote - the root's `remote` service, which gains the `session` namespace.
 * @returns a disposer for the services and the plugin.
 */
export function startBetterSidebar(root: Context, remote: object): () => void {
  const disposers: (() => unknown)[] = []
  const provide = (name: string, value: unknown): void => {
    const dispose = root.reflect.provide(name, value)
    disposers.push(() => dispose())
  }
  Object.assign(remote, { session: sessionRemote })
  provide('remote.session', sessionRemote)
  provide('modules', { import: (specifier: string) => MODULES[specifier]?.() ?? Promise.reject(new Error(`no module ${specifier}`)) })
  provide('connection', connection)
  provide('conversation', conversation)
  installChunkLoader()

  let disposed = false
  void sidecarBase().then((base) => {
    if (disposed || base === undefined) return
    ;(globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string; httpBaseUrl?: string } }).__DSH_TRANSPORT__ = {
      streamBaseUrl: base,
      httpBaseUrl: base,
    }
    const fiber = root.plugin(betterSidebar)
    disposers.push(() => fiber.dispose())
  }).catch((error: unknown) => {
    console.error('[pid-better-sidebar] the sidebar host did not start:', error)
  })

  return () => {
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
  }
}
