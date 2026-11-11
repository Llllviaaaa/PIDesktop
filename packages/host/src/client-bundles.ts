/**
 * Compiles and serves plugin client UI bundles (`/plugins/<id>/client.js`) and
 * static assets (`/plugins/<id>/assets/*`) with ETag revalidation (ADR 0016).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { CLIENT_SHARED_EXTERNALS } from "@qianji/protocol";
import { canonicalPath, pathComparisonKey, resolveInsideDir } from "./plugin-manifest.ts";

export { CLIENT_SHARED_EXTERNALS };

interface BundlerOnResolveArgs {
  path: string;
  importer: string;
  resolveDir: string;
}

interface BundlerOnResolveResult {
  path?: string;
  external?: boolean;
  errors?: Array<{ text: string }>;
}

interface BundlerOnLoadArgs {
  path: string;
}

interface BundlerOnLoadResult {
  contents: string;
  loader: "js";
}

interface BundlerPluginBuild {
  onResolve(
    options: { filter: RegExp },
    callback: (args: BundlerOnResolveArgs) => Promise<BundlerOnResolveResult | undefined> | BundlerOnResolveResult | undefined,
  ): void;
  onLoad(
    options: { filter: RegExp },
    callback: (args: BundlerOnLoadArgs) => Promise<BundlerOnLoadResult> | BundlerOnLoadResult,
  ): void;
}

interface BundlerPlugin {
  name: string;
  setup(build: BundlerPluginBuild): void;
}

interface BunBuildOutput {
  text(): Promise<string>;
}

interface BunBuildResult {
  success: boolean;
  outputs: BunBuildOutput[];
  logs: Array<{ message?: string } | string>;
  metafile?: {
    inputs?: Record<string, unknown>;
  };
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
    plugins?: BundlerPlugin[];
    metafile?: boolean;
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
    plugins?: BundlerPlugin[];
    metafile: true;
    logLevel: "silent";
  }): Promise<{
    outputFiles: Array<{ text: string }>;
    metafile?: { inputs?: Record<string, unknown> };
  }>;
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

interface FileStamp {
  path: string;
  mtimeMs: number;
  size: number;
}

interface CachedBundle extends CompiledClientBundle {
  pluginDir: string;
  entryFile: string;
  trackedFiles: FileStamp[];
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

const TRACKABLE_SOURCE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".cjs",
  ".cts",
  ".json",
  ".css",
]);

const RESOLVE_PROBE_SUFFIXES = [
  "",
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".mts",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  "/index.tsx",
  "/index.ts",
  "/index.jsx",
  "/index.js",
] as const;

function isPathInsidePluginRoot(pluginRootCanonical: string, pluginRootKey: string, candidatePath: string): boolean {
  const canonicalTarget = canonicalPath(candidatePath);
  const lexicalRel = relative(pluginRootCanonical, canonicalTarget);
  if (lexicalRel.startsWith("..") || isAbsolute(lexicalRel)) {
    return false;
  }
  const realKey = pathComparisonKey(canonicalTarget);
  return realKey === pluginRootKey || realKey.startsWith(`${pluginRootKey}/`);
}

function assertImportInsidePluginRoot(
  pluginDir: string,
  pluginRootCanonical: string,
  pluginRootKey: string,
  specifier: string,
  baseDir: string,
): void {
  const baseCanonical = canonicalPath(baseDir);
  const rawCandidate = isAbsolute(specifier)
    ? canonicalPath(specifier)
    : resolve(baseCanonical, specifier);
  const lexicalRel = relative(pluginRootCanonical, rawCandidate);
  if (lexicalRel.startsWith("..") || isAbsolute(lexicalRel)) {
    throw new Error(`Client import "${specifier}" escapes plugin directory "${pluginDir}"`);
  }
  const rawKey = pathComparisonKey(rawCandidate);
  if (rawKey !== pluginRootKey && !rawKey.startsWith(`${pluginRootKey}/`)) {
    throw new Error(`Client import "${specifier}" escapes plugin directory "${pluginDir}"`);
  }
  for (const suffix of RESOLVE_PROBE_SUFFIXES) {
    const probed = `${rawCandidate}${suffix}`;
    if (existsSync(probed) && !isPathInsidePluginRoot(pluginRootCanonical, pluginRootKey, probed)) {
      throw new Error(`Client import "${specifier}" resolves outside plugin directory "${pluginDir}"`);
    }
  }
}

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

function sanitizeCssForFallbackScope(css: string): string {
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < css.length) {
    const ch = css[i];
    const next = css[i + 1];
    if (ch === "/" && next === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) {
        out += `${css.slice(i)}*/`;
        break;
      }
      out += css.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += quote;
      i += 1;
      let closed = false;
      while (i < css.length) {
        const c = css[i];
        out += c;
        i += 1;
        if (c === "\\" && i < css.length) {
          out += css[i];
          i += 1;
          continue;
        }
        if (c === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) out += quote;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      out += "{";
      i += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) {
        depth -= 1;
        out += "}";
      }
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  if (depth > 0) out += "}".repeat(depth);
  return out;
}

function buildCssModuleSnippet(pluginId: string, styleKey: string, cssText: string): string {
  const pidJson = JSON.stringify(pluginId);
  const keyJson = JSON.stringify(styleKey);
  const cssJson = JSON.stringify(cssText);
  const safeFallbackJson = JSON.stringify(sanitizeCssForFallbackScope(cssText));
  return [
    `const __css = ${cssJson};`,
    `if (typeof globalThis !== "undefined" && typeof globalThis.__qianjiInjectPluginStyle === "function") {`,
    `  globalThis.__qianjiInjectPluginStyle(${pidJson}, __css, ${keyJson});`,
    `} else if (typeof document !== "undefined" && document.head) {`,
    `  const __attr = ${JSON.stringify(`${pluginId}:${styleKey}`)};`,
    `  let __el = document.head.querySelector('style[data-qj-plugin-style="' + __attr.replace(/"/g, '\\\\"') + '"]');`,
    `  if (!__el) {`,
    `    __el = document.createElement("style");`,
    `    __el.setAttribute("data-qj-plugin-style", __attr);`,
    `    __el.setAttribute("data-qj-plugin-owner", ${pidJson});`,
    `    document.head.appendChild(__el);`,
    `  }`,
    `  const __escapedId = ${pidJson}.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"');`,
    `  __el.textContent = '@layer plugin-ui { @scope ([data-qj-plugin="' + __escapedId + '"]) {\\n' + ${safeFallbackJson} + '\\n} }';`,
    `}`,
    `export default __css;`,
  ].join("\n");
}

async function scanPluginSourceFiles(dir: string, acc: Set<string>, depth = 0): Promise<void> {
  if (depth > 6) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanPluginSourceFiles(full, acc, depth + 1);
    } else if (entry.isFile() && TRACKABLE_SOURCE_EXT.has(extname(entry.name).toLowerCase())) {
      acc.add(resolve(full));
    }
  }
}

