/**
 * Compiles and serves plugin client UI bundles (`/plugins/<id>/client.js`) and
 * static assets (`/plugins/<id>/assets/*`) with ETag revalidation (ADR 0016).
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { extname } from "node:path";
import { resolveInsideDir } from "./plugin-manifest.ts";

/** Modules the desktop renderer exposes through `ctx.modules` / `window.__ModuleLoader__`. */
export const CLIENT_SHARED_EXTERNALS: readonly string[] = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "cordis",
  "@deepseek-ai/cordis",
  "@deepseek-ai/schemastery",
  "schemastery",
  "@qianji/client",
  "@qianji/protocol",
  "@pid/client",
  "@pid/protocol",
  "lucide-react",
];

interface BunBuildOutput {
  text(): Promise<string>;
}

interface BunBuildResult {
  success: boolean;
  outputs: BunBuildOutput[];
  logs: Array<{ message?: string } | string>;
}

interface BunGlobalWithBuild {
  build(options: {
    entrypoints: string[];
    format: "cjs";
    target: "browser";
    define?: Record<string, string>;
    jsx?: {
      runtime?: "automatic" | "classic";
      development?: boolean;
    };
    external: string[];
  }): Promise<BunBuildResult>;
}

interface EsbuildModule {
  build(options: {
    entryPoints: string[];
    bundle: boolean;
    write: false;
    format: "cjs";
    platform: "browser";
    target: string;
    jsx: "automatic";
    external: string[];
    logLevel: "silent";
  }): Promise<{ outputFiles: Array<{ text: string }> }>;
}

function loadNodeEsbuild(): EsbuildModule {
  const req = createRequire(import.meta.url);
  const pkgName = "esbuild";
  return req(pkgName) as EsbuildModule;
}

export interface CompiledClientBundle {
  code: string;
  etag: string;
}

interface CachedBundle extends CompiledClientBundle {
  pluginDir: string;
  entryFile: string;
  mtimeMs: number;
  size: number;
  revision: number;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function shortSha1(input: string | Buffer): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

function wrapInModuleLoader(pluginId: string, cjsBody: string, sourceLabel: string): string {
  return [
    `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
    "var module = { exports: {} }; var exports = module.exports;",
    cjsBody,
    "return module.exports;",
    "} });",
    `//# sourceURL=qianji-plugin://${encodeURIComponent(pluginId)}/${encodeURIComponent(sourceLabel)}`,
  ].join("\n");
}

function looksLikeEsmSource(filePath: string, raw: string): boolean {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".jsx") || lower.endsWith(".mts") || lower.endsWith(".mjs")) {
    return true;
  }
  return /^\s*(?:import\s|export\s)/m.test(raw);
}

async function bundleClientEntryToCjs(entryFile: string): Promise<string> {
  const bun = (globalThis as { Bun?: BunGlobalWithBuild }).Bun;
  if (bun !== undefined) {
    const result = await bun.build({
      entrypoints: [entryFile],
      format: "cjs",
      target: "browser",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      jsx: { runtime: "automatic", development: false },
      external: [...CLIENT_SHARED_EXTERNALS],
    });
    if (!result.success || result.outputs[0] === undefined) {
      const details = result.logs.map((item) => (typeof item === "string" ? item : item.message ?? String(item))).join("; ");
      throw new Error(`Failed to bundle client plugin ${entryFile}${details !== "" ? `: ${details}` : ""}`);
    }
    return result.outputs[0].text();
  }

  const esbuild = loadNodeEsbuild();
  const built = await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    external: [...CLIENT_SHARED_EXTERNALS],
    logLevel: "silent",
  });
  const first = built.outputFiles[0];
  if (first === undefined) {
    throw new Error(`esbuild produced no output for ${entryFile}`);
  }
  return first.text;
}

export class ClientBundleRegistry {
  private readonly cache = new Map<string, CachedBundle>();
  private readonly dirRevisions = new Map<string, number>();

