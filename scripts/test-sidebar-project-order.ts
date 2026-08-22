import assert from "node:assert/strict";
import { sortSidebarProjectGroups, type SidebarProjectGroup } from "../src/lib/sidebarProjectOrder.ts";
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
  sortSidebarProjectGroups(groups, []).map(([workspace]) => workspace),
  [alpha.cwd, beta.cwd],
  "projects should follow activity order without an active-workspace override",
);

const configs: ProjectConfig[] = [
  { path: beta.cwd.toUpperCase(), name: "", pinned: true, hidden: false },
];
assert.deepEqual(
  sortSidebarProjectGroups(groups, configs).map(([workspace]) => workspace),
  [beta.cwd, alpha.cwd],
  "pinned projects should remain the only navigation-driven ordering override",
);
assert.deepEqual(
  groups.map(([workspace]) => workspace),
  [alpha.cwd, beta.cwd],
  "sorting must not mutate the source group order",
);

console.log("sidebar-project-order: project order is stable across session selection");
