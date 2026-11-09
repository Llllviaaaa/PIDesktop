import assert from "node:assert/strict";
import { extractInlineThinking, foldThinking } from "../src/lib/thinkingDisplay";
import { mergeAssistantTurn } from "../src/lib/transcriptTurns";
import { test } from "vitest";

test("thinking display", async () => {
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
});

test("extractInlineThinking strips <think> tags for showThinking control", () => {
  assert.deepEqual(
    extractInlineThinking("<think>\n先分析问题根因\n</think>\n\n最终答复正文。"),
    { content: "最终答复正文。", thinking: "先分析问题根因" },
  );

  // Unclosed streaming <think> must be routed into thinking, never leaked into visible content.
  assert.deepEqual(
    extractInlineThinking("<think>正在推导第一步……"),
    { content: "", thinking: "正在推导第一步……" },
  );

  // Mentioning `<think>` in normal prose must stay untouched.
  assert.deepEqual(
    extractInlineThinking("某些开源模型会输出 `<think>` 标签。"),
    { content: "某些开源模型会输出 `<think>` 标签。", thinking: undefined },
  );

  const inlineMsg = {
    id: "m1",
    role: "assistant" as const,
    content: "<think>内部推理步骤</think>\n对外可见结论",
    timestamp: 1_000,
  };
  const merged = mergeAssistantTurn([inlineMsg]);
  assert.equal(merged.content, "对外可见结论");
  assert.equal(merged.thinking, "内部推理步骤");
  assert.equal(merged.workSteps?.length, 1);
  assert.equal(merged.workSteps?.[0]?.kind, "thinking");
});
