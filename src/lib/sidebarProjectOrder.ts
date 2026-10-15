import type { ProjectConfig, SessionInfo } from "../types";

export type SidebarProjectGroup = [workspace: string, sessions: SessionInfo[]];

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function reconcileSidebarSessionOrder(
  previous: string[],
  sessions: SessionInfo[],
): string[] {
  const available = new Map(sessions.map((session) => [normalizedPath(session.file), session.file]));
  const retained = previous
    .map((file) => available.get(normalizedPath(file)))
    .filter((file): file is string => Boolean(file));
  const retainedKeys = new Set(retained.map(normalizedPath));
  const added = sessions
    .map((session) => session.file)
    .filter((file) => !retainedKeys.has(normalizedPath(file)));
  return [...added, ...retained];
}

/** What the sidebar remembers between refreshes and restarts. */
export interface SidebarOrder {
  /** Session files, newest first. A session keeps its slot once it has one. */
  sessions: string[];
  /** Normalized workspace paths, in the order the sidebar lists them. */
  workspaces: string[];
}

/**
 * Updates the remembered order against the sessions Pi lists now.
 *
 * A workspace moves to the top only when it gains a session. Sessions that
 * disappear (archived, deleted, or hidden behind a fork) never move it, so
 * archiving a project's newest chat leaves the project where it was. An empty
 * list means the sessions have not loaded yet, so it changes nothing.
 */
export function reconcileSidebarOrder(previous: SidebarOrder, sessions: SessionInfo[]): SidebarOrder {
  if (sessions.length === 0) return previous;
  const sessionOrder = reconcileSidebarSessionOrder(previous.sessions, sessions);
  const known = new Set(previous.sessions.map(normalizedPath));
  const workspaceByFile = new Map(sessions.map((session) => [normalizedPath(session.file), normalizedPath(session.cwd)]));
  const workspacesOf = (files: string[]) => [
    ...new Set(files.map((file) => workspaceByFile.get(normalizedPath(file)) ?? "")),
  ];
  const promoted = workspacesOf(sessionOrder.filter((file) => !known.has(normalizedPath(file))));
  const retained = previous.workspaces.filter((workspace) => !promoted.includes(workspace));
  const listed = new Set([...promoted, ...retained]);
  // Workspaces the order has not seen yet (the first run with this order) keep
  // the position their newest session gives them.
  const discovered = workspacesOf(sessionOrder).filter((workspace) => !listed.has(workspace));
  return { sessions: sessionOrder, workspaces: [...promoted, ...retained, ...discovered] };
}

export function sortSidebarSessions(
  sessions: SessionInfo[],
  pinnedFiles: string[],
  stableOrder: string[],
): SessionInfo[] {
  const pinned = new Set(pinnedFiles.map(normalizedPath));
  const rank = new Map(stableOrder.map((file, index) => [normalizedPath(file), index]));
  const sourceRank = new Map(sessions.map((session, index) => [normalizedPath(session.file), index]));
  return [...sessions].sort((a, b) => {
    const pinDifference = Number(pinned.has(normalizedPath(b.file)))
      - Number(pinned.has(normalizedPath(a.file)));
    if (pinDifference) return pinDifference;
    return (rank.get(normalizedPath(a.file)) ?? sourceRank.get(normalizedPath(a.file)) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(normalizedPath(b.file)) ?? sourceRank.get(normalizedPath(b.file)) ?? Number.MAX_SAFE_INTEGER);
  });
}

export function sortSidebarProjectGroups(
  groups: SidebarProjectGroup[],
  projectConfigs: ProjectConfig[],
  stableOrder: string[] = [],
  workspaceOrder: string[] = [],
): SidebarProjectGroup[] {
  const pinnedProjects = new Set(
    projectConfigs
      .filter((project) => project.pinned)
      .map((project) => normalizedPath(project.path)),
  );
  const workspaceRank = new Map(workspaceOrder.map((workspace, index) => [normalizedPath(workspace), index]));
  const sessionRank = new Map(stableOrder.map((file, index) => [normalizedPath(file), index]));
  const sourceRank = new Map(groups.map(([workspace], index) => [normalizedPath(workspace), index]));
  // Remembered workspaces come first in their remembered order; the rest
  // (projects without a chat yet) follow by their newest session.
  const groupRank = ([workspace, sessions]: SidebarProjectGroup) => {
    const remembered = workspaceRank.get(normalizedPath(workspace));
    if (remembered !== undefined) return remembered;
    const rankedSessions = sessions
      .map((session) => sessionRank.get(normalizedPath(session.file)))
      .filter((rank): rank is number => rank !== undefined);
    return workspaceOrder.length + (rankedSessions.length > 0
      ? Math.min(...rankedSessions)
      : stableOrder.length + (sourceRank.get(normalizedPath(workspace)) ?? Number.MAX_SAFE_INTEGER));
  };

  return [...groups].sort((a, b) => {
    const pinDifference = Number(pinnedProjects.has(normalizedPath(b[0])))
      - Number(pinnedProjects.has(normalizedPath(a[0])));
    if (pinDifference) return pinDifference;
    return groupRank(a) - groupRank(b);
  });
}
