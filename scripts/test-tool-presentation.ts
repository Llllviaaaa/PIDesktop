import assert from "node:assert/strict";
import {
  classifyToolKind,
  displayPath,
  parseDiffLines,
  parseSearchHits,
  presentToolCall,
  readLineRange,
  truncatePreview,
} from "../src/lib/toolPresentation";

assert.equal(classifyToolKind("read"), "read");
assert.equal(classifyToolKind("functions.read"), "read");
assert.equal(classifyToolKind("edit"), "edit");
assert.equal(classifyToolKind("apply_patch"), "edit");
assert.equal(classifyToolKind("bash"), "shell");
assert.equal(classifyToolKind("grep"), "search");
assert.equal(classifyToolKind("ctx_execute"), "shell");
assert.equal(classifyToolKind("ctx_search"), "search");
assert.equal(classifyToolKind("web_search"), "web-search");
assert.equal(classifyToolKind("browser_navigate"), "browser");
assert.equal(classifyToolKind("computer_screenshot"), "computer");
assert.equal(classifyToolKind("mcp__fs__read_file"), "mcp");

assert.equal(displayPath("src/components/Message.tsx"), "src/components/Message.tsx");
assert.equal(displayPath("D:\\repo\\src\\a\\b\\c.ts"), "a/b/c.ts");

const preview = truncatePreview(`${"line\n".repeat(100)}tail`, 80, 3);
assert.match(preview, /…$/);
assert.doesNotMatch(preview, /tail/);

assert.equal(readLineRange({ offset: 1, limit: 20 }), "1–20");
assert.equal(readLineRange({ offset: 1 }), undefined);

const read = presentToolCall({
  id: "1",
  name: "read",
  args: { path: "src/App.tsx", offset: 1, limit: 20 },
  result: "export function App() {}",
  running: false,
});
assert.equal(read.kind, "read");
assert.equal(read.heading, "读取 src/App.tsx · 1–20");
assert.equal(read.preview, "export function App() {}");
assert.equal(read.expandable, true);

const shell = presentToolCall({
  id: "2",
  name: "bash",
  args: { command: "npm test" },
  result: "ok\n",
  running: false,
});
assert.equal(shell.heading, "运行 npm test");
assert.match(shell.preview ?? "", /ok/);
assert.equal(shell.expandable, true);

const emptyShell = presentToolCall({
  id: "2b",
  name: "bash",
  args: { command: "npm test" },
  result: "",
  running: true,
});
assert.equal(emptyShell.expandable, true);

const edit = presentToolCall({
  id: "3",
  name: "edit",
  args: { path: "src/App.tsx", old_string: "title", new_string: "heading" },
  running: false,
});
assert.equal(edit.heading, "编辑 src/App.tsx");
assert.equal(edit.added, 1);
assert.equal(edit.removed, 1);
assert.deepEqual(edit.diff, [
  { type: "del", text: "title" },
  { type: "add", text: "heading" },
]);

const unified = parseDiffLines("@@ -1,1 +1,1 @@\n-old\n+new\n");
assert.deepEqual(unified, [
  { type: "hunk", text: "@@ -1,1 +1,1 @@" },
  { type: "del", text: "old" },
  { type: "add", text: "new" },
]);

const listedRead = presentToolCall({
  id: "read-list",
  name: "read",
  args: { path: "SKILL.md", limit: 80 },
  result: "- **File mutations**: `mkdir`\n- **Git writes**: `git add`\n---\nname: context-mode",
  running: false,
});
assert.equal(listedRead.diff, undefined);
assert.equal(listedRead.removed, undefined);

const ctx = presentToolCall({
  id: "ctx-1",
  name: "ctx_execute",
  args: { language: "shell", code: "opencli weibo hot --limit 30 -f yaml" },
  result: "word: AL夺冠\nrank: 8",
  running: false,
});
assert.equal(ctx.kind, "shell");
assert.match(ctx.heading, /运行 opencli weibo hot/);
assert.equal(ctx.diff, undefined);

const script = presentToolCall({
  id: "js-1",
  name: "ctx_execute",
  args: {
    language: "javascript",
    intent: "China Google News titles",
    code: "const {execSync} = require('child_process');\nfunction run(cmd) { return execSync(cmd); }",
  },
  running: false,
});
assert.equal(script.heading, "运行脚本 · China Google News titles");

const search = presentToolCall({
  id: "4",
  name: "grep",
  args: { pattern: "work-log", path: "src" },
  result: "src/components/Message.tsx:1",
  running: false,
});
assert.equal(search.heading, "搜索 work-log · src");
assert.equal(search.query, "work-log");
assert.deepEqual(search.hits, [{ path: "src/components/Message.tsx", line: 1 }]);
assert.equal(search.preview, undefined);

assert.deepEqual(parseSearchHits("src/components/Message.tsx:12:work-log fold\nsrc/styles.css:269:.work-log {}"), [
  { path: "src/components/Message.tsx", line: 12, text: "work-log fold" },
  { path: "src/styles.css", line: 269, text: ".work-log {}" },
]);

const plan = presentToolCall({
  id: "6",
  name: "update_plan",
  args: {
    explanation: "Ship density next",
    items: [
      { id: "a", text: "Fold", status: "completed" },
      { id: "b", text: "Density", status: "in_progress" },
    ],
  },
  running: false,
});
assert.equal(classifyToolKind("update_plan"), "plan");
assert.equal(plan.kind, "plan");
assert.equal(plan.heading, "计划 1/2");
assert.equal(plan.plan?.steps[1]?.text, "Density");
assert.equal(plan.expandable, true);

const unknown = presentToolCall({
  id: "5",
  name: "custom_tool",
  args: { nested: { value: 1 } },
  running: false,
});
assert.equal(unknown.kind, "other");
assert.equal(unknown.heading, "custom_tool");
assert.equal(unknown.expandable, false);
assert.equal(unknown.preview, undefined);

console.log("tool-presentation: all assertions passed");
