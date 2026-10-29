/**
 * Built-in file tools: read, write, edit, ls, find, grep. Paths resolve
 * against the session's cwd; output is capped so one call cannot flood the
 * context. Permission checks are not done here but in `tools/pre-execute`
 * listeners (P4).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { textOutput, type ToolDefinition } from "@pid/tools";
import {
  MAX_BYTES,
  MAX_LINES,
  clipLine,
  displayPath,
  matchesGlob,
  resolvePath,
  truncateHead,
  walkFiles,
} from "./shared.ts";

export * from "./shared.ts";

export const name = "pid-tool-fs";
export const inject = ["tools"];

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_ENTRIES = 500;
const MAX_FIND_RESULTS = 1000;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;

export const read: ToolDefinition<{ path: string; offset?: number; limit?: number }> = {
  name: "read",
  description: `Read a file. Text is returned from line \`offset\` (1-based) for at most \`limit\` lines, capped at ${MAX_LINES} lines or ${MAX_BYTES / 1024} KB; images (png, jpg, gif, webp) are returned as images.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory or absolute" },
      offset: { type: "integer", description: "First line to read, 1-based" },
      limit: { type: "integer", description: "Maximum number of lines" },
    },
    required: ["path"],
  },
  execute({ path, offset, limit }, env) {
    const file = resolvePath(env.cwd, path);
    const mimeType = IMAGE_TYPES[extname(file).toLowerCase()];
    if (mimeType !== undefined) {
      return { content: [{ type: "text", text: `Image ${path}:` }, { type: "image", mimeType, data: readFileSync(file).toString("base64") }] };
    }
    const lines = readFileSync(file, "utf8").split("\n");
    const start = Math.max(1, offset ?? 1);
    if (start > lines.length) return textOutput(`${path} has ${lines.length} lines; offset ${start} is past the end.`, true);
    const wanted = lines.slice(start - 1, limit === undefined ? undefined : start - 1 + Math.max(1, limit));
    const { text, truncated } = truncateHead(wanted.join("\n"));
    const shown = text === "" ? 0 : text.split("\n").length;
    const end = start + shown - 1;
    const more = end < lines.length;
    const note = truncated || more ? `\n\n[Lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to read more.]` : "";
    return textOutput(text + note);
  },
};

export const write: ToolDefinition<{ path: string; content: string }> = {
  name: "write",
  description: "Create or overwrite a file with `content`, creating parent directories as needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory or absolute" },
      content: { type: "string", description: "The complete new file content" },
    },
    required: ["path", "content"],
  },
  execute({ path, content }, env) {
    const file = resolvePath(env.cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return textOutput(`Wrote ${Buffer.byteLength(content)} bytes to ${path}.`);
  },
};

interface Edit {
  oldText: string;
  newText: string;
}

/** Apply exact, unique replacements; throws with the reason the model needs to fix its call. */
export function applyEdits(original: string, edits: readonly Edit[]): string {
  const crlf = original.includes("\r\n");
  const toFile = (text: string) => (crlf && !text.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text);
  const spans: Array<{ start: number; end: number; text: string; index: number }> = [];
  edits.forEach((edit, index) => {
    const oldText = toFile(edit.oldText);
    if (oldText === "") throw new Error(`edits[${index}].oldText is empty`);
    const start = original.indexOf(oldText);
    if (start < 0) throw new Error(`edits[${index}].oldText was not found; read the file and copy the text exactly`);
    if (original.indexOf(oldText, start + 1) >= 0) throw new Error(`edits[${index}].oldText occurs more than once; include more surrounding lines`);
    spans.push({ start, end: start + oldText.length, text: toFile(edit.newText), index });
  });
  spans.sort((a, b) => a.start - b.start);
  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1];
    const current = spans[index];
    if (previous !== undefined && current !== undefined && current.start < previous.end) {
      throw new Error(`edits[${previous.index}] and edits[${current.index}] overlap`);
    }
  }
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += original.slice(cursor, span.start) + span.text;
    cursor = span.end;
  }
  return result + original.slice(cursor);
}

export const edit: ToolDefinition<{ path: string; edits: Edit[] }> = {
  name: "edit",
  description: "Edit a file by exact text replacement. Each `oldText` must appear exactly once in the current file; all edits apply together or none do.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory or absolute" },
      edits: {
        type: "array",
        description: "Replacements to make",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", description: "Exact text to replace, unique in the file" },
            newText: { type: "string", description: "Replacement text" },
          },
          required: ["oldText", "newText"],
        },
      },
    },
    required: ["path", "edits"],
  },
  execute({ path, edits }, env) {
    const file = resolvePath(env.cwd, path);
    if (!existsSync(file)) return textOutput(`${path} does not exist; use write to create it.`, true);
    if (edits.some((item) => typeof item?.oldText !== "string" || typeof item?.newText !== "string")) {
      return textOutput("Each edit needs oldText and newText strings.", true);
    }
    const original = readFileSync(file, "utf8");
    let updated: string;
    try {
      updated = applyEdits(original, edits);
    } catch (error) {
      return textOutput(`No changes made to ${path}: ${(error as Error).message}.`, true);
    }
    writeFileSync(file, updated);
    return textOutput(`Applied ${edits.length} edit(s) to ${path}.`);
  },
};

