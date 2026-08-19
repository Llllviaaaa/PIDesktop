/** Parse unified diffs for per-file and aggregate +/- line counts (UI chrome). */

export interface FileLineStats {
  path: string;
  additions: number;
  deletions: number;
}

export function aggregateDiffStats(diff: string | undefined | null): { add: number; del: number } {
  let add = 0;
  let del = 0;
  if (!diff) return { add, del };
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) del += 1;
  }
  return { add, del };
}

export function perFileDiffStats(diff: string | undefined | null): Map<string, { add: number; del: number }> {
  const result = new Map<string, { add: number; del: number }>();
  if (!diff) return result;
  let current: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      if (raw === "/dev/null") continue;
      current = raw.replace(/^[ab]\//, "");
      if (!result.has(current)) result.set(current, { add: 0, del: 0 });
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (!current) continue;
    const stats = result.get(current);
    if (!stats) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) stats.add += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) stats.del += 1;
  }
  return result;
}
