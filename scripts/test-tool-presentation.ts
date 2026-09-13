import assert from "node:assert/strict";
import {
  classifyToolKind,
  displayPath,
  parseDiffLines,
  presentToolCall,
  truncatePreview,
} from "../src/lib/toolPresentation";

assert.equal(classifyToolKind("read"), "read");
assert.equal(classifyToolKind("functions.read"), "read");
assert.equal(classifyToolKind("edit"), "edit");
assert.equal(classifyToolKind("apply_patch"), "edit");
assert.equal(classifyToolKind("bash"), "shell");
assert.equal(classifyToolKind("grep"), "search");
assert.equal(classifyToolKind("web_search"), "web-search");
assert.equal(classifyToolKind("browser_navigate"), "browser");
assert.equal(classifyToolKind("computer_screenshot"), "computer");
assert.equal(classifyToolKind("mcp__fs__read_file"), "mcp");

assert.equal(displayPath("src/components/Message.tsx"), "src/components/Message.tsx");
assert.equal(displayPath("D:\\repo\\src\\a\\b\\c.ts"), "a/b/c.ts");

const preview = truncatePreview(`${"line\n".repeat(100)}tail`, 80, 3);
assert.match(preview, /…$/);
assert.doesNotMatch(preview, /tail/);

const read = presentToolCall({
  id: "1",
  name: "read",
  args: { path: "src/App.tsx", offset: 1 },
  result: "export function App() {}",
  running: false,
});
assert.equal(read.kind, "read");
assert.equal(read.heading, "读取 src/App.tsx");
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

const edit = presentToolCall({
  id: "3",
  name: "edit",
  args: { path: "src/App.tsx", old_string: "title", new_string: "heading" },
  running: false,
});
assert.equal(edit.heading, "编辑 src/App.tsx");
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

const search = presentToolCall({
  id: "4",
  name: "grep",
  args: { pattern: "work-log", path: "src" },
  result: "src/components/Message.tsx:1",
  running: false,
});
assert.equal(search.heading, "搜索 work-log");
assert.equal(search.query, "work-log");

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
