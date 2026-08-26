import assert from "node:assert/strict";
import {
  deriveCodeReviewComments,
  deriveLatestCodeReviewComments,
  parseCodeReviewComments,
  stripCodeReviewDirectives,
} from "../src/lib/codeReview";

const content = [
  "发现一个需要修复的问题。",
  "",
  "::code-comment{title=\"[P1] Avoid stale state\" body=\"The callback reads stale state\\nwhen the task changes.\" file=\"src/App.tsx\" start=121 end=123 priority=1}",
].join("\n");

const comments = parseCodeReviewComments({ id: "review-1", content });
assert.equal(comments.length, 1);
assert.deepEqual(comments[0], {
  id: `review-1:${content.indexOf("::code-comment")}`,
  title: "[P1] Avoid stale state",
  body: "The callback reads stale state\nwhen the task changes.",
  file: "src/App.tsx",
  start: 121,
  end: 123,
  priority: 1,
  messageId: "review-1",
});

assert.equal(stripCodeReviewDirectives(content), "发现一个需要修复的问题。");
assert.equal(parseCodeReviewComments({ id: "invalid", content: "::code-comment{title=\"Missing fields\"}" }).length, 0);
assert.equal(deriveCodeReviewComments([
  { id: "user", role: "user", content, timestamp: 1 },
  { id: "assistant", role: "assistant", content, timestamp: 2 },
]).length, 1);

const reviewMessages = [
  { id: "old-request", role: "user" as const, content: "审查当前未提交的代码更改", timestamp: 1 },
  { id: "old-result", role: "assistant" as const, content, timestamp: 2 },
  { id: "branch-request", role: "user" as const, content: "审查当前分支相对于基线分支 main 的代码更改", timestamp: 3 },
  { id: "branch-result", role: "assistant" as const, content: content.replace("src/App.tsx", "src/main.tsx"), timestamp: 4 },
];
assert.equal(deriveLatestCodeReviewComments(reviewMessages, { mode: "uncommitted" })[0]?.file, "src/App.tsx");
assert.equal(deriveLatestCodeReviewComments(reviewMessages, { mode: "base-branch", baseBranch: "main" })[0]?.file, "src/main.tsx");
assert.equal(deriveLatestCodeReviewComments(reviewMessages, { mode: "base-branch", baseBranch: "develop" }).length, 0);
assert.equal(deriveLatestCodeReviewComments(reviewMessages, null).length, 0);

console.log("code review directive tests passed");
