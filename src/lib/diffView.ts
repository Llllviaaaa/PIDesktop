/**
 * Unified diff parsing, hunk segmentation, and per-file statistics for
 * Qianji's native review workbench and inline diff cards.
 */

export const OVERSIZED_DIFF_THRESHOLD = 800;

export interface DiffRow {
  kind: "hunk" | "add" | "del" | "ctx";
  oldLine?: number;
  newLine?: number;
  text: string;
}

export function parseDiffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        oldLine = parseInt(match[1] ?? "0", 10);
        newLine = parseInt(match[2] ?? "0", 10);
        inHunk = true;
      }
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk || line === "") continue;
    if (line.startsWith("+")) {
      rows.push({ kind: "add", newLine: newLine++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldLine: oldLine++, text: line.slice(1) });
    } else if (line.startsWith("\\")) {
      rows.push({ kind: "ctx", text: line });
    } else {
      rows.push({ kind: "ctx", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
    }
  }
  return rows;
}

export interface UnifiedDiffRow {
  readonly kind: "context" | "del" | "add" | "mod" | "meta";
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
}

export interface HunkSegment {
  readonly kind: "hunk";
  readonly rows: readonly UnifiedDiffRow[];
}

export interface FoldSegment {
  readonly kind: "fold";
  readonly rows?: readonly UnifiedDiffRow[];
  readonly count: number;
  readonly oldStart: number;
  readonly oldEnd: number;
  readonly newStart: number;
  readonly newEnd: number;
}

export type DiffSegment = HunkSegment | FoldSegment;

export interface ParsedDiffLine {
  kind: "ctx" | "del" | "add" | "meta";
  text: string;
  oldNum: number | null;
  newNum: number | null;
}

export interface ParsedDiffHunk {
  oldStart: number;
  newStart: number;
  header: string;
  lines: ParsedDiffLine[];
}

export interface ParsedDiffFile {
  oldPath: string;
  newPath: string;
  binary: boolean;
  hunks: ParsedDiffHunk[];
}

export interface ParsedDiff {
  files: ParsedDiffFile[];
}

const QUOTED_PATH = '"(?:[^"\\\\]|\\\\.)*"';
const C_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

const pathEncoder = new TextEncoder();
const pathDecoder = new TextDecoder();

export function decodeGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] ?? "";
    if (char !== "\\") {
      for (const byte of pathEncoder.encode(char)) bytes.push(byte);
      continue;
    }
    const escaped = body[i + 1];
    const simple = escaped === undefined ? undefined : C_ESCAPES[escaped];
    if (simple !== undefined) {
      bytes.push(simple);
      i += 1;
      continue;
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1));
    if (octal !== null && octal[0] !== undefined) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += octal[0].length;
      continue;
    }
    for (const byte of pathEncoder.encode(char)) bytes.push(byte);
  }
  return pathDecoder.decode(new Uint8Array(bytes));
}

function headerPath(raw: string): string {
  return decodeGitPath(raw.endsWith("\t") ? raw.slice(0, -1) : raw);
}

function parseHunkHeader(line: string): { oldStart: number; newStart: number; header: string } | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
  if (match === null) return null;
  return {
    oldStart: Number(match[1] ?? 0),
    newStart: Number(match[3] ?? 0),
    header: match[5] ?? "",
  };
}

function pathsFromGitHeader(rest: string): { oldPath: string; newPath: string } | null {
  const quoted = new RegExp(`^(${QUOTED_PATH}) (${QUOTED_PATH})$`).exec(rest);
  if (quoted !== null && quoted[1] !== undefined && quoted[2] !== undefined) {
    return { oldPath: decodeGitPath(quoted[1]), newPath: decodeGitPath(quoted[2]) };
  }
  for (let at = rest.indexOf(" b/"); at !== -1; at = rest.indexOf(" b/", at + 1)) {
    const oldPath = rest.slice(0, at);
    const newPath = rest.slice(at + 1);
    if (oldPath.startsWith("a/") && newPath.startsWith("b/") && oldPath.slice(2) === newPath.slice(2)) {
      return { oldPath, newPath };
    }
  }
  return null;
}

