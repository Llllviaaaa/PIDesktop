/**
 * Unified native workbench plugin (`workbench`).
 *
 * Replaces the 121k-line vendored `better-sidebar` HTTP/WS sidecar bridge with a
 * clean ~90-line RPC + tool plugin:
 * - Registers the `sidebar_open` tool when an RPC gateway is mounted (never in
 *   headless CLI mode), allowing the AI to open files at a line range, Git diffs,
 *   URLs, or task summaries in the desktop workbench.
 * - Registers `workbench.open` so external plugins or scripts can focus panels
 *   over the standard RPC bus (`"workbench/open"` notification).
 */
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import {
  ErrorCode,
  type WorkbenchOpenNotification,
  type WorkbenchOpenTarget,
  type WorkbenchPreviewUrlResult,
} from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import { textOutput, type ToolOutput } from "@qianji/tools";
import type { WebServer } from "./web-server.ts";

export const name = "qianji-workbench";
export const inject = ["rpc", "tools", "sessions"];

const VALID_TARGETS = new Set<WorkbenchOpenTarget>([
  "files",
  "editor",
  "review",
  "preview",
  "summary",
  "side-chat",
  "terminal",
]);

const PREVIEW_PREFIX = "/preview";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function isInsideRoot(root: string, target: string): boolean {
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedTarget = process.platform === "win32" ? target.toLowerCase() : target;
  const rel = relative(normalizedRoot, normalizedTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalizeRoot(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function rootLookupKey(canonicalRoot: string): string {
  const cleaned = canonicalRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? cleaned.toLowerCase() : cleaned;
}

function normalizeWorkspacePath(cwd: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "" || trimmed.includes("\0")) throw new Error("path must be non-empty");
  const root = resolve(cwd);
  const full = resolve(root, trimmed);
  const rel = relative(root, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path is outside the workspace: ${rawPath}`);
  }
  return rel.replaceAll("\\", "/");
}

function validateUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use http:// or https://");
  }
  return parsed.toString();
}

function boundPort(webServer: WebServer | undefined): number | null {
  if (webServer === undefined) return null;
  const addr = webServer.server.address();
  return typeof addr === "object" && addr !== null && typeof addr.port === "number" && addr.port > 0
    ? addr.port
    : null;
}

export function apply(ctx: Context): void {
  const capabilityToRoot = new Map<string, string>();
  const rootToCapability = new Map<string, string>();

  const mintPreviewUrl = (cwd: string, normalizedPath: string): string | null => {
    const webServer = ctx.get("webServer");
    const port = boundPort(webServer);
    if (port === null) return null;
    const canonicalRoot = canonicalizeRoot(cwd);
    const rootKey = rootLookupKey(canonicalRoot);
    let cap = rootToCapability.get(rootKey);
    if (cap === undefined) {
      cap = randomBytes(18).toString("base64url");
      rootToCapability.set(rootKey, cap);
      capabilityToRoot.set(cap, canonicalRoot);
    }
    const encodedPath = normalizedPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `http://127.0.0.1:${port}${PREVIEW_PREFIX}/${cap}/${encodedPath}`;
  };

  const servePreviewRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
      return;
    }

    const pathname = new URL(req.url ?? "/", "http://harness.internal").pathname;
    const remainder = pathname.slice(PREVIEW_PREFIX.length).replace(/^\/+/, "");
    const slashIdx = remainder.indexOf("/");
    if (slashIdx <= 0) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    const cap = remainder.slice(0, slashIdx);
    const rawRel = remainder.slice(slashIdx + 1);
    const canonicalRoot = capabilityToRoot.get(cap);
    if (canonicalRoot === undefined || rawRel === "") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    let decodedSegments: string[];
    try {
      decodedSegments = rawRel.split("/").filter((part) => part !== "").map((part) => decodeURIComponent(part));
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("bad request");
      return;
    }

    if (
      decodedSegments.length === 0
      || decodedSegments.some((seg) => seg === "." || seg === ".." || seg.includes("\0") || seg.includes("/") || seg.includes("\\"))
    ) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }

    let targetPath = resolve(canonicalRoot, ...decodedSegments);
    if (!isInsideRoot(canonicalRoot, targetPath)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }

    try {
      let fileStat = await stat(targetPath);
      if (fileStat.isDirectory()) {
        targetPath = resolve(targetPath, "index.html");
        fileStat = await stat(targetPath);
      }
      if (!fileStat.isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }

      const [realRoot, realTarget] = await Promise.all([
        realpath(canonicalRoot).catch(() => canonicalRoot),
        realpath(targetPath),
      ]);
      if (!isInsideRoot(realRoot, realTarget)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("forbidden");
        return;
      }

      const ext = extname(realTarget).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const headers: Record<string, string | number> = {
        "content-type": contentType,
        "content-length": fileStat.size,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      };

      if (req.method === "HEAD") {
        res.writeHead(200, headers);
        res.end();
        return;
      }

      const data = await readFile(realTarget);
      res.writeHead(200, headers);
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  };

  ctx.inject(["webServer"], (innerCtx) => {
    innerCtx.effect(
      () => innerCtx.webServer.register({
        kind: "prefix",
        path: PREVIEW_PREFIX,
        handler: servePreviewRequest,
      }),
      "workbench: /preview loopback static route",
    );
  });
  ctx.effect(() => ctx.tools.register({
    name: "sidebar_open",
    description: "Open a workspace file (optionally at a line), Git diff review, live web preview URL, or task summary inside the user's workbench.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["files", "editor", "review", "preview", "summary", "terminal"],
          description: "Workbench panel to focus. Defaults to 'editor' when path is provided, or 'preview' when url is provided.",
        },
        path: {
          type: "string",
          description: "Workspace-relative file path to open in the editor.",
        },
        line: {
          type: "integer",
          minimum: 1,
          description: "Optional 1-indexed line number to scroll to.",
        },
        endLine: {
          type: "integer",
          minimum: 1,
          description: "Optional 1-indexed ending line number to highlight.",
        },
        url: {
          type: "string",
          description: "HTTP(S) URL to open in the workbench preview tab.",
        },
      },
    },
    async execute(args, env): Promise<ToolOutput> {
      const rawTarget = typeof args.target === "string" ? args.target : undefined;
      const rawPath = typeof args.path === "string" ? args.path : undefined;
      const rawUrl = typeof args.url === "string" ? args.url : undefined;
      const line = typeof args.line === "number" && Number.isInteger(args.line) && args.line >= 1 ? args.line : undefined;
      const endLine = typeof args.endLine === "number" && Number.isInteger(args.endLine) && args.endLine >= 1 ? args.endLine : undefined;

      let target: WorkbenchOpenTarget;
      if (rawTarget !== undefined) {
        if (!VALID_TARGETS.has(rawTarget as WorkbenchOpenTarget)) {
          return textOutput(`Invalid workbench target: ${rawTarget}`, true);
        }
        target = rawTarget as WorkbenchOpenTarget;
      } else if (rawPath !== undefined) {
        target = "editor";
      } else if (rawUrl !== undefined) {
        target = "preview";
      } else {
        return textOutput("sidebar_open requires at least one of target, path, or url", true);
      }

      let normalizedPath: string | undefined;
      if (rawPath !== undefined) {
        try {
          normalizedPath = normalizeWorkspacePath(env.cwd, rawPath);
        } catch (error) {
          return textOutput((error as Error).message, true);
        }
      }

      let normalizedUrl: string | undefined;
      if (rawUrl !== undefined) {
        try {
          normalizedUrl = validateUrl(rawUrl);
        } catch (error) {
          return textOutput((error as Error).message, true);
        }
      } else if (target === "preview" && normalizedPath !== undefined) {
        normalizedUrl = mintPreviewUrl(env.cwd, normalizedPath) ?? undefined;
      }

      const payload: WorkbenchOpenNotification = {
        sessionId: env.sessionId,
        cwd: env.cwd,
        target,
        ...(normalizedPath === undefined ? {} : { path: normalizedPath }),
        ...(line === undefined ? {} : { line }),
        ...(endLine === undefined ? {} : { endLine }),
        ...(normalizedUrl === undefined ? {} : { url: normalizedUrl }),
      };
      ctx.rpc.broadcast("workbench/open", payload);

      if (normalizedPath !== undefined) {
        return textOutput(`Opened ${normalizedPath}${line === undefined ? "" : `:${line}`} in workbench (${target}).`);
      }
      if (normalizedUrl !== undefined) {
        return textOutput(`Opened ${normalizedUrl} in workbench preview.`);
      }
      return textOutput(`Opened workbench panel: ${target}.`);
    },
  }), "workbench: sidebar_open tool");

  ctx.effect(() => ctx.rpc.method("workbench.open", (params): { ok: true } => {
    const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
    const rawTarget = p.target;
    if (typeof rawTarget !== "string" || !VALID_TARGETS.has(rawTarget as WorkbenchOpenTarget)) {
      throw new RpcError(ErrorCode.InvalidParams, "workbench.open requires a valid target");
    }
    const cwd = typeof p.cwd === "string" && p.cwd.trim() !== "" ? p.cwd : undefined;
    let normalizedPath: string | undefined;
    if (typeof p.path === "string" && p.path.trim() !== "") {
      try {
        normalizedPath = cwd !== undefined ? normalizeWorkspacePath(cwd, p.path) : p.path.trim().replaceAll("\\", "/");
      } catch (error) {
        throw new RpcError(ErrorCode.InvalidParams, (error as Error).message);
      }
    }
    let normalizedUrl: string | undefined;
    if (typeof p.url === "string" && p.url.trim() !== "") {
      try {
        normalizedUrl = validateUrl(p.url);
      } catch (error) {
        throw new RpcError(ErrorCode.InvalidParams, (error as Error).message);
      }
    } else if (rawTarget === "preview" && cwd !== undefined && normalizedPath !== undefined) {
      normalizedUrl = mintPreviewUrl(cwd, normalizedPath) ?? undefined;
    }
    const line = typeof p.line === "number" && Number.isInteger(p.line) && p.line >= 1 ? p.line : undefined;
    const endLine = typeof p.endLine === "number" && Number.isInteger(p.endLine) && p.endLine >= 1 ? p.endLine : undefined;
    const payload: WorkbenchOpenNotification = {
      ...(typeof p.sessionId === "string" ? { sessionId: p.sessionId } : {}),
      ...(cwd === undefined ? {} : { cwd }),
      target: rawTarget as WorkbenchOpenTarget,
      ...(normalizedPath === undefined ? {} : { path: normalizedPath }),
      ...(line === undefined ? {} : { line }),
      ...(endLine === undefined ? {} : { endLine }),
      ...(normalizedUrl === undefined ? {} : { url: normalizedUrl }),
    };
    ctx.rpc.broadcast("workbench/open", payload);
    return { ok: true };
  }), "workbench: workbench.open rpc");

  ctx.effect(() => ctx.rpc.method("workbench.previewUrl", (params): WorkbenchPreviewUrlResult => {
    const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
    const cwd = typeof p.cwd === "string" ? p.cwd.trim() : "";
    const rawPath = typeof p.path === "string" ? p.path.trim() : "";
    if (cwd === "" || rawPath === "") {
      throw new RpcError(ErrorCode.InvalidParams, "workbench.previewUrl requires cwd and path");
    }
    let normalizedPath: string;
    try {
      normalizedPath = normalizeWorkspacePath(cwd, rawPath);
    } catch (error) {
      throw new RpcError(ErrorCode.InvalidParams, (error as Error).message);
    }
    return {
      url: mintPreviewUrl(cwd, normalizedPath),
      path: normalizedPath,
    };
  }), "workbench: workbench.previewUrl rpc");
}
