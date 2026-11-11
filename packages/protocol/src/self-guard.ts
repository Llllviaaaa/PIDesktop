/**
 * Self-preservation command guard: detects shell / PowerShell / CMD / WMI
 * invocations that would terminate Qianji (`qianji` / `qianji-harness`) or its
 * live host PIDs while avoiding false positives on normal developer commands
 * such as `git commit -m "fix taskkill qianji"` or `rg qianji`.
 */

const SELF_KILL_REASON =
  "已拦截针对千机自身进程（qianji / qianji-harness）的终止命令，防止应用自杀闪退。";

const MAX_RECURSION_DEPTH = 6;

const BENIGN_TEXT_VERBS = new Set([
  "echo",
  "printf",
  "git",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "findstr",
  "cat",
  "type",
  "head",
  "tail",
  "wc",
  "ls",
  "dir",
]);

const COMMAND_PREFIX_WRAPPERS = new Set([
  "sudo",
  "nohup",
  "command",
  "builtin",
  "time",
  "nice",
]);

const UPSTREAM_PROCESS_QUERY_VERBS = new Set([
  "ps",
  "pgrep",
  "pidof",
  "tasklist",
  "get-process",
  "gps",
  "get-ciminstance",
  "gcim",
  "get-wmiobject",
  "gwmi",
  "wmic",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "findstr",
  "where-object",
  "where",
  "?",
  "awk",
  "gawk",
  "sed",
  "cut",
  "tr",
  "foreach-object",
  "foreach",
  "%",
  "select-object",
  "select",
]);

function decodeBase64Bytes(encoded: string): Uint8Array | undefined {
  const clean = encoded.trim().replace(/[\r\n\s]/g, "");
  if (clean.length === 0 || clean.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(clean)) {
    return undefined;
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === "=") break;
    const val = alphabet.indexOf(ch);
    if (val < 0) return undefined;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(output);
}

