import assert from "node:assert/strict";
import { aggregateDiffStats, perFileDiffStats } from "../src/lib/gitDiffStats.ts";

const sample = `# Staged changes
diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,4 @@
 keep
-old
+new
+extra
diff --git a/bar.md b/bar.md
--- a/bar.md
+++ b/bar.md
@@ -1,2 +1,1 @@
-line
 keep
`;

const agg = aggregateDiffStats(sample);
assert.equal(agg.add, 2);
assert.equal(agg.del, 2);

const files = perFileDiffStats(sample);
assert.equal(files.get("foo.ts")?.add, 2);
assert.equal(files.get("foo.ts")?.del, 1);
assert.equal(files.get("bar.md")?.add, 0);
assert.equal(files.get("bar.md")?.del, 1);

console.log("test-git-diff-stats: ok");
