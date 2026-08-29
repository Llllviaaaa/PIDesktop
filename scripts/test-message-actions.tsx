import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Message } from "../src/components/Message";

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