function decodeUtf16LeBase64(encoded: string): string | undefined {
  const bytes = decodeBase64Bytes(encoded);
  if (bytes === undefined || bytes.length < 2 || bytes.length % 2 !== 0) return undefined;
  let result = "";
  for (let i = 0; i < bytes.length; i += 2) {
    result += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  }
  return result;
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeVerb(raw: string): string {
  const unquoted = stripOuterQuotes(raw).trim();
  const slashIndex = Math.max(unquoted.lastIndexOf("/"), unquoted.lastIndexOf("\\"));
  const base = slashIndex >= 0 ? unquoted.slice(slashIndex + 1) : unquoted;
  return base.replace(/\.(?:exe|cmd|bat|com|ps1)$/i, "").toLowerCase();
}

/**
 * True if `token` (an argument, filter value, or pattern) targets the `qianji`
 * or `qianji-harness` process/binary rather than an unrelated file inside a
 * folder whose name happens to contain `qianji`.
 */
const QIANJI_IMAGE_PATTERN =
  /^\*?(?:qianji|qianji-harness)(?:-(?:x86_64|aarch64|i686)-[a-z0-9_-]+)?\*?(?:\.exe)?\*?$/i;

function unwrapTokenPunctuation(value: string): string {
  let cur = value.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = stripOuterQuotes(cur.replace(/^[(){}[\];]+|[(){}[\];]+$/g, "").trim());
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

function tokenTargetsQianjiProcess(rawToken: string): boolean {
  const cleaned = unwrapTokenPunctuation(rawToken);
  if (!cleaned) return false;

  // Handle key=value, /IM:qianji.exe, WMI/taskkill filters, and PowerShell scriptblock expressions.
  const filterParts = cleaned.split(/[\s=:,'"{}()[\];]+/).filter(Boolean);
  const candidates = filterParts.length > 1 ? [cleaned, ...filterParts] : [cleaned];

  for (const candidate of candidates) {
    const token = unwrapTokenPunctuation(candidate).replace(/^%+/, "*").replace(/%+$/, "*");
    if (!token || token.startsWith("-")) continue;

    const hasPathSep = token.includes("/") || token.includes("\\");
    if (hasPathSep) {
      const slash = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
      const base = token.slice(slash + 1);
      if (QIANJI_IMAGE_PATTERN.test(base)) {
        return true;
      }
      continue;
    }

    if (QIANJI_IMAGE_PATTERN.test(token)) {
      return true;
    }
  }
  return false;
}

function segmentMentionsQianjiProcess(tokens: readonly string[], rawSegment: string): boolean {
  if (tokens.some((token) => tokenTargetsQianjiProcess(token))) return true;
  if (
    /(?:imagename|name|commandline|processname|path)\s*(?:-?[ic]?(?:eq|like|match)|=)\s*['"]?[%*]?(?:qianji|qianji-harness)(?:-(?:x86_64|aarch64|i686)-[a-z0-9_-]+)?\*?(?:\.exe)?[%*]?['"]?/i.test(
      rawSegment,
    )
  ) {
    return true;
  }
  return /(?:name|processname|commandline|path)\s*\.\s*(?:contains|startswith|equals)\s*\(\s*['"](?:qianji|qianji-harness)(?:\.exe)?['"]/i.test(
    rawSegment,
  );
}

interface ParsedPipeline {
  segments: string[];
}

/**
 * Splits a shell script into top-level pipelines (`;`, `&&`, `||`, `&`, `\n`)
 * and pipeline segments (`|`) while respecting quotes and `(...)` nesting.
 */
function splitPipelines(input: string): ParsedPipeline[] {
  const pipelines: ParsedPipeline[] = [];
  let currentSegments: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  let parenDepth = 0;

  const flushSegment = () => {
    const trimmed = buf.trim();
    if (trimmed.length > 0) currentSegments.push(trimmed);
    buf = "";
  };

  const flushPipeline = () => {
    flushSegment();
    if (currentSegments.length > 0) {
      pipelines.push({ segments: currentSegments });
      currentSegments = [];
    }
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];

    if (quote !== null) {
      buf += ch;
      if (ch === "\\" && quote === '"' && (next === '"' || next === "\\" || next === "$" || next === "`")) {
        buf += next;
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }

    if (ch === "(") {
      parenDepth += 1;
      buf += ch;
      continue;
    }
    if (ch === ")" && parenDepth > 0) {
      parenDepth -= 1;
      buf += ch;
      continue;
    }

    if (parenDepth === 0) {
      if (ch === "\n" || ch === "\r" || ch === ";") {
        flushPipeline();
        continue;
      }
      if (ch === "&" && next === "&") {
        flushPipeline();
        i += 1;
        continue;
      }
      if (ch === "|" && next === "|") {
        flushPipeline();
        i += 1;
        continue;
      }
      if (ch === "|") {
        flushSegment();
        continue;
      }
      if (ch === "&") {
        // PowerShell call operator `& "cmd"` sits at the very start of a segment; background `&` sits after a command.
        if (buf.trim().length > 0 && next !== ">") {
          flushPipeline();
          continue;
        }
      }
    }

    buf += ch;
  }

  flushPipeline();
  return pipelines;
}

function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let parenDepth = 0;

  const push = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    const next = segment[i + 1];
    if (quote !== null) {
      if (ch === "\\" && quote === '"' && (next === '"' || next === "\\")) {
        current += next;
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      parenDepth += 1;
      current += ch;
      continue;
    }
    if (ch === ")" && parenDepth > 0) {
      parenDepth -= 1;
      current += ch;
      continue;
    }
    if (parenDepth === 0 && /\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return tokens;
}

function extractCommandSubstitutions(input: string): string[] {
  const results: string[] = [];
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\" && (next === "$" || next === "`" || next === '"' || next === "'")) {
      i += 1;
      continue;
    }
    if (ch === '"' && quote === '"') {
      quote = null;
      continue;
    }
    if (ch === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (ch === '"' && quote === null) {
      quote = '"';
      continue;
    }
    if (ch === "$" && next === "(") {
      let depth = 1;
      let j = i + 2;
      let innerQuote: "'" | '"' | null = null;
      while (j < input.length && depth > 0) {
        const c = input[j];
        if (innerQuote !== null) {
          if (c === innerQuote) innerQuote = null;
        } else if (c === "'" || c === '"') {
          innerQuote = c;
        } else if (c === "(") {
          depth += 1;
        } else if (c === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
        j += 1;
      }
      if (depth === 0) {
        results.push(input.slice(i + 2, j));
        i = j;
      }
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      while (j < input.length && input[j] !== "`") {
        if (input[j] === "\\") j += 1;
        j += 1;
      }
      if (j < input.length) {
        results.push(input.slice(i + 1, j));
        i = j;
      }
    }
  }
  return results;
}

function stripLeadingWrappers(tokens: readonly string[]): string[] {
  let idx = 0;
  while (idx < tokens.length) {
    const token = tokens[idx];
    if (token === "&" || token === ".") {
      idx += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      idx += 1;
      continue;
    }
    const lower = normalizeVerb(token);
    if (lower === "env") {
      idx += 1;
      while (idx < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]) || tokens[idx].startsWith("-"))) {
        idx += 1;
      }
      continue;
    }
    if (COMMAND_PREFIX_WRAPPERS.has(lower)) {
      idx += 1;
      if (lower === "nice" && idx < tokens.length && tokens[idx] === "-n") {
        idx += 2;
      }
      continue;
    }
    break;
  }
  return tokens.slice(idx);
}

