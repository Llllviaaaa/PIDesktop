import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCall } from "../src/components/ToolCall";

const read = renderToStaticMarkup(createElement(ToolCall, {
  call: {
    id: "read-1",
    name: "read",
    args: { path: "README.md", offset: 1 },
    result: "# Pi Desktop",
    running: false,
    startedAt: 1,
    finishedAt: 1100,
  },
}));
assert.match(read, /读取 README.md/);
assert.doesNotMatch(read, /# Pi Desktop/);
assert.doesNotMatch(read, /"offset"/);
assert.match(read, /1\.1s/);

const listed = renderToStaticMarkup(createElement(ToolCall, {
  call: {
    id: "read-list",
    name: "read",
    args: { path: "SKILL.md", limit: 80 },
    result: "- **File mutations**: `mkdir`\n- **Git writes**: `git add`\n---\nname: context-mode",
    running: false,
  },
}));
assert.match(listed, /读取 SKILL.md/);
assert.doesNotMatch(listed, /class="tool-diff"/);
assert.doesNotMatch(listed, /tool-stat-del/);
assert.doesNotMatch(listed, /File mutations/);

const edit = renderToStaticMarkup(createElement(ToolCall, {
  call: {
    id: "edit-1",
    name: "edit",
    args: { path: "src/App.tsx", old_string: "alpha", new_string: "beta" },
    running: false,
  },
}));
assert.match(edit, /编辑 src\/App\.tsx/);
assert.match(edit, /class="tool-diff"/);
assert.match(edit, /tool-stat-add/);
assert.doesNotMatch(edit, /"old_string"/);

const shell = renderToStaticMarkup(createElement(ToolCall, {
  call: {
    id: "shell-1",
    name: "bash",
    args: { command: "npm test" },
    result: "ok\n",
    running: false,
  },
}));
assert.match(shell, /运行 npm test/);
assert.doesNotMatch(shell, /class="tool-body"/);
assert.doesNotMatch(shell, /"command"/);

const search = renderToStaticMarkup(createElement(ToolCall, {
  call: {
    id: "grep-1",
    name: "grep",
    args: { pattern: "work-log", path: "src" },
    result: "src/components/Message.tsx:12:work-log fold",
    running: false,
  },
}));
assert.match(search, /搜索 work-log/);
assert.doesNotMatch(search, /class="tool-hits"/);
assert.doesNotMatch(search, /Message\.tsx:12/);
assert.doesNotMatch(search, /"pattern"/);

const instant = renderToStaticMarkup(createElement(ToolCall, {
  call: {
    id: "read-instant",
    name: "read",
    args: { path: "README.md" },
    result: "# Pi Desktop",
    running: false,
    startedAt: 1,
    finishedAt: 200,
  },
}));
assert.match(instant, /读取 README.md/);
assert.doesNotMatch(instant, /0\.2s/);
assert.doesNotMatch(instant, /lucide-check/);

const liveShell = renderToStaticMarkup(createElement(ToolCall, {
  call: {
    id: "shell-live",
    name: "bash",
    args: { command: "npm test" },
    result: "",
    running: true,
  },
}));
assert.match(liveShell, /class="tool-io-label"/);
assert.match(liveShell, /命令/);
assert.match(liveShell, /输出/);
assert.match(liveShell, /tool-card is-terminal/);
assert.doesNotMatch(liveShell, /lucide-check/);

console.log("tool-call render tests passed");
