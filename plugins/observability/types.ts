export type LogPlane = "desktop" | "host" | "renderer" | "webview";
export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface CrashRecord {
  v: 1;
  id: string;
  timestamp: string;
  plane: "desktop" | "host" | "webview";
  kind:
    | "unclean_desktop_exit"
    | "rust_panic"
    | "webview_process_failed"
    | "harness_unexpected_exit"
    | "harness_crash_loop"
    | "uncaughtException"
    | "unhandledRejection"
    | "startupFailure"
    | "renderer_crash"
    | "plugin_error";
  summary: string;
  detail?: string;
  pluginId?: string;
  exitCode?: number;
  pid?: number;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  epochMs: number;
  plane: LogPlane;
  level: LogLevel;
  component: string;
  pluginId?: string;
  message: string;
  stack?: string;
  file: string;
}

export interface LogFileSummary {
  name: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface ToolIssueEntry {
  id: string;
  timestamp: string;
  toolName: string;
  durationMs?: number;
  isError: boolean;
  preview: string;
}

export interface ObservabilityOverviewResult {
  host: {
    version: string;
    protocolVersion: string;
    startedAt: string;
    uptimeMs: number;
    pid: number;
    memoryRssBytes: number;
    heapUsedBytes: number;
    dataDir: string;
    logsDir: string;
  };
  logFiles: LogFileSummary[];
  counts: {
    unackedCrashes: number;
    totalIncidents: number;
    errorLogsToday: number;
    warnLogsToday: number;
    toolFailuresSession: number;
  };
  pluginErrorCounts: Record<string, number>;
  recentIncidents: CrashRecord[];
  recentToolIssues: ToolIssueEntry[];
  lastAckedAt: string | null;
}

export interface ObservabilityQueryLogsParams {
  date?: string;
  plane?: "all" | LogPlane;
  minLevel?: "debug" | "info" | "warn" | "error";
  search?: string;
  pluginId?: string;
  dedupeMirroredStderr?: boolean;
  limit?: number;
}

export interface ObservabilityQueryLogsResult {
  entries: LogEntry[];
  totalMatched: number;
  availableDates: string[];
  truncated: boolean;
}

export interface ObservabilityAckResult {
  acknowledgedAt: string;
}

export interface ObservabilityExportResult {
  path: string;
  sizeBytes: number;
  files: string[];
}

export interface ObservabilityPluginConfig {
  showStatusBarPill?: boolean;
  autoRefreshMs?: number;
  defaultTailLines?: number;
  dedupeMirroredStderr?: boolean;
}
