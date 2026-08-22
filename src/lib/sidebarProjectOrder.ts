import type { ProjectConfig, SessionInfo } from "../types";
import { sessionRecency } from "./sessionTitle";

export type SidebarProjectGroup = [workspace: string, sessions: SessionInfo[]];

function normalizedPath(path: string): string {
  return path.replace(/[\\/]+$/, "").toLowerCase();
}

export function sortSidebarProjectGroups(
  groups: SidebarProjectGroup[],
  projectConfigs: ProjectConfig[],
): SidebarProjectGroup[] {
  const pinnedProjects = new Set(
    projectConfigs
      .filter((project) => project.pinned)
      .map((project) => normalizedPath(project.path)),
  );

  return [...groups].sort((a, b) => {
    const pinDifference = Number(pinnedProjects.has(normalizedPath(b[0])))
      - Number(pinnedProjects.has(normalizedPath(a[0])));
    if (pinDifference) return pinDifference;
    return (b[1][0] ? sessionRecency(b[1][0]) : 0) - (a[1][0] ? sessionRecency(a[1][0]) : 0);
  });
}
