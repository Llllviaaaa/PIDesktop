import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const PIDESKTOP_CHECKPOINT_TYPE = "pidesktop-workspace-checkpoint";
export const PIDESKTOP_CHECKPOINT_RETENTION = 250;

export interface WorkspaceCheckpoint {
  version: 1;
  root: string;
  tree: string;
  indexTree: string;
  ref: string;
  createdAt: string;
}

export interface WorkspaceCheckpointDiff {
  changed: boolean;
  files: string[];
  indexChanged: boolean;
}

interface GitResult {
  stdout: Buffer;
  stderr: Buffer;
}

function runGit(
  cwd: string,
  args: string[],
  options: { env?: Record<string, string>; input?: Buffer | string } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const output = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (code === 0) resolve(output);
      else reject(new Error(output.stderr.toString("utf8").trim() || `git ${args[0]} failed with code ${code}`));
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function repositoryRoot(cwd: string): Promise<string | null> {
  try {
    const result = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    return result.stdout.toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

async function headTree(root: string): Promise<string | null> {
  try {
    const result = await runGit(root, ["rev-parse", "--verify", "HEAD^{tree}"]);
    return result.stdout.toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

async function worktreeTree(root: string): Promise<string> {
  const temp = await mkdtemp(join(tmpdir(), "pidesktop-checkpoint-"));
  const indexFile = join(temp, "index");
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    const base = await headTree(root);
    if (base) await runGit(root, ["read-tree", base], { env });
    else await runGit(root, ["read-tree", "--empty"], { env });
    await runGit(root, ["add", "-A", "--", "."], { env });
    const tree = await runGit(root, ["write-tree"], { env });
    return tree.stdout.toString("utf8").trim();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function indexTree(root: string): Promise<string> {
  const result = await runGit(root, ["write-tree"]);
  return result.stdout.toString("utf8").trim();
}

function checkpointEnvironment(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: "PIDesktop",
    GIT_AUTHOR_EMAIL: "checkpoint@pidesktop.local",
    GIT_COMMITTER_NAME: "PIDesktop",
    GIT_COMMITTER_EMAIL: "checkpoint@pidesktop.local",
  };
}

export async function pruneWorkspaceCheckpoints(root: string, retain = PIDESKTOP_CHECKPOINT_RETENTION): Promise<number> {
  const result = await runGit(root, [
    "for-each-ref",
    "--sort=-creatordate",
    "--format=%(refname)",
    "refs/pidesktop/checkpoints",
  ]);
  const refs = result.stdout.toString("utf8").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const stale = refs.slice(Math.max(0, retain));
  await Promise.all(stale.map((ref) => runGit(root, ["update-ref", "-d", ref])));
  return stale.length;
}

/** Capture tracked and non-ignored workspace files without touching the real Git index. */
export async function createWorkspaceCheckpoint(cwd: string): Promise<WorkspaceCheckpoint | null> {
  const root = await repositoryRoot(cwd);
  if (!root) return null;
  try {
    const [tree, stagedTree] = await Promise.all([worktreeTree(root), indexTree(root)]);
    const id = randomUUID();
    const ref = `refs/pidesktop/checkpoints/${id}`;
    const commit = await runGit(root, ["commit-tree", tree], {
      env: checkpointEnvironment(),
      input: `PIDesktop workspace checkpoint ${id}\n`,
    });
    await runGit(root, ["update-ref", ref, commit.stdout.toString("utf8").trim()]);
    await pruneWorkspaceCheckpoints(root);
    return {
      version: 1,
      root,
      tree,
      indexTree: stagedTree,
      ref,
      createdAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function isWorkspaceCheckpoint(value: unknown): value is WorkspaceCheckpoint {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkspaceCheckpoint>;
  return item.version === 1
    && typeof item.root === "string"
    && typeof item.tree === "string"
    && typeof item.indexTree === "string"
    && typeof item.ref === "string";
}

export async function diffWorkspaceCheckpoint(checkpoint: WorkspaceCheckpoint): Promise<WorkspaceCheckpointDiff> {
  const currentTree = await worktreeTree(checkpoint.root);
  const currentIndex = await indexTree(checkpoint.root);
  const result = await runGit(checkpoint.root, [
    "diff",
    "--name-only",
    "--no-ext-diff",
    currentTree,
    checkpoint.tree,
    "--",
  ]);
  const files = result.stdout.toString("utf8").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  return {
    changed: currentTree !== checkpoint.tree || currentIndex !== checkpoint.indexTree,
    files,
    indexChanged: currentIndex !== checkpoint.indexTree,
  };
}

/** Restore the captured file contents and staging state. Ignored files are deliberately untouched. */
export async function restoreWorkspaceCheckpoint(checkpoint: WorkspaceCheckpoint): Promise<WorkspaceCheckpointDiff> {
  const diff = await diffWorkspaceCheckpoint(checkpoint);
  if (!diff.changed) return diff;
  const currentTree = await worktreeTree(checkpoint.root);
  if (currentTree !== checkpoint.tree) {
    const patch = await runGit(checkpoint.root, [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      currentTree,
      checkpoint.tree,
      "--",
    ]);
    if (patch.stdout.length > 0) {
      await runGit(checkpoint.root, ["apply", "--binary", "--whitespace=nowarn", "-"], { input: patch.stdout });
    }
  }
  await runGit(checkpoint.root, ["read-tree", checkpoint.indexTree]);
  return diff;
}
