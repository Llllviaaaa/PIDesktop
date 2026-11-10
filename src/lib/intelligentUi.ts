/**
 * Frontend Intelligent UI engine (`src/lib/intelligentUi.ts`).
 *
 * Powers Qianji's built-in `intelligent-ui` plugin with:
 * 1. Versioned widget extraction across session turns (`render_ui`, `update_ui`, and ```intelligent-ui fences)
 * 2. A zero-eval, CSP-safe recursive-descent expression parser for live formulas
 * 3. A Cool-Gray Minimalist sandboxed HTML escape pod (`sandbox="allow-scripts"` + `connect-src 'none'`)
 */
import type { UiMessage, UiToolCall } from "../types";
import { normalizedToolName } from "./toolPresentation";

export const INTELLIGENT_UI_FENCE_LANGUAGE = "intelligent-ui";
export const INTELLIGENT_UI_POSTMESSAGE_SOURCE = "pi-intelligent-ui";
export const INTELLIGENT_UI_CANVAS_TAB_ID = "intelligent-ui-canvas";
export const INTELLIGENT_UI_COMPOSER_ACTION_ID = "intelligent-ui-trigger";

export type IntelligentUiEngine = "declarative" | "html";
export type IntelligentUiStateValue = number | string | boolean;
export type IntelligentUiStateMap = Record<string, IntelligentUiStateValue>;

export interface IntelligentUiControlOption {
  label: string;
  value: string | number;
}

export interface IntelligentUiControlItem {
  key: string;
  label: string;
  kind: "slider" | "number" | "text" | "select" | "toggle";
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
  help?: string;
  options?: IntelligentUiControlOption[];
}

export interface IntelligentUiStatItem {
  label: string;
  formula?: string;
  value?: string | number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  caption?: string;
  tone?: "default" | "accent" | "good" | "warn";
}

export interface IntelligentUiChartDatum {
  label: string;
  value?: number;
  formula?: string;
  secondaryValue?: number;
  secondaryFormula?: string;
  tone?: "accent" | "muted" | "good" | "warn";
}

export interface IntelligentUiTableColumn {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
  sortable?: boolean;
}

export interface IntelligentUiChecklistItem {
  id: string;
  label: string;
  detail?: string;
  checked?: boolean;
}

export interface IntelligentUiTabItem {
  id: string;
  label: string;
  content?: string;
  blocks?: IntelligentUiBlock[];
}

export type IntelligentUiBlock =
  | {
      type: "controls";
      title?: string;
      columns?: number;
      items: IntelligentUiControlItem[];
    }
  | {
      type: "stats";
      title?: string;
      columns?: number;
      items: IntelligentUiStatItem[];
    }
  | {
      type: "chart";
      title?: string;
      subtitle?: string;
      kind?: "bar" | "line" | "area" | "donut";
      unit?: string;
      secondaryLabel?: string;
      height?: number;
      series: IntelligentUiChartDatum[];
    }
  | {
      type: "table";
      title?: string;
      searchable?: boolean;
      columns: IntelligentUiTableColumn[];
      rows: Array<Record<string, unknown>>;
    }
  | {
      type: "tabs";
      items: IntelligentUiTabItem[];
    }
  | {
      type: "form";
      title?: string;
      description?: string;
      submitLabel?: string;
      promptTemplate?: string;
      fields?: IntelligentUiControlItem[];
    }
  | {
      type: "callout";
      tone?: "neutral" | "info" | "warn" | "good";
      title?: string;
      body: string;
    }
  | {
      type: "checklist";
      title?: string;
      submitLabel?: string;
      promptTemplate?: string;
      items: IntelligentUiChecklistItem[];
    };

export interface IntelligentUiDeclarativeSpec {
  state?: IntelligentUiStateMap;
  blocks: IntelligentUiBlock[];
}

export interface IntelligentUiArtifact {
  id: string;
  version: number;
  title: string;
  subtitle?: string;
  engine: IntelligentUiEngine;
  spec?: IntelligentUiDeclarativeSpec;
  html?: string;
  updatedAt: string;
  running?: boolean;
}

export interface IntelligentUiVersionGroup {
  id: string;
  versions: IntelligentUiArtifact[];
  latest: IntelligentUiArtifact;
}

