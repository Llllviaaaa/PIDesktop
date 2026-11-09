const DRAFT_OPENER = /(?:^|\n)(?:好的[，, ]*)?(?:我来(?:给你)?(?:整理|总结|说明|回答)|下面是|以下是)/;

const INCOMPLETE_TAIL = /\n+(?:#{1,6}\s*)?(?:\d+\.|[-*])\s*$/;
const LEADING_THINK_OPEN = /^\s*<think>(?:\r?\n)?/i;
const THINK_CLOSE = /<\/think>\s*/i;

function isAnswerDraft(text: string, content?: string): boolean {
  const heading = text.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  if (heading && content?.includes(heading)) return true;
  if (/^(?:好的[，,]?)?我来(?:给你)?(?:整理|总结|说明|回答)/.test(text)) return true;
  if (/^(?:下面是|以下是)/.test(text) && (content || "").trim().length > 40) return true;
  return false;
}

/**
 * Extract leading `<think>...</think>` (including unclosed `<think>...` while streaming)
 * emitted inside `content` by OpenAI-compatible relays, Ollama, vLLM, Qwen3, or DeepSeek proxies,
 * so `showThinking` consistently governs both native `thinking` deltas and inline `<think>` blocks.
 */
export function extractInlineThinking(
  content: string | undefined,
  existingThinking?: string | undefined,
): { content: string; thinking: string | undefined } {
  let remaining = content ?? "";
  const extracted: string[] = [];

  while (LEADING_THINK_OPEN.test(remaining)) {
    remaining = remaining.replace(LEADING_THINK_OPEN, "");
    const closeMatch = THINK_CLOSE.exec(remaining);
    if (!closeMatch) {
      const partial = remaining.trim();
      if (partial) extracted.push(partial);
      remaining = "";
      break;
    }
    const block = remaining.slice(0, closeMatch.index).trim();
    if (block) extracted.push(block);
    remaining = remaining.slice(closeMatch.index + closeMatch[0].length);
  }

  const base = (existingThinking ?? "").trim();
  const inlineText = extracted.join("\n\n").trim();
  const merged = base && inlineText
    ? (base.includes(inlineText) ? base : `${base}\n\n${inlineText}`)
    : (base || inlineText);

  return {
    content: remaining,
    thinking: merged || undefined,
  };
}

/** Work-log thinking: keep the plan, drop the unfinished answer draft Codex/Claude would never show. */
export function foldThinking(thinking: string | undefined, content?: string): string {
  let text = (thinking ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";

  const headingAt = text.search(/\n#{1,6}\s+\S/);
  if (headingAt > 0) text = text.slice(0, headingAt).trim();

  const draft = text.match(DRAFT_OPENER);
  if (draft && draft.index != null && draft.index > 24) {
    text = text.slice(0, draft.index).trim();
  }

  text = text.replace(INCOMPLETE_TAIL, "").trim();
  if (!text || isAnswerDraft(text, content)) return "";
  return text;
}
