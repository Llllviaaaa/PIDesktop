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
import "@pid/agent";
import { customEvents, type Session } from "@pid/session";
import {
  createWorkspaceCheckpoint,
  diffWorkspaceCheckpoint,
  isWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
  type WorkspaceCheckpoint,
  type WorkspaceCheckpointDiff,
} from "./git.ts";

export * from "./git.ts";

export const name = "pid-checkpoints";
export const inject = ["sessions", "agents"];
export const NAMESPACE = "pid-checkpoints";

export interface CheckpointRecord {
  /** The user message whose run this snapshot precedes. */
  userSeq: number;
  checkpoint: WorkspaceCheckpoint;
}

/** The checkpoints recorded on the session's current branch, oldest first. */
export function checkpointsOf(session: Session): CheckpointRecord[] {
  return customEvents(session.events, NAMESPACE).flatMap((event) => {
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
}