export interface TurnWidgetRef {
  id: string;
  version: number;
  action: "render" | "update" | "fence";
}

export interface SessionIntelligentUiSummary {
  groupsById: Map<string, IntelligentUiVersionGroup>;
  orderedGroups: IntelligentUiVersionGroup[];
  turnWidgetsByMessageId: Map<string, TurnWidgetRef[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeWidgetId(raw: unknown, fallback = "widget"): string {
  if (typeof raw !== "string") return fallback;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, 80);
}

function coerceStateMap(raw: unknown): IntelligentUiStateMap {
  if (!isRecord(raw)) return {};
  const result: IntelligentUiStateMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
    } else if (typeof value === "string" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

function parseDeclarativeSpec(raw: unknown): IntelligentUiDeclarativeSpec | undefined {
  let candidate: unknown = raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(candidate) || !Array.isArray(candidate.blocks) || candidate.blocks.length === 0) {
    return undefined;
  }
  const blocks = candidate.blocks.filter(
    (item): item is IntelligentUiBlock => isRecord(item) && typeof item.type === "string" && item.type.trim() !== "",
  );
  if (blocks.length === 0) return undefined;
  return {
    state: coerceStateMap(candidate.state),
    blocks,
  };
}

/**
 * Extracts initial default state for a declarative spec, combining `spec.state`
 * with sensible defaults inferred from `controls` / `form.fields`.
 */
export function buildInitialWidgetState(spec?: IntelligentUiDeclarativeSpec): IntelligentUiStateMap {
  if (!spec) return {};
  const merged: IntelligentUiStateMap = { ...(spec.state ?? {}) };
  const seedControl = (item: IntelligentUiControlItem) => {
    if (!item?.key || item.key in merged) return;
    if (item.kind === "toggle") {
      merged[item.key] = false;
    } else if (item.kind === "select") {
      const first = item.options?.[0]?.value;
      merged[item.key] = first !== undefined ? first : "";
    } else if (item.kind === "slider" || item.kind === "number") {
      merged[item.key] = typeof item.min === "number" ? item.min : 0;
    } else {
      merged[item.key] = "";
    }
  };
  const walkBlocks = (blocks: readonly IntelligentUiBlock[]) => {
    for (const block of blocks) {
      if (block.type === "controls" && Array.isArray(block.items)) {
        block.items.forEach(seedControl);
      } else if (block.type === "form" && Array.isArray(block.fields)) {
        block.fields.forEach(seedControl);
      } else if (block.type === "tabs" && Array.isArray(block.items)) {
        for (const tab of block.items) {
          if (Array.isArray(tab.blocks)) walkBlocks(tab.blocks);
        }
      }
    }
  };
  walkBlocks(spec.blocks);
  return merged;
}

/* ============================================================================
 * CSP-safe Recursive-Descent Formula Parser & Template Evaluator
 * ========================================================================== */

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "ident"; value: string }
  | { kind: "op"; value: string }
  | { kind: "punc"; value: "(" | ")" | "," | "?" | ":" };

const MULTI_CHAR_OPS = ["===", "!==", "==", "!=", "<=", ">=", "&&", "||", "**"] as const;
const SINGLE_CHAR_OPS = new Set(["+", "-", "*", "/", "%", "<", ">", "!"]);

