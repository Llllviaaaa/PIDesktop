import assert from "node:assert/strict";
import { foldThinking } from "../src/lib/thinkingDisplay";

const raw = [
  "I have a comprehensive picture of today's news. Let me compile a clean, well-structured briefing for September 13, 2026 (Sunday). Current time is around 21:39 CST.",
  "好的，我来给你整理一下今天（9月13日，星期日）的最新新闻要点。",
  "",
  "### 1. 敬一丹去世",
  "敬一丹今天凌晨5点在北京去世，享年71岁。女儿已宣布消息，央视也发布了官方公告，白岩松还发了悼文。",
  "",
  " 2.",
].join("\n");

const folded = foldThinking(raw, "今天是 **2026年9月13日（周日）**。敬一丹去世。");
assert.match(folded, /comprehensive picture of today's news/);
assert.doesNotMatch(folded, /敬一丹去世/);
assert.doesNotMatch(folded, /好的，我来给你整理/);
assert.doesNotMatch(folded, /### 1/);
assert.doesNotMatch(folded, /\n\s*2\.\s*$/);

assert.equal(foldThinking("好的，我来给你整理今天的新闻。\n\n### 1. 标题", "正文里也有标题"), "");
assert.equal(foldThinking("Need to search the codebase first."), "Need to search the codebase first.");
assert.equal(foldThinking(""), "");

console.log("thinking-display: all assertions passed");
