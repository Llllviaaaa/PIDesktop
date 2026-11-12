import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CrashRecord, LogEntry, LogFileSummary, LogLevel, LogPlane } from "./types.ts";

/** Read at most the trailing 512 KB per file so queries stay well under 20 ms even on busy disks. */
export const MAX_LOG_TAIL_BYTES = 512 * 1024;
const MAX_INCIDENTS = 50;
const RECENT_SCAN_DAYS = 7;

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

const VALID_CRASH_KINDS = new Set<CrashRecord["kind"]>([
  "unclean_desktop_exit",
  "rust_panic",
  "webview_process_failed",
  "harness_unexpected_exit",
  "harness_crash_loop",
  "uncaughtException",
  "unhandledRejection",
  "startupFailure",
  "renderer_crash",
  "plugin_error",
]);

const VALID_CRASH_PLANES = new Set<CrashRecord["plane"]>(["desktop", "host", "webview"]);

const DESKTOP_LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})) (.*)$/;
const HOST_LINE_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+(debug|info|warn|error|fatal)\s+\[([^\]]+)\]\s?(.*)$/i;

const DESKTOP_SUPERVISOR_HARNESS_RE =
  /Harness Host (?:exited unexpectedly|did not start|reported no port|crashed|kept crashing)|failed to (?:start|poll|read|send settings to) (?:the )?Harness Host|KEEPS_CRASHING/i;

const CORDIS_STDERR_LINE_RE =
  /^(?:\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+)?\[([IWED])\]\s+([^\s]+)\s*(.*)$/;

const STACK_CONTINUATION_BODY_RE = /^(?:\s{2,}(?:at\b|\d+:)|Backtrace:$|Caused by:)/;

const LOG_FILE_DATE_RE = /^(?:desktop|host)-(\d{4}-\d{2}-\d{2})\.log$/;

export interface ParsedLogEntry extends LogEntry {
  mirroredStderr?: boolean;
}

export interface DiagnosticsSnapshot {
  logFiles: LogFileSummary[];
  availableDates: string[];
  todayEntries: LogEntry[];
  errorLogsToday: number;
  warnLogsToday: number;
  pluginErrorCounts: Record<string, number>;
  recentIncidents: CrashRecord[];
}

export function localDayString(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function levelMeetsMinimum(
  level: LogLevel,
  minLevel: "debug" | "info" | "warn" | "error",
): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[minLevel];
}

function isValidPluginId(candidate: string | undefined): candidate is string {
  if (candidate === undefined || candidate === "") return false;
  if (candidate === "http" || candidate === "https" || candidate === "file" || candidate === "node") {
    return false;
  }
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(candidate);
}

/** Extract attributed plugin ID from component tags, structured markers, or plugin path stack frames. */
export function extractPluginId(
  component: string,
  message: string,
  stack?: string,
): string | undefined {
  const slotMatch = /^plugin-slot:([a-z0-9][a-z0-9._-]{0,63}):/i.exec(component);
  if (isValidPluginId(slotMatch?.[1])) return slotMatch[1];

  const loadCompMatch = /^plugin-load:([a-z0-9][a-z0-9._-]{0,63})$/i.exec(component);
  if (isValidPluginId(loadCompMatch?.[1])) return loadCompMatch[1];

  const combined = stack ? `${component} ${message}\n${stack}` : `${component} ${message}`;

  const patterns: readonly RegExp[] = [
    /\bplugin-slot:([a-z0-9][a-z0-9._-]{0,63}):/i,
    /\bplugin-load:([a-z0-9][a-z0-9._-]{0,63})\b/i,
    /\bplugin=([a-z0-9][a-z0-9._-]{0,63})\b/i,
    /\(plugin:([a-z0-9][a-z0-9._-]{0,63})\)/i,
    /\bplugin:([a-z0-9][a-z0-9._-]{0,63})(?=[\s):,/]|$)/i,
    /\bplugin\s+"([a-z0-9][a-z0-9._-]{0,63})"/i,
  ];
  for (const re of patterns) {
    const match = re.exec(combined);
    if (isValidPluginId(match?.[1])) return match[1];
  }

  if (component === "plugins") {
    const pluginsLoggerPatterns: readonly RegExp[] = [
      /^plugin\s+([a-z0-9][a-z0-9._-]{0,63})\s+(?:import|apply|reload|rollback|compile|client)\b/i,
      /\bHMR sync failed for\s+([a-z0-9][a-z0-9._-]{0,63}):/i,
      /\bwatcher error for\s+([a-z0-9][a-z0-9._-]{0,63})\b/i,
      /\bcould not watch plugin\s+([a-z0-9][a-z0-9._-]{0,63})\b/i,
      /\bclient bundle compile failed for\s+([a-z0-9][a-z0-9._-]{0,63})\b/i,
    ];
    for (const re of pluginsLoggerPatterns) {
      const match = re.exec(message);
      if (isValidPluginId(match?.[1])) return match[1];
    }
  }

  const stackPathMatch = /[/\\](?:bundled-plugins|plugins)[/\\]([a-z0-9][a-z0-9._-]{0,63})[/\\]/i.exec(
    combined,
  );
  if (isValidPluginId(stackPathMatch?.[1])) return stackPathMatch[1];

  return undefined;
}