function tokenizeFormula(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const len = input.length;

  while (index < len) {
    const ch = input.charAt(index);
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "," || ch === "?" || ch === ":") {
      tokens.push({ kind: "punc", value: ch });
      index += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      index += 1;
      let buf = "";
      while (index < len && input.charAt(index) !== quote) {
        if (input.charAt(index) === "\\" && index + 1 < len) {
          index += 1;
          buf += input.charAt(index);
        } else {
          buf += input.charAt(index);
        }
        index += 1;
      }
      index += 1;
      tokens.push({ kind: "str", value: buf });
      continue;
    }
    if (/\d/.test(ch) || (ch === "." && index + 1 < len && /\d/.test(input.charAt(index + 1)))) {
      let raw = "";
      while (index < len && /[\d._]/.test(input.charAt(index))) {
        if (input.charAt(index) !== "_") raw += input.charAt(index);
        index += 1;
      }
      if (index < len && (input.charAt(index) === "e" || input.charAt(index) === "E")) {
        raw += input.charAt(index);
        index += 1;
        if (index < len && (input.charAt(index) === "+" || input.charAt(index) === "-")) {
          raw += input.charAt(index);
          index += 1;
        }
        while (index < len && /\d/.test(input.charAt(index))) {
          raw += input.charAt(index);
          index += 1;
        }
      }
      tokens.push({ kind: "num", value: Number(raw) });
      continue;
    }

    let matchedMultiOp: string | undefined;
    for (const op of MULTI_CHAR_OPS) {
      if (input.startsWith(op, index)) {
        matchedMultiOp = op;
        break;
      }
    }
    if (matchedMultiOp) {
      tokens.push({ kind: "op", value: matchedMultiOp });
      index += matchedMultiOp.length;
      continue;
    }

    if (SINGLE_CHAR_OPS.has(ch)) {
      tokens.push({ kind: "op", value: ch });
      index += 1;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let ident = "";
      while (index < len && /[A-Za-z0-9_$.]/.test(input.charAt(index))) {
        ident += input.charAt(index);
        index += 1;
      }
      if (ident === "true") tokens.push({ kind: "bool", value: true });
      else if (ident === "false") tokens.push({ kind: "bool", value: false });
      else tokens.push({ kind: "ident", value: ident });
      continue;
    }

    throw new Error(`Unexpected character "${ch}"`);
  }

  return tokens;
}

type EvalValue = number | string | boolean;

const SAFE_FUNCTIONS: Record<string, (...args: EvalValue[]) => EvalValue> = {
  round: (x, digits) => {
    const n = Number(x);
    const d = digits !== undefined ? Math.max(0, Math.min(8, Math.trunc(Number(digits)))) : 0;
    const factor = 10 ** d;
    return Math.round(n * factor) / factor;
  },
  floor: (x) => Math.floor(Number(x)),
  ceil: (x) => Math.ceil(Number(x)),
  trunc: (x) => Math.trunc(Number(x)),
  abs: (x) => Math.abs(Number(x)),
  sqrt: (x) => Math.sqrt(Number(x)),
  pow: (x, y) => Math.pow(Number(x), Number(y)),
  exp: (x) => Math.exp(Number(x)),
  log: (x) => Math.log(Number(x)),
  log10: (x) => Math.log10(Number(x)),
  sin: (x) => Math.sin(Number(x)),
  cos: (x) => Math.cos(Number(x)),
  tan: (x) => Math.tan(Number(x)),
  min: (...xs) => Math.min(...xs.map(Number)),
  max: (...xs) => Math.max(...xs.map(Number)),
  clamp: (val, lo, hi) => Math.min(Number(hi), Math.max(Number(lo), Number(val))),
  fixed: (val, digits = 2) => Number(val).toFixed(Math.max(0, Math.min(8, Math.trunc(Number(digits))))),
  ifelse: (cond, a, b) => (cond ? a : b),
};

