import { describe, expect, it } from "vitest";
import { parsePullRequestDraft } from "../src/lib/gitClient";
import { OVERSIZED_DIFF_THRESHOLD } from "../src/better-sidebar/client/diff/DiffFiles";
import { diffStats, displayPath, parseUnifiedDiff, unifiedSegments } from "../src/better-sidebar/client/diff/rows";

describe("M4 PR draft parser and review special file detection", () => {
  it("parses raw JSON, fenced JSON, and Markdown fallbacks for PR drafts", () => {
    expect(
      parsePullRequestDraft(
        '{"title": "feat: add PR creation dialog", "body": "## 改动摘要\\n- 支持 gh pr create"}',
        "feat/pr",
      ),
    ).toEqual({
      title: "feat: add PR creation dialog",
      body: "## 改动摘要\n- 支持 gh pr create",
    });

    expect(
      parsePullRequestDraft(
        '```json\n{\n  "title": "fix: handle CI check failure",\n  "body": "Verified locally"\n}\n```',
        "fix/ci",
      ),
    ).toEqual({
      title: "fix: handle CI check failure",
      body: "Verified locally",
    });

    expect(
      parsePullRequestDraft("# chore: fallback markdown title\n\nBody paragraph 1\nBody paragraph 2", "chore/md"),
    ).toEqual({
      title: "chore: fallback markdown title",
      body: "Body paragraph 1\nBody paragraph 2",
    });
  });

  it("classifies binary, pure-rename, and oversized unified diff entries", () => {
    const addedLines = Array.from({ length: OVERSIZED_DIFF_THRESHOLD + 5 }, (_, idx) => `+line ${idx}`).join("\n");
    const sampleDiff = [
      "diff --git a/assets/logo.png b/assets/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
      "diff --git a/src/old-name.ts b/src/new-name.ts",
      "similarity index 100%",
      "rename from src/old-name.ts",
      "rename to src/new-name.ts",
      "diff --git a/src/huge.ts b/src/huge.ts",
      "new file mode 100644",
      `--- /dev/null`,
      `+++ b/src/huge.ts`,
      `@@ -0,0 +1,${OVERSIZED_DIFF_THRESHOLD + 5} @@`,
      addedLines,
    ].join("\n");

    const parsed = parseUnifiedDiff(sampleDiff);
    expect(parsed.files).toHaveLength(3);

    const [binaryFile, renamedFile, hugeFile] = parsed.files;
    expect(binaryFile?.binary).toBe(true);
    expect(binaryFile?.hunks).toHaveLength(0);

    expect(renamedFile?.binary).toBe(false);
    expect(displayPath(renamedFile?.oldPath ?? "")).toBe("src/old-name.ts");
    expect(displayPath(renamedFile?.newPath ?? "")).toBe("src/new-name.ts");
    expect(renamedFile?.hunks).toHaveLength(0);

    expect(hugeFile).toBeDefined();
    if (hugeFile !== undefined) {
      const stats = diffStats(unifiedSegments(hugeFile));
      expect(stats.added + stats.deleted).toBeGreaterThanOrEqual(OVERSIZED_DIFF_THRESHOLD);
    }
  });
});
