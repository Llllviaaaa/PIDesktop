import { invoke } from "@tauri-apps/api/core";
import type {
  GitBranchInfo,
  GitCommitInfo,
  GitCommitResult,
  GitPushResult,
  GitSnapshot,
} from "../types";

const gitSnapshotRequests = new Map<string, Promise<GitSnapshot>>();

export const gitClient = {
  snapshot(cwd: string): Promise<GitSnapshot> {
    const key = cwd.replace(/[\\/]+$/, "").toLowerCase();
    const pending = gitSnapshotRequests.get(key);
    if (pending) return pending;
    const request = invoke<GitSnapshot>("git_snapshot", { cwd })
      .finally(() => { gitSnapshotRequests.delete(key); });
    gitSnapshotRequests.set(key, request);
    return request;
  },
  repositoryRoot: (cwd: string) => invoke<string | null>("git_repository_root", { cwd }),
  restoreFiles: (cwd: string, paths: string[]) => invoke<void>("git_restore_files", { cwd, paths }),
  stageFiles: (cwd: string, paths: string[]) => invoke<void>("git_stage_files", { cwd, paths }),
  unstageFiles: (cwd: string, paths: string[]) => invoke<void>("git_unstage_files", { cwd, paths }),
  listBranches: (cwd: string) => invoke<GitBranchInfo[]>("git_list_branches", { cwd }),
  checkoutBranch: (cwd: string, branch: string) => invoke<void>("git_checkout_branch", { cwd, branch }),
  compare: (cwd: string, base: string) => invoke<GitSnapshot>("git_compare", { cwd, base }),
  reviewSnapshot: (cwd: string, filter: "uncommitted" | "unstaged" | "staged") =>
    invoke<GitSnapshot>("git_review_snapshot", { cwd, filter }),
  listCommits: (cwd: string, limit = 50) => invoke<GitCommitInfo[]>("git_list_commits", { cwd, limit }),
  commitSnapshot: (cwd: string, commit: string) => invoke<GitSnapshot>("git_commit_snapshot", { cwd, commit }),
  defaultBranch: (cwd: string) => invoke<string | null>("git_default_branch", { cwd }),
  commit: (cwd: string, message: string, options: { paths?: string[]; newBranch?: string } = {}) =>
    invoke<GitCommitResult>("git_commit", { cwd, message, paths: options.paths ?? null, newBranch: options.newBranch ?? null }),
  push: (cwd: string) => invoke<GitPushResult>("git_push", { cwd }),
  generateCommitMessage: (cwd: string, options: { paths?: string[]; provider?: string; model?: string } = {}) =>
    invoke<string>("git_generate_commit_message", {
      cwd,
      paths: options.paths ?? null,
      provider: options.provider ?? null,
      model: options.model ?? null,
    }),
  applyPatch: (cwd: string, patch: string, options: { cached: boolean; reverse: boolean }) =>
    invoke<void>("git_apply_patch", { cwd, patch, cached: options.cached, reverse: options.reverse }),
  lastTurnSnapshot: (cwd: string) =>
    invoke<(GitSnapshot & { startedAt: number }) | null>("git_last_turn_snapshot", { cwd }),
};
