/**
 * Line-at-a-time syntax highlighting for diffs and the file preview.
 *
 * Highlighting line by line keeps each row independent (diff rows are not
 * contiguous source), at the cost of multi-line constructs such as block
 * comments, which render as plain text past their first line.
 */
import hljs from "highlight.js/lib/common";

function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

export function languageForPath(path: string): string | null {
  const extension = fileName(path).split(".").pop()?.toLowerCase();
  const languages: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    rs: "rust", css: "css", scss: "scss", less: "less", html: "xml", htm: "xml", xml: "xml", vue: "xml", svelte: "xml",
    json: "json", jsonc: "json", py: "python", sh: "bash", bash: "bash", ps1: "powershell",
    md: "markdown", markdown: "markdown", yaml: "yaml", yml: "yaml", sql: "sql", toml: "ini",
    go: "go", java: "java", kt: "kotlin", cs: "csharp", cpp: "cpp", cc: "cpp", c: "c", h: "c", hpp: "cpp",
    rb: "ruby", php: "php", swift: "swift",
  };
  return extension ? languages[extension] ?? null : null;
}

export function highlightLine(text: string, path: string): string {
  const language = languageForPath(path);
  if (!language || !hljs.getLanguage(language)) return escapeHtml(text);
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
