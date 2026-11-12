/**
 * Host entry for `observability` (`系统可观测与诊断`).
 *
 * Provides 3-plane log aggregation (`desktop-*.log` + `host-*.log` + live Cordis
 * ring buffer), crash forensics (`desktop-crashes.jsonl` + `host-crashes.jsonl` +
 * log-derived incidents), tool error/latency tracking, redacted `.zip` export,
 * `/logs` diagnostic command, and the read-only `observability_inspect` Agent tool.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { Logger, type Context, type Exporter } from "@deepseek-ai/cordis";
import "@qianji/commands";
import { redactSensitiveText } from "@qianji/protocol";
import "@qianji/rpc";
import { textOutput, type ToolEnv } from "@qianji/tools";
import {
  collectDiagnosticsSnapshot,
  extractPluginId,
  levelMeetsMinimum,
  listAvailableLogDates,
  loadDateLogEntries,
  localDayString,
} from "./log-parser.ts";
import type {
  CrashRecord,
  LogEntry,
  LogLevel,
  LogPlane,
  ObservabilityAckResult,
  ObservabilityExportResult,
  ObservabilityOverviewResult,
  ObservabilityPluginConfig,
  ObservabilityQueryLogsParams,
  ObservabilityQueryLogsResult,
  ToolIssueEntry,
} from "./types.ts";

interface HostInfoView {
  readonly version: string;
  readonly protocolVersion: string;
  readonly dataDir: string;
  readonly startedAt: Date;
}

function readHostInfo(ctx: Context): HostInfoView {
  return (ctx as unknown as { readonly hostInfo: HostInfoView }).hostInfo;
}

export const name = "observability";
export const inject = ["hostInfo", "tools", "commands"];

const LIVE_LOG_BUFFER_CAP = 300;
const TOOL_ISSUES_CAP = 50;
const SLOW_TOOL_THRESHOLD_MS = 5_000;
const STATE_FILENAME = "observability-state.json";

const VALID_PLANES = new Set<LogPlane>(["desktop", "host", "renderer", "webview"]);
const VALID_MIN_LEVELS = new Set<"debug" | "info" | "warn" | "error">([
  "debug",
  "info",
  "warn",
  "error",
]);

interface ZipFileEntry {
  name: string;
  data: Buffer;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function computeCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    const tableVal = CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = tableVal ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipArchive(entries: readonly ZipFileEntry[], now = new Date()): Buffer {
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const crc = computeCrc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralDir, eocd]);
}

function formatCompactStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function readLastAckedAt(logsDir: string): string | null {
  const statePath = join(logsDir, STATE_FILENAME);
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    return typeof parsed.lastAckedAt === "string" && parsed.lastAckedAt !== ""
      ? parsed.lastAckedAt
      : null;
  } catch {
    return null;
  }
}

function writeLastAckedAt(logsDir: string, acknowledgedAt: string): void {
  try {
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, STATE_FILENAME),
      `${JSON.stringify({ v: 1, lastAckedAt: acknowledgedAt }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // Non-fatal on read-only file systems.
  }
}

function countUnackedIncidents(incidents: readonly CrashRecord[], lastAckedAt: string | null): number {
  if (lastAckedAt === null) return incidents.length;
  const ackEpoch = Date.parse(lastAckedAt);
  if (!Number.isFinite(ackEpoch)) return incidents.length;
  let count = 0;
  for (const item of incidents) {
    const ts = Date.parse(item.timestamp);
    if (!Number.isFinite(ts) || ts > ackEpoch) {
      count += 1;
    }
  }
  return count;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function formatBytesMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUptime(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1_000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

interface LivePluginSummaryItem {
  id?: string;
  name?: string;
  tier?: string;
  status?: string;
  enabled?: boolean;
  missingInject?: string[];
  error?: string;
  clientError?: { phase?: string; message?: string; stack?: string; etag?: string };
}

export function apply(ctx: Context, config: ObservabilityPluginConfig = {}): void {
  const liveLogs: LogEntry[] = [];
  const toolIssues: ToolIssueEntry[] = [];
  const callStartTimes = new Map<string, number>();
  let toolFailuresSession = 0;
  let toolIssueSeq = 0;

  const hostInfo = readHostInfo(ctx);
  const getDataDir = (): string => hostInfo.dataDir;
  const getLogsDir = (): string => join(hostInfo.dataDir, "logs");

  ctx.effect(() => {
    const liveExporter: Exporter = {
      colors: false,
      levels: { default: 3 },
      export(message) {
        const formatted = redactSensitiveText(Logger.format(liveExporter, message));
        const lines = formatted.split(/\r?\n/);
        const firstLine = (lines[0] ?? "").trim();
        const stack = lines.length > 1 ? lines.slice(1).join("\n") : undefined;
        const epochMs = typeof message.ts === "number" && Number.isFinite(message.ts)
          ? message.ts
          : Date.now();
        const level: LogLevel =
          message.type === "error" || message.type === "warn" || message.type === "debug"
            ? message.type
            : "info";
        const component = message.name || "host";
        const pluginId = extractPluginId(component, firstLine, stack);

        liveLogs.push({
          id: `live:${message.sn}`,
          timestamp: new Date(epochMs).toISOString(),
          epochMs,
          plane: "host",
          level,
          component,
          ...(pluginId === undefined ? {} : { pluginId }),
          message: firstLine,
          ...(stack === undefined || stack === "" ? {} : { stack }),
          file: "memory:live",
        });
        if (liveLogs.length > LIVE_LOG_BUFFER_CAP) {
          liveLogs.shift();
        }
      },
    };

    const disposeExporter = ctx.logger.exporter(liveExporter);

    const offPreExecute = ctx.on("tools/pre-execute", (call) => {
      if (call.id === "obs-plugins" || call.id.startsWith("obs-internal:")) {
        return undefined;
      }
      if (callStartTimes.size >= 200) {
        const oldestKey = callStartTimes.keys().next().value;
        if (oldestKey !== undefined) {
          callStartTimes.delete(oldestKey);
        }
      }
      callStartTimes.set(call.id, Date.now());
      return undefined;
    });

    const offResult = ctx.on("tools/result", (call, _env, output) => {
      if (call.id === "obs-plugins" || call.id.startsWith("obs-internal:")) {
        return;
      }
      const startedAt = callStartTimes.get(call.id);
      callStartTimes.delete(call.id);
      const durationMs = startedAt !== undefined ? Math.max(0, Date.now() - startedAt) : undefined;
      const isError = output.isError === true;

      if (isError) {
        toolFailuresSession += 1;
      }

      if (!isError && (durationMs === undefined || durationMs <= SLOW_TOOL_THRESHOLD_MS)) {
        return;
      }

      const rawPreview = output.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const redactedPreview = redactSensitiveText(rawPreview);
      const preview = redactedPreview.length > 240
        ? `${redactedPreview.slice(0, 240)}…`
        : redactedPreview || (isError ? `${call.name} failed` : `${call.name} slow execution`);

      toolIssueSeq += 1;
      toolIssues.push({
        id: `tool:${toolIssueSeq}:${call.id}`,
        timestamp: new Date().toISOString(),
        toolName: call.name,
        ...(durationMs === undefined ? {} : { durationMs }),
        isError,
        preview,
      });
      if (toolIssues.length > TOOL_ISSUES_CAP) {
        toolIssues.shift();
      }
    });

    return () => {
      void disposeExporter();
      offPreExecute();
      offResult();
      callStartTimes.clear();
    };
  }, "observability:live-telemetry");

  const buildOverview = (dedupeOverride?: boolean): ObservabilityOverviewResult => {
    const dataDir = getDataDir();
    const logsDir = getLogsDir();
    const dedupe = dedupeOverride ?? config.dedupeMirroredStderr ?? true;
    const snap = collectDiagnosticsSnapshot(logsDir, {
      dedupeMirroredStderr: dedupe,
      liveEntries: liveLogs,
    });
    const lastAckedAt = readLastAckedAt(logsDir);
    const mem = process.memoryUsage();

    return {
      host: {
        version: hostInfo.version,
        protocolVersion: hostInfo.protocolVersion,
        startedAt: hostInfo.startedAt.toISOString(),
        uptimeMs: Math.max(0, Date.now() - hostInfo.startedAt.getTime()),
        pid: process.pid,
        memoryRssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        dataDir,
        logsDir,
      },
      logFiles: snap.logFiles,
      counts: {
        unackedCrashes: countUnackedIncidents(snap.recentIncidents, lastAckedAt),
        totalIncidents: snap.recentIncidents.length,
        errorLogsToday: snap.errorLogsToday,
        warnLogsToday: snap.warnLogsToday,
        toolFailuresSession,
      },
      pluginErrorCounts: snap.pluginErrorCounts,
      recentIncidents: snap.recentIncidents,
      recentToolIssues: [...toolIssues].reverse(),
      lastAckedAt,
    };
  };

  const queryLogs = (rawParams: ObservabilityQueryLogsParams = {}): ObservabilityQueryLogsResult => {
    const logsDir = getLogsDir();
    const today = localDayString();
    const diskDates = listAvailableLogDates(logsDir);
    const datesSet = new Set<string>(diskDates);
    if (liveLogs.length > 0) {
      datesSet.add(today);
    }
    const availableDates = [...datesSet].sort((a, b) => b.localeCompare(a));

    const dedupe = rawParams.dedupeMirroredStderr ?? config.dedupeMirroredStderr ?? true;
    const defaultLimit = clampInt(config.defaultTailLines, 200, 50, 1_000);
    const limit = clampInt(rawParams.limit, defaultLimit, 1, 2_000);

    const requestedDate = typeof rawParams.date === "string" ? rawParams.date.trim() : "";
    let targetDates: string[];
    let includeLiveOnFallback = false;

    if (requestedDate === "all") {
      targetDates = availableDates.length > 0 ? [...availableDates].reverse() : [today];
    } else if (requestedDate !== "" && requestedDate !== "latest" && requestedDate !== "today") {
      targetDates = [requestedDate];
    } else if (diskDates.includes(today) || diskDates.length === 0) {
      targetDates = [today];
    } else {
      const latestDiskDate = diskDates[0] ?? today;
      targetDates = [latestDiskDate];
      includeLiveOnFallback = true;
    }

    const combined: LogEntry[] = [];
    for (const d of targetDates) {
      const useLive = d === today || includeLiveOnFallback;
      combined.push(...loadDateLogEntries(logsDir, d, dedupe, useLive ? liveLogs : []));
    }

    const planeFilter =
      typeof rawParams.plane === "string" && VALID_PLANES.has(rawParams.plane as LogPlane)
        ? (rawParams.plane as LogPlane)
        : undefined;
    const minLevel =
      typeof rawParams.minLevel === "string"
      && VALID_MIN_LEVELS.has(rawParams.minLevel as "debug" | "info" | "warn" | "error")
        ? (rawParams.minLevel as "debug" | "info" | "warn" | "error")
        : "debug";
    const pluginFilter =
      typeof rawParams.pluginId === "string" && rawParams.pluginId.trim() !== ""
        ? rawParams.pluginId.trim()
        : undefined;
    const searchNeedle =
      typeof rawParams.search === "string" && rawParams.search.trim() !== ""
        ? rawParams.search.trim().toLowerCase()
        : undefined;

    const matched = combined.filter((entry) => {
      if (planeFilter !== undefined && entry.plane !== planeFilter) return false;
      if (!levelMeetsMinimum(entry.level, minLevel)) return false;
      if (pluginFilter !== undefined && entry.pluginId !== pluginFilter) return false;
      if (searchNeedle !== undefined) {
        const haystack = `${entry.component} ${entry.pluginId ?? ""} ${entry.message} ${entry.stack ?? ""}`.toLowerCase();
        if (!haystack.includes(searchNeedle)) return false;
      }
      return true;
    });

    const totalMatched = matched.length;
    const truncated = totalMatched > limit;
    const entries = truncated ? matched.slice(totalMatched - limit) : matched;

    return {
      entries,
      totalMatched,
      availableDates,
      truncated,
    };
  };

  const ackIncidents = (): ObservabilityAckResult => {
    const acknowledgedAt = new Date().toISOString();
    writeLastAckedAt(getLogsDir(), acknowledgedAt);
    return { acknowledgedAt };
  };

  const exportDiagnostics = (): ObservabilityExportResult => {
    const dataDir = getDataDir();
    const logsDir = getLogsDir();
    const now = new Date();
    mkdirSync(logsDir, { recursive: true });

    const encodeRedacted = (raw: string): Buffer => Buffer.from(redactSensitiveText(raw), "utf8");

    const about = {
      createdAt: now.toISOString(),
      host: {
        version: hostInfo.version,
        protocolVersion: hostInfo.protocolVersion,
        startedAt: hostInfo.startedAt.toISOString(),
        pid: process.pid,
      },
      runtime: {
        platform: platform(),
        release: release(),
        arch: arch(),
        versions: process.versions,
      },
    };

    const entries: ZipFileEntry[] = [
      { name: "about.json", data: encodeRedacted(`${JSON.stringify(about, null, 2)}\n`) },
    ];

    for (const rootJson of ["harness.json", "plugins.json"]) {
      const fullPath = join(dataDir, rootJson);
      if (existsSync(fullPath)) {
        try {
          entries.push({ name: rootJson, data: encodeRedacted(readFileSync(fullPath, "utf8")) });
        } catch {
          // Ignore unreadable config file.
        }
      }
    }

    if (existsSync(logsDir)) {
      const logNames = readdirSync(logsDir)
        .filter((fileName) => fileName.endsWith(".log") || fileName.endsWith(".jsonl"))
        .sort((a, b) => a.localeCompare(b));
      for (const fileName of logNames) {
        try {
          entries.push({
            name: `logs/${fileName}`,
            data: encodeRedacted(readFileSync(join(logsDir, fileName), "utf8")),
          });
        } catch {
          // Ignore concurrently removed log file.
        }
      }
    }

    const zipBuffer = buildZipArchive(entries, now);
    const outPath = join(logsDir, `qianji-diagnostics-${formatCompactStamp(now)}.zip`);
    writeFileSync(outPath, zipBuffer);

    return {
      path: outPath,
      sizeBytes: zipBuffer.byteLength,
      files: entries.map((item) => item.name),
    };
  };

  const queryLivePluginsViaTool = async (
    env: ToolEnv,
    pluginId?: string,
  ): Promise<{ available: boolean; items: LivePluginSummaryItem[] }> => {
    if (ctx.tools.get("qianji_inspect") === undefined) {
      return { available: false, items: [] };
    }
    try {
      const out = await ctx.tools.execute(
        {
          id: "obs-plugins",
          name: "qianji_inspect",
          args: {
            topic: "plugins",
            ...(pluginId === undefined ? {} : { pluginId }),
          },
        },
        env,
      );
      if (out.isError === true) {
        return { available: false, items: [] };
      }
      const rawText = out.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n")
        .trim();
      const parsed = JSON.parse(rawText) as {
        plugins?: { available?: boolean; items?: LivePluginSummaryItem[] };
      };
      return {
        available: parsed.plugins?.available === true,
        items: Array.isArray(parsed.plugins?.items) ? parsed.plugins.items : [],
      };
    } catch {
      return { available: false, items: [] };
    }
  };

  // Headless-safe RPC registration: activates when `rpc` is mounted in desktop/web mode.
  ctx.inject(["rpc"], (rpcCtx) => {
    rpcCtx.effect(
      () =>
        rpcCtx.rpc.method("observability.overview", (rawParams) => {
          const p = (typeof rawParams === "object" && rawParams !== null ? rawParams : {}) as Record<
            string,
            unknown
          >;
          const dedupeOverride =
            typeof p.dedupeMirroredStderr === "boolean" ? p.dedupeMirroredStderr : undefined;
          return buildOverview(dedupeOverride);
        }),
      "observability.overview",
    );

    rpcCtx.effect(
      () =>
        rpcCtx.rpc.method("observability.queryLogs", (rawParams) => {
          const p = (typeof rawParams === "object" && rawParams !== null
            ? rawParams
            : {}) as ObservabilityQueryLogsParams;
          return queryLogs(p);
        }),
      "observability.queryLogs",
    );

    rpcCtx.effect(
      () => rpcCtx.rpc.method("observability.ackIncidents", () => ackIncidents()),
      "observability.ackIncidents",
    );

    rpcCtx.effect(
      () => rpcCtx.rpc.method("observability.exportDiagnostics", () => exportDiagnostics()),
      "observability.exportDiagnostics",
    );
  });

  // Read-only Agent self-diagnostic tool (`readOnly: true` runs without approval prompts).
  ctx.tools.register({
    name: "observability_inspect",
    description:
      "Read-only system observability & crash forensics tool: inspect Desktop/Host/WebView crash records (`闪退`), unified 3-plane logs (`desktop-*.log` + `host-*.log`), plugin health (`error` / `clientError` stacks + historical error counts), and slow/failed tool calls.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            'Diagnostic topic: "overview" | "crashes" | "logs" | "plugins" | "tools" (default: "overview")',
        },
        plane: {
          type: "string",
          description: 'Plane filter: "all" | "desktop" | "host" | "renderer" | "webview"',
        },
        minLevel: {
          type: "string",
          description: 'Minimum severity when topic="logs": "debug" | "info" | "warn" | "error"',
        },
        search: {
          type: "string",
          description: "Case-insensitive keyword filter for summaries, messages, or stack traces",
        },
        pluginId: {
          type: "string",
          description: "Optional plugin ID filter for crashes, logs, or plugin health",
        },
        date: {
          type: "string",
          description: 'Log date in YYYY-MM-DD format (or "all" across retained log files)',
        },
        limit: {
          type: "integer",
          description: "Maximum items to return (1..500)",
        },
      },
    },
    async execute(args, env) {
      const topic =
        typeof args.topic === "string" && args.topic.trim() !== ""
          ? args.topic.trim()
          : "overview";
      const pluginId =
        typeof args.pluginId === "string" && args.pluginId.trim() !== ""
          ? args.pluginId.trim()
          : undefined;
      const search =
        typeof args.search === "string" && args.search.trim() !== ""
          ? args.search.trim().toLowerCase()
          : undefined;

      if (topic === "overview") {
        return textOutput(JSON.stringify(buildOverview(), null, 2));
      }

      if (topic === "crashes") {
        const overview = buildOverview();
        const limit = clampInt(args.limit, 30, 1, 200);
        const plane =
          typeof args.plane === "string" && args.plane !== "all" ? args.plane.trim() : undefined;
        const filtered = overview.recentIncidents
          .filter((item) => {
            if (plane !== undefined && item.plane !== plane) return false;
            if (pluginId !== undefined && item.pluginId !== pluginId) return false;
            if (search !== undefined) {
              const hay = `${item.kind} ${item.pluginId ?? ""} ${item.summary} ${item.detail ?? ""}`.toLowerCase();
              if (!hay.includes(search)) return false;
            }
            return true;
          })
          .slice(0, limit);
        return textOutput(
          JSON.stringify(
            {
              lastAckedAt: overview.lastAckedAt,
              unackedCrashes: overview.counts.unackedCrashes,
              totalIncidents: overview.counts.totalIncidents,
              matchedCount: filtered.length,
              incidents: filtered,
            },
            null,
            2,
          ),
        );
      }

      if (topic === "logs") {
        const result = queryLogs({
          ...(typeof args.date === "string" ? { date: args.date } : {}),
          ...(typeof args.plane === "string"
            ? { plane: args.plane as ObservabilityQueryLogsParams["plane"] }
            : {}),
          ...(typeof args.minLevel === "string"
            ? { minLevel: args.minLevel as ObservabilityQueryLogsParams["minLevel"] }
            : {}),
          ...(typeof args.search === "string" ? { search: args.search } : {}),
          ...(pluginId === undefined ? {} : { pluginId }),
          limit: clampInt(args.limit, 80, 1, 500),
        });
        return textOutput(JSON.stringify(result, null, 2));
      }

      if (topic === "plugins") {
        const overview = buildOverview();
        const live = await queryLivePluginsViaTool(env, pluginId);
        const limit = clampInt(args.limit, 40, 1, 200);
        const enrichedItems = live.items.map((item) => {
          const id = item.id ?? "";
          const historicalErrors = id !== "" ? (overview.pluginErrorCounts[id] ?? 0) : 0;
          const unhealthy =
            item.status === "errored"
            || Boolean(item.error)
            || Boolean(item.clientError)
            || (Array.isArray(item.missingInject) && item.missingInject.length > 0)
            || historicalErrors > 0;
          return {
            ...item,
            historicalErrorCount: historicalErrors,
            unhealthy,
          };
        });
        const recentPluginLogs = queryLogs({
          date: "all",
          minLevel: "warn",
          ...(pluginId === undefined ? {} : { pluginId }),
          limit,
        }).entries.filter((entry) => entry.pluginId !== undefined);
        const recentPluginIncidents = overview.recentIncidents.filter((inc) =>
          pluginId !== undefined ? inc.pluginId === pluginId : inc.pluginId !== undefined,
        );

        return textOutput(
          JSON.stringify(
            {
              livePluginsAvailable: live.available,
              unhealthyPlugins: enrichedItems.filter((item) => item.unhealthy),
              allPlugins: enrichedItems,
              pluginErrorCounts:
                pluginId !== undefined
                  ? { [pluginId]: overview.pluginErrorCounts[pluginId] ?? 0 }
                  : overview.pluginErrorCounts,
              recentPluginIncidents: recentPluginIncidents.slice(0, limit),
              recentPluginLogs,
            },
            null,
            2,
          ),
        );
      }

      if (topic === "tools") {
        const limit = clampInt(args.limit, 30, 1, 100);
        const issues = [...toolIssues]
          .reverse()
          .filter((item) =>
            search === undefined
              ? true
              : `${item.toolName} ${item.preview}`.toLowerCase().includes(search),
          )
          .slice(0, limit);
        return textOutput(
          JSON.stringify(
            {
              toolFailuresSession,
              matchedCount: issues.length,
              issues,
            },
            null,
            2,
          ),
        );
      }

      return textOutput(
        `Unknown topic "${topic}". Expected one of: overview, crashes, logs, plugins, tools.`,
        true,
      );
    },
  });

  // Slash command `/logs` (`[crashes | plugins | <关键词>]`)
  ctx.commands.register({
    name: "logs",
    argsHint: "[crashes | plugins | <关键词>]",
    description: "查看三端闪退取证记录、插件异常堆栈与最新错误日志摘要（无参数时打开可观测面板）",
    source: "plugin",
    async execute(rawArgs, env) {
      const arg = rawArgs.trim();
      const lower = arg.toLowerCase();
      const overview = buildOverview();
      const toolEnv: ToolEnv = {
        sessionId: env.sessionId ?? "",
        cwd: env.cwd,
        signal: env.signal,
      };

      if (lower === "crashes" || lower === "crash") {
        const lines: string[] = [
          `### 闪退与异常取证报告`,
          ``,
          `- **日志目录**：\`${overview.host.logsDir}\``,
          `- **累计捕获事件**：**${overview.counts.totalIncidents}** 条（未读告警 **${overview.counts.unackedCrashes}** 条）`,
          ``,
        ];
        if (overview.recentIncidents.length === 0) {
          lines.push(`暂未检测到桌面闪退、Sidecar 异常退出或未捕获异常记录。`);
        } else {
          for (const inc of overview.recentIncidents.slice(0, 12)) {
            const pluginTag = inc.pluginId !== undefined ? ` · 插件 \`${inc.pluginId}\`` : "";
            lines.push(
              `- **[${inc.plane.toUpperCase()} / ${inc.kind}]** \`${inc.timestamp}\`${pluginTag}：${inc.summary}`,
            );
            if (inc.detail !== undefined) {
              const snippet = inc.detail.split(/\r?\n/).slice(0, 4).join("\n  ");
              lines.push(`  \`\`\`text\n  ${snippet}\n  \`\`\``);
            }
          }
        }
        return { output: lines.join("\n") };
      }

      if (lower === "plugins" || lower === "plugin") {
        const live = await queryLivePluginsViaTool(toolEnv);
        const unhealthyLive = live.items.filter(
          (p) =>
            p.status === "errored"
            || Boolean(p.error)
            || Boolean(p.clientError)
            || (Array.isArray(p.missingInject) && p.missingInject.length > 0),
        );
        const errorCountEntries = Object.entries(overview.pluginErrorCounts).sort(
          (a, b) => b[1] - a[1],
        );
        const lines: string[] = [
          `### 插件健康诊断摘要`,
          ``,
          `- **已加载插件数**：${live.available ? `${live.items.length} 个` : "（当前环境未挂载实时列表）"}`,
          `- **当前异常插件**：**${unhealthyLive.length}** 个`,
          `- **日志归因报错插件**：**${errorCountEntries.length}** 个`,
          ``,
        ];

        if (unhealthyLive.length === 0 && errorCountEntries.length === 0) {
          lines.push(`所有插件运行正常，未发现加载报错、渲染熔断或历史异常堆栈。`);
        } else {
          for (const p of unhealthyLive) {
            lines.push(
              `- **\`${p.id ?? "unknown"}\`**（状态：\`${p.status ?? "unknown"}\`，层级：\`${p.tier ?? "-"}\`）`,
            );
            if (p.error) {
              lines.push(`  - Host 错误：\`${p.error.split(/\r?\n/)[0]}\``);
            }
            if (p.clientError) {
              lines.push(
                `  - 前端熔断 (\`${p.clientError.phase ?? "render"}\`)：\`${p.clientError.message ?? ""}\``,
              );
            }
          }
          if (errorCountEntries.length > 0) {
            lines.push(
              `- **历史日志报错统计**：${errorCountEntries.map(([id, cnt]) => `\`${id}\` (${cnt})`).join("、")}`,
            );
          }
        }
        return { output: lines.join("\n") };
      }

      if (arg !== "") {
        const logs = queryLogs({ date: "all", search: arg, limit: 15 });
        const lines: string[] = [
          `### 日志检索结果：\`${arg}\`（共匹配 ${logs.totalMatched} 条）`,
          ``,
        ];
        if (logs.entries.length === 0) {
          lines.push(`未在最近日志中找到包含 \`${arg}\` 的记录。`);
        } else {
          for (const entry of logs.entries) {
            const pluginBadge = entry.pluginId !== undefined ? ` (plugin:${entry.pluginId})` : "";
            lines.push(
              `- \`${entry.timestamp}\` **[${entry.level.toUpperCase()}]** \`[${entry.plane}:${entry.component}]\`${pluginBadge} ${entry.message}`,
            );
          }
        }
        return { output: lines.join("\n") };
      }

      // Default `/logs` summary (used in CLI / headless or direct command invocation)
      const recentProblems = queryLogs({ minLevel: "warn", limit: 10 });
      const live = await queryLivePluginsViaTool(toolEnv);
      const unhealthyCount = live.items.filter(
        (p) => p.status === "errored" || Boolean(p.error) || Boolean(p.clientError),
      ).length;

      const lines: string[] = [
        `### 系统可观测与诊断概览`,
        ``,
        `- **Host 运行状态**：v${overview.host.version} · PID \`${overview.host.pid}\` · 已运行 \`${formatUptime(overview.host.uptimeMs)}\` · 内存 \`${formatBytesMb(overview.host.memoryRssBytes)}\``,
        `- **日志目录**：\`${overview.host.logsDir}\`（文件 ${overview.logFiles.length} 个）`,
        `- **异常统计**：未读闪退/崩溃 **${overview.counts.unackedCrashes}** 条（总计 ${overview.counts.totalIncidents}） · 今日错误 **${overview.counts.errorLogsToday}** 条 · 今日警告 **${overview.counts.warnLogsToday}** 条 · 工具失败 **${overview.counts.toolFailuresSession}** 次`,
        `- **插件健康**：当前异常插件 **${unhealthyCount}** 个 · 历史报错归因 **${Object.keys(overview.pluginErrorCounts).length}** 个`,
      ];

      if (overview.recentIncidents.length > 0) {
        lines.push(``, `#### 最近闪退与严重异常`);
        for (const inc of overview.recentIncidents.slice(0, 5)) {
          const pluginTag = inc.pluginId !== undefined ? ` (\`${inc.pluginId}\`)` : "";
          lines.push(`- **[${inc.plane}/${inc.kind}]** \`${inc.timestamp}\`${pluginTag}：${inc.summary}`);
        }
      }

      if (recentProblems.entries.length > 0) {
        lines.push(``, `#### 最新警告与错误日志`);
        for (const entry of recentProblems.entries) {
          lines.push(
            `- \`${entry.timestamp}\` **[${entry.level.toUpperCase()}]** \`[${entry.plane}:${entry.component}]\` ${entry.message}`,
          );
        }
      }

      return { output: lines.join("\n") };
    },
  });
}
