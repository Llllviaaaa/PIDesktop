/**
 * Loads better-sidebar's host half (src/better-sidebar/index.ts) into the
 * Harness Host, where it used to run as a sidecar of its own.
 *
 * DSH loads the plugin into its host process beside the web server that serves
 * the GUI. This plugin provides the services it injects that the Harness Host
 * does not have yet: the Loader row it looks itself up by, `webRuntime`, a
 * `settings` service over one JSON file, and empty `sessions` and `tools`.
 * Those two are isolated to this plugin's scope: the host's own `sessions`
 * and `tools` (P3) have a different shape than the DSH services the plugin
 * was written for. Pi still owns the desktop's sessions until P5, so each
 * request's working directory comes from the client's own session summary,
 * and the plugin's optional `sidebar_open` tool has no model to reach.
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as sidebarHost from 'dsh-better-sidebar/index.ts'
import { createSettings, SIDEBAR_ENTRY_ID } from './settings.ts'
import '../web-server.ts'

export const name = 'pid-better-sidebar'
export const inject = ['webServer']

export interface Config {
  /** Where the plugin keeps its settings file. */
  dataDir: string
}

export function apply(ctx: Context, config: Config): void {
  // Isolated where the inner plugin is loaded: a service provided under a name
  // isolated inside a running plugin never reached that plugin's children.
  ctx.isolate('sessions').isolate('tools').plugin({ name: `${name}/scope`, apply: (scoped: Context) => mount(scoped, config) })
}

function mount(ctx: Context, config: Config): void {
  const entry: { options: { id: string; name: string }; fiber: unknown; disabled: boolean } = {
    options: { id: SIDEBAR_ENTRY_ID, name: sidebarHost.name },
    fiber: undefined,
    disabled: false,
  }
  const provide = (service: string, value: unknown): void => {
    ctx.effect(() => ctx.provide(service, value), `pid-better-sidebar: provide ${service}`)
  }
  provide('loader', { entries: () => [entry], await: () => Promise.resolve() })
  provide('webRuntime', { trustedHosts: [] })
  provide('sessions', { get: () => undefined })
  provide('tools', { register: () => () => {} })
  provide('settings', createSettings(join(config.dataDir, 'better-sidebar', 'settings.json')))
  entry.fiber = ctx.plugin(sidebarHost)
}
