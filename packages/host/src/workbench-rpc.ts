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
import { isAbsolute, relative, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { ErrorCode, type WorkbenchOpenNotification, type WorkbenchOpenTarget } from "@pid/protocol";
import { RpcError } from "@pid/rpc";
import { textOutput, type ToolOutput } from "@pid/tools";

export const name = "pid-workbench";
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

function normalizeWorkspacePath(cwd: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "") throw new Error("path must be non-empty");
  const root = resolve(cwd);
  const full = resolve(root, trimmed);
  const rel = relative(root, full);
  if (rel.startsWith("..") || isAbsolute(rel)) {
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

export function apply(ctx: Context): void {
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
}