/** Read trailing bytes of a text file safely, discarding a partial first line when truncated. */
export function readTailUtf8(filePath: string, maxBytes = MAX_LOG_TAIL_BYTES): string {
  if (!existsSync(filePath)) return "";
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    if (size <= 0) return "";
    const readOffset = size > maxBytes ? size - maxBytes : 0;
    const length = size - readOffset;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, readOffset);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (readOffset > 0) {
      const firstNewline = text.indexOf("\n");
      return firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

export function listLogFileSummaries(logsDir: string): LogFileSummary[] {
  if (!existsSync(logsDir)) return [];
  try {
    const items: LogFileSummary[] = [];
    for (const name of readdirSync(logsDir)) {
      if (!name.endsWith(".log") && !name.endsWith(".jsonl")) continue;
      try {
        const st = statSync(join(logsDir, name));
        if (!st.isFile()) continue;
        items.push({
          name,
          sizeBytes: st.size,
          updatedAt: st.mtime.toISOString(),
        });
      } catch {
        // File rotated concurrently; skip.
      }
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

export function listAvailableLogDates(logsDir: string): string[] {
  if (!existsSync(logsDir)) return [];
  try {
    const dates = new Set<string>();
    for (const name of readdirSync(logsDir)) {
      const match = LOG_FILE_DATE_RE.exec(name);
      if (match?.[1] !== undefined) {
        dates.add(match[1]);
      }
    }
    return [...dates].sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

function parseTimestampEpoch(ts: string): number {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

function classifyDesktopBody(rawBody: string): {
  plane: LogPlane;
  level: LogLevel;
  component: string;
  message: string;
  mirroredStderr?: boolean;
} {
  if (rawBody.startsWith("[panic]")) {
    return {
      plane: "desktop",
      level: "fatal",
      component: "panic",
      message: rawBody.slice("[panic]".length).trim() || rawBody,
    };
  }

  if (rawBody.startsWith("[webview]")) {
    const msg = rawBody.slice("[webview]".length).trim();
    const level: LogLevel = /circuit_broken/i.test(msg)
      ? "fatal"
      : /ProcessFailed|failed|crash|error/i.test(msg)
        ? "error"
        : /unresponsive|warn|reload|recover/i.test(msg)
          ? "warn"
          : "info";
    return {
      plane: "webview",
      level,
      component: "webview",
      message: msg || rawBody,
    };
  }

  const rendererMatch = /^\[renderer:(error|warn)\]\s*(?:\(([^)]+)\)\s*)?(.*)$/i.exec(rawBody);
  if (rendererMatch !== null) {
    const sev = (rendererMatch[1] ?? "error").toLowerCase() === "warn" ? "warn" : "error";
    const sourceLabel = (rendererMatch[2] ?? "").trim() || "renderer";
    const msg = (rendererMatch[3] ?? "").trim() || rawBody;
    return {
      plane: "renderer",
      level: sev,
      component: sourceLabel,
      message: msg,
    };
  }

  if (rawBody.startsWith("[desktop]")) {
    const msg = rawBody.slice("[desktop]".length).trim();
    const level: LogLevel = /exited uncleanly|unclean|panic|fatal|error|failed/i.test(msg)
      ? "error"
      : /warn/i.test(msg)
        ? "warn"
        : "info";
    return {
      plane: "desktop",
      level,
      component: "desktop",
      message: msg || rawBody,
    };
  }

  if (rawBody.startsWith("[harness]")) {
    const rest = rawBody.slice("[harness]".length).trim();
    if (DESKTOP_SUPERVISOR_HARNESS_RE.test(rest)) {
      const level: LogLevel = /KEEPS_CRASHING|kept crashing|crashed repeatedly/i.test(rest)
        ? "fatal"
        : "error";
      return {
        plane: "desktop",
        level,
        component: "harness",
        message: rest,
        mirroredStderr: false,
      };
    }

    const cordisMatch = CORDIS_STDERR_LINE_RE.exec(rest);
    if (cordisMatch !== null) {
      const code = cordisMatch[1];
      const loggerName = cordisMatch[2] ?? "harness";
      const text = (cordisMatch[3] ?? "").trim();
      const level: LogLevel =
        code === "E" ? "error" : code === "W" ? "warn" : code === "D" ? "debug" : "info";
      return {
        plane: "host",
        level,
        component: loggerName,
        message: text || rest,
        mirroredStderr: true,
      };
    }

    const mirroredLevel: LogLevel =
      /uncaughtException|unhandledRejection|startupFailure|\berror\b|circuit-breaking/i.test(rest)
        ? "error"
        : /\bwarn(?:ing)?\b/i.test(rest)
          ? "warn"
          : "info";
    return {
      plane: "host",
      level: mirroredLevel,
      component: "harness",
      message: rest || rawBody,
      mirroredStderr: true,
    };
  }

  const fallbackCordis = CORDIS_STDERR_LINE_RE.exec(rawBody);
  if (fallbackCordis !== null) {
    const code = fallbackCordis[1];
    return {
      plane: "host",
      level: code === "E" ? "error" : code === "W" ? "warn" : code === "D" ? "debug" : "info",
      component: fallbackCordis[2] ?? "host",
      message: (fallbackCordis[3] ?? "").trim() || rawBody,
      mirroredStderr: true,
    };
  }

  const inferredLevel: LogLevel = /\bfatal\b/i.test(rawBody)
    ? "fatal"
    : /\b(?:error|failed|panic)\b/i.test(rawBody)
      ? "error"
      : /\bwarn(?:ing)?\b/i.test(rawBody)
        ? "warn"
        : "info";

  return {
    plane: "desktop",
    level: inferredLevel,
    component: "desktop",
    message: rawBody,
  };
}

function finalizeEntry(draft: ParsedLogEntry, stackLines: string[]): ParsedLogEntry {
  if (stackLines.length > 0) {
    draft.stack = stackLines.join("\n");
  }
  const attributed = extractPluginId(draft.component, draft.message, draft.stack);
  if (attributed !== undefined) {
    draft.pluginId = attributed;
  }
  return draft;
}

export function parseDesktopLogText(content: string, fileName: string): ParsedLogEntry[] {
  if (content === "") return [];
  const rawLines = content.split(/\r?\n/);
  const entries: ParsedLogEntry[] = [];
  let current: ParsedLogEntry | undefined;
  let stackLines: string[] = [];
  let seq = 0;

  for (const line of rawLines) {
    if (line === "" && current === undefined) continue;
    const match = DESKTOP_LINE_RE.exec(line);
    if (match === null) {
      if (current !== undefined && line !== "") {
        stackLines.push(line);
      }
      continue;
    }

    const timestamp = match[1] ?? "";
    const body = match[2] ?? "";

    // Sidecar stderr or multi-line outputs forwarded line-by-line can carry a fresh timestamp
    // followed immediately by indented stack frames (`    at ...`) or `Backtrace:`.
    if (current !== undefined && STACK_CONTINUATION_BODY_RE.test(body)) {
      stackLines.push(body);
      continue;
    }

    if (current !== undefined) {
      entries.push(finalizeEntry(current, stackLines));
      stackLines = [];
    }

    if (body.trim() === "") {
      current = undefined;
      continue;
    }

    seq += 1;
    const classified = classifyDesktopBody(body);
    current = {
      id: `${fileName}:${seq}`,
      timestamp,
      epochMs: parseTimestampEpoch(timestamp),
      plane: classified.plane,
      level: classified.level,
      component: classified.component,
      message: classified.message,
      file: fileName,
      ...(classified.mirroredStderr === true ? { mirroredStderr: true } : {}),
    };
  }

  if (current !== undefined) {
    entries.push(finalizeEntry(current, stackLines));
  }
  return entries;
}

export function parseHostLogText(content: string, fileName: string): ParsedLogEntry[] {
  if (content === "") return [];
  const rawLines = content.split(/\r?\n/);
  const entries: ParsedLogEntry[] = [];
  let current: ParsedLogEntry | undefined;
  let stackLines: string[] = [];
  let seq = 0;

  for (const line of rawLines) {
    if (line === "" && current === undefined) continue;
    const match = HOST_LINE_RE.exec(line);
    if (match === null) {
      if (current !== undefined && line !== "") {
        stackLines.push(line);
      }
      continue;
    }

    if (current !== undefined) {
      entries.push(finalizeEntry(current, stackLines));
      stackLines = [];
    }

    const timestamp = match[1] ?? "";
    const rawLevel = (match[2] ?? "info").toLowerCase() as LogLevel;
    const component = (match[3] ?? "host").trim() || "host";
    const message = (match[4] ?? "").trim();

    seq += 1;
    current = {
      id: `${fileName}:${seq}`,
      timestamp,
      epochMs: parseTimestampEpoch(timestamp),
      plane: "host",
      level: rawLevel in LEVEL_RANK ? rawLevel : "info",
      component,
      message,
      file: fileName,
    };
  }

  if (current !== undefined) {
    entries.push(finalizeEntry(current, stackLines));
  }
  return entries;
}

function stripInternalFlags(entry: ParsedLogEntry): LogEntry {
  const { mirroredStderr: _ignored, ...clean } = entry;
  return clean;
}

/** Merge disk logs for `date` with optional live in-memory entries, deduplicating mirrored lines. */
export function loadDateLogEntries(
  logsDir: string,
  date: string,
  dedupeMirroredStderr: boolean,
  liveEntries: readonly LogEntry[] = [],
): LogEntry[] {
  const desktopFile = `desktop-${date}.log`;
  const hostFile = `host-${date}.log`;
  const desktopPath = join(logsDir, desktopFile);
  const hostPath = join(logsDir, hostFile);

  const desktopParsed = parseDesktopLogText(readTailUtf8(desktopPath), desktopFile);
  const hostParsed = parseHostLogText(readTailUtf8(hostPath), hostFile);
  const hasHostSource = hostParsed.length > 0 || existsSync(hostPath);

  const merged: Array<{ entry: LogEntry; order: number }> = [];
  let order = 0;

  for (const item of desktopParsed) {
    if (dedupeMirroredStderr && hasHostSource && item.mirroredStderr === true) {
      continue;
    }
    order += 1;
    merged.push({ entry: stripInternalFlags(item), order });
  }

  for (const item of hostParsed) {
    order += 1;
    merged.push({ entry: stripInternalFlags(item), order });
  }

  // Merge live in-memory exporter entries that have not yet flushed or when running without logFileExporter.
  for (const live of liveEntries) {
    const duplicateOnDisk = hostParsed.some(
      (disk) =>
        disk.component === live.component
        && disk.level === live.level
        && disk.message === live.message
        && Math.abs(disk.epochMs - live.epochMs) <= 2_000,
    );
    if (!duplicateOnDisk) {
      order += 1;
      merged.push({ entry: live, order });
    }
  }

  merged.sort((a, b) => a.entry.epochMs - b.entry.epochMs || a.order - b.order);
  return merged.map((item) => item.entry);
}

function parseJsonlCrashFile(filePath: string, fallbackPlane: CrashRecord["plane"]): CrashRecord[] {
  const text = readTailUtf8(filePath);
  if (text === "") return [];
  const records: CrashRecord[] = [];
  let idx = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    idx += 1;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed !== "object" || parsed === null) continue;
      const rawKind = typeof parsed.kind === "string" ? parsed.kind : "";
      if (!VALID_CRASH_KINDS.has(rawKind as CrashRecord["kind"])) continue;
      const rawPlane = typeof parsed.plane === "string" ? parsed.plane : fallbackPlane;
      const plane: CrashRecord["plane"] = VALID_CRASH_PLANES.has(rawPlane as CrashRecord["plane"])
        ? (rawPlane as CrashRecord["plane"])
        : fallbackPlane;
      const timestamp = typeof parsed.timestamp === "string" && parsed.timestamp !== ""
        ? parsed.timestamp
        : new Date(0).toISOString();
      const summary = typeof parsed.summary === "string" && parsed.summary.trim() !== ""
        ? parsed.summary.trim()
        : rawKind;
      const detail = typeof parsed.detail === "string" && parsed.detail.trim() !== ""
        ? parsed.detail
        : undefined;
      const explicitPlugin = typeof parsed.pluginId === "string" && isValidPluginId(parsed.pluginId)
        ? parsed.pluginId
        : extractPluginId(rawKind, summary, detail);
      records.push({
        v: 1,
        id: typeof parsed.id === "string" && parsed.id !== "" ? parsed.id : `jsonl:${plane}:${idx}`,
        timestamp,
        plane,
        kind: rawKind as CrashRecord["kind"],
        summary,
        ...(detail === undefined ? {} : { detail }),
        ...(explicitPlugin === undefined ? {} : { pluginId: explicitPlugin }),
        ...(typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode)
          ? { exitCode: parsed.exitCode }
          : {}),
        ...(typeof parsed.pid === "number" && Number.isFinite(parsed.pid) ? { pid: parsed.pid } : {}),
      });
    } catch {
      // Skip malformed JSONL lines gracefully.
    }
  }
  return records;
}

function deriveIncidentFromLogEntry(entry: LogEntry): CrashRecord | undefined {
  if (entry.plane === "desktop" && entry.component === "panic") {
    const pidMatch = /\bpid=(\d+)/.exec(entry.message);
    const pid = pidMatch?.[1] !== undefined ? Number(pidMatch[1]) : undefined;
    return {
      v: 1,
      id: `log:${entry.id}`,
      timestamp: entry.timestamp,
      plane: "desktop",
      kind: "rust_panic",
      summary: entry.message,
      ...(entry.stack === undefined ? {} : { detail: entry.stack }),
      ...(pid !== undefined && Number.isFinite(pid) ? { pid } : {}),
    };
  }

  if (entry.plane === "webview" && /ProcessFailed/i.test(entry.message)) {
    const codeMatch = /\bexit_code=(-?\d+)/.exec(entry.message);
    const exitCode = codeMatch?.[1] !== undefined ? Number(codeMatch[1]) : undefined;
    return {
      v: 1,
      id: `log:${entry.id}`,
      timestamp: entry.timestamp,
      plane: "webview",
      kind: "webview_process_failed",
      summary: entry.message,
      ...(entry.stack === undefined ? {} : { detail: entry.stack }),
      ...(exitCode !== undefined && Number.isFinite(exitCode) ? { exitCode } : {}),
    };
  }

  if (entry.plane === "desktop" && entry.component === "harness") {
    if (/KEEPS_CRASHING|kept crashing|crashed repeatedly/i.test(entry.message)) {
      return {
        v: 1,
        id: `log:${entry.id}`,
        timestamp: entry.timestamp,
        plane: "desktop",
        kind: "harness_crash_loop",
        summary: entry.message,
        ...(entry.stack === undefined ? {} : { detail: entry.stack }),
      };
    }
    if (/Harness Host exited unexpectedly/i.test(entry.message)) {
      const codeMatch = /\bwith code (-?\d+)/.exec(entry.message);
      const exitCode = codeMatch?.[1] !== undefined ? Number(codeMatch[1]) : undefined;
      return {
        v: 1,
        id: `log:${entry.id}`,
        timestamp: entry.timestamp,
        plane: "desktop",
        kind: "harness_unexpected_exit",
        summary: entry.message,
        ...(entry.stack === undefined ? {} : { detail: entry.stack }),
        ...(exitCode !== undefined && Number.isFinite(exitCode) ? { exitCode } : {}),
      };
    }
  }

  if (entry.plane === "desktop" && /previous session.*exited uncleanly/i.test(entry.message)) {
    const pidMatch = /\bpid=(\d+)/.exec(entry.message);
    const pid = pidMatch?.[1] !== undefined ? Number(pidMatch[1]) : undefined;
    return {
      v: 1,
      id: `log:${entry.id}`,
      timestamp: entry.timestamp,
      plane: "desktop",
      kind: "unclean_desktop_exit",
      summary: entry.message,
      ...(pid !== undefined && Number.isFinite(pid) ? { pid } : {}),
    };
  }

  if (entry.plane === "host" && entry.component === "crash-guard") {
    const kind: CrashRecord["kind"] = /^unhandledRejection\b/i.test(entry.message)
      ? "unhandledRejection"
      : /^startupFailure\b/i.test(entry.message)
        ? "startupFailure"
        : "uncaughtException";
    return {
      v: 1,
      id: `log:${entry.id}`,
      timestamp: entry.timestamp,
      plane: "host",
      kind,
      summary: entry.message,
      ...(entry.stack === undefined ? {} : { detail: entry.stack }),
      ...(entry.pluginId === undefined ? {} : { pluginId: entry.pluginId }),
    };
  }

  if (entry.plane === "renderer" && entry.level === "error") {
    const kind: CrashRecord["kind"] = entry.pluginId !== undefined ? "plugin_error" : "renderer_crash";
    return {
      v: 1,
      id: `log:${entry.id}`,
      timestamp: entry.timestamp,
      plane: "webview",
      kind,
      summary: `[${entry.component}] ${entry.message}`,
      ...(entry.stack === undefined ? {} : { detail: entry.stack }),
      ...(entry.pluginId === undefined ? {} : { pluginId: entry.pluginId }),
    };
  }

  if (entry.plane === "host" && entry.component === "plugins" && entry.level === "error" && entry.pluginId !== undefined) {
    return {
      v: 1,
      id: `log:${entry.id}`,
      timestamp: entry.timestamp,
      plane: "host",
      kind: "plugin_error",
      summary: entry.message,
      ...(entry.stack === undefined ? {} : { detail: entry.stack }),
      pluginId: entry.pluginId,
    };
  }

  return undefined;
}

export function collectDiagnosticsSnapshot(
  logsDir: string,
  options: {
    dedupeMirroredStderr: boolean;
    liveEntries: readonly LogEntry[];
    now?: Date;
  },
): DiagnosticsSnapshot {
  const now = options.now ?? new Date();
  const today = localDayString(now);
  const logFiles = listLogFileSummaries(logsDir);
  const diskDates = listAvailableLogDates(logsDir);
  const datesSet = new Set<string>(diskDates);
  if (options.liveEntries.length > 0) {
    datesSet.add(today);
  }
  const availableDates = [...datesSet].sort((a, b) => b.localeCompare(a));

  const recentDates = availableDates.slice(0, RECENT_SCAN_DAYS);
  if (!recentDates.includes(today)) {
    recentDates.unshift(today);
  }

  const pluginErrorCounts: Record<string, number> = {};
  const fallbackCandidates: CrashRecord[] = [];
  let todayEntries: LogEntry[] = [];

  for (const date of recentDates) {
    const entries = loadDateLogEntries(
      logsDir,
      date,
      options.dedupeMirroredStderr,
      date === today ? options.liveEntries : [],
    );
    if (date === today) {
      todayEntries = entries;
    }
    for (const entry of entries) {
      if ((entry.level === "error" || entry.level === "fatal") && entry.pluginId !== undefined) {
        pluginErrorCounts[entry.pluginId] = (pluginErrorCounts[entry.pluginId] ?? 0) + 1;
      }
      const derived = deriveIncidentFromLogEntry(entry);
      if (derived !== undefined) {
        fallbackCandidates.push(derived);
      }
    }
  }

  const jsonlRecords = [
    ...parseJsonlCrashFile(join(logsDir, "desktop-crashes.jsonl"), "desktop"),
    ...parseJsonlCrashFile(join(logsDir, "host-crashes.jsonl"), "host"),
  ];

  const kept: Array<{ record: CrashRecord; epochMs: number; fromJsonl: boolean }> = [];

  for (const rec of jsonlRecords) {
    const epochMs = parseTimestampEpoch(rec.timestamp);
    const dup = kept.some(
      (k) =>
        k.record.kind === rec.kind
        && (k.record.pluginId ?? "") === (rec.pluginId ?? "")
        && k.record.summary === rec.summary
        && Math.abs(k.epochMs - epochMs) <= 2_000,
    );
    if (!dup) {
      kept.push({ record: rec, epochMs, fromJsonl: true });
    }
  }

  // Ensure JSONL-only plugin crashes also reflect in pluginErrorCounts even when log files rotated.
  const jsonlPluginTotals: Record<string, number> = {};
  for (const item of kept) {
    const pid = item.record.pluginId;
    if (pid !== undefined) {
      jsonlPluginTotals[pid] = (jsonlPluginTotals[pid] ?? 0) + 1;
    }
  }
  for (const [pid, count] of Object.entries(jsonlPluginTotals)) {
    if ((pluginErrorCounts[pid] ?? 0) < count) {
      pluginErrorCounts[pid] = count;
    }
  }

  for (const cand of fallbackCandidates) {
    const epochMs = parseTimestampEpoch(cand.timestamp);
    const coveredByJsonl = kept.some(
      (k) =>
        k.fromJsonl
        && k.record.kind === cand.kind
        && (k.record.pluginId ?? "") === (cand.pluginId ?? "")
        && Math.abs(k.epochMs - epochMs) <= 10_000,
    );
    if (coveredByJsonl) continue;

    const coveredByLog = kept.some(
      (k) =>
        !k.fromJsonl
        && k.record.kind === cand.kind
        && (k.record.pluginId ?? "") === (cand.pluginId ?? "")
        && k.record.summary === cand.summary
        && Math.abs(k.epochMs - epochMs) <= 3_000,
    );
    if (!coveredByLog) {
      kept.push({ record: cand, epochMs, fromJsonl: false });
    }
  }

  kept.sort((a, b) => b.epochMs - a.epochMs || b.record.timestamp.localeCompare(a.record.timestamp));
  const recentIncidents = kept.slice(0, MAX_INCIDENTS).map((item) => item.record);

  let errorLogsToday = 0;
  let warnLogsToday = 0;
  for (const entry of todayEntries) {
    if (entry.level === "error" || entry.level === "fatal") {
      errorLogsToday += 1;
    } else if (entry.level === "warn") {
      warnLogsToday += 1;
    }
  }

  return {
    logFiles,
    availableDates,
    todayEntries,
    errorLogsToday,
    warnLogsToday,
    pluginErrorCounts,
    recentIncidents,
  };
}
