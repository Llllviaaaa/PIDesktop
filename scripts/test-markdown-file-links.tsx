import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/Markdown";

const rendered = renderToStaticMarkup(createElement(Markdown, { content: "Open src/App.tsx:42 and `README.md`." }));

assert.match(rendered, /href="pifile:\/\/src%2FApp\.tsx#L42"/);
assert.match(rendered, /href="pifile:\/\/README\.md"/);
assert.match(rendered, /class="file-ref"/);
console.log("markdown file link tests passed");
