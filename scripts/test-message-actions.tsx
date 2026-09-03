import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isUserMessageOverLineLimit, Message, USER_MESSAGE_COLLAPSED_LINES } from "../src/components/Message";

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

assert.match(completedThinking, /aria-label="展开思考过程"/);
assert.match(completedThinking, /aria-expanded="false"/);
assert.doesNotMatch(completedThinking, /Internal reasoning details/);

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
console.log("message action tests passed");
