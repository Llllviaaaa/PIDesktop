import { pi } from "./pi";
import type { WorkspaceDirEntry } from "../types";

let searchSequence = 0;

/** Run a workspace search, and cancel it on the backend if the query is abandoned. */
export async function searchWorkspace(cwd: string, needle: string, signal: AbortSignal): Promise<WorkspaceDirEntry[]> {
  const requestId = `workspace-search-${Date.now()}-${++searchSequence}`;
  const cancel = () => void pi.cancelWorkspaceSearch(requestId).catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await pi.searchWorkspaceFiles(cwd, needle, requestId);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
