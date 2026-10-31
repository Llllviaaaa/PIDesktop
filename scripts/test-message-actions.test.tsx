import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildProcessSummary,
  foldWorkingLabel,
  formatMessageClock,
  formatRunDuration,
  isLiveAssistantWork,
  isUserMessageOverLineLimit,
  Message,
  processSegments,
  USER_MESSAGE_COLLAPSED_LINES,
} from "../src/components/Message";
import { test } from "vitest";

/** The visible words of a rendering, tags removed. */
function words(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

test("message actions", async () => {
  assert.equal(isUserMessageOverLineLimit(20 * USER_MESSAGE_COLLAPSED_LINES, 20), false);
  assert.equal(isUserMessageOverLineLimit(20 * USER_MESSAGE_COLLAPSED_LINES + 2, 20), false);
  assert.equal(isUserMessageOverLineLimit(20 * USER_MESSAGE_COLLAPSED_LINES + 3, 20), true);
  assert.equal(isUserMessageOverLineLimit(Number.NaN, 20), false);

  const now = new Date(2026, 9, 14, 15, 30).getTime();
  assert.equal(formatMessageClock(new Date(2026, 9, 14, 9, 5).getTime(), now), "09:05");
  assert.equal(formatMessageClock(new Date(2026, 9, 13, 21, 0).getTime(), now), "10月13日 21:00");
  assert.equal(formatMessageClock(new Date(2025, 0, 2, 8, 0).getTime(), now), "2025年1月2日 08:00");
  assert.equal(formatRunDuration(13_400).map((part) => part.text).join(""), "13秒");
  assert.equal(formatRunDuration(83_000).map((part) => part.text).join(""), "1分23秒");
  assert.equal(buildProcessSummary(2, 0, 3), "执行 2 次思考，调用 3 次工具");
  assert.equal(buildProcessSummary(0, 1, 1), "输出 1 次，调用 1 次工具");

  // The host's grouping: a narration closes the open group and stands on its own.
  const segments = processSegments([
    { kind: "thinking", text: "Plan" },
    { kind: "tool", call: { id: "r", name: "read", args: { path: "a.ts" }, running: false } },
    { kind: "note", text: "正在编辑 a.ts" },
    { kind: "tool", call: { id: "e", name: "edit", args: { path: "a.ts", old_string: "x", new_string: "y" }, running: false } },
    { kind: "tool", call: { id: "b", name: "bash", args: { command: "npm test" }, running: false } },
    { kind: "note", text: "测试通过" },
  ]);
  assert.deepEqual(
    segments.map((segment) => segment.kind === "text"
      ? `text:${segment.text}`
      : `group:${segment.thinking}/${segment.tools}/${segment.activity}`),
    ["group:1/1/thinking", "text:正在编辑 a.ts", "group:0/2/edit", "text:测试通过"],
  );

  const rendered = renderToStaticMarkup(createElement(Message, {
    message: {
      id: "user-message",
      entryId: "user-entry",
      role: "user",
      content: "Please update the implementation.\n**not markdown**",
      timestamp: 1,
    },
    onEdit: () => undefined,
    onRewind: async () => true,
  }));

  // DSH's UserStyleBubble: a plain-text bubble, then copy / edit / rewind behind a leading clock.
  assert.match(rendered, /data-chat-flow-kind="user"/);
  assert.match(rendered, /class="dshc-bubble"/);
  assert.match(rendered, /\*\*not markdown\*\*/);
  assert.match(rendered, /class="dshc-actions dshc-user-actions" data-clock="start"/);
  assert.match(rendered, /class="dshc-time-start"/);
  assert.match(rendered, /aria-label="复制"/);
  assert.match(rendered, /aria-label="编辑消息"/);
  assert.match(rendered, /aria-label="回退消息和改动"/);
  assert.doesNotMatch(rendered, /dshc-bubble-expand/);

  const editing = renderToStaticMarkup(createElement(Message, {
    message: {
      id: "editing-message",
      entryId: "editing-entry",
      role: "user",
      content: "Edit this message.",
      timestamp: 2,
    },
    editing: true,
    onCancelEdit: () => undefined,
    onSubmitEdit: async () => true,
  }));

  assert.match(editing, /class="dshc-flow dshc-user-row is-editing"/);
  assert.match(editing, /class="message-edit-card"/);
  assert.match(editing, /aria-label="编辑消息"/);
  assert.match(editing, /rows="1"/);
  assert.match(editing, /class="message-edit-submit"/);

  const completedThinking = renderToStaticMarkup(createElement(Message, {
    message: {
      id: "assistant-thinking-message",
      timestamp: 0,
      role: "assistant",
      content: "The implementation is ready.",
      thinking: "Internal reasoning details",
      durationMs: 2_000,
    },
  }));

  // A settled turn: the 「已完成，用时」 divider folds its process above the answer.
  assert.match(completedThinking, /class="dshc-turn-process"/);
  assert.match(words(completedThinking), /已完成，用时 2 秒/);
  assert.match(completedThinking, /aria-label="展开工作过程"/);
  assert.match(completedThinking, /aria-expanded="false"/);
  assert.doesNotMatch(completedThinking, /Internal reasoning details/);
  assert.doesNotMatch(completedThinking, /data-step-process/);
  assert.match(completedThinking, /class="dshc-actions dshc-turn-actions" data-clock="end"/);

  const completedTools = renderToStaticMarkup(createElement(Message, {
    message: {
      id: "assistant-tools-message",
      timestamp: 0,
      role: "assistant",
      content: "Read the file.",
      durationMs: 1_000,
      toolCalls: [{
        id: "read-1",
        name: "read",
        args: { path: "src/App.tsx", offset: 1 },
        result: "export function App() {}",
        running: false,
      }],
    },
  }));

  assert.match(words(completedTools), /已完成，用时 1 秒/);
  assert.doesNotMatch(completedTools, /src\/App\.tsx/);
  assert.doesNotMatch(completedTools, /"offset"/);
  assert.doesNotMatch(completedTools, /export function App/);

  const streamingWork = renderToStaticMarkup(createElement(Message, {
    message: {
      id: "assistant-streaming-work",
      timestamp: 0,
      role: "assistant",
      content: "",
      thinking: "Planning the read",
      isStreaming: true,
      toolCalls: [{
        id: "read-2",
        name: "read",
        args: { path: "README.md" },
        running: true,
      }],
    },
    isLastAssistant: true,
    globalStreaming: true,
    workingLabel: "正在工作…",
  }));

  // A working turn (普通 = DSH 标准) keeps the group still gathering calls open under its header, and ends on the running line.
  assert.doesNotMatch(streamingWork, /dshc-turn-process/);
  assert.match(streamingWork, /class="dshc-group-title" aria-expanded="true"/);
  assert.match(streamingWork, /执行 1 次思考，调用 1 次工具/);
  assert.match(streamingWork, /Planning the read/);
  assert.match(words(streamingWork), /读取 README\.md/);
  assert.match(streamingWork, /data-chat-running=""/);
  assert.match(streamingWork, /正在调用工具/);
  assert.doesNotMatch(streamingWork, /"path"/);

  const reasoning = renderToStaticMarkup(createElement(Message, {
    message: {
      id: "assistant-reasoning",
      timestamp: 0,
      role: "assistant",
      content: "",
      thinking: "Reading the request first",
      isStreaming: true,
    },
    isLastAssistant: true,
    globalStreaming: true,
  }));
  // The reasoning row stays open while the model reasons.
  assert.match(reasoning, /data-variant="think" data-state="running" data-expanded="true"/);
  assert.match(reasoning, /data-dsh-claude-reason-window=""/);
  assert.match(reasoning, /正在思考/);

  const summaryWork = renderToStaticMarkup(createElement(Message, {
    message: {
      id: "assistant-summary",
      timestamp: 0,
      role: "assistant",
      content: "Done.",
      thinking: "Hidden in summary mode",
      durationMs: 3_000,
      toolCalls: [{
        id: "read-3",
        name: "read",
        args: { path: "src/store.ts" },
        running: false,
      }],
    },
    summaryMode: true,
  }));

  // 摘要 (DSH 简洁) still folds to the answer and still opens on demand.
  assert.match(words(summaryWork), /已完成，用时 3 秒/);
  assert.doesNotMatch(summaryWork, /Hidden in summary mode/);
  assert.doesNotMatch(summaryWork, /src\/store\.ts/);
  assert.match(summaryWork, /aria-label="展开工作过程"/);

  const compaction = renderToStaticMarkup(createElement(Message, {
    message: {
      id: "compact-1",
      role: "notice",
      noticeKind: "compaction",
      content: "Context compacted\n\nOlder turns were summarized.",
      timestamp: 3,
    },
  }));
  assert.match(compaction, /class="dshc-flow compaction-divider is-compaction"/);
  assert.match(compaction, /上下文已压缩/);
  assert.doesNotMatch(compaction, /Older turns were summarized/);

  const verboseCompaction = renderToStaticMarkup(createElement(Message, {
    message: {
      id: "compact-2",
      role: "notice",
      noticeKind: "compaction",
      content: "Context compacted\n\nOlder turns were summarized.",
      timestamp: 4,
    },
    density: "verbose",
  }));
  assert.match(verboseCompaction, /Older turns were summarized/);

  const verboseWork = renderToStaticMarkup(createElement(Message, {
    message: {
      id: "verbose-tools",
      timestamp: 0,
      role: "assistant",
      content: "Done.",
      thinking: "Shown in verbose mode",
      toolCalls: [{
        id: "read-4",
        name: "read",
        args: { path: "src/store.ts" },
        running: false,
      }],
    },
    density: "verbose",
  }));
  // 详细 is DSH's 详细: a settled turn folds to its answer like every other mode.
  assert.match(verboseWork, /aria-label="展开工作过程"/);
  assert.doesNotMatch(verboseWork, /Shown in verbose mode/);
  assert.doesNotMatch(verboseWork, /src\/store\.ts/);
  assert.match(verboseWork, /Done\./);

  const verboseLive = renderToStaticMarkup(createElement(Message, {
    message: {
      id: "verbose-live",
      timestamp: 0,
      role: "assistant",
      content: "",
      thinking: "Shown in verbose mode",
      isStreaming: true,
      toolCalls: [{
        id: "read-5",
        name: "read",
        args: { path: "src/store.ts" },
        running: true,
      }],
    },
    isLastAssistant: true,
    globalStreaming: true,
    density: "verbose",
  }));
  // While it works, 详细 lists the rows inline with no group header.
  assert.match(verboseLive, /data-group-expanded-mode=""/);
  assert.doesNotMatch(verboseLive, /dshc-group-title/);
  assert.match(verboseLive, /Shown in verbose mode/);
  assert.match(words(verboseLive), /读取 src\/store\.ts/);

  const goalOnly = renderToStaticMarkup(createElement(Message, {
    message: {
      id: "goal-only-message",
      timestamp: 0,
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "goal-call",
        name: "functions.create_goal",
        args: { objective: "Keep goal state outside the transcript" },
        running: false,
      }],
    },
  }));

  assert.equal(goalOnly, "");

  assert.equal(isLiveAssistantWork(true, "", [{ running: false }]), true);
  assert.equal(isLiveAssistantWork(true, "Here is the answer.", [{ running: false }]), false);
  assert.equal(isLiveAssistantWork(true, "Here is the answer.", [{ running: true }]), true);
  assert.equal(isLiveAssistantWork(false, "", [{ running: true }]), false);
  assert.equal(foldWorkingLabel("Agent 正在工作…"), "正在工作…");
  assert.equal(foldWorkingLabel("正在压缩上下文"), "正在压缩上下文");

  const streamingAnswer = renderToStaticMarkup(createElement(Message, {
    message: {
      id: "assistant-streaming-answer",
      timestamp: 0,
      role: "assistant",
      content: "Here is the conclusion.",
      thinking: "I should fold once the answer starts.",
      isStreaming: true,
      toolCalls: [{
        id: "read-done",
        name: "read",
        args: { path: "README.md" },
        running: false,
      }],
    },
    isLastAssistant: true,
    globalStreaming: true,
    workingLabel: "Agent 正在工作…",
  }));
  assert.match(streamingAnswer, /正在写回答/);
  assert.doesNotMatch(streamingAnswer, /Agent 正在工作…/);
  // Once the answer streams, the group above it folds to its header; the answer streams below.
  assert.match(streamingAnswer, /class="dshc-group-title" aria-expanded="false"/);
  assert.doesNotMatch(streamingAnswer, /I should fold once the answer starts/);
  assert.match(streamingAnswer, /class="dshc-answer" data-streaming="true"/);
  assert.match(streamingAnswer, /Here is the conclusion/);

  const mergedSameFileEdits = renderToStaticMarkup(createElement(Message, {
    message: {
      id: "assistant-merged-edits",
      timestamp: 0,
      role: "assistant",
      content: "",
      isStreaming: true,
      toolCalls: [
        {
          id: "edit-1",
          name: "edit",
          args: { path: "src/App.tsx", old_string: "a", new_string: "b\nc" },
          running: false,
        },
        {
          id: "edit-2",
          name: "edit",
          args: { path: "src/App.tsx", old_string: "c", new_string: "d" },
          running: false,
        },
      ],
    },
    isLastAssistant: true,
    globalStreaming: true,
    density: "verbose",
  }));
  // Same-file edits read as one row whose stats are the edits' sum (dsh-claude-style D62).
  assert.equal((mergedSameFileEdits.match(/class="dshc-tool"/g) ?? []).length, 1);
  assert.match(words(mergedSameFileEdits), /编辑 src\/App\.tsx \+3 -2/);
});
