import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  buildFilePatch,
  buildHunkPatch,
  hunkActions,
  hunksForPath,
  resolveHunkOrigin,
  splitUnifiedDiff,
} from "../src/lib/diffHunks.ts";

const COMBINED = `# Staged changes
diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 keep
-old
+staged
 tail

# Working tree changes
diff --git a/src/app.ts b/src/app.ts
index 2222222..3333333 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,2 +10,3 @@ function main() {
 ten
+working
 eleven
diff --git a/docs/new.md b/docs/new.md
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1 @@
+hello
\\ No newline at end of file
`;

test("splits the combined snapshot into files, hunks and origins", () => {
  const files = splitUnifiedDiff(COMBINED);
  assert.deepEqual(files.map((file) => [file.path, file.origin, file.hunks.length]), [
    ["src/app.ts", "staged", 1],
    ["src/app.ts", "unstaged", 1],
    ["docs/new.md", "unstaged", 1],
  ]);
  assert.equal(files[0].header.length, 4);
  // The blank separator between sections is not part of the staged hunk.
  assert.deepEqual(files[0].hunks[0].lines, [" keep", "-old", "+staged", " tail"]);
  assert.deepEqual(files[2].hunks[0].lines, ["+hello", "\\ No newline at end of file"]);
});

test("gathers a path's hunks in diff order with display rows", () => {
  const hunks = hunksForPath(splitUnifiedDiff(COMBINED), "src\\app.ts");
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks.map((item) => item.hunk.origin), ["staged", "unstaged"]);
  assert.equal(hunks[1].rows[0].kind, "hunk");
  assert.deepEqual(hunks[1].rows.find((row) => row.kind === "add"), { kind: "add", newLine: 11, text: "working" });
});

test("rebuilds patches that carry the file header", () => {
  const [staged, , created] = splitUnifiedDiff(COMBINED);
  assert.equal(
    buildHunkPatch(staged, staged.hunks[0]),
    "diff --git a/src/app.ts b/src/app.ts\nindex 1111111..2222222 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,3 @@\n keep\n-old\n+staged\n tail\n",
  );
  assert.ok(buildFilePatch(created).startsWith("diff --git a/docs/new.md b/docs/new.md\nnew file mode 100644"));
  assert.equal(splitUnifiedDiff(COMBINED)[2].path, "docs/new.md");
});

test("decodes the quoted paths Git prints for CJK file names", () => {
  const diff = [
    'diff --git "a/docs/\\344\\271\\246\\347\\255\\276.md" "b/docs/\\344\\271\\246\\347\\255\\276.md"',
    "index 1111111..2222222 100644",
    '--- "a/docs/\\344\\271\\246\\347\\255\\276.md"',
    '+++ "b/docs/\\344\\271\\246\\347\\255\\276.md"',
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  const [file] = splitUnifiedDiff(diff);
  assert.equal(file.path, "docs/书签.md");
  assert.equal(hunksForPath([file], '"docs/\\344\\271\\246\\347\\255\\276.md"').length, 1);
  assert.equal(hunksForPath([file], "docs/书签.md").length, 1);
});

test("resolves origins and actions", () => {
  assert.equal(resolveHunkOrigin(null, { staged: true, unstaged: false, untracked: false }), "staged");
  assert.equal(resolveHunkOrigin(null, { staged: false, unstaged: true, untracked: false }), "unstaged");
  assert.equal(resolveHunkOrigin(null, { staged: true, unstaged: true, untracked: false }), null);
  assert.equal(resolveHunkOrigin(null, { staged: false, unstaged: true, untracked: true }), null);
  assert.equal(resolveHunkOrigin("worktree"), "worktree");
  assert.deepEqual(hunkActions("unstaged"), { stage: true, unstage: false, discard: true });
  assert.deepEqual(hunkActions("staged"), { stage: false, unstage: true, discard: false });
  assert.deepEqual(hunkActions("worktree"), { stage: false, unstage: false, discard: true });
  assert.deepEqual(hunkActions(null), { stage: false, unstage: false, discard: false });
});

test("a rebuilt hunk patch stages exactly that hunk with git apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidesktop-hunk-test-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  try {
    git("init");
    git("config", "user.name", "PIDesktop Test");
    git("config", "user.email", "test@pidesktop.local");
    git("config", "core.autocrlf", "false");
    const original = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    await writeFile(join(root, "notes.txt"), original);
    git("add", "notes.txt");
    git("commit", "-m", "initial");
    await writeFile(join(root, "notes.txt"), original.replace("line 2\n", "line two\n").replace("line 28\n", "line 28!\n"));

    const [file] = splitUnifiedDiff(git("diff", "--no-ext-diff", "--unified=3"), "unstaged");
    assert.equal(file.hunks.length, 2);
    execFileSync("git", ["apply", "--cached", "-"], { cwd: root, input: buildHunkPatch(file, file.hunks[1]), windowsHide: true });
    const staged = git("diff", "--cached");
    assert.match(staged, /\+line 28!/);
    assert.doesNotMatch(staged, /line two/);

    execFileSync("git", ["apply", "--reverse", "-"], { cwd: root, input: buildHunkPatch(file, file.hunks[0]), windowsHide: true });
    assert.match(await readFile(join(root, "notes.txt"), "utf8"), /^line 1\nline 2\n/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
