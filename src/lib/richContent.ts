export const RICH_CONTENT_LANGUAGE = "pidesktop-rich";
export const RICH_CONTENT_MAX_BYTES = 32 * 1024;

const MAX_BLOCKS = 12;
const MAX_GROUP_ITEMS = 12;
const MAX_TOTAL_ITEMS = 60;
const MAX_TOTAL_TEXT = 12_000;
const MAX_NESTING = 16;
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

export type RichTone = "neutral" | "info" | "success" | "warning" | "danger";
export type RichStepStatus = "done" | "active" | "pending";

export interface RichMetricsBlock {
  type: "metrics";
  title?: string;
  items: Array<{ label: string; value: string; detail?: string; tone?: RichTone }>;
}

export interface RichCalloutBlock {
  type: "callout";
  title?: string;
  body: string;
  tone?: RichTone;
}

export interface RichStepsBlock {
  type: "steps";
  title?: string;
  items: Array<{ title: string; description?: string; status?: RichStepStatus }>;
}

export interface RichComparisonBlock {
  type: "comparison";
  title?: string;
  columns: string[];
  rows: string[][];
}

export interface RichProgressBlock {
  type: "progress";
  title?: string;
  items: Array<{ label: string; value: number; detail?: string; tone?: RichTone }>;
}

export interface RichBarsBlock {
  type: "bars";
  title?: string;
  items: Array<{ label: string; value: number; max: number; unit?: string; tone?: RichTone }>;
}

export interface RichLinksBlock {
  type: "links";
  title?: string;
  items: Array<{ label: string; url: string; description?: string }>;
}

export type RichContentBlock =
  | RichMetricsBlock
  | RichCalloutBlock
  | RichStepsBlock
  | RichComparisonBlock
  | RichProgressBlock
  | RichBarsBlock
  | RichLinksBlock;

export interface RichContentDocument {
  version: 1;
  title?: string;
  summary?: string;
  blocks: RichContentBlock[];
}

interface ParseState {
  itemCount: number;
  textLength: number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: UnknownRecord, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new Error("unknown key");
}

function addItems(state: ParseState, count: number): void {
  state.itemCount += count;
  if (state.itemCount > MAX_TOTAL_ITEMS) throw new Error("too many items");
}

function readText(
  value: unknown,
  state: ParseState,
  maxLength: number,
  optional = false,
): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw new Error("text expected");
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || UNSAFE_TEXT.test(normalized)) throw new Error("invalid text");
  state.textLength += normalized.length;
  if (state.textLength > MAX_TOTAL_TEXT) throw new Error("too much text");
  return normalized;
}

function readTitle(value: UnknownRecord, state: ParseState): string | undefined {
  return readText(value.title, state, 80, true);
}

function readTone(value: unknown): RichTone | undefined {
  if (value === undefined) return undefined;
  if (value === "neutral" || value === "info" || value === "success" || value === "warning" || value === "danger") {
    return value;
  }
  throw new Error("invalid tone");
}

function readStatus(value: unknown): RichStepStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "done" || value === "active" || value === "pending") return value;
  throw new Error("invalid status");
}

function readNumber(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error("invalid number");
  }
  return value;
}

function readItems(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_GROUP_ITEMS) throw new Error("invalid items");
  return value;
}

function readHttpUrl(value: unknown, state: ParseState): string {
  const raw = readText(value, state, 2048);
  if (!raw || raw !== value) throw new Error("invalid url whitespace");
  const parsed = new URL(raw);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new Error("unsafe url");
  }
  if (parsed.href.length > 2048) throw new Error("url too long");
  return parsed.href;
}

function parseMetrics(value: UnknownRecord, state: ParseState): RichMetricsBlock {
  assertKeys(value, ["type", "title", "items"]);
  const items = readItems(value.items);
  addItems(state, items.length);
  return {
    type: "metrics",
    title: readTitle(value, state),
    items: items.map((item) => {
      if (!isRecord(item)) throw new Error("metric expected");
      assertKeys(item, ["label", "value", "detail", "tone"]);
      return {
        label: readText(item.label, state, 60)!,
        value: readText(item.value, state, 80)!,
        detail: readText(item.detail, state, 1000, true),
        tone: readTone(item.tone),
      };
    }),
  };
}

function parseCallout(value: UnknownRecord, state: ParseState): RichCalloutBlock {
  assertKeys(value, ["type", "title", "body", "tone"]);
  addItems(state, 1);
  return {
    type: "callout",
    title: readTitle(value, state),
    body: readText(value.body, state, 1000)!,
    tone: readTone(value.tone),
  };
}

function parseSteps(value: UnknownRecord, state: ParseState): RichStepsBlock {
  assertKeys(value, ["type", "title", "items"]);
  const items = readItems(value.items);
  addItems(state, items.length);
  return {
    type: "steps",
    title: readTitle(value, state),
    items: items.map((item) => {
      if (!isRecord(item)) throw new Error("step expected");
      assertKeys(item, ["title", "description", "status"]);
      return {
        title: readText(item.title, state, 120)!,
        description: readText(item.description, state, 1000, true),
        status: readStatus(item.status),
      };
    }),
  };
}

