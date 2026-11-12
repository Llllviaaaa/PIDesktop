import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition, ToolEnv, ToolOutput } from "@qianji/tools";
import { applyEdits, edit, find, globToRegExp, grep, ls, matchesGlob, read, write } from "../src/index.ts";

let cwd = "";
const env = (): ToolEnv => ({ sessionId: "s", cwd, signal: new AbortController().signal });

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pid-tool-fs-"));
  mkdirSync(join(cwd, "src", "deep"), { recursive: true });
  mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\nconst hidden = 'needle';\n");
  writeFileSync(join(cwd, "src", "deep", "b.test.ts"), "test('needle', () => {});\n");
  writeFileSync(join(cwd, "node_modules", "dep", "index.ts"), "needle\n");
  writeFileSync(join(cwd, "README.md"), "# Title\n");
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

async function call<A extends Record<string, unknown>>(tool: ToolDefinition<A>, args: A): Promise<{ text: string; isError: boolean }> {
  const output: ToolOutput = await tool.execute(args, env());
  return { text: output.content.map((block) => (block.type === "text" ? block.text : `[${block.mimeType}]`)).join("\n"), isError: output.isError === true };
}

describe("read", () => {
  it("reads a window of lines and says how to continue", async () => {
    writeFileSync(join(cwd, "long.txt"), Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
    expect((await call(read, { path: "long.txt", offset: 3, limit: 2 })).text).toBe("line 3\nline 4\n\n[Lines 3-4 of 10. Use offset=5 to read more.]");
    expect((await call(read, { path: "long.txt", offset: 20 })).isError).toBe(true);
    expect((await call(read, { path: "README.md" })).text).toBe("# Title\n");
  });

  it("returns images as image blocks", async () => {
    writeFileSync(join(cwd, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect((await call(read, { path: "pic.png" })).text).toBe("Image pic.png:\n[image/png]");
  });
});

describe("write and edit", () => {
  it("writes files, creating directories", async () => {
    expect((await call(write, { path: "new/dir/f.txt", content: "hi" })).text).toBe("Wrote 2 bytes to new/dir/f.txt.");
    expect(readFileSync(join(cwd, "new", "dir", "f.txt"), "utf8")).toBe("hi");
  });

  it("applies unique replacements all or nothing", async () => {
    const result = await call(edit, { path: "src/a.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }, { oldText: "'needle'", newText: "'pin'" }] });
    expect(result).toEqual({ text: "Applied 2 edit(s) to src/a.ts.", isError: false });
    expect(readFileSync(join(cwd, "src", "a.ts"), "utf8")).toBe("export const a = 2;\nconst hidden = 'pin';\n");

    const failed = await call(edit, { path: "src/a.ts", edits: [{ oldText: "a = 2", newText: "a = 3" }, { oldText: "absent", newText: "" }] });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("edits[1].oldText was not found");
    expect(readFileSync(join(cwd, "src", "a.ts"), "utf8")).toContain("a = 2");
  });

  it("explains ambiguous, overlapping and empty edits", () => {
    expect(() => applyEdits("x x", [{ oldText: "x", newText: "y" }])).toThrow("more than once");
    expect(() => applyEdits("abcdef", [{ oldText: "abc", newText: "" }, { oldText: "cde", newText: "" }])).toThrow("overlap");
    expect(() => applyEdits("abc", [{ oldText: "", newText: "z" }])).toThrow("empty");
  });

  it("keeps CRLF files CRLF", () => {
    expect(applyEdits("one\r\ntwo\r\n", [{ oldText: "one\ntwo", newText: "1\n2" }])).toBe("1\r\n2\r\n");
  });

  it("falls back to tolerating retyped quotes, dashes, spaces and trailing whitespace", () => {
    const fuzzy: number[] = [];
    // The file has curly quotes, an em dash, a no-break space and trailing spaces; the model typed plain ASCII.
    const original = "const a = \u201Chello\u201D;   \nconst b = 1 \u2014 2;\nconst c = 3\u00A0+ 4;\nkeep \u201Cthis\u201D\n";
    const updated = applyEdits(original, [
      { oldText: 'const a = "hello";\nconst b = 1 - 2;', newText: 'const a = "hi";\nconst b = 0;' },
      { oldText: "const c = 3 + 4;", newText: "const c = 7;" },
    ], fuzzy);
    expect(updated).toBe("const a = \"hi\";\nconst b = 0;\nconst c = 7;\nkeep \u201Cthis\u201D\n");
    expect(fuzzy).toEqual([0, 1]);

    // Exact matches never take the fallback.
    const exact: number[] = [];
    applyEdits("x = 1", [{ oldText: "x = 1", newText: "x = 2" }], exact);
    expect(exact).toEqual([]);
  });

  it("still requires a unique match and exact indentation when tolerating", () => {
    expect(() => applyEdits("a \u2014 b\na \u2013 b\n", [{ oldText: "a - b", newText: "c" }])).toThrow("more than once");
    expect(() => applyEdits("  if (x) {\n", [{ oldText: "    if (x) {", newText: "" }])).toThrow("was not found");
    expect(() => applyEdits("[a] (b) $c", [{ oldText: "[a] (b) $d", newText: "" }])).toThrow("was not found");
    expect(applyEdits("f(a[0], 'x')  \n", [{ oldText: "f(a[0], \u2018x\u2019)", newText: "g()" }])).toBe("g()  \n");
  });

  it("tells the model when an edit matched only after tolerating differences", async () => {
    writeFileSync(join(cwd, "src", "quotes.ts"), "say(\u201Chi\u201D);\n");
    const result = await call(edit, { path: "src/quotes.ts", edits: [{ oldText: 'say("hi");', newText: 'say("bye");' }] });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("edits[0] matched only after ignoring differences");
    expect(readFileSync(join(cwd, "src", "quotes.ts"), "utf8")).toBe('say("bye");\n');
  });
});

describe("ls, find and grep", () => {
  it("lists a directory with directories marked", async () => {
    expect((await call(ls, {})).text).toBe("node_modules/\nREADME.md\nsrc/");
  });

  it("finds files by glob, skipping node_modules", async () => {
    expect((await call(find, { pattern: "*.ts" })).text).toBe("src/a.ts\nsrc/deep/b.test.ts");
    expect((await call(find, { pattern: "src/**/*.test.ts" })).text).toBe("src/deep/b.test.ts");
    expect((await call(find, { pattern: "*.{md,txt}" })).text).toBe("README.md");
    expect((await call(find, { pattern: "*.rs" })).text).toBe("No files found.");
  });

  it("matches globs the way the descriptions say", () => {
    expect(globToRegExp("src/**/x.ts").test("src/x.ts")).toBe(true);
    expect(globToRegExp("src/**/x.ts").test("src/a/b/x.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("a/b.ts")).toBe(false);
    expect(matchesGlob("*.ts", "a/b.ts")).toBe(true);
  });

  it("greps contents with paths and line numbers", async () => {
    expect((await call(grep, { pattern: "needle" })).text).toBe("src/a.ts:2: const hidden = 'needle';\nsrc/deep/b.test.ts:1: test('needle', () => {});");
    expect((await call(grep, { pattern: "NEEDLE", ignoreCase: true, glob: "*.test.ts" })).text).toBe("src/deep/b.test.ts:1: test('needle', () => {});");
    expect((await call(grep, { pattern: "(", literal: true, path: "src/deep/b.test.ts" })).text).toBe("b.test.ts:1: test('needle', () => {});");
    expect((await call(grep, { pattern: "needle", limit: 1 })).text).toContain("[Stopped at 1 matches");
    expect((await call(grep, { pattern: "(" })).isError).toBe(true);
  });
});
