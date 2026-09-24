import assert from "node:assert/strict";
import { test } from "vitest";
import { gitActionsFor } from "../src/lib/gitActions.ts";
import type { GitSnapshot } from "../src/types.ts";

const changed = [{ path: "a.ts", status: "M" }];

function snapshot(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    isRepository: true,
    branch: "feat/x",
    files: [],
    diff: "",
    sync: { upstream: "origin/feat/x", ahead: 0, behind: 0, hasRemote: true },
    ...overrides,
  };
}

test("offers nothing outside a repository or when everything is pushed", () => {
  assert.equal(gitActionsFor(null), null);
  assert.equal(gitActionsFor({ isRepository: false, files: [], diff: "" }), null);
  const clean = gitActionsFor(snapshot());
  assert.equal(clean?.primary, null);
  assert.equal(clean?.syncLabel, "origin/feat/x · 已同步");
});

test("commits first, then pushes what is ahead", () => {
  const dirty = gitActionsFor(snapshot({ files: changed, sync: { upstream: "origin/feat/x", ahead: 2, behind: 1, hasRemote: true } }));
  assert.deepEqual(dirty?.primary, { kind: "commit" });
  assert.equal(dirty?.canCommitAndPush, true);
  assert.deepEqual(dirty?.push, { kind: "push", ahead: 2 });
  assert.equal(dirty?.syncLabel, "origin/feat/x · 领先 2，落后 1");
  const ahead = gitActionsFor(snapshot({ sync: { upstream: "origin/feat/x", ahead: 3, behind: 0, hasRemote: true } }));
  assert.deepEqual(ahead?.primary, { kind: "push", ahead: 3 });
});

test("publishes a branch without an upstream, and never pushes without a remote or branch", () => {
  const local = gitActionsFor(snapshot({ sync: { ahead: 0, behind: 0, hasRemote: true } }));
  assert.deepEqual(local?.primary, { kind: "publish" });
  assert.equal(local?.syncLabel, "尚未发布到远程");
  const noRemote = gitActionsFor(snapshot({ files: changed, sync: { ahead: 0, behind: 0, hasRemote: false } }));
  assert.equal(noRemote?.canCommitAndPush, false);
  assert.equal(noRemote?.push, null);
  const detached = gitActionsFor(snapshot({ branch: "HEAD" }));
  assert.equal(detached?.primary, null);
  assert.equal(detached?.syncLabel, "不在任何分支上");
});