function matchesProtectedPidToken(raw: string, protectedPids?: ReadonlySet<number>): boolean {
  const token = stripOuterQuotes(raw).trim();
  if (!token) return false;
  if (/^\$\{?PPID\}?$/.test(token)) return true;
  if (protectedPids === undefined || protectedPids.size === 0) return false;
  for (const part of token.split(",")) {
    const trimmed = part.trim();
    if (/^\d+$/.test(trimmed) && protectedPids.has(Number(trimmed))) {
      return true;
    }
  }
  return false;
}

function filterMatchesProtectedPid(filter: string, protectedPids?: ReadonlySet<number>): boolean {
  if (protectedPids === undefined || protectedPids.size === 0) return false;
  const cleaned = unwrapTokenPunctuation(filter);
  for (const pid of protectedPids) {
    if (new RegExp(`\\bpid\\s+eq\\s+${pid}\\b`, "i").test(cleaned)) return true;
  }
  return false;
}

function taskkillTargetsProtectedPid(args: readonly string[], protectedPids?: ReadonlySet<number>): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (/^(?:\/+|-)pid$/i.test(arg)) {
      if (i + 1 < args.length && matchesProtectedPidToken(args[i + 1], protectedPids)) return true;
      continue;
    }
    const colonMatch = /^(?:\/+|-)pid:(.*)$/i.exec(arg);
    if (colonMatch && matchesProtectedPidToken(colonMatch[1], protectedPids)) return true;
    if (/^(?:\/+|-)fi$/i.test(arg) && i + 1 < args.length) {
      if (filterMatchesProtectedPid(args[i + 1], protectedPids)) return true;
      continue;
    }
    const fiColonMatch = /^(?:\/+|-)fi:(.*)$/i.exec(arg);
    if (fiColonMatch) {
      const combined = i + 1 < args.length ? `${fiColonMatch[1]} ${args.slice(i + 1).join(" ")}` : fiColonMatch[1];
      if (filterMatchesProtectedPid(combined, protectedPids)) return true;
    }
  }
  return false;
}

function stopProcessTargetsProtectedPid(args: readonly string[], protectedPids?: ReadonlySet<number>): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (/^-id$/i.test(arg)) {
      if (i + 1 < args.length && matchesProtectedPidToken(args[i + 1], protectedPids)) return true;
      i += 1;
      continue;
    }
    if (!arg.startsWith("-") && matchesProtectedPidToken(arg, protectedPids)) {
      return true;
    }
  }
  return false;
}

function segmentTargetsProtectedPid(
  args: readonly string[],
  rawSegment: string,
  protectedPids?: ReadonlySet<number>,
): boolean {
  if (protectedPids === undefined || protectedPids.size === 0) return false;
  for (let i = 0; i < args.length; i += 1) {
    if (/^-(?:id|pid)$/i.test(args[i]) && i + 1 < args.length) {
      if (matchesProtectedPidToken(args[i + 1], protectedPids)) return true;
    }
  }
  const pidExprRe = /(?:\b(?:id|pid|processid)\b|\$_\.(?:id|processid))\s*(?:-?[ic]?eq|=)\s*['"]?(\d+)['"]?/gi;
  let match = pidExprRe.exec(rawSegment);
  while (match !== null) {
    if (protectedPids.has(Number(match[1]))) return true;
    match = pidExprRe.exec(rawSegment);
  }
  return false;
}

function isPosixZeroSignalProbe(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = stripOuterQuotes(args[i]);
    if (arg === "--") break;
    if (/^-(?:sig)?0$/i.test(arg) || /^--signal=(?:sig)?0$/i.test(arg)) {
      return true;
    }
    if ((arg === "-s" || arg === "-n" || arg === "--signal") && i + 1 < args.length) {
      if (/^(?:sig)?0$/i.test(stripOuterQuotes(args[i + 1]))) {
        return true;
      }
      i += 1;
    }
  }
  return false;
}

