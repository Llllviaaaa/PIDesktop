/**
 * The host's loopback HTTP server and its route table (`webServer`), carried
 * over from the better-sidebar sidecar (ADR 0001).
 *
 * Pi Desktop's page is served from Tauri's origin (or the Vite dev server), so
 * every browser request reaching this server is cross-origin. A request whose
 * Origin, or failing that Referer, is one of the configured page origins is
 * presented to the routes as a same-origin request and answered with CORS
 * headers; any other browser origin is refused. Requests with neither header
 * (no browser involved) reach the routes as they came, and each route applies
 * its own check: better-sidebar its trust fence, the RPC gateway its token.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { Context, Service } from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context {
    webServer: WebServer;
  }
}

export interface WebRoute {
  kind: "exact" | "prefix";
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

export interface WebUpgradeRoute {
  path: string;
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}

export interface WebServerConfig {
  /** The origins Pi Desktop's own page is served from. */
  pageOrigins: readonly string[];
}

/** How a request relates to the page: from it, from no browser, or from some other site. */
export type Admission = "page" | "unattributed" | "foreign";

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function originOf(value: string): string | undefined {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://harness.internal").pathname;
}

function matches(route: WebRoute, pathname: string): boolean {
  return route.kind === "exact"
    ? pathname === route.path
    : pathname === route.path || pathname.startsWith(`${route.path}/`);
}

export class WebServer extends Service {
  readonly server: Server;
  private readonly routes = new Set<WebRoute>();
  private readonly upgrades = new Set<WebUpgradeRoute>();
  private readonly trusted: Set<string>;

  constructor(ctx: Context, config: WebServerConfig) {
    super(ctx, "webServer");
    this.trusted = new Set(config.pageOrigins);
    this.server = createServer((req, res) => this.handle(req, res));
    this.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head));
    ctx.effect(() => () => {
      this.server.closeAllConnections();
      this.server.close();
    }, "webServer: close the loopback server");
  }

  /** Listen on loopback and resolve the bound port (`port` 0 picks a free one). */
  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        resolve(typeof address === "object" && address !== null ? address.port : port);
      });
    });
  }

  register(route: WebRoute): () => void {
    this.routes.add(route);
    return () => {
      this.routes.delete(route);
    };
  }

  registerUpgrade(route: WebUpgradeRoute): () => void {
    this.upgrades.add(route);
    return () => {
      this.upgrades.delete(route);
    };
  }

  /**
   * Classify a request. A page request is rewritten to look same-origin, the
   * way DSH's own page would have sent it to the routes.
   */
  admit(req: IncomingMessage): Admission {
    const origin = header(req, "origin");
    const referer = header(req, "referer");
    if (origin === undefined && referer === undefined) return "unattributed";
    const source = origin !== undefined ? originOf(origin) : referer !== undefined ? originOf(referer) : undefined;
    if (source !== undefined && this.trusted.has(source)) {
      delete req.headers.origin;
      req.headers["sec-fetch-site"] = "same-origin";
      return "page";
    }
    // Requests from a page this server rendered (an HTML preview) name it.
    const host = header(req, "host");
    if (source !== undefined && host !== undefined && source === `http://${host}`) return "unattributed";
    return "foreign";
  }

  private routeFor(pathname: string): WebRoute | undefined {
    let best: WebRoute | undefined;
    for (const route of this.routes) {
      if (!matches(route, pathname)) continue;
      if (route.kind === "exact") return route;
      if (best === undefined || route.path.length > best.path.length) best = route;
    }
    return best;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const origin = header(req, "origin");
    const admission = this.admit(req);
    if (admission === "foreign") {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    if (admission === "page" && origin !== undefined) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "ETag, Content-Disposition, Content-Length, Content-Type");
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, HEAD, POST",
          "Access-Control-Allow-Headers": header(req, "access-control-request-headers") ?? "content-type",
          "Access-Control-Allow-Private-Network": "true",
          "Access-Control-Max-Age": "600",
        });
        res.end();
        return;
      }
    }
    const route = this.routeFor(pathnameOf(req));
    if (route === undefined) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    Promise.resolve()
      .then(() => route.handler(req, res))
      .catch((error: unknown) => {
        this.ctx.logger("webServer").error("%s %s failed: %s", req.method, req.url, error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end();
      });
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = pathnameOf(req);
    const route = [...this.upgrades].find((candidate) => candidate.path === pathname);
    if (route === undefined || this.admit(req) === "foreign") {
      socket.destroy();
      return;
    }
    Promise.resolve()
      .then(() => route.handler(req, socket, head))
      .catch((error: unknown) => {
        this.ctx.logger("webServer").error("upgrade %s failed: %s", pathname, error);
        socket.destroy();
      });
  }
}
