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
assert.doesNotMatch(read, /"offset"/);
assert.doesNotMatch(read, /# Pi Desktop/);
assert.match(read, /1\.1s/);

const edit = renderToStaticMarkup(createElement(ToolCall, {
  call: {
    id: "edit-1",
    name: "edit",
    args: { path: "src/App.tsx", old_string: "alpha", new_string: "beta" },
    running: false,
  },
}));
assert.match(edit, /编辑 src\/App\.tsx/);
assert.doesNotMatch(edit, /class="tool-diff"/);
assert.doesNotMatch(edit, /"old_string"/);

console.log("tool-call render tests passed");
