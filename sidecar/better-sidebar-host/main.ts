/**
 * better-sidebar's host half, run as PIDesktop's sidecar.
 *
 * DSH loads the plugin's `src/index.ts` into its own host process, beside the
 * web server that serves the GUI. PIDesktop has no such process, so this entry
 * builds the cordis root the plugin expects, provides the host services it
 * injects (backed by a loopback HTTP server and a JSON settings file), and
 * loads the plugin unchanged.
 *
 * Usage: better-sidebar-host --data-dir <dir> [--port <n>] [--page-origin <origin>]... [--exit-with-stdin]
 * Prints one JSON line `{"port": n}` on stdout once listening; logs go to stderr.
 */
import { join } from 'node:path'
import { format } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import * as sidebarHost from '../../src/better-sidebar/index.ts'
import { createHostWebServer } from './web-server.ts'
import { createSettings, SIDEBAR_ENTRY_ID } from './settings.ts'

interface Options {
  port: number
  dataDir: string
  pageOrigins: string[]
  exitWithStdin: boolean
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = { port: 0, dataDir: '', pageOrigins: [], exitWithStdin: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = (): string => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`${flag} needs a value`)
      index += 1
      return next
    }
    if (flag === '--port') options.port = Number(value())
    else if (flag === '--data-dir') options.dataDir = value()
    else if (flag === '--page-origin') options.pageOrigins.push(value())
    else if (flag === '--exit-with-stdin') options.exitWithStdin = true
    else throw new Error(`unknown argument ${flag}`)
  }
  if (!Number.isInteger(options.port) || options.port < 0) throw new Error('--port must be a port number')
  if (options.dataDir === '') throw new Error('--data-dir is required')
  return options
}

const log = (level: string) => (...args: unknown[]): void => {
  process.stderr.write(`[better-sidebar-host] ${level} ${format(...args)}\n`)
}

const options = parseOptions(process.argv.slice(2))
const web = createHostWebServer(options.pageOrigins)
const root = new Context()
const provide = (name: string, value: unknown): void => { root.reflect.provide(name, value) }

// The Loader row better-sidebar looks itself up by (see ownEntryId in its index.ts).
const entry: { options: { id: string; name: string }; fiber: unknown; disabled: boolean } = {
  options: { id: SIDEBAR_ENTRY_ID, name: sidebarHost.name },
  fiber: undefined,
  disabled: false,
}

provide('logger', { debug: () => {}, info: log('info'), warn: log('warn'), error: log('error') })
provide('loader', { entries: () => [entry], await: () => Promise.resolve() })
provide('webServer', web.service)
provide('webRuntime', { trustedHosts: [] })
// PIDesktop's sessions are Pi's: none is attached here, so each request's
// working directory comes from the client's own session summary.
provide('sessions', { get: () => undefined })
// Pi owns the agent's tools; the plugin's optional `sidebar_open` tool has no model to reach.
provide('tools', { register: () => () => {} })
provide('settings', createSettings(join(options.dataDir, 'settings.json')))

entry.fiber = root.plugin(sidebarHost)

web.server.listen(options.port, '127.0.0.1', () => {
  const address = web.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port
  process.stdout.write(`${JSON.stringify({ port })}\n`)
})

const shutdown = (): void => {
  web.server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
if (options.exitWithStdin) {
  // The desktop app holds our stdin; when it exits, however it exits, the pipe closes.
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.stdin.resume()
}
