const DRAFT_OPENER = /(?:^|\n)(?:好的[，, ]*)?(?:我来(?:给你)?(?:整理|总结|说明|回答)|下面是|以下是)/;

const INCOMPLETE_TAIL = /\n+(?:#{1,6}\s*)?(?:\d+\.|[-*])\s*$/;

function isAnswerDraft(text: string, content?: string): boolean {
  const heading = text.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
  if (heading && content?.includes(heading)) return true;
  if (/^(?:好的[，,]?)?我来(?:给你)?(?:整理|总结|说明|回答)/.test(text)) return true;
  if (/^(?:下面是|以下是)/.test(text) && (content || "").trim().length > 40) return true;
  return false;
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
