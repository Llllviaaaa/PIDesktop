import type { UiMessage } from "../types";

export interface CodeReviewComment {
  id: string;
  title: string;
  body: string;
  file: string;
  start: number | null;
  end: number | null;
  priority: number | null;
  messageId: string;
}

export type CodeReviewScope =
  | { mode: "uncommitted" }
  | { mode: "base-branch"; baseBranch: string };

const DIRECTIVE_RE = /::code-comment\{([^}\n]*)\}/g;
const ATTRIBUTE_RE = /([A-Za-z][\w-]*)=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s]+))/g;

function unescapeAttribute(value: string): string {
  return value.replace(/\\([\\"'])/g, "$1").replace(/\\n/g, "\n");
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let match: RegExpExecArray | null;
  ATTRIBUTE_RE.lastIndex = 0;
  while ((match = ATTRIBUTE_RE.exec(source)) !== null) {
    attributes[match[1]] = unescapeAttribute(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function positiveLine(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseCodeReviewComments(message: Pick<UiMessage, "id" | "content">): CodeReviewComment[] {
  const comments: CodeReviewComment[] = [];
  let match: RegExpExecArray | null;
  DIRECTIVE_RE.lastIndex = 0;
  while ((match = DIRECTIVE_RE.exec(message.content)) !== null) {
    const attributes = parseAttributes(match[1]);
    if (!attributes.title || !attributes.body || !attributes.file) continue;
    const start = positiveLine(attributes.start);
    const end = positiveLine(attributes.end) ?? start;
    const priority = attributes.priority === undefined ? null : Number.parseInt(attributes.priority, 10);
    comments.push({
      id: `${message.id}:${match.index}`,
      title: attributes.title,
      body: attributes.body,
      file: attributes.file,
      start,
      end,
      priority: Number.isFinite(priority) ? priority : null,
      messageId: message.id,
    });
  }
  return comments;
}

export function deriveCodeReviewComments(messages: UiMessage[]): CodeReviewComment[] {
  return messages
    .filter((message) => message.role === "assistant" && message.content.includes("::code-comment{"))
    .flatMap(parseCodeReviewComments);
}

function matchesReviewRequest(content: string, scope: CodeReviewScope): boolean {
  if (scope.mode === "uncommitted") {
    return content.includes("审查当前未提交的代码更改");
  }
  return content.includes("审查当前分支相对于基线分支") && content.includes(scope.baseBranch);
}

/** Keep inline findings attached to the latest review request for the visible diff source. */
export function deriveLatestCodeReviewComments(
  messages: UiMessage[],
  scope: CodeReviewScope | null,
): CodeReviewComment[] {
  if (!scope) return [];
  let requestIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && matchesReviewRequest(message.content, scope)) {
      requestIndex = index;
      break;
    }
  }
  if (requestIndex < 0) return [];
  return deriveCodeReviewComments(messages.slice(requestIndex + 1));
}

export function stripCodeReviewDirectives(content: string): string {
  return content
    .replace(DIRECTIVE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
