/** Parse a single-file unified diff into structured rows for the changes panel. */

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
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
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
