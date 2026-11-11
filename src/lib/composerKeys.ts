/**
 * Keyboard shortcut resolution for chat textareas (`Composer` and message inline edit).
 *
 * Keeps `requireCtrlEnter` consistent across every prompt input:
 * - When `requireCtrlEnter` is OFF (default): plain `Enter` submits; `Shift+Enter`,
 *   `Ctrl+Enter`, `Cmd+Enter`, and `Alt+Enter` insert a newline instead of sending.
 * - When `requireCtrlEnter` is ON: `Ctrl+Enter` / `Cmd+Enter` submits; plain `Enter`
 *   and `Shift+Enter` insert a newline.
 */

export interface ChatEnterEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented?: boolean;
}

export interface ChatEnterOptions {
  requireCtrlEnter: boolean;
  hasActiveSuggestion?: boolean;
}

export type ChatEnterAction =
  | "ignore"
  | "accept-suggestion"
  | "submit"
  | "insert-newline";

/** Decide what `onKeyDown` on a chat textarea should do for `Enter` / `Tab`. */
export function resolveChatEnterAction(
  event: ChatEnterEventLike,
  options: ChatEnterOptions,
): ChatEnterAction {
  if (event.defaultPrevented) return "ignore";
  // Never steal Enter/Tab while an IME (e.g. Microsoft/Sogou Pinyin) is composing.
  if (event.isComposing || event.keyCode === 229) return "ignore";

  const mod = event.ctrlKey || event.metaKey;

  if (options.hasActiveSuggestion) {
    if (event.key === "Tab" && !mod && !event.altKey) {
      return "accept-suggestion";
    }
    if (event.key === "Enter" && !mod && !event.shiftKey && !event.altKey) {
      return "accept-suggestion";
    }
  }

  // Some Windows/Linux input layers emit "\n" for Ctrl+Enter; normal & numpad Enter emit "Enter".
  const isEnterKey = event.key === "Enter" || (mod && event.key === "\n");
  if (!isEnterKey) return "ignore";

  if (options.requireCtrlEnter) {
    if (mod && !event.shiftKey && !event.altKey) {
      return "submit";
    }
    // Native <textarea> inserts a newline on plain Enter and Shift+Enter, but not Alt+Enter.
    if (event.altKey && !mod && !event.shiftKey) {
      return "insert-newline";
    }
    return "ignore";
  }

  // Default mode (`requireCtrlEnter === false`): only unmodified Enter sends.
  if (!mod && !event.shiftKey && !event.altKey) {
    return "submit";
  }
  // Native <textarea> does not insert a newline on Ctrl/Cmd/Alt+Enter in Chromium/WebView2.
  if ((mod || event.altKey) && !event.shiftKey) {
    return "insert-newline";
  }
  return "ignore";
}

/** Insert `\n` over the current textarea selection and return the next value and caret index. */
export function insertNewlineAtSelection(
  value: string,
  selectionStart: number | null | undefined,
  selectionEnd: number | null | undefined,
): { value: string; caret: number } {
  const start = Math.max(0, Math.min(value.length, selectionStart ?? value.length));
  const end = Math.max(start, Math.min(value.length, selectionEnd ?? start));
  return {
    value: `${value.slice(0, start)}\n${value.slice(end)}`,
    caret: start + 1,
  };
}

/** Human-readable shortcut suffix for send button tooltips. */
export function formatSendShortcutHint(requireCtrlEnter: boolean): string {
  return requireCtrlEnter ? "Ctrl+Enter" : "Enter";
}
