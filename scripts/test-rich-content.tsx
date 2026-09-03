import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/Markdown";
import { Message } from "../src/components/Message";
import { RichContent } from "../src/components/RichContent";
import { parseRichContent, RICH_CONTENT_MAX_BYTES } from "../src/lib/richContent";

const validSource = JSON.stringify({
  version: 1,
  title: "交付概览 <script>alert(1)</script>",
  summary: "七种受控组件",
  blocks: [
    { type: "metrics", title: "指标", items: [{ label: "通过率", value: "98%", detail: "最近一次", tone: "success" }] },
    { type: "callout", title: "注意", body: "不执行 <img src=x onerror=alert(1)>", tone: "warning" },
    { type: "steps", title: "步骤", items: [{ title: "校验", description: "严格模式", status: "done" }] },
    { type: "comparison", title: "对比", columns: ["方案", "结果"], rows: [["A", "推荐"], ["B", "备用"]] },
    { type: "progress", title: "进度", items: [{ label: "实现", value: 75, detail: "进行中", tone: "info" }] },
    { type: "bars", title: "规模", items: [{ label: "测试", value: 8, max: 10, unit: "项", tone: "neutral" }] },
    { type: "links", title: "资料", items: [{ label: "文档", url: "https://example.com/docs?q=1", description: "官方页面" }] },
  ],
});

const document = parseRichContent(validSource);
assert.ok(document, "all supported blocks should parse");
assert.equal(document.blocks.length, 7);
assert.equal(document.blocks[6].type, "links");
if (document.blocks[6].type === "links") assert.equal(document.blocks[6].items[0].url, "https://example.com/docs?q=1");

const markup = renderToStaticMarkup(<RichContent document={document} />);
assert.match(markup, /class="pi-rich"/);
assert.match(markup, /<dl/);
assert.match(markup, /<ol/);
assert.match(markup, /<table/);
assert.match(markup, /scope="row"/);
assert.match(markup, /<progress/);
assert.match(markup, /aria-label="实现 75%"/);
assert.match(markup, /example\.com/);
assert.ok(!markup.includes("<script>"), "model text must be escaped");
assert.ok(!markup.includes("<img "), "model text must not create image elements");
assert.match(markup, /&lt;script&gt;/);

const rejects = (value: unknown, message: string) => {
  assert.equal(parseRichContent(typeof value === "string" ? value : JSON.stringify(value)), null, message);
};

rejects({ version: 2, blocks: [{ type: "callout", body: "x" }] }, "unknown versions should fail");
rejects({ version: 1, extra: true, blocks: [{ type: "callout", body: "x" }] }, "unknown root keys should fail");
rejects({ version: 1, blocks: [{ type: "callout", body: "x", style: "position:fixed" }] }, "unknown block keys should fail");
rejects('{"version":1,"blocks":[{"type":"metrics","items":[{"label":"x","value":"y","__proto__":"bad"}]}]}', "prototype keys should fail");
rejects({ version: 1, blocks: [{ type: "callout", body: `unsafe\u202etext` }] }, "bidi controls should fail");
rejects({ version: 1, blocks: [{ type: "progress", items: [{ label: "x", value: 101 }] }] }, "out-of-range progress should fail");
rejects({ version: 1, blocks: [{ type: "bars", items: [{ label: "x", value: 2, max: 1 }] }] }, "bar values above max should fail");
rejects({ version: 1, blocks: [{ type: "comparison", columns: ["a", "b"], rows: [["short"]] }] }, "ragged rows should fail");
rejects({ version: 1, blocks: [{ type: "links", items: [{ label: "x", url: "javascript:alert(1)" }] }] }, "script URLs should fail");
rejects({ version: 1, blocks: [{ type: "links", items: [{ label: "x", url: "//example.com" }] }] }, "protocol-relative URLs should fail");
rejects({ version: 1, blocks: [{ type: "links", items: [{ label: "x", url: "https://user:pass@example.com" }] }] }, "credential URLs should fail");
for (const url of ["data:text/html,bad", "blob:https://example.com/id", "file:///tmp/bad", "pifile://secret.txt", "/relative"]) {
  rejects({ version: 1, blocks: [{ type: "links", items: [{ label: "x", url }] }] }, `${url} should fail`);
}
rejects('{"version":1,"version":1,"blocks":[{"type":"callout","body":"x"}]}', "duplicate keys should fail");
rejects({ version: 1, blocks: [] }, "empty documents should fail");
rejects({ version: 1, blocks: Array.from({ length: 13 }, () => ({ type: "callout", body: "x" })) }, "block limit should hold");
rejects({ version: 1, blocks: [{ type: "metrics", items: Array.from({ length: 13 }, (_, index) => ({ label: String(index), value: "x" })) }] }, "group limit should hold");
rejects({ version: 1, blocks: Array.from({ length: 6 }, () => ({ type: "metrics", items: Array.from({ length: 11 }, (_, index) => ({ label: String(index), value: "x" })) })) }, "total item limit should hold");
rejects({ version: 1, title: "x", blocks: Array.from({ length: 12 }, () => ({ type: "callout", body: "x".repeat(1000) })) }, "aggregate text limit should hold");
assert.equal(parseRichContent("{"), null, "truncated JSON should fail without throwing");
assert.equal(parseRichContent(" ".repeat(RICH_CONTENT_MAX_BYTES + 1)), null, "byte limit should hold");
assert.equal(parseRichContent("[".repeat(17) + "]".repeat(17)), null, "nesting limit should hold");

