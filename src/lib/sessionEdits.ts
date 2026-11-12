/**
 * Which of the workspace's uncommitted changes the current session made: the
 * conversation's change card lists and undoes only those, not edits the user
 * or another session left in the same checkout.
 */
import type { GitFileChange, UiMessage } from "../types";
import { classifyToolKind, toolPathFromArgs } from "./toolPresentation";

const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

const EMPTY_PATHS: readonly string[] = [];
const messageEditedPathsCache = new WeakMap<UiMessage, readonly string[]>();
const arrayEditedPathsCache = new WeakMap<readonly UiMessage[], string[]>();

function editedPathsForMessage(message: UiMessage): readonly string[] {
  const cached = messageEditedPathsCache.get(message);
  if (cached) return cached;
  const calls = message.toolCalls;
  if (!calls || calls.length === 0) {
    messageEditedPathsCache.set(message, EMPTY_PATHS);
    return EMPTY_PATHS;
  }
  const found: string[] = [];
  for (const call of calls) {
    if (call.isError || call.running) continue;
    const kind = classifyToolKind(call.name);
    if (kind !== "edit" && kind !== "write") continue;
    const path = toolPathFromArgs(call.args);
    if (path) found.push(path);
  }
  const result = found.length > 0 ? found : EMPTY_PATHS;
  messageEditedPathsCache.set(message, result);
  return result;
}

/** The paths this session's successful edit and write tool calls wrote, as the tools were given them. */
export function sessionEditedPaths(messages: readonly UiMessage[]): string[] {
  const cached = arrayEditedPathsCache.get(messages);
  if (cached) return cached;
  const paths = new Set<string>();
  for (const message of messages) {
    const perMessage = editedPathsForMessage(message);
    for (const path of perMessage) {
      paths.add(path);
    }
  }
  const result = [...paths];
  arrayEditedPathsCache.set(messages, result);
  return result;
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
