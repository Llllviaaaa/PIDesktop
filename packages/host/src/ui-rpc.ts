/**
 * The UI bridge (ADR 0002, 0009): `ui` requests go to every connected client
 * as `ui/request` notifications, the first `ui.respond` wins, and `ui/cancel`
 * withdraws a request that no longer needs an answer. A client that
 * reconnects asks `ui.pending` for what is still open.
 *
 * Because a desktop client is there, this plugin also tells the model about
 * the rich-content block the desktop renders.
 */
import type { Context } from "@deepseek-ai/cordis";
import { ErrorCode, type UiPendingResult, type UiRequestNotification } from "@pid/protocol";
import { SectionOrder } from "@pid/system-prompt";
import "@pid/ui";
import { RpcError } from "./rpc.ts";

export const name = "pid-ui-rpc";
export const inject = ["rpc", "ui", "systemPrompt"];

export const RICH_CONTENT_INSTRUCTIONS = `PIDesktop can render one optional structured visual in a completed assistant reply. Use it only when metrics, comparisons, steps, progress, grouped status, or curated links are materially easier to scan than ordinary prose. Otherwise use normal Markdown. Emit at most one fenced block with the exact language pidesktop-rich and valid JSON in this schema:
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

  ctx.effect(() => ctx.systemPrompt.section("rich-content", () => RICH_CONTENT_INSTRUCTIONS, { order: SectionOrder.environment - 10 }), "ui-rpc: rich content section");
}
