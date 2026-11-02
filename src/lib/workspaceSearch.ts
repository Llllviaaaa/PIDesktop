import { agent } from "./agent";
import type { WorkspaceDirEntry } from "../types";

let searchSequence = 0;

/**
 * What an `@` mention offers for a query: the workspace root when it is empty,
 * a folder's entries when it ends in `/` (the user went into that folder), and
 * a search of the whole workspace otherwise.
 */
export async function findMentionCandidates(cwd: string, query: string, signal: AbortSignal): Promise<WorkspaceDirEntry[]> {
  if (query === "") return agent.listWorkspaceDir(cwd);
  if (query.endsWith("/")) return agent.listWorkspaceDir(cwd, query.slice(0, -1)).catch(() => []);
  return searchWorkspace(cwd, query, signal);
}

/** Run a workspace search, and cancel it on the backend if the query is abandoned. */
export async function searchWorkspace(cwd: string, needle: string, signal: AbortSignal): Promise<WorkspaceDirEntry[]> {
  const requestId = `workspace-search-${Date.now()}-${++searchSequence}`;
  const cancel = () => void agent.cancelWorkspaceSearch(requestId).catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await agent.searchWorkspaceFiles(cwd, needle, requestId);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
