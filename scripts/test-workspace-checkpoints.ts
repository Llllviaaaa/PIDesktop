import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceCheckpoint,
  diffWorkspaceCheckpoint,
  isWorkspaceCheckpoint,
  pruneWorkspaceCheckpoints,
  restoreWorkspaceCheckpoint,
} from "../src-tauri/resources/pidesktop-checkpoints.ts";

const root = await mkdtemp(join(tmpdir(), "pidesktop-checkpoint-test-"));

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

try {
  git("init");
  git("config", "user.name", "PIDesktop Test");
  git("config", "user.email", "test@pidesktop.local");
  await writeFile(join(root, "tracked.txt"), "committed\n");
  git("add", "tracked.txt");
  git("commit", "-m", "initial");

  await writeFile(join(root, "tracked.txt"), "staged-before-turn\n");
  git("add", "tracked.txt");
  await writeFile(join(root, "tracked.txt"), "worktree-before-turn\n");
  await writeFile(join(root, "untracked-before.txt"), "keep me\n");

  const checkpoint = await createWorkspaceCheckpoint(root);
  assert.ok(checkpoint, "Git workspaces should produce a checkpoint");
  assert.ok(isWorkspaceCheckpoint(checkpoint), "checkpoint should pass runtime validation");
  assert.equal(git("show", ":tracked.txt"), "staged-before-turn", "capturing must not mutate the real index");

  await writeFile(join(root, "tracked.txt"), "changed-by-agent\n");
  await unlink(join(root, "untracked-before.txt"));
  await writeFile(join(root, "created-by-agent.txt"), "remove me\n");
  git("add", "tracked.txt", "created-by-agent.txt");

  const diff = await diffWorkspaceCheckpoint(checkpoint);
  assert.equal(diff.changed, true, "workspace changes should be detected");
  assert.ok(diff.files.includes("tracked.txt"), "changed tracked file should be reported");
  assert.ok(diff.files.includes("untracked-before.txt"), "deleted baseline untracked file should be reported");
  assert.ok(diff.files.includes("created-by-agent.txt"), "new agent file should be reported");

  await restoreWorkspaceCheckpoint(checkpoint);
  assert.equal((await readFile(join(root, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n"), "worktree-before-turn\n", "worktree content should rewind");
  assert.equal((await readFile(join(root, "untracked-before.txt"), "utf8")).replace(/\r\n/g, "\n"), "keep me\n", "baseline untracked file should return");
  await assert.rejects(readFile(join(root, "created-by-agent.txt"), "utf8"), "agent-created file should be removed");
  assert.equal(git("show", ":tracked.txt"), "staged-before-turn", "staging state should rewind independently");

  const restoredDiff = await diffWorkspaceCheckpoint(checkpoint);
  assert.equal(restoredDiff.changed, false, "restored workspace should match the checkpoint exactly");
  await createWorkspaceCheckpoint(root);
  await createWorkspaceCheckpoint(root);
  const pruned = await pruneWorkspaceCheckpoints(root, 2);
  assert.ok(pruned >= 1, "checkpoint retention should prune stale refs");
  assert.equal(git("for-each-ref", "--format=%(refname)", "refs/pidesktop/checkpoints").split(/\r?\n/).filter(Boolean).length, 2);
  assert.equal(await createWorkspaceCheckpoint(join(root, "missing")), null, "non-repositories should not throw");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("workspace-checkpoints: all assertions passed");
