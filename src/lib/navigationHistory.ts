import { normalizeLocalPath } from "./pathIdentity";

export type NavigationTarget<Hub extends string = string> =
  | { kind: "home"; workspace: string }
  | { kind: "hub"; view: Hub }
  | { kind: "session"; cwd: string; file: string };

export function navigationKey(target: NavigationTarget): string {
  return target.kind === "home"
    ? `home:${normalizeLocalPath(target.workspace)}`
    : target.kind === "hub"
      ? `hub:${target.view}`
      : `session:${normalizeLocalPath(target.file)}`;
}

export function withoutArchivedSessions<T extends NavigationTarget>(
  targets: T[],
  archivedFiles: string[],
): T[] {
  const archived = new Set(archivedFiles.map(normalizeLocalPath));
  return targets.filter((target) => target.kind !== "session" || !archived.has(normalizeLocalPath(target.file)));
}
