import { invoke } from "@tauri-apps/api/core";
import type { LlmCompleteResult } from "@pid/protocol";
import { harnessRuntimes } from "./harnessRuntime";
import type {
  GitBranchInfo,
  GitCommitInfo,
  GitCommitResult,
  GitPushResult,
  GitSnapshot,
} from "../types";

const gitSnapshotRequests = new Map<string, Promise<GitSnapshot>>();

/** Models sometimes wrap the answer in a code fence or quotes anyway. */
export function cleanCommitMessage(output: string): string {
  const message = output.trim().split(/\r?\n/).filter((line) => !line.trimStart().startsWith("```")).join("\n").trim();
  const quoted = /^"([^"]*)"$/.exec(message);
  return (quoted?.[1] ?? message).trim();
}

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
  /** Rust describes the changes; the Harness Host writes the message with one model call (P6a). */
  generateCommitMessage: async (cwd: string, options: { paths?: string[]; provider?: string; model?: string } = {}) => {
    const prompt = await invoke<string>("git_commit_message_prompt", { cwd, paths: options.paths ?? null });
    const model = options.provider && options.model ? { provider: options.provider, model: options.model } : {};
    const { text } = await harnessRuntimes.call<LlmCompleteResult>("llm.complete", { prompt, ...model });
    const message = cleanCommitMessage(text);
    if (!message) throw new Error("模型返回了空的提交说明");
    return message;
  },
  applyPatch: (cwd: string, patch: string, options: { cached: boolean; reverse: boolean }) =>
    invoke<void>("git_apply_patch", { cwd, patch, cached: options.cached, reverse: options.reverse }),
  lastTurnSnapshot: (cwd: string) =>
    invoke<(GitSnapshot & { startedAt: number }) | null>("git_last_turn_snapshot", { cwd }),
};