class FormulaParser {
  private pos = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly state: IntelligentUiStateMap,
  ) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token | undefined {
    const tok = this.tokens[this.pos];
    this.pos += 1;
    return tok;
  }

  private matchOp(...ops: string[]): string | undefined {
    const tok = this.peek();
    if (tok?.kind === "op" && ops.includes(tok.value)) {
      this.pos += 1;
      return tok.value;
    }
    return undefined;
  }

  private matchPunc(val: "(" | ")" | "," | "?" | ":"): boolean {
    const tok = this.peek();
    if (tok?.kind === "punc" && tok.value === val) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseExpression(): EvalValue {
    const value = this.parseTernary();
    if (this.pos < this.tokens.length) {
      throw new Error("Trailing tokens in expression");
    }
    return value;
  }

  private parseTernary(): EvalValue {
    const cond = this.parseLogicalOr();
    if (this.matchPunc("?")) {
      const whenTrue = this.parseTernary();
      if (!this.matchPunc(":")) throw new Error("Expected ':' in ternary");
      const whenFalse = this.parseTernary();
      return cond ? whenTrue : whenFalse;
    }
    return cond;
  }

  private parseLogicalOr(): EvalValue {
    let left = this.parseLogicalAnd();
    while (this.matchOp("||")) {
      const right = this.parseLogicalAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  private parseLogicalAnd(): EvalValue {
    let left = this.parseEquality();
    while (this.matchOp("&&")) {
      const right = this.parseEquality();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  private parseEquality(): EvalValue {
    let left = this.parseRelational();
    for (;;) {
      const op = this.matchOp("===", "!==", "==", "!=");
      if (!op) break;
      const right = this.parseRelational();
      if (op === "===" || op === "==") left = left === right || String(left) === String(right);
      else left = !(left === right || String(left) === String(right));
    }
    return left;
  }

  private parseRelational(): EvalValue {
    let left = this.parseAdditive();
    for (;;) {
      const op = this.matchOp("<", "<=", ">", ">=");
      if (!op) break;
      const right = this.parseAdditive();
      const ln = Number(left);
      const rn = Number(right);
      if (op === "<") left = ln < rn;
      else if (op === "<=") left = ln <= rn;
      else if (op === ">") left = ln > rn;
      else left = ln >= rn;
    }
    return left;
  }

  private parseAdditive(): EvalValue {
    let left = this.parseMultiplicative();
    for (;;) {
      const op = this.matchOp("+", "-");
      if (!op) break;
      const right = this.parseMultiplicative();
      if (op === "+") {
        if (typeof left === "string" || typeof right === "string") {
          left = `${left}${right}`;
        } else {
          left = Number(left) + Number(right);
        }
      } else {
        left = Number(left) - Number(right);
      }
    }
    return left;
  }

  private parseMultiplicative(): EvalValue {
    let left = this.parsePower();
    for (;;) {
      const op = this.matchOp("*", "/", "%");
      if (!op) break;
      const right = this.parsePower();
      const ln = Number(left);
      const rn = Number(right);
      if (op === "*") left = ln * rn;
      else if (op === "/") left = rn === 0 ? 0 : ln / rn;
      else left = rn === 0 ? 0 : ln % rn;
    }
    return left;
  }

  private parsePower(): EvalValue {
    const base = this.parseUnary();
    if (this.matchOp("**")) {
      const exp = this.parsePower();
      return Math.pow(Number(base), Number(exp));
    }
    return base;
  }

  private parseUnary(): EvalValue {
    const op = this.matchOp("+", "-", "!");
    if (op === "+") return +Number(this.parseUnary());
    if (op === "-") return -Number(this.parseUnary());
    if (op === "!") return !this.parseUnary();
    return this.parsePrimary();
  }

  private parsePrimary(): EvalValue {
    if (this.matchPunc("(")) {
      const inner = this.parseTernary();
      if (!this.matchPunc(")")) throw new Error("Unclosed '('");
      return inner;
    }

    const tok = this.consume();
    if (!tok) throw new Error("Unexpected end of expression");
    if (tok.kind === "num" || tok.kind === "str" || tok.kind === "bool") {
      return tok.value;
    }
    if (tok.kind === "ident") {
      const rawIdent = tok.value;
      const normalizedFn = rawIdent.startsWith("Math.") ? rawIdent.slice(5) : rawIdent;
      if (this.matchPunc("(")) {
        const args: EvalValue[] = [];
        if (!this.matchPunc(")")) {
          do {
            args.push(this.parseTernary());
          } while (this.matchPunc(","));
          if (!this.matchPunc(")")) throw new Error("Unclosed function arguments");
        }
        const fn = SAFE_FUNCTIONS[normalizedFn];
        if (!fn) return Number.NaN;
        return fn(...args);
      }
      if (rawIdent === "Math.PI" || rawIdent === "PI") return Math.PI;
      if (rawIdent === "Math.E" || rawIdent === "E") return Math.E;
      const stateKey = rawIdent.startsWith("state.") ? rawIdent.slice(6) : rawIdent;
      const stateVal = this.state[stateKey];
      if (stateVal !== undefined) {
        return stateVal;
      }
      return 0;
    }
    throw new Error("Invalid primary token");
  }
}

export function evaluateFormula(expression: string, state: IntelligentUiStateMap): EvalValue {
  const trimmed = expression.trim();
  if (!trimmed) return 0;
  try {
    const tokens = tokenizeFormula(trimmed);
    const parser = new FormulaParser(tokens, state);
    return parser.parseExpression();
  } catch {
    return Number.NaN;
  }
}

export function evaluateNumericFormula(expression: string | undefined, fallback: number | undefined, state: IntelligentUiStateMap): number {
  if (typeof expression === "string" && expression.trim()) {
    const val = Number(evaluateFormula(expression, state));
    return Number.isFinite(val) ? val : (fallback ?? 0);
  }
  return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : 0;
}

export function formatStatValue(
  item: Pick<IntelligentUiStatItem, "formula" | "value" | "prefix" | "suffix" | "decimals">,
  state: IntelligentUiStateMap,
): string {
  let raw: EvalValue;
  if (typeof item.formula === "string" && item.formula.trim()) {
    raw = evaluateFormula(item.formula, state);
  } else if (item.value !== undefined) {
    raw = typeof item.value === "string" ? interpolateTemplate(item.value, state) : item.value;
  } else {
    raw = 0;
  }

  let formatted: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      formatted = "—";
    } else if (typeof item.decimals === "number") {
      formatted = raw.toLocaleString("zh-CN", {
        minimumFractionDigits: item.decimals,
        maximumFractionDigits: item.decimals,
      });
    } else {
      formatted = Number.isInteger(raw)
        ? raw.toLocaleString("zh-CN")
        : raw.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
    }
  } else if (typeof raw === "boolean") {
    formatted = raw ? "是" : "否";
  } else {
    formatted = String(raw);
  }

  return `${item.prefix ?? ""}${formatted}${item.suffix ?? ""}`;
}

/**
 * Replaces `{=formula}` with computed values and `{key}` with `state[key]`.
 */
export function interpolateTemplate(template: string, state: IntelligentUiStateMap): string {
  return template.replace(/\{(=?)([^{}]+)\}/g, (full, isFormula: string, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return full;
    if (isFormula === "=") {
      const value = evaluateFormula(trimmed, state);
      if (typeof value === "number") {
        return Number.isFinite(value)
          ? (Number.isInteger(value) ? String(value) : value.toFixed(2))
          : "—";
      }
      return String(value);
    }
    if (trimmed in state) {
      return String(state[trimmed]);
    }
    return full;
  });
}

/* ============================================================================
 * Artifact Extraction & Version History Derivation
 * ========================================================================== */

function artifactFromDetails(details: unknown): IntelligentUiArtifact | null {
  if (!isRecord(details) || typeof details.id !== "string" || typeof details.title !== "string") {
    return null;
  }
  const engine: IntelligentUiEngine = details.engine === "html" ? "html" : "declarative";
  if (engine === "html") {
    if (typeof details.html !== "string" || !details.html.trim()) return null;
    return {
      id: normalizeWidgetId(details.id),
      version: typeof details.version === "number" && details.version > 0 ? details.version : 1,
      title: details.title.trim(),
      ...(typeof details.subtitle === "string" && details.subtitle.trim() ? { subtitle: details.subtitle.trim() } : {}),
      engine: "html",
      html: details.html,
      updatedAt: typeof details.updatedAt === "string" ? details.updatedAt : new Date(0).toISOString(),
    };
  }
  const spec = parseDeclarativeSpec(details.spec);
  if (!spec) return null;
  return {
    id: normalizeWidgetId(details.id),
    version: typeof details.version === "number" && details.version > 0 ? details.version : 1,
    title: details.title.trim(),
    ...(typeof details.subtitle === "string" && details.subtitle.trim() ? { subtitle: details.subtitle.trim() } : {}),
    engine: "declarative",
    spec,
    updatedAt: typeof details.updatedAt === "string" ? details.updatedAt : new Date(0).toISOString(),
  };
}

function artifactFromToolCall(
  call: UiToolCall,
  toolName: "render_ui" | "update_ui",
  previous: IntelligentUiArtifact | undefined,
  fallbackTimestamp: number,
): IntelligentUiArtifact | null {
  if (call.isError) return null;

  const fromDetails = artifactFromDetails(call.details);
  if (fromDetails) {
    return {
      ...fromDetails,
      version: previous ? Math.max(previous.version + 1, fromDetails.version) : fromDetails.version,
      running: call.running === true,
    };
  }

  const args = isRecord(call.args) ? call.args : {};
  const rawId = typeof args.id === "string" && args.id.trim() ? args.id : previous?.id;
  if (!rawId) return null;
  const id = normalizeWidgetId(rawId);
  const title = typeof args.title === "string" && args.title.trim()
    ? args.title.trim()
    : previous?.title;
  if (!title) return null;

  const subtitle = typeof args.subtitle === "string" && args.subtitle.trim()
    ? args.subtitle.trim()
    : previous?.subtitle;
  const hasHtml = typeof args.html === "string" && args.html.trim() !== "";
  const parsedSpec = parseDeclarativeSpec(args.spec);
  const engine: IntelligentUiEngine = args.engine === "html" || (hasHtml && !parsedSpec && args.engine !== "declarative")
    ? "html"
    : args.engine === "declarative" || parsedSpec
      ? "declarative"
      : previous?.engine ?? "declarative";

  const version = (previous?.version ?? 0) + 1;
  const updatedAt = new Date(call.finishedAt ?? call.startedAt ?? fallbackTimestamp).toISOString();

  if (engine === "html") {
    const html = hasHtml ? String(args.html).trim() : previous?.html;
    if (!html) return null;
    return {
      id,
      version,
      title,
      ...(subtitle ? { subtitle } : {}),
      engine: "html",
      html,
      updatedAt,
      running: call.running === true,
    };
  }

  let spec = parsedSpec ?? (previous?.spec ? { ...previous.spec, state: { ...(previous.spec.state ?? {}) } } : undefined);
  if (!spec) return null;
  if (toolName === "update_ui" && isRecord(args.state)) {
    spec = {
      ...spec,
      state: {
        ...(spec.state ?? {}),
        ...coerceStateMap(args.state),
      },
    };
  }

  return {
    id,
    version,
    title,
    ...(subtitle ? { subtitle } : {}),
    engine: "declarative",
    spec,
    updatedAt,
    running: call.running === true,
  };
}

export function parseIntelligentUiFence(rawText: string, fallbackId = "inline-widget"): IntelligentUiArtifact | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) return null;
    const id = normalizeWidgetId(parsed.id, fallbackId);
    const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "交互式组件";
    const subtitle = typeof parsed.subtitle === "string" && parsed.subtitle.trim() ? parsed.subtitle.trim() : undefined;
    if (parsed.engine === "html" || (typeof parsed.html === "string" && parsed.html.trim())) {
      return {
        id,
        version: 1,
        title,
        ...(subtitle ? { subtitle } : {}),
        engine: "html",
        html: String(parsed.html).trim(),
        updatedAt: new Date(0).toISOString(),
      };
    }
    const spec = parseDeclarativeSpec(parsed.spec ?? parsed);
    if (!spec) return null;
    return {
      id,
      version: 1,
      title,
      ...(subtitle ? { subtitle } : {}),
      engine: "declarative",
      spec,
      updatedAt: new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

function extractIntelligentUiFences(markdown: string, messageId: string): IntelligentUiArtifact[] {
  if (!markdown.includes(INTELLIGENT_UI_FENCE_LANGUAGE)) return [];
  const artifacts: IntelligentUiArtifact[] = [];
  const fenceRegex = /```intelligent-ui[ \t]*\r?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = fenceRegex.exec(markdown)) !== null) {
    index += 1;
    const artifact = parseIntelligentUiFence(match[1] ?? "", `fence-${messageId}-${index}`);
    if (artifact) artifacts.push(artifact);
  }
  return artifacts;
}

export function deriveSessionIntelligentUis(messages: readonly UiMessage[]): SessionIntelligentUiSummary {
  const groupsById = new Map<string, IntelligentUiVersionGroup>();
  const orderedIds: string[] = [];
  const turnWidgetsByMessageId = new Map<string, TurnWidgetRef[]>();

  const recordArtifact = (
    messageId: string,
    artifact: IntelligentUiArtifact,
    action: TurnWidgetRef["action"],
  ) => {
    let group = groupsById.get(artifact.id);
    if (!group) {
      group = {
        id: artifact.id,
        versions: [artifact],
        latest: artifact,
      };
      groupsById.set(artifact.id, group);
      orderedIds.push(artifact.id);
    } else {
      const nextVersion = group.versions.length + 1;
      const versioned: IntelligentUiArtifact = { ...artifact, version: nextVersion };
      group.versions.push(versioned);
      group.latest = versioned;
      artifact = versioned;
    }

    const turnList = turnWidgetsByMessageId.get(messageId) ?? [];
    const existingIdx = turnList.findIndex((item) => item.id === artifact.id);
    const nextRef: TurnWidgetRef = { id: artifact.id, version: artifact.version, action };
    if (existingIdx >= 0) {
      turnList[existingIdx] = nextRef;
    } else {
      turnList.push(nextRef);
    }
    turnWidgetsByMessageId.set(messageId, turnList);
  };

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const calls = message.toolCalls ?? [];
    const renderedIdsInTurn = new Set<string>();

    for (const call of calls) {
      const normalized = normalizedToolName(call.name);
      if (normalized !== "render_ui" && normalized !== "update_ui") continue;
      const rawId = isRecord(call.args) && typeof call.args.id === "string"
        ? normalizeWidgetId(call.args.id)
        : undefined;
      const previous = rawId ? groupsById.get(rawId)?.latest : undefined;
      const artifact = artifactFromToolCall(call, normalized, previous, message.timestamp);
      if (!artifact) continue;
      renderedIdsInTurn.add(artifact.id);
      recordArtifact(message.id, artifact, normalized === "render_ui" ? "render" : "update");
    }

    // Also register standalone ```intelligent-ui fences so they appear in the Canvas workbench too,
    // without duplicating widgets already emitted via tool calls in the same turn.
    if (message.content) {
      const fenced = extractIntelligentUiFences(message.content, message.id);
      for (const item of fenced) {
        if (renderedIdsInTurn.has(item.id)) continue;
        const previous = groupsById.get(item.id)?.latest;
        const artifact: IntelligentUiArtifact = {
          ...item,
          version: (previous?.version ?? 0) + 1,
          updatedAt: new Date(message.timestamp).toISOString(),
        };
        const existingGroup = groupsById.get(artifact.id);
        if (!existingGroup) {
          groupsById.set(artifact.id, { id: artifact.id, versions: [artifact], latest: artifact });
          orderedIds.push(artifact.id);
        } else {
          existingGroup.versions.push(artifact);
          existingGroup.latest = artifact;
        }
      }
    }
  }

  const orderedGroups: IntelligentUiVersionGroup[] = [];
  for (const id of orderedIds) {
    const grp = groupsById.get(id);
    if (grp) orderedGroups.push(grp);
  }

  return {
    groupsById,
    orderedGroups,
    turnWidgetsByMessageId,
  };
}

export function serializeWidgetSource(artifact: IntelligentUiArtifact): string {
  if (artifact.engine === "html") {
    return artifact.html ?? "";
  }
  return JSON.stringify(
    {
      id: artifact.id,
      title: artifact.title,
      ...(artifact.subtitle ? { subtitle: artifact.subtitle } : {}),
      engine: "declarative",
      spec: artifact.spec,
    },
    null,
    2,
  );
}

/* ============================================================================
 * Sandboxed HTML Escape Pod (`sandbox="allow-scripts"` + `data:text/html`)
 * ========================================================================== */

export function buildSandboxedWidgetHtml(options: {
  html: string;
  widgetId: string;
  title: string;
  isDark: boolean;
}): string {
  const { html, widgetId, title, isDark } = options;
  const paletteCss = isDark
    ? `
      --pi-bg: #141619;
      --pi-surface: #191c20;
      --pi-surface-soft: #1f2328;
      --pi-text: #e6e8ec;
      --pi-muted: #9aa1ac;
      --pi-subtle: #6b7280;
      --pi-border: rgba(255, 255, 255, 0.08);
      --pi-border-strong: rgba(255, 255, 255, 0.14);
      --pi-accent: #6687a8;
      --pi-accent-soft: rgba(102, 135, 168, 0.16);
      --pi-accent-text: #ffffff;
      --pi-good: #4ca378;
      --pi-warn: #c79a4b;
      --pi-bad: #c96565;
      color-scheme: dark;
    `
    : `
      --pi-bg: #ffffff;
      --pi-surface: #f7f8fa;
      --pi-surface-soft: #f0f2f5;
      --pi-text: #181a1e;
      --pi-muted: #5c6370;
      --pi-subtle: #8b93a1;
      --pi-border: rgba(15, 23, 42, 0.08);
      --pi-border-strong: rgba(15, 23, 42, 0.15);
      --pi-accent: #4c6a88;
      --pi-accent-soft: rgba(76, 106, 136, 0.12);
      --pi-accent-text: #ffffff;
      --pi-good: #2d7a56;
      --pi-warn: #9c6b19;
      --pi-bad: #b44444;
      color-scheme: light;
    `;

  const escapedTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const bridgeScript = `
(function () {
  var WIDGET_ID = ${JSON.stringify(widgetId)};
  var SOURCE = ${JSON.stringify(INTELLIGENT_UI_POSTMESSAGE_SOURCE)};
  var lastHeight = 0;
  var rafId = 0;
  function post(payload) {
    try {
      window.parent.postMessage(Object.assign({ source: SOURCE, widgetId: WIDGET_ID }, payload), "*");
    } catch (_) {}
  }
  function measure() {
    var root = document.getElementById("pi-widget-root") || document.body;
    if (!root) return;
    var rect = root.getBoundingClientRect();
    var h = Math.ceil(Math.max(root.scrollHeight, root.offsetHeight, rect.height, 96));
    if (Math.abs(h - lastHeight) > 1) {
      lastHeight = h;
      post({ kind: "resize", height: h });
    }
  }
  function scheduleMeasure() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      measure();
    });
  }
  window.piUI = Object.freeze({
    sendPrompt: function (text) {
      if (typeof text === "string" && text.trim()) {
        post({ kind: "prompt", prompt: text.trim() });
      }
    },
    notifyResize: measure
  });
  document.addEventListener("click", function (e) {
    var target = e.target && e.target.closest ? e.target.closest("[data-pi-prompt]") : null;
    if (!target) return;
    var promptText = target.getAttribute("data-pi-prompt");
    if (promptText && promptText.trim()) {
      e.preventDefault();
      window.piUI.sendPrompt(promptText);
    }
  });
  window.addEventListener("message", function (e) {
    var data = e && e.data;
    if (data && data.source === SOURCE && data.widgetId === WIDGET_ID && data.kind === "remeasure") {
      lastHeight = 0;
      measure();
    }
  });
  function attachObservers() {
    var root = document.getElementById("pi-widget-root") || document.body;
    if (typeof ResizeObserver !== "undefined" && root) {
      var ro = new ResizeObserver(scheduleMeasure);
      ro.observe(root);
      if (document.body && document.body !== root) ro.observe(document.body);
    }
    if (typeof MutationObserver !== "undefined" && root) {
      var mo = new MutationObserver(scheduleMeasure);
      mo.observe(root, { childList: true, subtree: true, attributes: true });
    }
    measure();
    setTimeout(measure, 60);
    setTimeout(measure, 240);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attachObservers);
  } else {
    attachObservers();
  }
  window.addEventListener("load", measure);
})();
`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; connect-src 'none';" />
<title>${escapedTitle}</title>
<style>
  :root {
    ${paletteCss}
    --pi-radius: 8px;
    --pi-font: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    --pi-mono: "JetBrains Mono", "Cascadia Mono", Consolas, monospace;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    color: var(--pi-text);
    font: 13px/1.55 var(--pi-font);
    -webkit-font-smoothing: antialiased;
  }
  #pi-widget-root {
    display: flow-root;
    padding: 14px 16px;
  }
  button, input, select, textarea {
    font: inherit;
    color: inherit;
  }
  button {
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--pi-border-strong);
    background: var(--pi-surface);
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
  }
  button:hover {
    background: var(--pi-surface-soft);
  }
  button.primary {
    background: var(--pi-accent);
    border-color: var(--pi-accent);
    color: var(--pi-accent-text);
  }
  input[type="text"], input[type="number"], select, textarea {
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--pi-border-strong);
    background: var(--pi-surface);
    outline: none;
  }
  input[type="range"] {
    accent-color: var(--pi-accent);
  }
  code, pre {
    font-family: var(--pi-mono);
  }
</style>
<script>${bridgeScript}</script>
</head>
<body>
<div id="pi-widget-root">${html}</div>
</body>
</html>`;
}

export function buildSandboxedWidgetDataUrl(options: {
  html: string;
  widgetId: string;
  title: string;
  isDark: boolean;
}): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildSandboxedWidgetHtml(options))}`;
}
