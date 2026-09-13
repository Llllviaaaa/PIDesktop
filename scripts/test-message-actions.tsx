import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  foldWorkingLabel,
  isLiveAssistantWork,
  isUserMessageOverLineLimit,
  Message,
  USER_MESSAGE_COLLAPSED_LINES,
} from "../src/components/Message";

assert.equal(isUserMessageOverLineLimit(20 * USER_MESSAGE_COLLAPSED_LINES, 20), false);
assert.equal(isUserMessageOverLineLimit(20 * USER_MESSAGE_COLLAPSED_LINES + 2, 20), false);
assert.equal(isUserMessageOverLineLimit(20 * USER_MESSAGE_COLLAPSED_LINES + 3, 20), true);
assert.equal(isUserMessageOverLineLimit(Number.NaN, 20), false);

const rendered = renderToStaticMarkup(createElement(Message, {
  message: {
    id: "user-message",
    entryId: "user-entry",
    role: "user",
    content: "Please update the implementation.",
    timestamp: 1,
  },
  onEdit: () => undefined,
  onRewind: async () => true,
}));

assert.match(rendered, /aria-label="编辑消息"/);
assert.match(rendered, /aria-label="回退消息和改动"/);
assert.match(rendered, /class="user-message-actions"/);
assert.match(rendered, /class="user-message-text"/);
assert.doesNotMatch(rendered, /class="user-message-expand"/);

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

assert.match(editing, /class="message-row user-message is-editing"/);
assert.match(editing, /class="message-edit-card"/);
assert.match(editing, /aria-label="编辑消息"/);
assert.match(editing, /rows="1"/);
assert.match(editing, /class="message-edit-submit"/);

const completedThinking = renderToStaticMarkup(createElement(Message, {
  message: {
    id: "assistant-thinking-message",
    role: "assistant",
    content: "The implementation is ready.",
    thinking: "Internal reasoning details",
    durationMs: 2_000,
  },
}));

assert.match(completedThinking, /class="work-log"/);
assert.match(completedThinking, /aria-label="展开工作过程"/);
assert.match(completedThinking, /aria-expanded="false"/);
assert.match(completedThinking, /耗时 2秒/);
assert.doesNotMatch(completedThinking, /Internal reasoning details/);
assert.doesNotMatch(completedThinking, /work-log-body/);

const completedTools = renderToStaticMarkup(createElement(Message, {
  message: {
    id: "assistant-tools-message",
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

assert.match(completedTools, /耗时 1秒/);
assert.doesNotMatch(completedTools, /读取 src\/App\.tsx/);
assert.doesNotMatch(completedTools, /"offset"/);
assert.doesNotMatch(completedTools, /export function App/);

const streamingWork = renderToStaticMarkup(createElement(Message, {
  message: {
    id: "assistant-streaming-work",
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

assert.match(streamingWork, /正在工作…/);
assert.match(streamingWork, /Planning the read/);
assert.match(streamingWork, /读取 README.md/);
assert.doesNotMatch(streamingWork, /"path"/);

const summaryWork = renderToStaticMarkup(createElement(Message, {
  message: {
    id: "assistant-summary",
    role: "assistant",
    content: "Done.",
    thinking: "Hidden in summary mode",
    toolCalls: [{
      id: "read-3",
      name: "read",
      args: { path: "src/store.ts" },
      running: false,
    }],
  },
  summaryMode: true,
}));

assert.match(summaryWork, /工作过程|耗时/);
assert.doesNotMatch(summaryWork, /Hidden in summary mode/);
assert.doesNotMatch(summaryWork, /读取 src\/store.ts/);
assert.doesNotMatch(summaryWork, /aria-label="展开工作过程"/);

const compaction = renderToStaticMarkup(createElement(Message, {
  message: {
    id: "compact-1",
    role: "notice",
    noticeKind: "compaction",
    content: "Context compacted\n\nOlder turns were summarized.",
    timestamp: 3,
  },
}));
assert.match(compaction, /class="compaction-divider is-compaction"/);
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
assert.match(verboseWork, /Shown in verbose mode/);
assert.match(verboseWork, /读取 src\/store.ts/);

const verboseEdit = renderToStaticMarkup(createElement(Message, {
  message: {
    id: "verbose-edit",
    role: "assistant",
    content: "Done.",
    thinking: "Edit the title.",
    toolCalls: [{
      id: "edit-v",
      name: "edit",
      args: { path: "src/App.tsx", old_string: "Pi", new_string: "Pi Desktop" },
      running: false,
    }],
  },
  density: "verbose",
}));
assert.match(verboseEdit, /编辑 src\/App\.tsx/);
assert.match(verboseEdit, /class="tool-diff"/);
assert.match(verboseEdit, /Pi Desktop/);
assert.doesNotMatch(verboseEdit, /"old_string"/);

const goalOnly = renderToStaticMarkup(createElement(Message, {
  message: {
    id: "goal-only-message",
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
assert.equal(foldWorkingLabel("Pi 正在工作…"), "正在工作…");
assert.equal(foldWorkingLabel("正在压缩上下文"), "正在压缩上下文");

const streamingAnswer = renderToStaticMarkup(createElement(Message, {
  message: {
    id: "assistant-streaming-answer",
    role: "assistant",
    content: "Here is the conclusion.",
    thinking: "I should hide this once the answer starts.",
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
  workingLabel: "Pi 正在工作…",
}));
assert.match(streamingAnswer, /正在工作…/);
assert.doesNotMatch(streamingAnswer, /Pi 正在工作…/);
assert.doesNotMatch(streamingAnswer, /I should hide this once the answer starts/);
assert.doesNotMatch(streamingAnswer, /读取 README.md/);
assert.match(streamingAnswer, /Here is the conclusion/);
assert.match(streamingAnswer, /aria-label="展开工作过程"/);

const streamingLiveTool = renderToStaticMarkup(createElement(Message, {
  message: {
    id: "assistant-live-tool",
    role: "assistant",
    content: "Still editing the file.",
    thinking: "Keep the live tool visible.",
    isStreaming: true,
    toolCalls: [{
      id: "edit-live",
      name: "edit",
      args: { path: "src/App.tsx" },
      running: true,
    }],
  },
  isLastAssistant: true,
  globalStreaming: true,
}));
assert.match(streamingLiveTool, /Keep the live tool visible/);
assert.match(streamingLiveTool, /编辑 src\/App\.tsx/);
assert.match(streamingLiveTool, /Still editing the file/);

console.log("message action tests passed");
