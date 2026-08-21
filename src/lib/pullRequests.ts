export function uniqueWorkspacePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const trimmed = path.trim();
    if (!trimmed) continue;
    const key = trimmed.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

export async function findGitWorkspace(
  preferredWorkspace: string,
  workspaceOptions: string[],
  resolveRepositoryRoot: (workspace: string) => Promise<string | null>,
  allowFallback = true,
): Promise<{ workspace: string; repositoryRoot: string } | null> {
  const candidates = uniqueWorkspacePaths(
    allowFallback ? [preferredWorkspace, ...workspaceOptions] : [preferredWorkspace],
  );
  for (const workspace of candidates) {
    try {
      const repositoryRoot = await resolveRepositoryRoot(workspace);
      if (repositoryRoot) return { workspace, repositoryRoot };
    } catch {
      // Removed or unavailable workspaces should not block another local repository.
    }
  }
  return null;
}
