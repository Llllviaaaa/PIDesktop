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
  /** Normalized workspace paths, in the fixed order the sidebar lists them. */
  workspaces: string[];
}

/**
 * Updates the remembered order against the sessions and registered projects now listed.
 *
 * Workspaces keep their existing slots once discovered: opening a workspace or
 * starting a new session inside it never moves the workspace above others.
 * Newly discovered workspaces are appended at the end so spatial order stays stable.
 * An empty session list means sessions may not have loaded yet, so session order is untouched.
 */
export function reconcileSidebarOrder(
  previous: SidebarOrder,
  sessions: SessionInfo[],
  extraWorkspaces: readonly string[] = [],
): SidebarOrder {
  const normalizedExtra = [
    ...new Set(extraWorkspaces.map(normalizedPath).filter(Boolean)),
  ];
  if (sessions.length === 0) {
    if (normalizedExtra.length === 0) return previous;
    // Wait for sessions before seeding an empty workspace order from legacy session-only state.
    if (previous.workspaces.length === 0 && previous.sessions.length > 0) return previous;
    const retainedOnly = [...new Set(previous.workspaces.map(normalizedPath).filter(Boolean))];
    const listedOnly = new Set(retainedOnly);
    const addedOnly = normalizedExtra.filter((workspace) => !listedOnly.has(workspace));
    if (addedOnly.length === 0 && retainedOnly.length === previous.workspaces.length) return previous;
    return { sessions: previous.sessions, workspaces: [...retainedOnly, ...addedOnly] };
  }

  const sessionOrder = reconcileSidebarSessionOrder(previous.sessions, sessions);
  const workspaceByFile = new Map(
    sessions.map((session) => [normalizedPath(session.file), normalizedPath(session.cwd)]),
  );
  const workspacesOf = (files: string[]) => [
    ...new Set(files.map((file) => workspaceByFile.get(normalizedPath(file)) ?? "").filter(Boolean)),
  ];
  const retained = [...new Set(previous.workspaces.map(normalizedPath).filter(Boolean))];
  const listed = new Set(retained);
  // Workspaces the order has not seen yet keep the initial position their newest session or registration gives them.
  const discoveredFromSessions = workspacesOf(sessionOrder).filter((workspace) => !listed.has(workspace));
  for (const workspace of discoveredFromSessions) listed.add(workspace);
  const discoveredFromProjects = normalizedExtra.filter((workspace) => !listed.has(workspace));
  return {
    sessions: sessionOrder,
    workspaces: [...retained, ...discoveredFromSessions, ...discoveredFromProjects],
  };
}

/** Moves `sourceWorkspace` directly before or after `targetWorkspace` while preserving all other slots. */
export function reorderSidebarWorkspaces(
  workspaces: readonly string[],
  sourceWorkspace: string,
  targetWorkspace: string,
  position: "before" | "after" = "before",
): string[] {
  const source = normalizedPath(sourceWorkspace);
  const target = normalizedPath(targetWorkspace);
  const unique = [...new Set(workspaces.map(normalizedPath).filter(Boolean))];
  if (!source || !target || source === target) return unique;
  if (!unique.includes(source)) unique.push(source);
  if (!unique.includes(target)) unique.push(target);
  const withoutSource = unique.filter((workspace) => workspace !== source);
  const targetIndex = withoutSource.indexOf(target);
  if (targetIndex < 0) return unique;
  const insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
  return [
    ...withoutSource.slice(0, insertIndex),
    source,
    ...withoutSource.slice(insertIndex),
  ];
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
