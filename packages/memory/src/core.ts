/**
 * Taken from the Pi engine's pidesktop-memory-core.ts, extended with dual-layer
 * scopes (`user` / `project`) and unified diff generation for write approvals.
 */
export type MemoryWriteAction = "append" | "replace" | "clear";
export type MemoryScope = "user" | "project";

export function nextMemoryContent(current: string, action: MemoryWriteAction, content?: string): string {
  if (action === "clear") return "";
  const value = content?.trim();
  if (!value) throw new Error(`content is required for ${action}`);
  return action === "append" && current.trim()
    ? `${current.trimEnd()}\n\n${value}\n`
    : `${value}\n`;
}

function toLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized === "") return [];
  const parts = normalized.split("\n");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/** Build a fenced `diff` preview comparing `before` and `after` Markdown content. */
export function buildMemoryDiff(before: string, after: string, label = "memory.md"): string {
  const oldLines = toLines(before);
  const newLines = toLines(after);
  const out: string[] = [`--- a/${label}`, `+++ b/${label}`];

  if (oldLines.length + newLines.length <= 240) {
    const m = oldLines.length;
    const n = newLines.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i -= 1) {
      const row = dp[i] as number[];
      const nextRow = dp[i + 1] as number[];
      for (let j = n - 1; j >= 0; j -= 1) {
        row[j] = oldLines[i] === newLines[j]
          ? (nextRow[j + 1] ?? 0) + 1
          : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
      }
    }
    const rawOps: Array<{ kind: " " | "-" | "+"; text: string }> = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (oldLines[i] === newLines[j]) {
        rawOps.push({ kind: " ", text: oldLines[i] as string });
        i += 1;
        j += 1;
      } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
        rawOps.push({ kind: "-", text: oldLines[i] as string });
        i += 1;
      } else {
        rawOps.push({ kind: "+", text: newLines[j] as string });
        j += 1;
      }
    }
    while (i < m) {
      rawOps.push({ kind: "-", text: oldLines[i] as string });
      i += 1;
    }
    while (j < n) {
      rawOps.push({ kind: "+", text: newLines[j] as string });
      j += 1;
    }

    // Collapse long runs of unchanged context lines so large memories stay readable.
    let idx = 0;
    while (idx < rawOps.length) {
      const op = rawOps[idx];
      if (op?.kind !== " ") {
        if (op !== undefined) out.push(`${op.kind}${op.text}`);
        idx += 1;
        continue;
      }
      let end = idx;
      while (end < rawOps.length && rawOps[end]?.kind === " ") end += 1;
      const runLen = end - idx;
      if (runLen <= 4) {
        for (let k = idx; k < end; k += 1) out.push(` ${rawOps[k]?.text ?? ""}`);
      } else {
        if (idx > 0) {
          out.push(` ${rawOps[idx]?.text ?? ""}`);
          out.push(` ${rawOps[idx + 1]?.text ?? ""}`);
        }
        out.push("@@ ... @@");
        if (end < rawOps.length) {
          out.push(` ${rawOps[end - 2]?.text ?? ""}`);
          out.push(` ${rawOps[end - 1]?.text ?? ""}`);
        }
      }
      idx = end;
    }
  } else {
    for (const line of oldLines.slice(0, 40)) out.push(`-${line}`);
    if (oldLines.length > 40) out.push(`-... (${oldLines.length - 40} more lines)`);
    for (const line of newLines.slice(0, 40)) out.push(`+${line}`);
    if (newLines.length > 40) out.push(`+... (${newLines.length - 40} more lines)`);
  }

  return ["```diff", ...out, "```"].join("\n");
}
