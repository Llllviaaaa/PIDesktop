import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExtensionDialog } from "../src/components/ExtensionDialog";
import {
  BATCH_ASK_ENVELOPE_KEY,
  BATCH_ASK_PLACEHOLDER,
  headlineForUiRequest,
  isBatchAskComplete,
  parseBatchAskEnvelope,
  serializeBatchAskResponse,
} from "../src/lib/batchAsk";

const leaked = {
  [BATCH_ASK_ENVELOPE_KEY]: 1,
  review: false,
  questions: [{
    id: "grok_login",
    type: "select",
    question: "Grok 现在搜不了：opencli 浏览器桥没连上，xAI 接口也没登录，grok.com 网页要求注册/登录。要怎么继续？",
    options: [
      { label: "现在登录 Grok（我会打开登录页，你在浏览器里完成）", value: "login", description: "跑 opencli grok login，等你登录后再用 Grok 搜今天新闻" },
      { label: "先别登录，改用路透/微博/Google 出今天新闻", value: "fallback", description: "不走 Grok，用刚才已经搜到的其他源整理" },
      { label: "只告诉我 Grok 为什么失败，先不搜了", value: "stop", description: "只汇报失败原因，不再继续搜索" },
    ],
    allowOther: true,
  }],
};

const title = JSON.stringify(leaked);
const parsed = parseBatchAskEnvelope(title, BATCH_ASK_PLACEHOLDER);
assert.ok(parsed);
assert.equal(parsed.questions.length, 1);
assert.equal(parsed.questions[0].id, "grok_login");
assert.equal(parsed.questions[0].type, "select");
assert.equal(parsed.questions[0].options?.[0].value, "login");
assert.equal(parsed.questions[0].allowOther, true);
assert.equal(parsed.review, false);
assert.equal(
  headlineForUiRequest("input", title, BATCH_ASK_PLACEHOLDER),
  leaked.questions[0].question,
);
assert.equal(headlineForUiRequest("input", "请选择分支"), "请选择分支");
assert.equal(parseBatchAskEnvelope("请选择分支"), null);

const answers = {
  grok_login: { id: "grok_login", type: "select", value: "fallback", label: leaked.questions[0].options[1].label },
};
assert.equal(isBatchAskComplete(parsed, answers), true);
const payload = JSON.parse(serializeBatchAskResponse([answers.grok_login])) as { answers: Array<{ value: string }> };
assert.equal(payload.answers[0].value, "fallback");

const rendered = renderToStaticMarkup(createElement(ExtensionDialog, {
  request: {
    type: "extension_ui_request",
    id: "batch-1",
    method: "input",
    title,
    placeholder: BATCH_ASK_PLACEHOLDER,
  },
  onAnswer: () => undefined,
}));
assert.match(rendered, /class="question-card question-batch"/);
assert.match(rendered, /现在登录 Grok/);
assert.match(rendered, /跑 opencli grok login/);
assert.match(rendered, /自行输入/);
assert.doesNotMatch(rendered, /__piDeckBatchAsk/);
assert.doesNotMatch(rendered, /placeholder="__piDeckBatchAsk__"/);

const plain = renderToStaticMarkup(createElement(ExtensionDialog, {
  request: {
    type: "extension_ui_request",
    id: "input-1",
    method: "input",
    title: "请选择分支",
    placeholder: "main",
  },
  onAnswer: () => undefined,
}));
assert.match(plain, /请选择分支/);
assert.match(plain, /placeholder="main"/);
assert.doesNotMatch(plain, /question-batch/);

console.log("batch-ask tests passed");
