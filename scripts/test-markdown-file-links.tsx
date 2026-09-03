import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/Markdown";

const rendered = renderToStaticMarkup(createElement(Markdown, { content: "Open src/App.tsx:42 and `README.md`." }));

assert.match(rendered, /href="pifile:\/\/src%2FApp\.tsx#L42"/);
assert.match(rendered, /href="pifile:\/\/README\.md"/);
assert.match(rendered, /class="file-ref"/);

const table = renderToStaticMarkup(createElement(Markdown, {
  content: "| Name | Value |\n| --- | --- |\n| Width | 760px |",
}));

assert.match(table, /class="markdown-table-scroll"/);
assert.match(table, /role="region"/);
assert.match(table, /aria-label="表格内容，可横向滚动"/);
assert.match(table, /tabindex="0"/);
assert.match(table, /<table>/);
console.log("markdown file link tests passed");
