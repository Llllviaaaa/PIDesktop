/**
 * Which of the workspace's uncommitted changes the current session made: the
 * conversation's change card lists and undoes only those, not edits the user
 * or another session left in the same checkout.
 */
import type { GitFileChange, UiMessage } from "../types";
import { classifyToolKind, toolPathFromArgs } from "./toolPresentation";

const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

/** The paths this session's successful edit and write tool calls wrote, as the tools were given them. */
export function sessionEditedPaths(messages: readonly UiMessage[]): string[] {
  const paths = new Set<string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.isError || call.running) continue;
      const kind = classifyToolKind(call.name);
      if (kind !== "edit" && kind !== "write") continue;
      const path = toolPathFromArgs(call.args);
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

/**
 * The changes among `files` that one of `editedPaths` names. Git reports paths
 * relative to the repository, while tools may get absolute or relative ones,
 * so an edited path matches a change when it is that path or ends with it.
 */
export function changesEditedBy(files: readonly GitFileChange[], editedPaths: readonly string[]): GitFileChange[] {
  if (editedPaths.length === 0) return [];
  const edited = editedPaths.map(normalize);
  return files.filter((file) => {
    const path = normalize(file.path);
    return edited.some((candidate) => candidate === path || candidate.endsWith(`/${path}`));
  });
}
