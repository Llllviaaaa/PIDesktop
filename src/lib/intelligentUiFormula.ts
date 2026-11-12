/**
 * The formula engine of Intelligent UI widgets (re-exported by intelligentUi.ts):
 * a zero-eval, CSP-safe recursive-descent parser for live formulas, stat
 * formatting and `{{ }}` template interpolation over a widget's state.
 */
import type { IntelligentUiStateMap, IntelligentUiStatItem } from "./intelligentUi";

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