function posixKillTargetsProtectedPid(args: readonly string[], protectedPids?: ReadonlySet<number>): boolean {
  if (isPosixZeroSignalProbe(args)) return false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "-s" || arg === "-n" || arg === "--signal") {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (matchesProtectedPidToken(arg, protectedPids)) return true;
  }
  return false;
}

function extractShellWrapperScript(verb: string, args: readonly string[]): string | undefined {
  if (verb === "cmd") {
    for (let i = 0; i < args.length; i += 1) {
      if (/^(?:\/+|-)[ck]$/i.test(args[i])) {
        return args.slice(i + 1).join(" ");
      }
    }
    return undefined;
  }

  if (verb === "powershell" || verb === "pwsh") {
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (/^-(?:e|ec|enc|encodedcommand)$/i.test(arg)) {
        const encoded = args[i + 1];
        return encoded === undefined ? undefined : decodeUtf16LeBase64(encoded);
      }
      if (/^-(?:c|command)$/i.test(arg)) {
        return args.slice(i + 1).join(" ");
      }
      if (/^-(?:f|file)$/i.test(arg)) {
        return undefined;
      }
      if (/^-(?:w|windowstyle|ep|ex|executionpolicy|inputformat|outputformat)$/i.test(arg)) {
        i += 2;
        continue;
      }
      if (arg.startsWith("-")) {
        i += 1;
        continue;
      }
      return args.slice(i).join(" ");
    }
    return undefined;
  }

  if (verb === "bash" || verb === "sh" || verb === "zsh" || verb === "dash" || verb === "ash" || verb === "ksh") {
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === "-c" || /^-[a-zA-Z]*c$/.test(arg)) {
        return args[i + 1];
      }
    }
    return undefined;
  }

  if (verb === "eval") {
    return args.join(" ");
  }

  return undefined;
}

function extractXargsTarget(args: readonly string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      i += 1;
      break;
    }
    if (/^-(?:n|L|I|i|P|s|d|E|e|a)$/.test(arg)) {
      i += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  return args.slice(i);
}

function isZeroSignalLiteral(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const cleaned = stripOuterQuotes(raw.trim());
  return cleaned === "0" || cleaned.toUpperCase() === "SIG0";
}

