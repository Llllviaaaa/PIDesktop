import assert from "node:assert/strict";
import { groupTranscriptMessages, mergeAssistantTurn } from "../src/lib/transcriptTurns";
import type { UiMessage } from "../src/types";

function assistant(partial: Partial<UiMessage> & { id: string }): UiMessage {
  return {
    role: "assistant",
    content: "",
    timestamp: 1,
    ...partial,
  };
}

const user: UiMessage = { id: "u1", role: "user", content: "给我搜一下今天的最新新闻", timestamp: 1 };
const step1 = assistant({
  id: "a1",
  content: "先按智能搜索流程处理。",
  thinking: "Need to search.",
  timestamp: 2,
  toolCalls: [{ id: "t1", name: "read", args: { path: "SKILL.md" }, running: false }],
});
const step2 = assistant({
  id: "a2",
  content: "豆包失败了，我改用微博。",
  thinking: "Retry another source.",
  timestamp: 3,
  toolCalls: [{ id: "t2", name: "bash", args: { command: "opencli weibo hot" }, running: false }],
});
const finale = assistant({
  id: "a3",
  content: "今天是 9月13日。敬一丹去世。",
  thinking: "Compile the briefing.",
  timestamp: 10,
  durationMs: 8000,
});

const grouped = groupTranscriptMessages([user, step1, step2, finale]);
assert.equal(grouped.length, 2);
assert.equal(grouped[0].id, "u1");
assert.equal(grouped[1].id, "a1");
assert.equal(grouped[1].content, "今天是 9月13日。敬一丹去世。");
assert.doesNotMatch(grouped[1].content, /先按智能搜索流程/);
assert.doesNotMatch(grouped[1].content, /豆包失败了/);
assert.match(grouped[1].thinking ?? "", /Need to search/);
assert.match(grouped[1].thinking ?? "", /Compile the briefing/);
assert.equal(grouped[1].workSteps?.filter((step) => step.kind === "thinking").length, 3);
assert.equal(grouped[1].workSteps?.filter((step) => step.kind === "note").length, 2);
assert.equal(grouped[1].workSteps?.filter((step) => step.kind === "tool").length, 2);
assert.equal(grouped[1].toolCalls?.map((call) => call.id).join(","), "t1,t2");
assert.equal(grouped[1].durationMs, 8000);

const merged = mergeAssistantTurn([step1, step2]);
assert.equal(merged.content, "豆包失败了，我改用微博。");
assert.equal(merged.toolCalls?.length, 2);

const single = groupTranscriptMessages([user, finale]);
assert.equal(single[1].id, finale.id);
assert.equal(single[1].content, finale.content);
assert.equal(single[1].workSteps?.some((step) => step.kind === "thinking"), true);

const notice: UiMessage = { id: "n1", role: "notice", noticeKind: "compaction", content: "Context compacted", timestamp: 4 };
const split = groupTranscriptMessages([user, step1, notice, finale]);
assert.equal(split.length, 4);
assert.equal(split[1].content, "先按智能搜索流程处理。");
assert.equal(split[3].content, "今天是 9月13日。敬一丹去世。");

const drafted = mergeAssistantTurn([
  assistant({
    id: "draft",
    content: "今天是 **2026年9月13日（周日）**。敬一丹去世。",
    thinking: [
      "I have a comprehensive picture of today's news.",
      "好的，我来给你整理一下今天的最新新闻要点。",
      "",
      "### 1. 敬一丹去世",
      "敬一丹今天凌晨5点在北京去世。",
      "",
      " 2.",
    ].join("\n"),
  }),
]);
const draftThinking = drafted.workSteps?.find((step) => step.kind === "thinking");
assert.equal(draftThinking?.kind, "thinking");
if (draftThinking?.kind === "thinking") {
  assert.match(draftThinking.text, /comprehensive picture/);
  assert.doesNotMatch(draftThinking.text, /### 1/);
  assert.doesNotMatch(draftThinking.text, /好的，我来给你整理/);
}

console.log("transcript-turns: all assertions passed");