export const ls: ToolDefinition<{ path?: string }> = {
  name: "ls",
  description: `List a directory (default: the working directory). Directories end with "/". At most ${MAX_ENTRIES} entries.`,
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Directory path" } },
  },
  execute({ path }, env) {
    const dir = resolvePath(env.cwd, path ?? ".");
    const entries = readdirSync(dir, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => a.localeCompare(b));
    if (entries.length === 0) return textOutput("(empty directory)");
    const note = entries.length > MAX_ENTRIES ? `\n[${entries.length - MAX_ENTRIES} more entries not shown]` : "";
    return textOutput(entries.slice(0, MAX_ENTRIES).join("\n") + note);
  },
};

export const find: ToolDefinition<{ pattern: string; path?: string }> = {
  name: "find",
  description: `Find files by glob, e.g. "*.ts" (any depth) or "src/**/*.test.ts". Skips .git and node_modules. At most ${MAX_FIND_RESULTS} paths.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob; without a '/' it matches file names at any depth" },
      path: { type: "string", description: "Directory to search (default: the working directory)" },
    },
    required: ["pattern"],
  },
  execute({ pattern, path }, env) {
    const root = resolvePath(env.cwd, path ?? ".");
    const found: string[] = [];
    let more = false;
    for (const file of walkFiles(root, env.signal)) {
      const rel = displayPath(root, file);
      if (!matchesGlob(pattern, rel)) continue;
      if (found.length >= MAX_FIND_RESULTS) {
        more = true;
        break;
      }
      found.push(rel);
    }
    if (found.length === 0) return textOutput("No files found.");
    found.sort((a, b) => a.localeCompare(b));
    return textOutput(found.join("\n") + (more ? `\n[More than ${MAX_FIND_RESULTS} files; narrow the pattern.]` : ""));
  },
};

export const grep: ToolDefinition<{ pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; limit?: number }> = {
  name: "grep",
  description: `Search file contents for a regular expression (or literal text). Prints "path:line: text". Skips .git, node_modules and binary files. At most ${MAX_GREP_MATCHES} matches unless \`limit\` says otherwise.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression, or text when literal is true" },
      path: { type: "string", description: "File or directory to search (default: the working directory)" },
      glob: { type: "string", description: "Only search files matching this glob, e.g. \"*.ts\"" },
      ignoreCase: { type: "boolean" },
      literal: { type: "boolean" },
      limit: { type: "integer", description: "Maximum matches" },
    },
    required: ["pattern"],
  },
  execute({ pattern, path, glob, ignoreCase, literal, limit }, env) {
    let regex: RegExp;
    try {
      regex = new RegExp(literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, ignoreCase ? "i" : "");
    } catch (error) {
      return textOutput(`Invalid pattern: ${(error as Error).message}`, true);
    }
    const target = resolvePath(env.cwd, path ?? ".");
    const single = statSync(target).isFile();
    const base = single ? dirname(target) : target;
    const files = single ? [target] : walkFiles(target, env.signal);
    const max = Math.max(1, limit ?? MAX_GREP_MATCHES);
    const matches: string[] = [];
    let more = false;
    outer: for (const file of files) {
      const rel = displayPath(base, file);
      if (glob !== undefined && !matchesGlob(glob, rel)) continue;
      let buffer: Buffer;
      try {
        if (statSync(file).size > MAX_GREP_FILE_BYTES) continue;
        buffer = readFileSync(file);
      } catch {
        continue;
      }
      if (buffer.subarray(0, 8192).includes(0)) continue;
      const lines = buffer.toString("utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] as string).replace(/\r$/, "");
        if (!regex.test(line)) continue;
        if (matches.length >= max) {
          more = true;
          break outer;
        }
        matches.push(`${rel}:${index + 1}: ${clipLine(line)}`);
      }
    }
    if (matches.length === 0) return textOutput("No matches.");
    return textOutput(matches.join("\n") + (more ? `\n[Stopped at ${max} matches; narrow the search.]` : ""));
  },
};

export const FS_TOOLS = [read, write, edit, ls, find, grep] as const;

export function apply(ctx: Context): void {
  for (const tool of FS_TOOLS) ctx.effect(() => ctx.tools.register(tool), `${name}: ${tool.name}`);
}
