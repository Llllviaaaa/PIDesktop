/**
 * Workspace checkpoints (ADR 0009): before each run that may change files,
 * snapshot the git workspace (without touching the real index) and record it
 * in the session as a `custom` event of namespace `pid-checkpoints`, tied to
 * the user message that started the run. `checkpoint.diff` and
 * `checkpoint.restore` then put the files back to how they were before that
 * message; the client pairs a restore with `session.rewind`.
 *
 * Runs whose effective permission is read-only take no checkpoint.
 */
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/agent";
import { ErrorCode, type CheckpointDiffResult, type CheckpointListResult } from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import { customEvents, type Session } from "@qianji/session";
import {
  createWorkspaceCheckpoint,
  diffWorkspaceCheckpoint,
  isWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  type WorkspaceCheckpoint,
  type WorkspaceCheckpointDiff,
} from "./git.ts";

export * from "./git.ts";

export const name = "qianji-checkpoints";
export const inject = ["sessions", "agents"];
export const NAMESPACE = "qianji-checkpoints";
export const LEGACY_NAMESPACE = "pid-checkpoints";

export interface CheckpointRecord {
  /** The user message whose run this snapshot precedes. */
  userSeq: number;
  checkpoint: WorkspaceCheckpoint;
}

/** The checkpoints recorded on the session's current branch, oldest first. */
export function checkpointsOf(session: Session): CheckpointRecord[] {
  return customEvents(session.events, [NAMESPACE, LEGACY_NAMESPACE]).flatMap((event) => {
    const data = event.data.data as Partial<CheckpointRecord> | undefined;
    return typeof data?.userSeq === "number" && isWorkspaceCheckpoint(data.checkpoint) ? [{ userSeq: data.userSeq, checkpoint: data.checkpoint }] : [];
  });
}

export function checkpointFor(session: Session, userSeq: number): CheckpointRecord | undefined {
  return checkpointsOf(session).find((record) => record.userSeq === userSeq);
}

/** Take a checkpoint for the session's latest user message; undefined outside a git repository. */
export async function takeCheckpoint(session: Session): Promise<CheckpointRecord | undefined> {
  const user = session.events.findLast((event) => event.type === "user");
  if (user === undefined || checkpointFor(session, user.seq) !== undefined) return undefined;
  const checkpoint = await createWorkspaceCheckpoint(session.header.cwd);
  if (checkpoint === null) return undefined;
  const record: CheckpointRecord = { userSeq: user.seq, checkpoint };
  session.append("custom", { ns: NAMESPACE, data: record });
  return record;
}

export async function diffCheckpoint(record: CheckpointRecord): Promise<WorkspaceCheckpointDiff> {
  return diffWorkspaceCheckpoint(record.checkpoint);
}

export async function restoreCheckpoint(record: CheckpointRecord): Promise<WorkspaceCheckpointDiff> {
  return restoreWorkspaceCheckpoint(record.checkpoint);
}

export function apply(ctx: Context): void {
  ctx.on("agent/before-start", async (session) => {
    const permissions = ctx.get("permissions") as { modes(session: Session): { effective: string } } | undefined;
    if (permissions?.modes(session).effective === "read-only") return;
    try {
      await takeCheckpoint(session);
    } catch (error) {
      ctx.logger("checkpoints").warn("checkpoint of %s failed: %s", session.id, error);
    }
  });

  ctx.inject(["rpc"], (rpcCtx) => {
    const resolveSession = async (params: unknown): Promise<{ target: Session; p: Record<string, unknown> }> => {
      const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
      if (typeof p.sessionId !== "string") throw new RpcError(ErrorCode.InvalidParams, "sessionId must be a string");
      const target = await rpcCtx.sessions.get(p.sessionId);
      if (target === undefined) throw new RpcError(ErrorCode.SessionNotFound, `No session ${p.sessionId}`);
      return { target, p };
    };
    const parseUserSeq = (p: Record<string, unknown>): number => {
      if (!Number.isInteger(p.userSeq)) {
        throw new RpcError(ErrorCode.InvalidParams, "userSeq must be the seq of a user message");
      }
      return p.userSeq as number;
    };

    rpcCtx.effect(
      () => rpcCtx.rpc.method("checkpoint.list", async (params): Promise<CheckpointListResult> => ({
        checkpoints: checkpointsOf((await resolveSession(params)).target).map(({ userSeq, checkpoint }) => ({
          userSeq,
          root: checkpoint.root,
          createdAt: checkpoint.createdAt,
        })),
      })),
      `${name}: checkpoint.list`,
    );

    rpcCtx.effect(
      () => rpcCtx.rpc.method("checkpoint.diff", async (params): Promise<CheckpointDiffResult> => {
        const { target, p } = await resolveSession(params);
        const record = checkpointFor(target, parseUserSeq(p));
        if (record === undefined) throw new RpcError(ErrorCode.InvalidParams, "No checkpoint for that message");
        return diffCheckpoint(record);
      }),
      `${name}: checkpoint.diff`,
    );

    rpcCtx.effect(
      () => rpcCtx.rpc.method("checkpoint.restore", async (params): Promise<CheckpointDiffResult> => {
        const { target, p } = await resolveSession(params);
        if (rpcCtx.agents.status(target.id).running) {
          throw new RpcError(ErrorCode.SessionBusy, `Session ${target.id} is running`);
        }
        const record = checkpointFor(target, parseUserSeq(p));
        if (record === undefined) throw new RpcError(ErrorCode.InvalidParams, "No checkpoint for that message");
        return restoreCheckpoint(record);
      }),
      `${name}: checkpoint.restore`,
    );
  });
}
