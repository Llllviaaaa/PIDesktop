import assert from "node:assert/strict";
import {
  reconcileSidebarSessionOrder,
  sortSidebarProjectGroups,
  sortSidebarSessions,
  type SidebarProjectGroup,
} from "../src/lib/sidebarProjectOrder.ts";
import type { ProjectConfig, SessionInfo } from "../src/types.ts";

function session(file: string, cwd: string, updatedAt: number): SessionInfo {
  return {
    file,
    sessionId: file,
    cwd,
    messageCount: 1,
    updatedAt,
  };
}

const alpha = session("alpha", "D:\\alpha", 300);
const beta = session("beta", "D:\\beta", 200);
const groups: SidebarProjectGroup[] = [
  [alpha.cwd, [alpha]],
  [beta.cwd, [beta]],
];

assert.deepEqual(
  sortSidebarProjectGroups(groups, [], [alpha.file, beta.file]).map(([workspace]) => workspace),
  [alpha.cwd, beta.cwd],
  "projects should follow their persisted order",
);

const refreshedBeta = session(beta.file, beta.cwd, 900);
const stableOrder = reconcileSidebarSessionOrder([alpha.file, beta.file], [refreshedBeta, alpha]);
assert.deepEqual(stableOrder, [alpha.file, beta.file], "activity updates must not reorder existing sessions");
assert.deepEqual(
  sortSidebarSessions([refreshedBeta, alpha], [], stableOrder).map((item) => item.file),
  [alpha.file, beta.file],
  "rendered sessions must use the stable order instead of updatedAt",
);
assert.deepEqual(
  sortSidebarProjectGroups([[beta.cwd, [refreshedBeta]], [alpha.cwd, [alpha]]], [], stableOrder)
    .map(([workspace]) => workspace),
  [alpha.cwd, beta.cwd],
  "project groups must not move when an existing session becomes active",
);

const gamma = session("gamma", "D:\\gamma", 1_000);
assert.deepEqual(
  reconcileSidebarSessionOrder(stableOrder, [gamma, refreshedBeta, alpha]),
  [gamma.file, alpha.file, beta.file],
  "new sessions should be inserted at the top once",
);
assert.deepEqual(
  reconcileSidebarSessionOrder([gamma.file, alpha.file, beta.file], [gamma, refreshedBeta]),
  [gamma.file, beta.file],
  "removed sessions should be pruned without disturbing retained sessions",
);
assert.deepEqual(
  sortSidebarSessions([alpha, refreshedBeta], [beta.file.toUpperCase()], stableOrder).map((item) => item.file),
  [beta.file, alpha.file],
  "pinned sessions should override stable order with case-insensitive path matching",
);

const configs: ProjectConfig[] = [
  { path: beta.cwd.toUpperCase(), name: "", pinned: true, hidden: false },
];
assert.deepEqual(
  sortSidebarProjectGroups(groups, configs, [alpha.file, beta.file]).map(([workspace]) => workspace),
  [beta.cwd, alpha.cwd],
  "pinned projects should remain the only navigation-driven ordering override",
);
assert.deepEqual(
  groups.map(([workspace]) => workspace),
  [alpha.cwd, beta.cwd],
  "sorting must not mutate the source group order",
);

console.log("sidebar-project-order: session and project order remain stable across activity updates");
