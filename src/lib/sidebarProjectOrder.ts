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
): SidebarProjectGroup[] {
  const pinnedProjects = new Set(
    projectConfigs
      .filter((project) => project.pinned)
      .map((project) => normalizedPath(project.path)),
  );
  const sessionRank = new Map(stableOrder.map((file, index) => [normalizedPath(file), index]));
  const sourceRank = new Map(groups.map(([workspace], index) => [normalizedPath(workspace), index]));
  const groupRank = ([workspace, sessions]: SidebarProjectGroup) => {
    const rankedSessions = sessions
      .map((session) => sessionRank.get(normalizedPath(session.file)))
      .filter((rank): rank is number => rank !== undefined);
    return rankedSessions.length > 0
      ? Math.min(...rankedSessions)
      : stableOrder.length + (sourceRank.get(normalizedPath(workspace)) ?? Number.MAX_SAFE_INTEGER);
  };

  return [...groups].sort((a, b) => {
    const pinDifference = Number(pinnedProjects.has(normalizedPath(b[0])))
      - Number(pinnedProjects.has(normalizedPath(a[0])));
    if (pinDifference) return pinDifference;
    return groupRank(a) - groupRank(b);
  });
}
