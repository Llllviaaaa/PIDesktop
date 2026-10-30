/**
 * The Harness Host's sessions in the shapes the desktop lists and navigates
 * (docs/adr/0014-frontend-harness-adapter.md): sidebar entries, fork points,
 * the session tree, and the harness's efforts as thinking levels. The
 * messages themselves are src/lib/transcript.ts.
 */
import type { PersistedEvent, SessionInfo as HostSessionInfo } from "@pid/protocol";
import type { ForkPoint, SessionInfo } from "../types";
import { currentBranch, userMessageOf } from "./transcript";

/** The harness's efforts as thinking levels, and back. */
export const HARNESS_THINKING_LEVELS = ["off", "low", "medium", "high"];

export function effortForLevel(level: string): "off" | "low" | "medium" | "high" {
  if (level === "off") return "off";
  if (level === "minimal" || level === "low") return "low";
  if (level === "high" || level === "xhigh") return "high";
  return "medium";
}

/** A Host session as a sidebar entry; its file is `harness:<id>`. */
export function sessionInfoFromHost(session: HostSessionInfo): SessionInfo {
  const updatedAt = Date.parse(session.updatedAt);
  return {
    file: `harness:${session.id}`,
    sessionId: session.id,
    cwd: session.cwd,
    ...(session.title === undefined ? {} : { name: session.title }),
    ...(session.firstMessage === undefined ? {} : { firstMessage: session.firstMessage }),
    messageCount: session.messageCount,
    createdAt: session.createdAt,
    ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
  };
}

/** The user messages on the current branch, as fork points (`entryId` is the event's seq). */
export function forkPointsOf(events: readonly PersistedEvent[]): ForkPoint[] {
  return currentBranch(events).flatMap((event) => (event.type === "user" ? [{ entryId: String(event.seq), text: userMessageOf(event).content }] : []));
}

export interface HarnessTreeNode {
  entry: { type: "message"; id: string; parentId: string | null; timestamp: string; message: { role: string; content: unknown } };
  children: HarnessTreeNode[];
}

/**
 * The whole log as Pi's session tree: each user or assistant message hangs
 * off the previous message of its branch, and a rewind starts a new branch
 * from the last message at or before its `toSeq`. Returns the roots and the
 * id of the current branch's last message.
 */
export function sessionTreeOf(events: readonly PersistedEvent[]): { tree: HarnessTreeNode[]; leafId: string | null } {
  const roots: HarnessTreeNode[] = [];
  const nodes = new Map<number, HarnessTreeNode>();
  const path: number[] = [];
  for (const event of events) {
    if (event.type === "rewind") {
      const toSeq = (event.data as { toSeq?: number }).toSeq ?? 0;
      while (path.length > 0 && (path.at(-1) as number) > toSeq) path.pop();
      continue;
    }
    if (event.type !== "user" && event.type !== "assistant") continue;
    const parentSeq = path.at(-1);
    const node: HarnessTreeNode = {
      entry: {
        type: "message",
        id: String(event.seq),
        parentId: parentSeq === undefined ? null : String(parentSeq),
        timestamp: event.ts,
        message: { role: event.type, content: (event.data as { content?: unknown }).content },
      },
      children: [],
    };
    nodes.set(event.seq, node);
    if (parentSeq === undefined) roots.push(node);
    else nodes.get(parentSeq)?.children.push(node);
    path.push(event.seq);
  }
  const leaf = path.at(-1);
  return { tree: roots, leafId: leaf === undefined ? null : String(leaf) };
}
