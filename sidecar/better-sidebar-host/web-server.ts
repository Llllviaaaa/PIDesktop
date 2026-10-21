/**
 * PIDesktop's `webServer` service for better-sidebar's host half: the route
 * table DSH's host web server keeps, on a loopback `node:http` server of its own.
 *
 * DSH serves the GUI and the plugin routes from one origin, so better-sidebar's
 * fence (trust-fence.ts) admits only same-host browser requests. PIDesktop's
 * page comes from Tauri's origin instead (`http://tauri.localhost`, or the Vite
 * dev server), so every request is cross-origin. This server is the fence for
 * that boundary: a request whose Origin, or failing that Referer, is one of the
 * PIDesktop page origins is presented to the routes as a same-origin request
 * and answered with CORS headers; any other browser origin is refused here.
 * Requests with neither header (no browser involved) reach the routes as they
 * came, under better-sidebar's own fence.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type {
  SidebarHttpRequest,
  SidebarHttpResponse,
  SidebarUpgradeSocket,
  SidebarWebRoute,
  SidebarWebServer,
  SidebarWebUpgradeRoute,
} from '../../src/better-sidebar/context-types.ts'

export interface HostWebServer {
  readonly server: Server
  readonly service: SidebarWebServer
}

type Admission = 'page' | 'unattributed' | 'foreign'

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function originOf(value: string): string | undefined {
  try {
    const origin = new URL(value).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://sidebar.internal').pathname
}

function matches(route: { path: string }, kind: 'exact' | 'prefix', pathname: string): boolean {
  return kind === 'exact'
    ? pathname === route.path
    : pathname === route.path || pathname.startsWith(`${route.path}/`)
}

/**
 * Create the server and the service the routes register into.
 * @param pageOrigins - the origins PIDesktop's own page is served from.
 */
export function createHostWebServer(pageOrigins: readonly string[]): HostWebServer {
  const routes = new Set<SidebarWebRoute>()
  const upgrades = new Set<SidebarWebUpgradeRoute>()
  const trusted = new Set(pageOrigins)

  const selfOrigin = (req: IncomingMessage): string | undefined => {
    const host = header(req, 'host')
    return host === undefined ? undefined : `http://${host}`
  }

  const admit = (req: IncomingMessage): Admission => {
    const origin = header(req, 'origin')
    const referer = header(req, 'referer')
    const source = origin !== undefined ? originOf(origin) : referer !== undefined ? originOf(referer) : undefined
    if (origin === undefined && referer === undefined) return 'unattributed'
    if (source !== undefined && trusted.has(source)) {
      // Seen by the routes as the same-origin request DSH would have sent.
      delete req.headers.origin
      req.headers['sec-fetch-site'] = 'same-origin'
      return 'page'
    }
    // Requests from a page this server rendered (an HTML preview) name it.
    if (source !== undefined && source === selfOrigin(req)) return 'unattributed'
    return 'foreign'
  }

  const corsHeaders = (res: ServerResponse, origin: string): void => {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Expose-Headers', 'ETag, Content-Disposition, Content-Length, Content-Type')
  }

  const routeFor = (pathname: string): SidebarWebRoute | undefined => {
    let best: SidebarWebRoute | undefined
    for (const route of routes) {
      if (!matches(route, route.kind, pathname)) continue
      if (route.kind === 'exact') return route
      if (best === undefined || route.path.length > best.path.length) best = route
    }
    return best
  }

  const server = createServer((req, res) => {
    const origin = header(req, 'origin')
    const admission = admit(req)
    if (admission === 'foreign') {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    if (admission === 'page' && origin !== undefined) {
      corsHeaders(res, origin)
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, HEAD, POST',
          'Access-Control-Allow-Headers': header(req, 'access-control-request-headers') ?? 'content-type',
          'Access-Control-Allow-Private-Network': 'true',
          'Access-Control-Max-Age': '600',
        })
        res.end()
        return
      }
    }
    const route = routeFor(pathnameOf(req))
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    Promise.resolve()
      .then(() => route.handler(req as SidebarHttpRequest, res as unknown as SidebarHttpResponse))
      .catch((error: unknown) => {
        console.error(`[better-sidebar-host] ${req.method} ${req.url} failed:`, error)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end()
      })
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = pathnameOf(req)
    const route = [...upgrades].find(candidate => candidate.path === pathname)
    if (route === undefined || admit(req) === 'foreign') {
      socket.destroy()
      return
    }
    Promise.resolve()
      .then(() => route.handler(req as SidebarHttpRequest, socket as unknown as SidebarUpgradeSocket, head))
      .catch((error: unknown) => {
        console.error(`[better-sidebar-host] upgrade ${pathname} failed:`, error)
        socket.destroy()
      })
  })

  return {
    server,
    service: {
      register(route) {
        routes.add(route)
        return () => { routes.delete(route) }
      },
      registerUpgrade(route) {
        upgrades.add(route)
        return () => { upgrades.delete(route) }
      },
    },
  }
}
