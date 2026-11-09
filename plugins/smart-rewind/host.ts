/**
 * Host entry for `smart-rewind` (`智能检查点回退`).
 *
 * Registers:
 * - `/rewind` slash command so Composer autocomplete surfaces `/rewind` with
 *   a plugin badge and headless invocations inspect session turns cleanly.
 * - `smartRewind.undoBranch` RPC endpoint that restores a rewound conversation
 *   branch in-place using pure append-only session events (preserving Git
 *   checkpoint `userSeq` bindings without creating duplicate fork sessions).
 */
import type { Context } from "@deepseek-ai/cordis";
import "@pid/agent";
import "@pid/commands";
import { ErrorCode } from "@pid/protocol";
import { RpcError } from "@pid/rpc";
import { currentBranch, type SessionEvent } from "@pid/session";

export const name = "smart-rewind";
export const inject = ["commands", "sessions", "agents", "rpc"];

const CHECKPOINT_NS = "pid-checkpoints";

function extractUserText(event: Extract<SessionEvent, { type: "user" }>): string {
  return event.data.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function apply(ctx: Context): void {
  ctx.effect(
    () =>
      ctx.commands.register({
        name: "rewind",
        description: "打开检查点回退时光机，选择回退对话/代码并自动回填原消息（快捷键：双击 Esc）",
        source: "plugin",
        async execute(_rawArgs, env) {
          if (!env.sessionId) {
            return { output: "当前对话尚未开始，发送消息后即可使用 `/rewind` 或双击 `Esc` 回退任意轮次。" };
          }
          const session = await ctx.sessions.get(env.sessionId);
          if (!session) {
            return { output: "未找到当前会话记录。", isError: true };
          }
          const userTurns = currentBranch(session.events).filter(
            (event): event is Extract<SessionEvent, { type: "user" }> => event.type === "user",
          );
          if (userTurns.length === 0) {
            return { output: "当前分支暂无可回退的用户消息。" };
          }
          const summary = userTurns
            .map((turn, idx) => `- **第 ${idx + 1} 轮** (\`seq ${turn.seq}\`)：${extractUserText(turn).slice(0, 80) || "[图片消息]"}`)
            .join("\n");
          return {
            output: `当前会话共有 **${userTurns.length}** 个可回退检查点：\n\n${summary}\n\n提示：在桌面端可直接点击消息下方的回退图标或连按两次 \`Esc\` 打开时光机。`,
          };
        },
      }),
    "smart-rewind: /rewind command",
  );

  ctx.effect(
    () =>
      ctx.rpc.method("smartRewind.undoBranch", async (rawParams) => {
        const p = (typeof rawParams === "object" && rawParams !== null ? rawParams : {}) as Record<string, unknown>;
        if (typeof p.sessionId !== "string" || p.sessionId.trim() === "") {
          throw new RpcError(ErrorCode.InvalidParams, "sessionId must be a non-empty string");
        }
        if (!Number.isInteger(p.rewindSeq)) {
          throw new RpcError(ErrorCode.InvalidParams, "rewindSeq must be an integer seq");
        }
        const target = await ctx.sessions.get(p.sessionId);
        if (!target) {
          throw new RpcError(ErrorCode.SessionNotFound, `No session ${p.sessionId}`);
        }
        if (ctx.agents.status(target.id).running) {
          throw new RpcError(ErrorCode.SessionBusy, `Session ${target.id} is running`);
        }

        const rewindSeq = p.rewindSeq as number;
        const rewindIndex = target.events.findIndex(
          (event) => event.seq === rewindSeq && event.type === "rewind",
        );
        if (rewindIndex < 0) {
          throw new RpcError(ErrorCode.InvalidParams, `Rewind event #${rewindSeq} not found`);
        }
        const rewindEvent = target.events[rewindIndex];
        if (!rewindEvent || rewindEvent.type !== "rewind") {
          throw new RpcError(ErrorCode.InvalidParams, `Event #${rewindSeq} is not a rewind event`);
        }

        const toSeq = rewindEvent.data.toSeq;
        const branchBefore = currentBranch(target.events.slice(0, rewindIndex));
        const droppedTail = branchBefore.filter((event) => event.seq > toSeq);
        if (droppedTail.length === 0) {
          return { ok: true, restoredEvents: 0, leafSeq: target.lastSeq };
        }

        const nowBranch = currentBranch(target.events);
        const nowLeafSeq = nowBranch.at(-1)?.seq ?? 0;
        if (nowLeafSeq !== toSeq) {
          target.append("rewind", { toSeq, reason: "prepare undo rewind" });
        }

        const seqMap = new Map<number, number>();
        for (const oldEvent of droppedTail) {
          if (oldEvent.type === "rewind") continue;
          if (oldEvent.type === "custom" && oldEvent.data.ns === CHECKPOINT_NS) {
            const payload = oldEvent.data.data as { userSeq?: unknown; checkpoint?: unknown } | undefined;
            const mappedUserSeq = typeof payload?.userSeq === "number" ? seqMap.get(payload.userSeq) : undefined;
            const appended = target.append("custom", {
              ns: CHECKPOINT_NS,
              data: mappedUserSeq !== undefined
                ? { ...(payload as Record<string, unknown>), userSeq: mappedUserSeq }
                : oldEvent.data.data,
            });
            seqMap.set(oldEvent.seq, appended.seq);
            continue;
          }
          const appended = (target.append as (type: SessionEvent["type"], data: unknown) => SessionEvent)(
            oldEvent.type,
            oldEvent.data,
          );
          seqMap.set(oldEvent.seq, appended.seq);
        }

        await target.flush();
        return {
          ok: true,
          restoredEvents: droppedTail.length,
          leafSeq: target.lastSeq,
        };
      }),
    "smart-rewind: smartRewind.undoBranch",
  );
}
