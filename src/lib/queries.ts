/**
 * Query keys for data read from the Tauri backend.
 *
 * Everything scoped to a workspace starts with ["workspace", cwd], so one
 * invalidation refreshes every view of that workspace — the file tree's
 * refresh button does exactly that. Keys are built here rather than inline so
 * a component that writes to the cache and one that reads it cannot drift
 * apart.
 */
export const queryKeys = {
  workspace: (cwd: string) => ["workspace", cwd] as const,
  directory: (cwd: string, path: string) => ["workspace", cwd, "directory", path] as const,
  search: (cwd: string, needle: string) => ["workspace", cwd, "search", needle] as const,
  file: (cwd: string, path: string) => ["workspace", cwd, "file", path] as const,
  gitSnapshot: (cwd: string) => ["workspace", cwd, "git"] as const,
  reviewSources: (cwd: string) => ["workspace", cwd, "review-sources"] as const,
  resources: (cwd: string) => ["workspace", cwd, "resources"] as const,
  worktrees: (cwd: string) => ["workspace", cwd, "worktrees"] as const,
  appearance: (cwd: string) => ["workspace", cwd, "appearance"] as const,

  archivedSessions: () => ["sessions", "archived"] as const,
  usage: () => ["usage"] as const,
  localMemory: () => ["local-memory"] as const,
  projects: () => ["projects"] as const,
  scheduled: () => ["scheduled"] as const,
  modelProviders: () => ["models", "providers"] as const,
  modelConfigs: () => ["models", "configs"] as const,
  pullRequests: (requested: string, candidates: readonly string[], touched: boolean) =>
    ["pull-requests", requested, candidates, touched] as const,
  diagram: (kind: string, dark: boolean, source: string) => ["diagram", kind, dark, source] as const,
};