function pathsFromBinaryLine(raw: string): { oldPath: string; newPath: string } | null {
  const body = raw.slice("Binary files ".length).replace(/ differ$/, "");
  const quoted = new RegExp(`^(${QUOTED_PATH}) and (${QUOTED_PATH})$`).exec(body);
  if (quoted !== null && quoted[1] !== undefined && quoted[2] !== undefined) {
    return { oldPath: decodeGitPath(quoted[1]), newPath: decodeGitPath(quoted[2]) };
  }
  for (let at = body.indexOf(" and "); at !== -1; at = body.indexOf(" and ", at + 1)) {
    const oldPath = decodeGitPath(body.slice(0, at));
    const newPath = decodeGitPath(body.slice(at + " and ".length));
    const oldSide = oldPath === "/dev/null" || oldPath.startsWith("a/");
    const newSide = newPath === "/dev/null" || newPath.startsWith("b/");
    if (oldSide && newSide) return { oldPath, newPath };
  }
  return null;
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let inHunk = false;
  let hunk: ParsedDiffHunk | null = null;
  let oldNum = 0;
  let newNum = 0;

  const flushHunk = (): void => {
    if (current !== null && hunk !== null) current.hunks.push(hunk);
    hunk = null;
    inHunk = false;
  };

  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flushHunk();
      current = { oldPath: "", newPath: "", binary: false, hunks: [] };
      const headPaths = pathsFromGitHeader(raw.slice("diff --git ".length));
      if (headPaths !== null) {
        current.oldPath = headPaths.oldPath;
        current.newPath = headPaths.newPath;
      }
      files.push(current);
      continue;
    }
    if (current === null) continue;
    if (raw.startsWith("rename from ")) {
      current.oldPath = decodeGitPath(raw.slice("rename from ".length));
      continue;
    }
    if (raw.startsWith("rename to ")) {
      current.newPath = decodeGitPath(raw.slice("rename to ".length));
      continue;
    }
    if (raw.startsWith("Binary files ") || raw === "GIT binary patch") {
      flushHunk();
      current.binary = true;
      if (raw.startsWith("Binary files ")) {
        const binPaths = pathsFromBinaryLine(raw);
        if (binPaths !== null) {
          current.oldPath = binPaths.oldPath;
          current.newPath = binPaths.newPath;
        }
      }
      continue;
    }
    if (!inHunk && raw.startsWith("--- ")) {
      flushHunk();
      current.oldPath = headerPath(raw.slice(4));
      continue;
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      current.newPath = headerPath(raw.slice(4));
      continue;
    }
    const header = parseHunkHeader(raw);
    if (header !== null) {
      flushHunk();
      hunk = { oldStart: header.oldStart, newStart: header.newStart, header: header.header, lines: [] };
      oldNum = header.oldStart;
      newNum = header.newStart;
      inHunk = true;
      continue;
    }
    if (!inHunk || hunk === null) continue;
    const marker = raw[0];
    if (marker === "\\") {
      hunk.lines.push({ kind: "meta", text: raw.slice(1), oldNum: null, newNum: null });
      continue;
    }
    if (marker === " ") {
      hunk.lines.push({ kind: "ctx", text: raw.slice(1), oldNum, newNum });
      oldNum += 1;
      newNum += 1;
    } else if (marker === "-") {
      hunk.lines.push({ kind: "del", text: raw.slice(1), oldNum, newNum: null });
      oldNum += 1;
    } else if (marker === "+") {
      hunk.lines.push({ kind: "add", text: raw.slice(1), oldNum: null, newNum });
      newNum += 1;
    } else {
      flushHunk();
    }
  }
  flushHunk();
  return { files };
}

export function pairMods(rows: readonly UnifiedDiffRow[]): UnifiedDiffRow[] {
  const out = rows.slice();
  let k = 0;
  while (k < out.length) {
    const current = out[k];
    if (!current || current.kind !== "del") {
      k += 1;
      continue;
    }
    const delStart = k;
    while (k < out.length && out[k]?.kind === "del") k += 1;
    const addStart = k;
    while (k < out.length && out[k]?.kind === "add") k += 1;
    const pairs = Math.min(addStart - delStart, k - addStart);
    for (let p = 0; p < pairs; p += 1) {
      const delRow = out[delStart + p];
      const addRow = out[addStart + p];
      if (delRow) out[delStart + p] = { ...delRow, kind: "mod" };
      if (addRow) out[addStart + p] = { ...addRow, kind: "mod" };
    }
  }
  return out;
}

function rowOfLine(line: ParsedDiffLine): UnifiedDiffRow {
  if (line.kind === "meta") return { kind: "meta", text: line.text };
  const kind: UnifiedDiffRow["kind"] = line.kind === "ctx" ? "context" : line.kind;
  if (line.kind === "del") return { kind, oldLine: line.oldNum ?? undefined, text: line.text };
  if (line.kind === "add") return { kind, newLine: line.newNum ?? undefined, text: line.text };
  return { kind, oldLine: line.oldNum ?? undefined, newLine: line.newNum ?? undefined, text: line.text };
}

export function unifiedSegments(file: ParsedDiffFile): DiffSegment[] {
  const segments: DiffSegment[] = [];
  file.hunks.forEach((hunk, index) => {
    const rows = pairMods(hunk.lines.map(rowOfLine));
    const prev = index > 0 ? file.hunks[index - 1] : undefined;
    if (prev !== undefined) {
      const prevOldEnd = prev.oldStart + prev.lines.filter((line) => line.oldNum !== null).length - 1;
      const prevNewEnd = prev.newStart + prev.lines.filter((line) => line.newNum !== null).length - 1;
      const oldGap = hunk.oldStart - prevOldEnd - 1;
      const newGap = hunk.newStart - prevNewEnd - 1;
      if (oldGap > 0 || newGap > 0) {
        segments.push({
          kind: "fold",
          count: Math.max(oldGap, newGap, 0),
          oldStart: prevOldEnd + 1,
          oldEnd: Math.max(hunk.oldStart - 1, prevOldEnd),
          newStart: prevNewEnd + 1,
          newEnd: Math.max(hunk.newStart - 1, prevNewEnd),
        });
      }
    } else if (hunk.oldStart > 1 || hunk.newStart > 1) {
      segments.push({
        kind: "fold",
        count: Math.max(hunk.oldStart - 1, hunk.newStart - 1, 0),
        oldStart: 1,
        oldEnd: hunk.oldStart - 1,
        newStart: 1,
        newEnd: hunk.newStart - 1,
      });
    }
    segments.push({ kind: "hunk", rows });
  });
  return segments;
}

export function displayPath(path: string): string {
  if (path === "/dev/null") return path;
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

export function diffStats(segments: readonly DiffSegment[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const segment of segments) {
    if (segment.kind !== "hunk") continue;
    for (const row of segment.rows) {
      const onNewSide = row.kind === "add" || (row.kind === "mod" && row.newLine !== undefined);
      const onOldSide = row.kind === "del" || (row.kind === "mod" && row.oldLine !== undefined);
      if (onNewSide) added += 1;
      if (onOldSide) deleted += 1;
    }
  }
  return { added, deleted };
}
