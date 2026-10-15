import assert from "node:assert/strict";
import {
  reconcileSidebarOrder,
  reconcileSidebarSessionOrder,
  sortSidebarProjectGroups,
  sortSidebarSessions,
  type SidebarOrder,
  type SidebarProjectGroup,
} from "../src/lib/sidebarProjectOrder.ts";
import type { ProjectConfig, SessionInfo } from "../src/types.ts";
import { test } from "vitest";

test("sidebar project order", async () => {
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
});

test("archiving a session does not reorder projects", () => {
  function session(file: string, cwd: string): SessionInfo {
    return { file, sessionId: file, cwd, messageCount: 1 };
  }
  function groupsOf(sessions: SessionInfo[], emptyProjects: string[] = []): SidebarProjectGroup[] {
    const result = new Map<string, SessionInfo[]>();
    for (const item of sessions) result.set(item.cwd, [...(result.get(item.cwd) ?? []), item]);
    for (const path of emptyProjects) if (!result.has(path)) result.set(path, []);
    return [...result.entries()];
  }
  function projectOrder(order: SidebarOrder, sessions: SessionInfo[], emptyProjects: string[] = []): string[] {
    return sortSidebarProjectGroups(groupsOf(sessions, emptyProjects), [], order.sessions, order.workspaces)
      .map(([workspace]) => workspace);
  }

  const alphaNew = session("alpha-new", "D:\\alpha");
  const beta = session("beta", "D:\\beta");
  const alphaOld = session("alpha-old", "D:\\alpha");
  const listed = [alphaNew, beta, alphaOld];

  // An order saved before projects were remembered: projects follow their newest session.
  const upgraded = reconcileSidebarOrder({ sessions: listed.map((item) => item.file), workspaces: [] }, listed);
  assert.deepEqual(projectOrder(upgraded, listed), ["D:\\alpha", "D:\\beta"], "existing order should carry over");
  assert.deepEqual(reconcileSidebarOrder(upgraded, listed), upgraded, "reconciling should be idempotent");

  const afterArchive = reconcileSidebarOrder(upgraded, [beta, alphaOld]);
  assert.deepEqual(
    projectOrder(afterArchive, [beta, alphaOld]),
    ["D:\\alpha", "D:\\beta"],
    "archiving a project's newest session must not move the project",
  );

  const afterArchivingAll = reconcileSidebarOrder(afterArchive, [beta]);
  assert.deepEqual(
    projectOrder(afterArchivingAll, [beta], ["D:\\alpha"]),
    ["D:\\alpha", "D:\\beta"],
    "a project whose chats are all archived should keep its slot",
  );

  const betaNew = session("beta-new", "D:\\beta");
  const afterNewChat = reconcileSidebarOrder(afterArchive, [betaNew, beta, alphaOld]);
  assert.deepEqual(
    projectOrder(afterNewChat, [betaNew, beta, alphaOld]),
    ["D:\\beta", "D:\\alpha"],
    "a new chat should still bring its project to the top",
  );

  assert.equal(
    reconcileSidebarOrder(afterNewChat, []),
    afterNewChat,
    "an empty list (sessions not loaded yet) must not wipe the remembered order",
  );

  const fresh = reconcileSidebarOrder({ sessions: [], workspaces: [] }, listed);
  assert.deepEqual(fresh.sessions, listed.map((item) => item.file), "a first run should take Pi's order");
  assert.deepEqual(projectOrder(fresh, listed), ["D:\\alpha", "D:\\beta"], "a first run should list projects by newest chat");

  const caseShifted = reconcileSidebarOrder(afterArchive, [session("BETA", "d:\\BETA"), session("ALPHA-OLD", "d:\\ALPHA")]);
  assert.deepEqual(caseShifted.workspaces, afterArchive.workspaces, "paths should match case-insensitively");
});
