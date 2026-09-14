/** PiDeck `ask_question` batch envelope. RPC can only open one input dialog, so the
 *  extension stuffs the questionnaire JSON into `ctx.ui.input(title, placeholder)`. */

export const BATCH_ASK_ENVELOPE_KEY = "__piDeckBatchAsk";
export const BATCH_ASK_PLACEHOLDER = "__piDeckBatchAsk__";

export type BatchAskType = "select" | "confirm" | "input" | "editor";

export interface BatchAskOption {
  label: string;
  value: string;
  description?: string;
}

export interface BatchAskQuestion {
  id: string;
  type: BatchAskType;
  question: string;
  options?: BatchAskOption[];
  allowOther?: boolean;
  placeholder?: string;
  prefill?: string;
}

export interface BatchAskEnvelope {
  questions: BatchAskQuestion[];
  review: boolean;
}

export interface BatchAskAnswer {
  id: string;
  type: string;
  value: string | boolean | null;
  label?: string;
  wasCustom?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asType(value: unknown): BatchAskType {
  return value === "select" || value === "confirm" || value === "editor" || value === "input"
    ? value
    : "input";
}

function normalizeOptions(options: unknown): BatchAskOption[] {
  if (!Array.isArray(options)) return [];
  return options.map((option) => {
    if (typeof option === "string") return { label: option, value: option };
    if (!isRecord(option)) return { label: "", value: "" };
    const label = String(option.label ?? "");
    return {
      label,
      value: String(option.value ?? label),
      ...(typeof option.description === "string" && option.description
        ? { description: option.description }
        : {}),
    };
  }).filter((option) => option.label || option.value);
}

function normalizeQuestion(raw: unknown, index: number): BatchAskQuestion | null {
  if (!isRecord(raw)) return null;
  const type = asType(raw.type);
  const question = String(raw.question ?? "").trim();
  if (!question) return null;
  return {
    id: String(raw.id ?? `q${index + 1}`),
    type,
    question,
    options: type === "select" ? normalizeOptions(raw.options) : undefined,
    allowOther: type === "select" ? raw.allowOther !== false : undefined,
    placeholder: typeof raw.placeholder === "string" ? raw.placeholder : undefined,
    prefill: typeof raw.prefill === "string" ? raw.prefill : undefined,
  };
}

export function parseBatchAskEnvelope(title: string, placeholder?: string): BatchAskEnvelope | null {
  const looksLikeEnvelope = title.includes(BATCH_ASK_ENVELOPE_KEY)
    || placeholder === BATCH_ASK_PLACEHOLDER;
  if (!looksLikeEnvelope) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(title);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed[BATCH_ASK_ENVELOPE_KEY] !== 1) return null;
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return null;
  const questions = parsed.questions
    .map((question, index) => normalizeQuestion(question, index))
    .filter((question): question is BatchAskQuestion => Boolean(question));
  if (questions.length === 0) return null;
  return { questions, review: parsed.review === true };
}

export function serializeBatchAskResponse(answers: BatchAskAnswer[], cancelled = false): string {
  return JSON.stringify(cancelled ? { cancelled: true, answers } : { answers });
}

export function batchAskHeadline(envelope: BatchAskEnvelope): string {
  if (envelope.questions.length === 1) return envelope.questions[0].question;
  return `需要回答 ${envelope.questions.length} 个问题`;
}

export function headlineForUiRequest(method: string, title?: string, placeholder?: string): string | undefined {
  if (method === "input" && title) {
    const batch = parseBatchAskEnvelope(title, placeholder);
    if (batch) return batchAskHeadline(batch);
  }
  return title || undefined;
}

export function isBatchAskComplete(envelope: BatchAskEnvelope, answers: Record<string, BatchAskAnswer>): boolean {
  return envelope.questions.every((question) => {
    const answer = answers[question.id];
    return answer != null && answer.value !== null && answer.value !== undefined && String(answer.value) !== "";
  });
}
