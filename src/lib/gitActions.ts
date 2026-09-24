/**
 * What the topbar Git button offers for the working tree: commit while there
 * are changes, then push what is ahead of the upstream, or publish a branch
 * that has none.
 */
import type { GitSnapshot } from "../types";

export type GitPrimaryAction =
  | { kind: "commit" }
  | { kind: "push"; ahead: number }
  | { kind: "publish" };

export interface GitActionState {
  primary: GitPrimaryAction | null;
  /** Commit-and-push is offered when a push could follow the commit. */
  canCommitAndPush: boolean;
  /** A push or publish the menu can offer next to the primary commit. */
  push: Exclude<GitPrimaryAction, { kind: "commit" }> | null;
  branch: string;
  /** One line for the menu header: upstream and counts, or why pushing is unavailable. */
  syncLabel: string;
  /** The push will be rejected until the remote's new commits are merged. */
  behind: number;
}

export function gitActionsFor(git: GitSnapshot | null | undefined): GitActionState | null {
  if (!git?.isRepository) return null;
  const branch = git.branch ?? "";
  const detached = !branch || branch === "HEAD";
  const sync = git.sync;
  const remoteReady = Boolean(sync?.hasRemote) && !detached;
  const ahead = sync?.ahead ?? 0;
  const behind = sync?.behind ?? 0;
  const push: GitActionState["push"] = !remoteReady
    ? null
    : sync?.upstream
      ? ahead > 0 ? { kind: "push", ahead } : null
      : { kind: "publish" };
  const hasChanges = git.files.length > 0;
  const syncLabel = detached
    ? "不在任何分支上"
    : !sync?.hasRemote
      ? "没有远程仓库"
      : !sync.upstream
        ? "尚未发布到远程"
        : ahead || behind
          ? `${sync.upstream} · ${[ahead ? `领先 ${ahead}` : "", behind ? `落后 ${behind}` : ""].filter(Boolean).join("，")}`
          : `${sync.upstream} · 已同步`;
  return {
    primary: hasChanges ? { kind: "commit" } : push,
    canCommitAndPush: hasChanges && remoteReady,
    push: hasChanges ? push : null,
    branch: detached ? "HEAD" : branch,
    syncLabel,
    behind,
  };
}
