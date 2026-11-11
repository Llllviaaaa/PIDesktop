import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer } from "../src/components/Composer";
import { Message } from "../src/components/Message";
import {
  formatSendShortcutHint,
  insertNewlineAtSelection,
  resolveChatEnterAction,
  type ChatEnterEventLike,
} from "../src/lib/composerKeys";

function keyEvent(overrides: Partial<ChatEnterEventLike> = {}): ChatEnterEventLike {
  return {
    key: "Enter",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 13,
    defaultPrevented: false,
    ...overrides,
  };
}

describe("resolveChatEnterAction", () => {
  it("default mode (requireCtrlEnter = false): plain Enter submits, Ctrl/Cmd/Alt+Enter inserts newline, Shift+Enter lets textarea newline", () => {
    expect(resolveChatEnterAction(keyEvent(), { requireCtrlEnter: false })).toBe("submit");
    expect(resolveChatEnterAction(keyEvent({ shiftKey: true }), { requireCtrlEnter: false })).toBe("ignore");
    expect(resolveChatEnterAction(keyEvent({ ctrlKey: true }), { requireCtrlEnter: false })).toBe("insert-newline");
    expect(resolveChatEnterAction(keyEvent({ metaKey: true }), { requireCtrlEnter: false })).toBe("insert-newline");
    expect(resolveChatEnterAction(keyEvent({ altKey: true }), { requireCtrlEnter: false })).toBe("insert-newline");
    expect(resolveChatEnterAction(keyEvent({ key: "\n", ctrlKey: true }), { requireCtrlEnter: false })).toBe("insert-newline");
  });

  it("Ctrl+Enter mode (requireCtrlEnter = true): Ctrl/Cmd+Enter submits, plain Enter and Shift+Enter do not submit", () => {
    expect(resolveChatEnterAction(keyEvent(), { requireCtrlEnter: true })).toBe("ignore");
    expect(resolveChatEnterAction(keyEvent({ shiftKey: true }), { requireCtrlEnter: true })).toBe("ignore");
    expect(resolveChatEnterAction(keyEvent({ ctrlKey: true }), { requireCtrlEnter: true })).toBe("submit");
    expect(resolveChatEnterAction(keyEvent({ metaKey: true }), { requireCtrlEnter: true })).toBe("submit");
    expect(resolveChatEnterAction(keyEvent({ key: "\n", ctrlKey: true }), { requireCtrlEnter: true })).toBe("submit");
    expect(resolveChatEnterAction(keyEvent({ ctrlKey: true, shiftKey: true }), { requireCtrlEnter: true })).toBe("ignore");
    expect(resolveChatEnterAction(keyEvent({ altKey: true }), { requireCtrlEnter: true })).toBe("insert-newline");
  });

  it("never steals Enter or Tab during IME composition or when already defaultPrevented", () => {
    expect(resolveChatEnterAction(keyEvent({ isComposing: true }), { requireCtrlEnter: false })).toBe("ignore");
    expect(resolveChatEnterAction(keyEvent({ keyCode: 229 }), { requireCtrlEnter: false })).toBe("ignore");
    expect(resolveChatEnterAction(keyEvent({ ctrlKey: true, isComposing: true }), { requireCtrlEnter: true })).toBe("ignore");
    expect(
      resolveChatEnterAction(keyEvent({ isComposing: true }), {
        requireCtrlEnter: false,
        hasActiveSuggestion: true,
      }),
    ).toBe("ignore");
    expect(resolveChatEnterAction(keyEvent({ defaultPrevented: true }), { requireCtrlEnter: false })).toBe("ignore");
  });

  it("suggestion menu accepts plain Enter and Tab, but lets Ctrl/Cmd+Enter pass through", () => {
    expect(
      resolveChatEnterAction(keyEvent(), {
        requireCtrlEnter: false,
        hasActiveSuggestion: true,
      }),
    ).toBe("accept-suggestion");
    expect(
      resolveChatEnterAction(keyEvent(), {
        requireCtrlEnter: true,
        hasActiveSuggestion: true,
      }),
    ).toBe("accept-suggestion");
    expect(
      resolveChatEnterAction(keyEvent({ key: "Tab", keyCode: 9 }), {
        requireCtrlEnter: true,
        hasActiveSuggestion: true,
      }),
    ).toBe("accept-suggestion");
    expect(
      resolveChatEnterAction(keyEvent({ ctrlKey: true }), {
        requireCtrlEnter: true,
        hasActiveSuggestion: true,
      }),
    ).toBe("submit");
    expect(
      resolveChatEnterAction(keyEvent({ ctrlKey: true }), {
        requireCtrlEnter: false,
        hasActiveSuggestion: true,
      }),
    ).toBe("insert-newline");
  });
});

describe("insertNewlineAtSelection & UI shortcut hints", () => {
  it("inserts a newline at cursor or replaces selected text", () => {
    assert.deepEqual(insertNewlineAtSelection("hello world", 5, 5), {
      value: "hello\n world",
      caret: 6,
    });
    assert.deepEqual(insertNewlineAtSelection("hello world", 5, 11), {
      value: "hello\n",
      caret: 6,
    });
    assert.deepEqual(insertNewlineAtSelection("abc", null, null), {
      value: "abc\n",
      caret: 4,
    });
  });

  it("renders Composer and Message edit shortcut hints matching requireCtrlEnter", () => {
    expect(formatSendShortcutHint(false)).toBe("Enter");
    expect(formatSendShortcutHint(true)).toBe("Ctrl+Enter");

    const baseProps = {
      isStreaming: false,
      attachments: [],
      commands: [],
      models: [],
      model: null,
      thinkingLevel: "medium",
      thinkingLevels: ["medium"],
      pendingCount: 0,
      onSend: () => true,
      onStop: () => undefined,
      onPickAttachments: () => undefined,
      onRemoveAttachment: () => undefined,
      onModelChange: () => undefined,
      onThinkingChange: () => undefined,
    };

    const defaultComposer = renderToStaticMarkup(createElement(Composer, { ...baseProps, requireCtrlEnter: false }));
    expect(defaultComposer).toContain('title="发送 (Enter)"');
    expect(defaultComposer).not.toContain("Ctrl+Enter 发送");

    const ctrlEnterComposer = renderToStaticMarkup(createElement(Composer, { ...baseProps, requireCtrlEnter: true }));
    expect(ctrlEnterComposer).toContain('title="发送 (Ctrl+Enter)"');
    expect(ctrlEnterComposer).toContain("Ctrl+Enter 发送…");

    const editMessage = (requireCtrlEnter: boolean) =>
      renderToStaticMarkup(
        createElement(Message, {
          message: {
            id: "u1",
            entryId: "e1",
            role: "user",
            content: "Hello",
            timestamp: 1,
          },
          editing: true,
          requireCtrlEnter,
          onCancelEdit: () => undefined,
          onSubmitEdit: async () => true,
        }),
      );

    expect(editMessage(false)).toContain('title="从此消息重新发送 (Enter)"');
    expect(editMessage(true)).toContain('title="从此消息重新发送 (Ctrl+Enter)"');
  });
});
