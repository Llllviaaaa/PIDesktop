import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiagramBlock, diagramKindForLanguage } from "../src/components/DiagramBlock";
import { Markdown } from "../src/components/Markdown";

assert.equal(diagramKindForLanguage("mermaid"), "mermaid");
assert.equal(diagramKindForLanguage("plantuml"), "plantuml");
assert.equal(diagramKindForLanguage("puml"), "plantuml");
assert.equal(diagramKindForLanguage("uml"), "plantuml");
assert.equal(diagramKindForLanguage("typescript"), null);

const mermaid = renderToStaticMarkup(createElement(Markdown, {
  content: "```mermaid\ngraph TD\n  A --> B\n```",
}));
assert.match(mermaid, /aria-label="Mermaid 图形"/);
assert.match(mermaid, /正在渲染/);

const plantUml = renderToStaticMarkup(createElement(Markdown, {
  content: "```plantuml\n@startuml\nAlice -> Bob: hello\n@enduml\n```",
}));
assert.match(plantUml, /aria-label="PlantUML 图形"/);

const fallback = renderToStaticMarkup(createElement(Markdown, {
  content: "```ts\nconst value = 1;\n```",
}));
assert.match(fallback, /class="markdown-code"/);

const explicitSource = renderToStaticMarkup(createElement(DiagramBlock, {
  kind: "plantuml",
  source: "Alice -> Bob: hello",
}));
assert.match(explicitSource, /PlantUML/);
assert.match(explicitSource, /aria-label="查看 PlantUML 大图"/);
assert.match(explicitSource, /aria-label="保存 PlantUML 为 SVG"/);

console.log("markdown diagram tests passed");
