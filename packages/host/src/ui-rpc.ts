/**
 * The UI bridge (ADR 0002, 0009): `ui` requests go to every connected client
 * as `ui/request` notifications, the first `ui.respond` wins, and `ui/cancel`
 * withdraws a request that no longer needs an answer. A client that
 * reconnects asks `ui.pending` for what is still open.
 *
 * Because a desktop client is there, this plugin also tells the model about
 * the rich-content block the desktop renders.
 */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import {
  ErrorCode,
  type UiPendingResult,
  type UiRequestNotification,
  type UiSandboxUrlParams,
  type UiSandboxUrlResult,
} from "@qianji/protocol";
import { SectionOrder } from "@qianji/system-prompt";
import "@qianji/ui";
import { RpcError } from "./rpc.ts";
import type { WebServer } from "./web-server.ts";

export const name = "qianji-ui-rpc";
export const inject = ["rpc", "ui", "systemPrompt"];

const UI_SANDBOX_PREFIX = "/ui-sandbox";
const MAX_SANDBOX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_SANDBOX_ENTRIES = 128;
const UI_SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none';";

function boundPort(webServer: WebServer | undefined): number | null {
  if (webServer === undefined) return null;
  const addr = webServer.server.address();
  return typeof addr === "object" && addr !== null && typeof addr.port === "number" && addr.port > 0
    ? addr.port
    : null;
}