const fencedSource = `\`\`\`pidesktop-rich\n${validSource}\n\`\`\``;
const enabledMarkdown = renderToStaticMarkup(<Markdown content={fencedSource} allowRichContent />);
assert.match(enabledMarkdown, /class="pi-rich"/, "enabled Markdown should render the protocol");
const disabledMarkdown = renderToStaticMarkup(<Markdown content={fencedSource} />);
assert.doesNotMatch(disabledMarkdown, /class="pi-rich"/, "Markdown should be safe by default");
assert.match(disabledMarkdown, /markdown-code/, "disabled rich content should remain a code fence");

const completedAssistant = renderToStaticMarkup(<Message
  message={{ id: "assistant-rich", role: "assistant", content: fencedSource }}
  allowRichContent
/>);
assert.match(completedAssistant, /class="pi-rich"/, "completed opted-in assistant messages should render rich content");
const defaultAssistant = renderToStaticMarkup(<Message
  message={{ id: "assistant-default", role: "assistant", content: fencedSource }}
/>);
assert.doesNotMatch(defaultAssistant, /class="pi-rich"/, "shared message surfaces should remain opted out by default");
const streamingAssistant = renderToStaticMarkup(<Message
  message={{ id: "assistant-streaming", role: "assistant", content: fencedSource, isStreaming: true }}
  allowRichContent
/>);
assert.doesNotMatch(streamingAssistant, /class="pi-rich"/, "streaming JSON should not switch into rich rendering");
assert.match(streamingAssistant, /markdown-code/, "streaming JSON should remain visible as code");
const userMessage = renderToStaticMarkup(<Message
  message={{ id: "user-rich", role: "user", content: fencedSource }}
  allowRichContent
/>);
assert.doesNotMatch(userMessage, /class="pi-rich"/, "user messages should never render rich content");
const errorAssistant = renderToStaticMarkup(<Message
  message={{ id: "assistant-error", role: "assistant", content: fencedSource, isError: true }}
  allowRichContent
/>);
assert.doesNotMatch(errorAssistant, /class="pi-rich"/, "error replies should keep their source visible");
const globallyStreamingAssistant = renderToStaticMarkup(<Message
  message={{ id: "assistant-global-stream", role: "assistant", content: fencedSource }}
  allowRichContent
  isLastAssistant
  globalStreaming
/>);
assert.doesNotMatch(globallyStreamingAssistant, /class="pi-rich"/, "app-level streaming should keep the latest reply as source");
const twoFences = `${fencedSource}\n\n${fencedSource}`;
const repeatedRichContent = renderToStaticMarkup(<Markdown content={twoFences} allowRichContent />);
assert.doesNotMatch(repeatedRichContent, /class="pi-rich"/, "more than one rich fence should fall back to code");
assert.equal((repeatedRichContent.match(/class="markdown-code"/g) ?? []).length, 2, "both repeated fences should remain visible");
const unclosedFence = `\`\`\`pidesktop-rich\n${validSource}`;
const unclosedRichContent = renderToStaticMarkup(<Markdown content={unclosedFence} allowRichContent />);
assert.doesNotMatch(unclosedRichContent, /class="pi-rich"/, "an unclosed rich fence should never render as UI");
assert.match(unclosedRichContent, /markdown-code/, "an unclosed rich fence should keep its source visible");
const quotedFence = fencedSource.split("\n").map((line) => `> ${line}`).join("\n");
const quotedAndTopLevel = renderToStaticMarkup(<Markdown content={`${quotedFence}\n\n${fencedSource}`} allowRichContent />);
assert.doesNotMatch(quotedAndTopLevel, /class="pi-rich"/, "a quoted rich fence should consume the one-fence budget");
assert.equal((quotedAndTopLevel.match(/class="markdown-code"/g) ?? []).length, 2, "quoted and top-level fences should remain code");
const listFence = `- nested\n\n  \`\`\`pidesktop-rich\n  ${validSource}\n  \`\`\``;
const listedAndTopLevel = renderToStaticMarkup(<Markdown content={`${listFence}\n\n${fencedSource}`} allowRichContent />);
assert.doesNotMatch(listedAndTopLevel, /class="pi-rich"/, "a list-nested rich fence should consume the one-fence budget");
assert.equal((listedAndTopLevel.match(/class="markdown-code"/g) ?? []).length, 2, "list-nested and top-level fences should remain code");
const metadataFence = fencedSource.replace("```pidesktop-rich", "```pidesktop-rich extra");
const metadataAndExact = renderToStaticMarkup(<Markdown content={`${metadataFence}\n\n${fencedSource}`} allowRichContent />);
assert.doesNotMatch(metadataAndExact, /class="pi-rich"/, "a rich language token with metadata should consume the one-fence budget");
assert.equal((metadataAndExact.match(/class="markdown-code"/g) ?? []).length, 2, "metadata and exact fences should remain code");
const suffixedFence = fencedSource.replace("```pidesktop-rich", "```pidesktop-rich:extra");
const suffixedAndExact = renderToStaticMarkup(<Markdown content={`${suffixedFence}\n\n${fencedSource}`} allowRichContent />);
assert.doesNotMatch(suffixedAndExact, /class="pi-rich"/, "a punctuation-suffixed rich token should consume the one-fence budget");
assert.equal((suffixedAndExact.match(/class="markdown-code"/g) ?? []).length, 2, "suffixed and exact fences should remain code");
const noDocumentTitle = parseRichContent(JSON.stringify({
  version: 1,
  blocks: [{ type: "metrics", title: "指标", items: [{ label: "x", value: "1" }] }],
}));
assert.ok(noDocumentTitle);
const untitledMarkup = renderToStaticMarkup(<RichContent document={noDocumentTitle} />);
assert.match(untitledMarkup, /<h3[^>]*pi-rich__sr-title[^>]*>结构化内容<\/h3>/, "untitled documents should retain a level-three heading");

console.log("rich-content: all assertions passed");