function checkInlineRuntimeKill(
  verb: string,
  rawPipeline: string,
  protectedPids?: ReadonlySet<number>,
): boolean {
  if (BENIGN_TEXT_VERBS.has(verb)) return false;

  // PowerShell `(Get-Process qianji).Kill()` or `Get-Process qianji | ForEach-Object { $_.Kill() }`
  if (
    /\b(?:get-process|gps)\b[^;]*\bqianji(?:-harness)?(?:-(?:x86_64|aarch64|i686)-[a-z0-9_-]+)?(?:\.exe)?\b[^;]*\.\s*(?:kill|closemainwindow)\s*\(/i.test(
      rawPipeline,
    )
  ) {
    return true;
  }

  // .NET `[System.Diagnostics.Process]::GetProcessesByName('qianji')` with `.Kill()` / `Stop-Process`
  if (
    /\[(?:system\.)?diagnostics\.process\]::getprocessesbyname\s*\([^)]*\bqianji(?:-harness)?(?:-(?:x86_64|aarch64|i686)-[a-z0-9_-]+)?(?:\.exe)?\b[^)]*\)[^;]*(?:\.\s*(?:kill|closemainwindow)\s*\(|\b(?:stop-process|spps|kill)\b)/i.test(
      rawPipeline,
    )
  ) {
    return true;
  }

  // PowerShell `(Get-Process -Id <PID>).Kill()` or `[System.Diagnostics.Process]::GetProcessById(<PID>).Kill()`
  if (protectedPids !== undefined && protectedPids.size > 0) {
    const psPidKillRe =
      /(?:\b(?:get-process|gps)\b[^;]*?-id\s+(\d+)\b|\[(?:system\.)?diagnostics\.process\]::getprocessbyid\s*\(\s*(\d+)\s*\))[^;]*\.\s*(?:kill|closemainwindow)\s*\(/gi;
    let psMatch = psPidKillRe.exec(rawPipeline);
    while (psMatch !== null) {
      const pidNum = Number(psMatch[1] ?? psMatch[2]);
      if (protectedPids.has(pidNum)) return true;
      psMatch = psPidKillRe.exec(rawPipeline);
    }
  }

  // WMI / CIM process termination referencing qianji
  if (
    /\bwin32_process\b[^]*?\bqianji(?:-harness)?(?:-(?:x86_64|aarch64|i686)-[a-z0-9_-]+)?(?:\.exe)?\b[^]*?\b(?:terminate|remove-ciminstance|remove-wmiobject)\b/i.test(
      rawPipeline,
    )
  ) {
    return true;
  }

  // Inline `node -e "process.kill(process.ppid)"` or `python -c "os.kill(os.getppid(), 9)"`
  const ppidKillRe =
    /\b(?:process|os)\.kill\s*\(\s*(?:process\.ppid|os\.getppid\s*\(\s*\))(?:\s*,\s*([^)]+?))?\s*\)/g;
  let ppidMatch = ppidKillRe.exec(rawPipeline);
  while (ppidMatch !== null) {
    if (!isZeroSignalLiteral(ppidMatch[1])) return true;
    ppidMatch = ppidKillRe.exec(rawPipeline);
  }

  // Inline `node -e "process.kill(PID)"` or `python -c "os.kill(PID, ...)"` (excluding signal-0 probes)
  if (protectedPids !== undefined && protectedPids.size > 0) {
    const killCallRe = /\b(?:process|os)\.kill\s*\(\s*(\d+)\b(?:\s*,\s*([^)]+?))?\s*\)/g;
    let match = killCallRe.exec(rawPipeline);
    while (match !== null) {
      if (!isZeroSignalLiteral(match[2]) && protectedPids.has(Number(match[1]))) {
        return true;
      }
      match = killCallRe.exec(rawPipeline);
    }
  }

  return false;
}

/**
 * Returns a human-readable block reason when `command` attempts to kill
 * `qianji`, `qianji-harness`, or any PID in `protectedPids`; otherwise `undefined`.
 */
