import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Play,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { showToast, useHostRpcQuery } from "@qianji/client";
import type {
  LogEntry,
  LogLevel,
  LogPlane,
  ObservabilityQueryLogsResult,
} from "./types";

export interface LogsTabProps {
  defaultTailLines: number;
  defaultDedupeStderr: boolean;
  autoRefreshMs: number;
  pluginIdFilter: string;
  onPluginIdFilterChange: (pluginId: string) => void;
}

type PlaneFilter = "all" | LogPlane;
type MinLevelFilter = "debug" | "info" | "warn" | "error";

function formatClockMs(timestamp: string, epochMs: number): string {
  const ms = Number.isFinite(epochMs) && epochMs > 0 ? epochMs : Date.parse(timestamp);
  if (Number.isNaN(ms)) return timestamp.slice(11, 23) || timestamp;
  const d = new Date(ms);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

function levelBadgeVariant(level: LogLevel): string {
  if (level === "error" || level === "fatal") return "danger";
  if (level === "warn") return "warn";
  if (level === "info") return "info";
  return "";
}

async function copyLogEntry(entry: LogEntry): Promise<void> {
  const pluginTag = entry.pluginId ? ` (plugin:${entry.pluginId})` : "";
  const full = `${entry.timestamp} [${entry.plane}/${entry.level}] [${entry.component}]${pluginTag} ${entry.message}${entry.stack ? `\n${entry.stack}` : ""}`;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(full);
      showToast("已复制日志条目", "info");
    } else {
      showToast("当前环境不支持剪贴板写入", "warning");
    }
  } catch (err) {
    showToast(`复制失败：${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

export function LogsTab({
  defaultTailLines,
  defaultDedupeStderr,
  autoRefreshMs,
  pluginIdFilter,
  onPluginIdFilterChange,
}: LogsTabProps) {
  const [plane, setPlane] = useState<PlaneFilter>("all");
  const [minLevel, setMinLevel] = useState<MinLevelFilter>("info");
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [paused, setPaused] = useState<boolean>(false);
  const [dedupeOverride, setDedupeOverride] = useState<boolean | null>(null);
  const [expandedStacks, setExpandedStacks] = useState<Record<string, boolean>>({});

  const dedupeStderr = dedupeOverride ?? defaultDedupeStderr;
  const limit = Number.isFinite(defaultTailLines) && defaultTailLines >= 50 ? defaultTailLines : 200;

  const queryParams = useMemo<Record<string, unknown>>(
    () => ({
      plane,
      minLevel,
      dedupeMirroredStderr: dedupeStderr,
      limit,
      ...(selectedDate ? { date: selectedDate } : {}),
      ...(search.trim() !== "" ? { search: search.trim() } : {}),
      ...(pluginIdFilter.trim() !== "" ? { pluginId: pluginIdFilter.trim() } : {}),
    }),
    [dedupeStderr, limit, minLevel, plane, pluginIdFilter, search, selectedDate],
  );

  const logsQuery = useHostRpcQuery<ObservabilityQueryLogsResult>(
    "observability.queryLogs",
    queryParams,
    { refreshIntervalMs: paused ? undefined : autoRefreshMs },
  );

  const availableDates = logsQuery.data?.availableDates ?? [];
  const entries = logsQuery.data?.entries ?? [];
  const totalMatched = logsQuery.data?.totalMatched ?? 0;
  const truncated = logsQuery.data?.truncated === true;

  const toggleStack = (id: string) => {
    setExpandedStacks((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="obs-logs-wrap" data-testid="obs-logs-tab">
      <div className="obs-filter-bar">
        <div className="obs-row-wrap">
          <select
            aria-label="日志平面筛选"
            className="obs-select"
            value={plane}
            onChange={(e) => setPlane(e.target.value as PlaneFilter)}
          >
            <option value="all">全部平面</option>
            <option value="desktop">Desktop</option>
            <option value="host">Host</option>
            <option value="renderer">Renderer</option>
            <option value="webview">WebView</option>
          </select>

          <select
            aria-label="最低日志级别"
            className="obs-select"
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value as MinLevelFilter)}
          >
            <option value="debug">Debug+</option>
            <option value="info">Info+</option>
            <option value="warn">Warn+</option>
            <option value="error">Error</option>
          </select>

          <select
            aria-label="日志日期"
            className="obs-select"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
          >
            <option value="">最新日期</option>
            {availableDates.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>

          <button
            type="button"
            className={`obs-btn${paused ? " primary" : ""}`}
            title={paused ? "恢复自动刷新" : "暂停自动刷新"}
            onClick={() => setPaused((prev) => !prev)}
          >
            {paused ? (
              <>
                <Play size={11} />
                <span>继续刷新</span>
              </>
            ) : (
              <span>暂停流</span>
            )}
          </button>

          <button
            type="button"
            className="obs-btn ghost"
            title="立即刷新日志"
            onClick={() => void logsQuery.refetch()}
          >
            <RefreshCw size={12} />
          </button>
        </div>

        <div className="obs-row-wrap" style={{ justifyContent: "space-between" }}>
          <div style={{ position: "relative", display: "inline-flex", alignItems: "center", flex: 1, minWidth: "140px" }}>
            <Search size={12} style={{ position: "absolute", left: "8px", color: "var(--qj-text-muted)", pointerEvents: "none" }} />
            <input
              type="search"
              className="obs-input"
              style={{ width: "100%", paddingLeft: "25px" }}
              placeholder="搜索消息、堆栈或错误码…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <label style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", color: "var(--qj-text-secondary)", cursor: "pointer", userSelect: "none" }}>
            <input
              type="checkbox"
              checked={dedupeStderr}
              onChange={(e) => setDedupeOverride(e.target.checked)}
              style={{ margin: 0, accentColor: "var(--qj-brand-primary)" }}
            />
            <span>去重镜像 stderr</span>
          </label>
        </div>

        {pluginIdFilter.trim() !== "" && (
          <div className="obs-row-wrap">
            <span className="obs-badge warn mono">
              <span>插件过滤: {pluginIdFilter}</span>
              <button
                type="button"
                aria-label="清除插件过滤"
                onClick={() => onPluginIdFilterChange("")}
                style={{ border: 0, background: "transparent", color: "inherit", padding: 0, display: "inline-flex", cursor: "pointer" }}
              >
                <X size={11} />
              </button>
            </span>
          </div>
        )}
      </div>

      <div className="obs-log-meta-bar">
        <span>
          共匹配 {totalMatched} 条
          {truncated ? `（仅显示最近 ${entries.length} 条）` : ""}
        </span>
        <span>{paused ? "已暂停自动刷新" : `每 ${Math.round(autoRefreshMs / 1000)}s 自动同步`}</span>
      </div>

      {logsQuery.error && (
        <div className="obs-card danger-tint" style={{ margin: "8px 12px 0" }}>
          <div className="obs-row-wrap" style={{ color: "var(--qj-status-danger)" }}>
            <AlertTriangle size={13} />
            <span>查询日志失败：{logsQuery.error}</span>
          </div>
        </div>
      )}

      <div className="obs-log-list">
        {logsQuery.loading && entries.length === 0 ? (
          <div className="obs-empty" style={{ margin: "12px" }}>正在加载三端统一日志…</div>
        ) : entries.length === 0 ? (
          <div className="obs-empty" style={{ margin: "12px" }}>当前筛选条件下暂无匹配日志</div>
        ) : (
          entries.map((entry) => {
            const hasStack = Boolean(entry.stack && entry.stack.trim() !== "");
            const isExpanded = Boolean(expandedStacks[entry.id]);
            return (
              <div key={entry.id} className="obs-log-entry">
                <div className="obs-log-line">
                  <span className="obs-log-time" title={`${entry.timestamp} (${entry.file})`}>
                    {formatClockMs(entry.timestamp, entry.epochMs)}
                  </span>
                  <span className={`obs-badge ${levelBadgeVariant(entry.level)} mono`}>
                    {entry.level.toUpperCase()}
                  </span>
                  <span className="obs-badge mono">{entry.plane} · [{entry.component}]</span>
                  {entry.pluginId && (
                    <button
                      type="button"
                      className="obs-badge warn mono clickable"
                      title="按此插件过滤日志"
                      onClick={() => {
                        if (entry.pluginId) onPluginIdFilterChange(entry.pluginId);
                      }}
                    >
                      {entry.pluginId}
                    </button>
                  )}
                  <span className="obs-log-msg">{entry.message}</span>
                  {hasStack && (
                    <button
                      type="button"
                      className="obs-btn ghost"
                      title={isExpanded ? "收起堆栈" : "展开堆栈"}
                      onClick={() => toggleStack(entry.id)}
                    >
                      {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                  )}
                  <button
                    type="button"
                    className="obs-btn ghost"
                    title="复制此条日志"
                    onClick={() => void copyLogEntry(entry)}
                  >
                    <Copy size={11} />
                  </button>
                </div>
                {hasStack && isExpanded && <pre className="obs-code-box">{entry.stack}</pre>}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
