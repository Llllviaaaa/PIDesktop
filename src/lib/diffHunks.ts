/**
 * Splits unified diffs into files and hunks, and rebuilds single-hunk patches
 * that `git apply` accepts. The review pane uses this to stage, unstage and
 * discard one hunk at a time.
 */
import { parseDiffRows, type DiffRow } from "./diffView";

/** Where a hunk lives, which decides the Git actions it offers. */
export type HunkOrigin =
  /** In the index (`git diff --cached`): it can be unstaged. */
  | "staged"
  /** Between index and working tree (`git diff`): it can be staged or discarded. */
  | "unstaged"
  /** Between a turn checkpoint and the working tree: it can be discarded. */
  | "worktree";

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@` line. */
  header: string;
  /** Raw body lines, prefixes included (` `, `+`, `-`, `\`). */
  lines: string[];
  origin: HunkOrigin | null;
}

export interface DiffFilePatch {
  path: string;
  /** `diff --git`, mode, index, `---` and `+++` lines. */
  header: string[];
  hunks: DiffHunk[];
  origin: HunkOrigin | null;
}

/** Marker lines the combined uncommitted snapshot inserts between its two diffs. */
const STAGED_MARKER = "# Staged changes";
const WORKING_MARKER = "# Working tree changes";

const C_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", a: "\x07", b: "\b", f: "\f", v: "\v" };

/**
 * Git quotes paths it considers unusual. With the default core.quotePath that
 * includes every CJK file name: `"src/\346\226\207.ts"`. Decode them so a diff
 * header and a status line name the same file.
 */
export function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;
  const body = path.slice(1, -1);
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(index + 1))?.[0];
    if (octal) {
      bytes.push(parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    const next = body[index + 1] ?? "";
    bytes.push(...encoder.encode(C_ESCAPES[next] ?? next));
    index += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function normalizeDiffPath(path: string): string {
  return unquoteGitPath(path.trim()).replace(/\\/g, "/").replace(/^\.\//, "");
}

function pathFromHeader(header: string[]): string {
  const plus = header.find((line) => line.startsWith("+++ "));
  const minus = header.find((line) => line.startsWith("--- "));
  const pick = (line: string | undefined) => {
    if (!line) return null;
    const raw = unquoteGitPath(line.slice(4).replace(/\t.*$/, "").trim());
    if (raw === "/dev/null") return null;
    return raw.replace(/^[ab]\//, "");
  };
  const fromMarkers = pick(plus) ?? pick(minus);
  if (fromMarkers) return normalizeDiffPath(fromMarkers);
  // Binary or mode-only changes have no ---/+++ lines; fall back to `diff --git a/x b/x`.
  const match = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(header[0] ?? "");
  return normalizeDiffPath(match?.[2] ?? match?.[1] ?? "");
}

/**
 * Parse a unified diff (possibly the combined staged + working snapshot) into
 * files. The same path can appear twice when it has staged and unstaged edits.
 */
export function splitUnifiedDiff(diff: string, defaultOrigin: HunkOrigin | null = null): DiffFilePatch[] {
  const files: DiffFilePatch[] = [];
  let section: HunkOrigin | null = defaultOrigin;
  let current: DiffFilePatch | null = null;
  let hunk: DiffHunk | null = null;

  const finishFile = () => {
    if (current) {
      current.path = pathFromHeader(current.header);
      files.push(current);
    }
    current = null;
    hunk = null;
  };

  const lines = diff.split("\n");
  // A trailing newline leaves one empty string that is not a diff line.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  for (const line of lines) {
    if (line === STAGED_MARKER || line === WORKING_MARKER) {
      finishFile();
      section = line === STAGED_MARKER ? "staged" : "unstaged";
      continue;
    }
    if (line.startsWith("diff --git ")) {
      finishFile();
      current = { path: "", header: [line], hunks: [], origin: section };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("@@")) {
      hunk = { header: line, lines: [], origin: section };
      (current as DiffFilePatch).hunks.push(hunk);
      continue;
    }
    if (hunk) {
      // The combined snapshot separates its two halves with a blank line.
      if (line === "") continue;
      (hunk as DiffHunk).lines.push(line);
    } else {
      (current as DiffFilePatch).header.push(line);
    }
  }
  finishFile();
  return files;
}

/** A patch that applies exactly one hunk of `file`. */
export function buildHunkPatch(file: DiffFilePatch, hunk: DiffHunk): string {
  return `${[...file.header, hunk.header, ...hunk.lines].join("\n")}\n`;
}

/** A patch with every hunk of `file` (used to discard a whole file's turn changes). */
export function buildFilePatch(file: DiffFilePatch): string {
  return `${[...file.header, ...file.hunks.flatMap((hunk) => [hunk.header, ...hunk.lines])].join("\n")}\n`;
}

export interface HunkRows {
  hunk: DiffHunk;
  file: DiffFilePatch;
  rows: DiffRow[];
}

/** Every hunk of `path`, in diff order, with display rows parsed from it. */
export function hunksForPath(files: DiffFilePatch[], path: string): HunkRows[] {
  const target = normalizeDiffPath(path).toLowerCase();
  return files
    .filter((file) => file.path.toLowerCase() === target)
    .flatMap((file) => file.hunks.map((hunk) => ({
      hunk,
      file,
      rows: parseDiffRows([hunk.header, ...hunk.lines].join("\n")),
    })));
}

/**
 * The uncommitted snapshot only carries section markers when both the staged
 * and the working diff are non-empty. Without them, a file's own index and
 * worktree flags say which side its hunks came from.
 */
export function resolveHunkOrigin(
  origin: HunkOrigin | null,
  change?: { staged?: boolean; unstaged?: boolean; untracked?: boolean },
): HunkOrigin | null {
  if (origin) return origin;
  if (!change || change.untracked) return null;
  if (change.staged && !change.unstaged) return "staged";
  if (change.unstaged && !change.staged) return "unstaged";
  return null;
}

/**
 * Which Git actions a hunk supports in a given review scope.
 * Branch and commit views are history, so they offer none.
 */
export function hunkActions(origin: HunkOrigin | null): { stage: boolean; unstage: boolean; discard: boolean } {
  return {
    stage: origin === "unstaged",
    unstage: origin === "staged",
    discard: origin === "unstaged" || origin === "worktree",
  };
}