export function inspectSelfKillCommand(
  command: string,
  protectedPids?: ReadonlySet<number>,
  depth = 0,
): string | undefined {
  if (depth > MAX_RECURSION_DEPTH) return undefined;
  const trimmed = command.trim();
  if (!trimmed) return undefined;

  for (const sub of extractCommandSubstitutions(trimmed)) {
    const subViolation = inspectSelfKillCommand(sub, protectedPids, depth + 1);
    if (subViolation !== undefined) return subViolation;
  }

  for (const pipeline of splitPipelines(trimmed)) {
    let upstreamTargetsQianji = false;
    const rawPipeline = pipeline.segments.join(" | ");

    for (const rawSegment of pipeline.segments) {
      const strippedParen = rawSegment.trim();
      if (
        (strippedParen.startsWith("(") && strippedParen.endsWith(")")) ||
        (strippedParen.startsWith("{") && strippedParen.endsWith("}"))
      ) {
        const inner = strippedParen.slice(1, -1).trim();
        // Guard against `(Get-Process qianji).Kill()` which starts with `(` but closes before `.Kill()`
        if (inner && inspectSelfKillCommand(inner, protectedPids, depth + 1) !== undefined) {
          return SELF_KILL_REASON;
        }
      }

      const rawTokens = tokenizeSegment(rawSegment);
      const tokens = stripLeadingWrappers(rawTokens);
      if (tokens.length === 0) continue;

      const verb = normalizeVerb(tokens[0]);
      const args = tokens.slice(1);

      const nestedScript = extractShellWrapperScript(verb, args);
      if (nestedScript !== undefined) {
        const nestedViolation = inspectSelfKillCommand(nestedScript, protectedPids, depth + 1);
        if (nestedViolation !== undefined) return nestedViolation;
      }

      if (checkInlineRuntimeKill(verb, rawPipeline, protectedPids)) {
        return SELF_KILL_REASON;
      }

      if (verb === "xargs") {
        const target = extractXargsTarget(args);
        if (target.length > 0) {
          const targetVerb = normalizeVerb(target[0]);
          if (
            upstreamTargetsQianji &&
            (targetVerb === "kill" ||
              targetVerb === "taskkill" ||
              targetVerb === "tskill" ||
              targetVerb === "stop-process" ||
              targetVerb === "spps")
          ) {
            return SELF_KILL_REASON;
          }
          const xargsNested = inspectSelfKillCommand(target.join(" "), protectedPids, depth + 1);
          if (xargsNested !== undefined) return xargsNested;
        }
      }

      if (verb === "taskkill" || verb === "tskill") {
        if (segmentMentionsQianjiProcess(args, rawSegment) || taskkillTargetsProtectedPid(args, protectedPids)) {
          return SELF_KILL_REASON;
        }
        if (verb === "tskill" && args.some((arg) => matchesProtectedPidToken(arg, protectedPids))) {
          return SELF_KILL_REASON;
        }
      } else if (verb === "stop-process" || verb === "spps") {
        if (
          upstreamTargetsQianji ||
          segmentMentionsQianjiProcess(args, rawSegment) ||
          stopProcessTargetsProtectedPid(args, protectedPids)
        ) {
          return SELF_KILL_REASON;
        }
      } else if (verb === "pkill" || verb === "killall" || verb === "skill") {
        if (segmentMentionsQianjiProcess(args, rawSegment)) {
          return SELF_KILL_REASON;
        }
      } else if (verb === "kill") {
        // Covers POSIX `kill` (including `kill $(pgrep qianji)`) and PowerShell's `kill` alias for `Stop-Process`.
        if (!isPosixZeroSignalProbe(args)) {
          const substitutionTargetsQianji = extractCommandSubstitutions(rawSegment).some((sub) =>
            /\bqianji(?:-harness)?(?:-(?:x86_64|aarch64|i686)-[a-z0-9_-]+)?(?:\.exe)?\b/i.test(sub),
          );
          if (
            upstreamTargetsQianji ||
            substitutionTargetsQianji ||
            segmentMentionsQianjiProcess(args, rawSegment) ||
            posixKillTargetsProtectedPid(args, protectedPids) ||
            stopProcessTargetsProtectedPid(args, protectedPids)
          ) {
            return SELF_KILL_REASON;
          }
        }
      } else if (verb === "wmic") {
        const isProcessTarget = args.some((arg) => normalizeVerb(arg) === "process");
        const isDestructive = args.some((arg) => /^(?:delete|terminate)$/i.test(stripOuterQuotes(arg)));
        const targetsProtectedPid =
          protectedPids !== undefined &&
          Array.from(protectedPids).some((pid) =>
            new RegExp(`\\bprocessid\\s*=\\s*['"]?${pid}['"]?\\b`, "i").test(rawSegment),
          );
        if (isProcessTarget && isDestructive && (segmentMentionsQianjiProcess(args, rawSegment) || targetsProtectedPid)) {
          return SELF_KILL_REASON;
        }
      } else if (
        (verb === "invoke-cimmethod" || verb === "icim" || verb === "invoke-wmimethod" || verb === "iwmi") &&
        upstreamTargetsQianji &&
        args.some((arg) => /^terminate$/i.test(stripOuterQuotes(arg)))
      ) {
        return SELF_KILL_REASON;
      } else if ((verb === "remove-ciminstance" || verb === "rcim" || verb === "remove-wmiobject" || verb === "rwmi") && upstreamTargetsQianji) {
        return SELF_KILL_REASON;
      } else if (
        (verb === "foreach-object" || verb === "foreach" || verb === "%") &&
        upstreamTargetsQianji &&
        /\.\s*(?:kill|closemainwindow)\s*\(/i.test(rawSegment)
      ) {
        return SELF_KILL_REASON;
      }

      if (
        UPSTREAM_PROCESS_QUERY_VERBS.has(verb) &&
        (segmentMentionsQianjiProcess(args, rawSegment) ||
          segmentTargetsProtectedPid(args, rawSegment, protectedPids))
      ) {
        upstreamTargetsQianji = true;
      } else if (
        /\[(?:system\.)?diagnostics\.process\]::getprocessesbyname\s*\([^)]*\bqianji(?:-harness)?/i.test(
          rawSegment,
        )
      ) {
        upstreamTargetsQianji = true;
      }
    }
  }

  return undefined;
}

export function isSelfKillCommand(command: string, protectedPids?: ReadonlySet<number>): boolean {
  return inspectSelfKillCommand(command, protectedPids) !== undefined;
}