function parseComparison(value: UnknownRecord, state: ParseState): RichComparisonBlock {
  assertKeys(value, ["type", "title", "columns", "rows"]);
  if (!Array.isArray(value.columns) || value.columns.length < 2 || value.columns.length > 8) {
    throw new Error("invalid columns");
  }
  if (!Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 30) throw new Error("invalid rows");
  if (value.columns.length * value.rows.length > 240) throw new Error("too many cells");
  addItems(state, value.rows.length);
  const columns = value.columns.map((column) => readText(column, state, 80)!);
  const rows = value.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) throw new Error("row width mismatch");
    return row.map((cell) => readText(cell, state, 1000)!);
  });
  return { type: "comparison", title: readTitle(value, state), columns, rows };
}

function parseProgress(value: UnknownRecord, state: ParseState): RichProgressBlock {
  assertKeys(value, ["type", "title", "items"]);
  const items = readItems(value.items);
  addItems(state, items.length);
  return {
    type: "progress",
    title: readTitle(value, state),
    items: items.map((item) => {
      if (!isRecord(item)) throw new Error("progress item expected");
      assertKeys(item, ["label", "value", "detail", "tone"]);
      return {
        label: readText(item.label, state, 80)!,
        value: readNumber(item.value, 0, 100),
        detail: readText(item.detail, state, 1000, true),
        tone: readTone(item.tone),
      };
    }),
  };
}

function parseBars(value: UnknownRecord, state: ParseState): RichBarsBlock {
  assertKeys(value, ["type", "title", "items"]);
  const items = readItems(value.items);
  addItems(state, items.length);
  return {
    type: "bars",
    title: readTitle(value, state),
    items: items.map((item) => {
      if (!isRecord(item)) throw new Error("bar item expected");
      assertKeys(item, ["label", "value", "max", "unit", "tone"]);
      const max = readNumber(item.max, Number.MIN_VALUE, 1_000_000_000_000);
      return {
        label: readText(item.label, state, 80)!,
        value: readNumber(item.value, 0, max),
        max,
        unit: readText(item.unit, state, 20, true),
        tone: readTone(item.tone),
      };
    }),
  };
}

function parseLinks(value: UnknownRecord, state: ParseState): RichLinksBlock {
  assertKeys(value, ["type", "title", "items"]);
  const items = readItems(value.items);
  addItems(state, items.length);
  return {
    type: "links",
    title: readTitle(value, state),
    items: items.map((item) => {
      if (!isRecord(item)) throw new Error("link expected");
      assertKeys(item, ["label", "url", "description"]);
      return {
        label: readText(item.label, state, 120)!,
        url: readHttpUrl(item.url, state),
        description: readText(item.description, state, 1000, true),
      };
    }),
  };
}

function parseBlock(value: unknown, state: ParseState): RichContentBlock {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("invalid block");
  switch (value.type) {
    case "metrics": return parseMetrics(value, state);
    case "callout": return parseCallout(value, state);
    case "steps": return parseSteps(value, state);
    case "comparison": return parseComparison(value, state);
    case "progress": return parseProgress(value, state);
    case "bars": return parseBars(value, state);
    case "links": return parseLinks(value, state);
    default: throw new Error("unknown block");
  }
}

function hasExcessiveNesting(source: string): boolean {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of source) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_NESTING) return true;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
  return false;
}

function hasDuplicateObjectKeys(source: string): boolean {
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(source[index] || "")) index += 1;
  };
  const scanString = (): string => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const character = source[index++];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') return JSON.parse(source.slice(start, index)) as string;
    }
    throw new Error("unterminated string");
  };
  const scanValue = (): boolean => {
    skipWhitespace();
    if (source[index] === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[index] === "}") {
        index += 1;
        return false;
      }
      while (index < source.length) {
        skipWhitespace();
        if (source[index] !== '"') throw new Error("object key expected");
        const key = scanString();
        if (keys.has(key)) return true;
        keys.add(key);
        skipWhitespace();
        if (source[index++] !== ":") throw new Error("colon expected");
        if (scanValue()) return true;
        skipWhitespace();
        if (source[index] === "}") {
          index += 1;
          return false;
        }
        if (source[index++] !== ",") throw new Error("comma expected");
      }
      throw new Error("unterminated object");
    }
    if (source[index] === "[") {
      index += 1;
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return false;
      }
      while (index < source.length) {
        if (scanValue()) return true;
        skipWhitespace();
        if (source[index] === "]") {
          index += 1;
          return false;
        }
        if (source[index++] !== ",") throw new Error("comma expected");
      }
      throw new Error("unterminated array");
    }
    if (source[index] === '"') {
      scanString();
      return false;
    }
    while (index < source.length && !/[\s,}\]]/.test(source[index])) index += 1;
    return false;
  };
  return scanValue();
}

export function parseRichContent(source: string): RichContentDocument | null {
  try {
    if (typeof source !== "string" || new TextEncoder().encode(source).byteLength > RICH_CONTENT_MAX_BYTES) return null;
    if (hasExcessiveNesting(source)) return null;
    const parsed: unknown = JSON.parse(source);
    if (hasDuplicateObjectKeys(source) || !isRecord(parsed)) return null;
    assertKeys(parsed, ["version", "title", "summary", "blocks"]);
    if (parsed.version !== 1 || !Array.isArray(parsed.blocks) || parsed.blocks.length < 1 || parsed.blocks.length > MAX_BLOCKS) {
      return null;
    }
    const state: ParseState = { itemCount: 0, textLength: 0 };
    return {
      version: 1,
      title: readText(parsed.title, state, 80, true),
      summary: readText(parsed.summary, state, 240, true),
      blocks: parsed.blocks.map((block) => parseBlock(block, state)),
    };
  } catch {
    return null;
  }
}
