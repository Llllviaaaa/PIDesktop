import { readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Output caps shared by the tools, so one call cannot flood the context. */
export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;
export const MAX_LINE_CHARS = 500;

/** Resolve a path the model gave against the session's cwd; `~` is the home directory. */
export function resolvePath(cwd: string, path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** A path relative to `base`, with forward slashes. */
export function displayPath(base: string, path: string): string {
  const rel = relative(base, path);
  return (rel === "" ? "." : rel).split(sep).join("/");
}

/** Directories never worth walking into. */
export const SKIPPED_DIRS = new Set([".git", "node_modules", ".hg", ".svn"]);

/** Every file under `root`, depth first, skipping `SKIPPED_DIRS`. */
export function* walkFiles(root: string, signal?: AbortSignal): Generator<string> {
  const stack = [root];
  while (stack.length > 0) {
    if (signal?.aborted) return;
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs: string[] = [];
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) subdirs.push(path);
      } else if (entry.isFile()) {
        yield path;
      }
    }
    stack.push(...subdirs.reverse());
  }
}

/**
 * A glob as a regular expression over `/`-separated relative paths:
 * `**` any depth, `*` and `?` within a segment, `{a,b}` alternatives.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      const close = glob.indexOf("}", index);
      if (close < 0) {
        source += "\\{";
      } else {
        source += `(?:${glob.slice(index + 1, close).split(",").map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
        index = close;
      }
    } else {
      source += char.replace(/[.+^$()|[\]\\}]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, process.platform === "win32" ? "i" : "");
}

/** Whether `relPath` matches `glob`; a glob without `/` matches the file name at any depth. */
export function matchesGlob(glob: string, relPath: string): boolean {
  const pattern = globToRegExp(glob);
  if (glob.includes("/")) return pattern.test(relPath);
  return pattern.test(relPath.slice(relPath.lastIndexOf("/") + 1));
}

export interface Truncated {
  text: string;
  truncated: boolean;
}

/** Keep the head of `text` within the line and byte caps. */
export function truncateHead(text: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): Truncated {
  const lines = text.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1;
    if (kept.length >= maxLines || bytes + size > maxBytes) return { text: kept.join("\n"), truncated: true };
    kept.push(line);
    bytes += size;
  }
  return { text: kept.join("\n"), truncated: false };
}

export function clipLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line clipped]` : line;
}