async function collectFileStamps(paths: Iterable<string>): Promise<FileStamp[]> {
  const unique = [...new Set([...paths].map((p) => resolve(p)))].sort();
  const stamps: FileStamp[] = [];
  for (const filePath of unique) {
    try {
      const info = await stat(filePath);
      stamps.push({ path: filePath, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      // File disappeared or virtual path: record sentinel so cache invalidates if needed.
      stamps.push({ path: filePath, mtimeMs: -1, size: -1 });
    }
  }
  return stamps;
}

async function stampsMatch(recorded: readonly FileStamp[]): Promise<boolean> {
  if (recorded.length === 0) return false;
  for (const item of recorded) {
    try {
      const info = await stat(item.path);
      if (info.mtimeMs !== item.mtimeMs || info.size !== item.size) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function isRealFilesystemInputPath(inputKey: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(inputKey)) return true;
  return !inputKey.includes(":");
}

async function bundleClientEntryToCjs(
  pluginId: string,
  pluginDir: string,
  entryFile: string,
): Promise<{ cjs: string; inputs: Set<string> }> {
  const pluginRootCanonical = canonicalPath(pluginDir);
  const pluginRootKey = pathComparisonKey(pluginRootCanonical);
  if (!isPathInsidePluginRoot(pluginRootCanonical, pluginRootKey, entryFile)) {
    throw new Error(`Client entry "${entryFile}" escapes plugin directory "${pluginDir}"`);
  }
  const entryCanonical = canonicalPath(entryFile);

  const externalSet = new Set<string>(CLIENT_SHARED_EXTERNALS);
  const inputs = new Set<string>([entryCanonical]);
  const boundaryAndCssPlugin: BundlerPlugin = {
    name: "qianji-client-boundary-and-css",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (externalSet.has(args.path)) {
          return { path: args.path, external: true };
        }
        if (args.path.startsWith(".") || isAbsolute(args.path)) {
          const baseDir = args.resolveDir || (args.importer ? dirname(args.importer) : pluginRootCanonical);
          assertImportInsidePluginRoot(pluginDir, pluginRootCanonical, pluginRootKey, args.path, baseDir);
        }
        return undefined;
      });
      build.onLoad({ filter: /\.css$/i }, async (args) => {
        const absPath = canonicalPath(args.path);
        if (!isPathInsidePluginRoot(pluginRootCanonical, pluginRootKey, absPath)) {
          throw new Error(`Client CSS import "${args.path}" escapes plugin directory "${pluginDir}"`);
        }
        inputs.add(absPath);
        const cssText = await readFile(absPath, "utf8");
        const relKey = relative(pluginRootCanonical, absPath).replace(/\\/g, "/") || absPath;
        return {
          contents: buildCssModuleSnippet(pluginId, relKey, cssText),
          loader: "js",
        };
      });
    },
  };

  const verifyRecordedInputs = (metaInputs: Record<string, unknown> | undefined) => {
    if (metaInputs === undefined) return;
    for (const inputKey of Object.keys(metaInputs)) {
      if (!isRealFilesystemInputPath(inputKey)) continue;
      const resolvedInput = canonicalPath(inputKey);
      if (!isPathInsidePluginRoot(pluginRootCanonical, pluginRootKey, resolvedInput)) {
        throw new Error(`Client bundle input "${inputKey}" escapes plugin directory "${pluginDir}"`);
      }
      inputs.add(resolvedInput);
    }
  };

  const bun = (globalThis as { Bun?: BunGlobalWithBuild }).Bun;
  if (bun !== undefined) {
    const result = await bun.build({
      entrypoints: [entryCanonical],
      format: "cjs",
      target: "browser",
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      jsx: { runtime: "automatic", development: false },
      external: [...CLIENT_SHARED_EXTERNALS],
      plugins: [boundaryAndCssPlugin],
      metafile: true,
    });
    if (!result.success || result.outputs[0] === undefined) {
      const details = result.logs.map((item) => (typeof item === "string" ? item : item.message ?? String(item))).join("; ");
      throw new Error(`Failed to bundle client plugin ${entryFile}${details !== "" ? `: ${details}` : ""}`);
    }
    if (result.metafile?.inputs) {
      verifyRecordedInputs(result.metafile.inputs);
    } else {
      await scanPluginSourceFiles(pluginRootCanonical, inputs);
    }
    return { cjs: await result.outputs[0].text(), inputs };
  }

  const esbuild = loadNodeEsbuild();
  let built;
  try {
    built = await esbuild.build({
      entryPoints: [entryCanonical],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      external: [...CLIENT_SHARED_EXTERNALS],
      plugins: [boundaryAndCssPlugin],
      metafile: true,
      logLevel: "silent",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to bundle client plugin ${entryFile}: ${msg}`, { cause: error });
  }
  const first = built.outputFiles[0];
  if (first === undefined) {
    throw new Error(`esbuild produced no output for ${entryFile}`);
  }
  verifyRecordedInputs(built.metafile?.inputs);
  return { cjs: first.text, inputs };
}

export class ClientBundleRegistry {
  private readonly cache = new Map<string, CachedBundle>();
  private readonly dirRevisions = new Map<string, number>();

  /** Bump the revision of `pluginDir` so multi-file edits invalidate cached client bundles. */
  invalidateDir(pluginDir: string): void {
    const dirKey = pathComparisonKey(pluginDir);
    const next = (this.dirRevisions.get(dirKey) ?? 0) + 1;
    this.dirRevisions.set(dirKey, next);
    for (const [key, cached] of this.cache) {
      if (pathComparisonKey(cached.pluginDir) === dirKey) this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
    this.dirRevisions.clear();
  }

  async compile(pluginId: string, pluginDir: string, entryFile: string): Promise<CompiledClientBundle> {
    await stat(entryFile);
    const dirKey = pathComparisonKey(pluginDir);
    const revision = this.dirRevisions.get(dirKey) ?? 0;
    const cacheKey = `${pluginId}::${pathComparisonKey(entryFile)}`;
    const existing = this.cache.get(cacheKey);
    if (existing !== undefined && existing.revision === revision && (await stampsMatch(existing.trackedFiles))) {
      return { code: existing.code, etag: existing.etag };
    }

    const raw = await readFile(entryFile, "utf8");
    let code: string;
    let trackedPaths: Set<string>;
    if ((entryFile.endsWith(".js") || entryFile.endsWith(".cjs")) && raw.includes("__ModuleLoader__.load(")) {
      code = raw;
      trackedPaths = new Set([canonicalPath(entryFile)]);
    } else if (!looksLikeEsmSource(entryFile, raw)) {
      code = wrapInModuleLoader(pluginId, raw, "client.js");
      trackedPaths = new Set([canonicalPath(entryFile)]);
    } else {
      const bundled = await bundleClientEntryToCjs(pluginId, pluginDir, entryFile);
      code = wrapInModuleLoader(pluginId, bundled.cjs, "client.js");
      trackedPaths = bundled.inputs;
    }

    const etag = `"${shortSha1(code)}"`;
    const trackedFiles = await collectFileStamps(trackedPaths);
    this.cache.set(cacheKey, {
      pluginDir: canonicalPath(pluginDir),
      entryFile: canonicalPath(entryFile),
      trackedFiles,
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