  /** Bump the revision of `pluginDir` so multi-file edits invalidate cached client bundles. */
  invalidateDir(pluginDir: string): void {
    const next = (this.dirRevisions.get(pluginDir) ?? 0) + 1;
    this.dirRevisions.set(pluginDir, next);
    for (const [key, cached] of this.cache) {
      if (cached.pluginDir === pluginDir) this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
    this.dirRevisions.clear();
  }

  async compile(pluginId: string, pluginDir: string, entryFile: string): Promise<CompiledClientBundle> {
    const info = await stat(entryFile);
    const revision = this.dirRevisions.get(pluginDir) ?? 0;
    const cacheKey = `${pluginId}::${entryFile}`;
    const existing = this.cache.get(cacheKey);
    if (
      existing !== undefined
      && existing.mtimeMs === info.mtimeMs
      && existing.size === info.size
      && existing.revision === revision
    ) {
      return { code: existing.code, etag: existing.etag };
    }

    const raw = await readFile(entryFile, "utf8");
    let code: string;
    if ((entryFile.endsWith(".js") || entryFile.endsWith(".cjs")) && raw.includes("__ModuleLoader__.load(")) {
      code = raw;
    } else if (!looksLikeEsmSource(entryFile, raw)) {
      code = wrapInModuleLoader(pluginId, raw, "client.js");
    } else {
      const cjs = await bundleClientEntryToCjs(entryFile);
      code = wrapInModuleLoader(pluginId, cjs, "client.js");
    }

    const etag = `"${shortSha1(code)}"`;
    this.cache.set(cacheKey, {
      pluginDir,
      entryFile,
      mtimeMs: info.mtimeMs,
      size: info.size,
      revision,
      code,
      etag,
    });
    return { code, etag };
  }
}

export interface ClientRouteTarget {
  id: string;
  dir: string;
  clientEntry?: string;
  assetsDir?: string;
}

function browserFenceAllows(req: IncomingMessage): boolean {
  const fetchSite = req.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none") {
    return false;
  }
  return true;
}

export function createPluginsHttpHandler(
  bundles: ClientBundleRegistry,
  resolveTarget: (pluginId: string, workspace?: string) => ClientRouteTarget | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!browserFenceAllows(req)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
      return;
    }

    const parsedUrl = new URL(req.url ?? "/", "http://harness.internal");
    const pathname = parsedUrl.pathname;
    const workspace = parsedUrl.searchParams.get("workspace") ?? undefined;

    const clientMatch = /^\/plugins\/([^/]+)\/client\.js$/.exec(pathname);
    if (clientMatch !== null && clientMatch[1] !== undefined) {
      let pluginId: string;
      try {
        pluginId = decodeURIComponent(clientMatch[1]);
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("bad plugin id");
        return;
      }
      const target = resolveTarget(pluginId, workspace);
      if (target === undefined || target.clientEntry === undefined) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      const compiled = await bundles.compile(target.id, target.dir, target.clientEntry);
      if (req.headers["if-none-match"] === compiled.etag) {
        res.writeHead(304, { "cache-control": "no-cache", etag: compiled.etag });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
        etag: compiled.etag,
      });
      res.end(req.method === "HEAD" ? undefined : compiled.code);
      return;
    }

    const assetMatch = /^\/plugins\/([^/]+)\/assets\/(.+)$/.exec(pathname);
    if (assetMatch !== null && assetMatch[1] !== undefined && assetMatch[2] !== undefined) {
      let pluginId: string;
      let relAsset: string;
      try {
        pluginId = decodeURIComponent(assetMatch[1]);
        relAsset = decodeURIComponent(assetMatch[2]);
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("bad path");
        return;
      }
      const target = resolveTarget(pluginId, workspace);
      if (target === undefined || target.assetsDir === undefined) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      const resolvedFile = resolveInsideDir(target.assetsDir, relAsset);
      if (resolvedFile === undefined) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      const fileInfo = await stat(resolvedFile);
      if (!fileInfo.isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      const body = await readFile(resolvedFile);
      const etag = `"${shortSha1(body)}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { "cache-control": "no-cache", etag });
        res.end();
        return;
      }
      const mime = MIME_BY_EXT[extname(resolvedFile).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, {
        "content-type": mime,
        "cache-control": "no-cache",
        etag,
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  };
}