export const RICH_CONTENT_INSTRUCTIONS = `Qianji can render one optional structured visual in a completed assistant reply. Use it only when metrics, comparisons, steps, progress, grouped status, or curated links are materially easier to scan than ordinary prose. Otherwise use normal Markdown. Emit at most one fenced block with the exact language qianji-rich and valid JSON in this schema:
{"version":1,"title"?:string,"summary"?:string,"blocks":[...]}
Allowed blocks are:
- {"type":"metrics","title"?:string,"items":[{"label":string,"value":string,"detail"?:string,"tone"?:Tone}]}
- {"type":"callout","title"?:string,"body":string,"tone"?:Tone}
- {"type":"steps","title"?:string,"items":[{"title":string,"description"?:string,"status"?:"done"|"active"|"pending"}]}
- {"type":"comparison","title"?:string,"columns":[string,...],"rows":[[string,...],...]}
- {"type":"progress","title"?:string,"items":[{"label":string,"value":number,"detail"?:string,"tone"?:Tone}]}, where value is 0..100
- {"type":"bars","title"?:string,"items":[{"label":string,"value":number,"max":number,"unit"?:string,"tone"?:Tone}]}, where 0 <= value <= max
- {"type":"links","title"?:string,"items":[{"label":string,"url":string,"description"?:string}]}, with absolute http/https URLs only
Limits: 1..12 blocks, 1..12 items in each grouped block, 60 items total, and comparison tables with 2..8 columns and at most 30 rows. Keep titles within 80 characters and descriptions or body text within 1000 characters.
Tone is "neutral"|"info"|"success"|"warning"|"danger". Do not add unknown fields, HTML, SVG, scripts, styles, class names, images, local paths, actions, forms, or nested components. Keep prose outside the fence for context and accessibility.`;

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.ui.attach({
    request: ({ requestId, sessionId, request }) => {
      const notification: UiRequestNotification = { requestId, ...(sessionId === undefined ? {} : { sessionId }), ...request };
      ctx.rpc.broadcast("ui/request", notification);
    },
    cancel: (requestId) => ctx.rpc.broadcast("ui/cancel", { requestId }),
    notify: (sessionId, message, level) => {
      const notification: UiRequestNotification = { ...(sessionId === undefined ? {} : { sessionId }), kind: "notify", message, level };
      ctx.rpc.broadcast("ui/request", notification);
    },
  }), "ui-rpc: transport");

  ctx.effect(() => ctx.rpc.method("ui.respond", (params) => {
    const { requestId, value } = (params ?? {}) as { requestId?: unknown; value?: unknown };
    if (typeof requestId !== "string") throw new RpcError(ErrorCode.InvalidParams, "ui.respond needs { requestId, value }");
    if (!ctx.ui.respond(requestId, value)) throw new RpcError(ErrorCode.InvalidParams, `No pending UI request ${requestId}`);
    // Other clients showing the same question can close it.
    ctx.rpc.broadcast("ui/cancel", { requestId });
    return {};
  }), "ui-rpc: ui.respond");

  ctx.effect(() => ctx.rpc.method("ui.pending", (): UiPendingResult => ({
    requests: ctx.ui.pending().map(({ requestId, sessionId, request }) => ({ requestId, ...(sessionId === undefined ? {} : { sessionId }), ...request })),
  })), "ui-rpc: ui.pending");

  // Ephemeral capability-addressed sandbox HTML store so `<iframe sandbox="allow-scripts">`
  // loads over loopback `http://127.0.0.1:<port>/ui-sandbox/<cap>` with its own isolated CSP
  // rather than inheriting Tauri's parent-document `script-src 'self'` policy on `data:` URLs.
  const capToPayload = new Map<string, { htmlBytes: Buffer; digest: string }>();
  const digestToCap = new Map<string, string>();

  const serveSandboxHtml = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://harness.internal").pathname;
    const cap = pathname.slice(UI_SANDBOX_PREFIX.length).replace(/^\/+/, "");
    const entry = cap && !cap.includes("/") ? capToPayload.get(cap) : undefined;
    if (entry === undefined) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    // Refresh LRU order
    capToPayload.delete(cap);
    capToPayload.set(cap, entry);

    const headers: Record<string, string | number> = {
      "content-type": "text/html; charset=utf-8",
      "content-length": entry.htmlBytes.byteLength,
      "content-security-policy": UI_SANDBOX_CSP,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(entry.htmlBytes);
    }
  };

  ctx.inject(["webServer"], (innerCtx) => {
    innerCtx.effect(
      () => innerCtx.webServer.register({
        kind: "prefix",
        path: UI_SANDBOX_PREFIX,
        handler: serveSandboxHtml,
      }),
      "ui-rpc: /ui-sandbox loopback route",
    );
  });

  ctx.effect(() => ctx.rpc.method("ui.sandboxUrl", (params): UiSandboxUrlResult => {
    const rawHtml = (params as Partial<UiSandboxUrlParams> | undefined)?.html;
    if (typeof rawHtml !== "string" || rawHtml.length === 0) {
      throw new RpcError(ErrorCode.InvalidParams, "ui.sandboxUrl requires non-empty html");
    }
    const htmlBytes = Buffer.from(rawHtml, "utf8");
    if (htmlBytes.byteLength > MAX_SANDBOX_HTML_BYTES) {
      throw new RpcError(ErrorCode.InvalidParams, "ui.sandboxUrl html exceeds 2 MiB limit");
    }
    const port = boundPort(ctx.get("webServer"));
    if (port === null) {
      return { url: null };
    }
    const digest = createHash("sha256").update(htmlBytes).digest("base64url");
    let cap = digestToCap.get(digest);
    const existing = cap !== undefined ? capToPayload.get(cap) : undefined;
    if (cap !== undefined && existing !== undefined) {
      capToPayload.delete(cap);
      capToPayload.set(cap, existing);
    } else {
      cap = randomBytes(18).toString("base64url");
      if (capToPayload.size >= MAX_SANDBOX_ENTRIES) {
        const oldestKey = capToPayload.keys().next().value;
        if (oldestKey !== undefined) {
          const evicted = capToPayload.get(oldestKey);
          capToPayload.delete(oldestKey);
          if (evicted) digestToCap.delete(evicted.digest);
        }
      }
      capToPayload.set(cap, { htmlBytes, digest });
      digestToCap.set(digest, cap);
    }
    return { url: `http://127.0.0.1:${port}${UI_SANDBOX_PREFIX}/${cap}` };
  }), "ui-rpc: ui.sandboxUrl");

  ctx.effect(
    () => ctx.systemPrompt.section(
      "rich-content",
      ({ tools }) => (tools.some((tool) => tool.name === "render_ui") ? undefined : RICH_CONTENT_INSTRUCTIONS),
      { order: SectionOrder.environment - 10 },
    ),
    "ui-rpc: rich content section",
  );
}
