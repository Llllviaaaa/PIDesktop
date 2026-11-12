import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, FileText, Sparkles, Wrench } from "lucide-react";
import { callHostRpc, sendChatPrompt, showToast } from "@qianji/client";
import type { CrashRecord, ObservabilityAckResult, ObservabilityExportResult, ObservabilityOverviewResult } from "./types";

export interface OverviewTabProps {
  overview: ObservabilityOverviewResult | undefined;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onOpenPluginLogs: (pluginId: string) => void;
}

const CRASH_KIND_LABELS: Record<CrashRecord["kind"], string> = {
  unclean_desktop_exit: "上次异常闪退",
  rust_panic: "Rust Panic",
  webview_process_failed: "WebView 进程恢复",
  harness_unexpected_exit: "Sidecar 退出",
  harness_crash_loop: "Sidecar 崩溃熔断",
  uncaughtException: "未捕获异常",
  unhandledRejection: "未处理拒绝",
  startupFailure: "启动失败",
  renderer_crash: "渲染层异常",
  plugin_error: "插件运行异常",
};

const PLANE_LABELS: Record<CrashRecord["plane"], string> = {
  desktop: "Desktop",
  host: "Host",
  webview: "WebView",
};

function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function formatMb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const d = new Date(parsed);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function copyText(text: string, label: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      showToast(`已复制${label}`, "info");
    } else {
      showToast("当前环境不支持剪贴板写入", "warning");
    }
  } catch (err) {
    showToast(`复制失败：${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

function buildIncidentPrompt(item: CrashRecord): string {
  const lines = [
    `请帮我诊断以下千机（Qianji）系统异常/闪退记录，并结合 \`observability_inspect\` 工具排查根因与修复建议：`,
    `- 发生平面: ${PLANE_LABELS[item.plane]} (${item.plane})`,
    `- 异常类型: ${CRASH_KIND_LABELS[item.kind]} (${item.kind})`,
    `- 时间戳: ${item.timestamp}`,
    ...(item.pluginId ? [`- 归因插件: ${item.pluginId}`] : []),
    ...(item.exitCode !== undefined ? [`- 退出码: ${item.exitCode}`] : []),
    `- 摘要: ${item.summary}`,
  ];
  if (item.detail) {
    lines.push("", "```text", item.detail.slice(0, 3000), "```");
  }
  return lines.join("\n");
}

export function OverviewTab({
  overview,
  loading,
  error,
  onRefresh,
  onOpenPluginLogs,
}: OverviewTabProps) {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [exporting, setExporting] = useState(false);
  const [acking, setAcking] = useState(false);
  const [exportedPack, setExportedPack] = useState<ObservabilityExportResult | null>(null);

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await callHostRpc<ObservabilityExportResult>("observability.exportDiagnostics");
      setExportedPack(res);
      showToast(`已导出脱敏诊断包（${res.files.length} 个文件）`, "info");
    } catch (err) {
      showToast(`导出诊断包失败：${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setExporting(false);
    }
  };

  const handleAck = async () => {
    if (acking) return;
    setAcking(true);
    try {
      await callHostRpc<ObservabilityAckResult>("observability.ackIncidents");
      await onRefresh();
      showToast("已将异常告警标为已读", "info");
    } catch (err) {
      showToast(`操作失败：${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setAcking(false);
    }
  };

  const toggleDetail = (id: string) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  if (loading && !overview) {
    return <div className="obs-scroll"><div className="obs-empty">正在读取运行态遥测与闪退记录…</div></div>;
  }

  const host = overview?.host;
  const counts = overview?.counts;
  const incidents = overview?.recentIncidents ?? [];
  const toolIssues = overview?.recentToolIssues ?? [];
  const unacked = counts?.unackedCrashes ?? 0;
  const ackEpoch = overview?.lastAckedAt ? Date.parse(overview.lastAckedAt) : 0;

  return (
    <div className="obs-scroll" data-testid="obs-overview-tab">
      {error && (
        <div className="obs-card danger-tint">
          <div className="obs-row-wrap" style={{ color: "var(--qj-status-danger)" }}>
            <AlertTriangle size={14} />
            <span>无法读取 Host 观测概览：{error}</span>
          </div>
        </div>
      )}

      <div className="obs-metrics-grid">
        <div className="obs-metric-card">
          <span className="obs-metric-label">Host 运行时长</span>
          <span className="obs-metric-val">{host ? formatUptime(host.uptimeMs) : "—"}</span>
          <span className="obs-metric-sub">{host ? `v${host.version} · PID ${host.pid}` : "等待连接"}</span>
        </div>
        <div className="obs-metric-card">
          <span className="obs-metric-label">内存占用 (RSS / Heap)</span>
          <span className="obs-metric-val">{host ? formatMb(host.memoryRssBytes) : "—"}</span>
          <span className="obs-metric-sub">{host ? `Heap ${formatMb(host.heapUsedBytes)}` : "—"}</span>
        </div>
        <div className="obs-metric-card">
          <span className="obs-metric-label">今日日志错误 / 告警</span>
          <span className="obs-metric-val" style={(counts?.errorLogsToday ?? 0) > 0 ? { color: "var(--qj-status-danger)" } : undefined}>
            {counts ? `${counts.errorLogsToday} 错误` : "—"}
          </span>
          <span className="obs-metric-sub">{counts ? `${counts.warnLogsToday} 条告警` : "—"}</span>
        </div>
        <div className="obs-metric-card">
          <span className="obs-metric-label">工具异常 / 未读闪退</span>
          <span className="obs-metric-val" style={unacked > 0 ? { color: "var(--qj-status-danger)" } : undefined}>
            {counts ? `${counts.toolFailuresSession} 工具失败` : "—"}
          </span>
          <span className="obs-metric-sub">{unacked > 0 ? `${unacked} 条未读异常` : "无未读闪退"}</span>
        </div>
      </div>

      <div className="obs-card">
        <div className="obs-section-head">
          <span>日志目录与诊断包</span>
          <span style={{ fontSize: "11px", fontWeight: 400, color: "var(--qj-text-muted)" }}>
            {overview ? `${overview.logFiles.length} 个日志文件` : ""}
          </span>
        </div>
        {host?.logsDir && <div className="obs-mono-path">{host.logsDir}</div>}
        <div className="obs-row-wrap">
          {host?.logsDir && (
            <button type="button" className="obs-btn" onClick={() => void copyText(host.logsDir, "日志目录路径")}>
              <Copy size={12} />
              <span>复制路径</span>
            </button>
          )}
          <button type="button" className="obs-btn primary" disabled={exporting} onClick={() => void handleExport()}>
            <FileText size={12} />
            <span>{exporting ? "正在打包…" : "一键导出脱敏诊断包"}</span>
          </button>
          {(unacked > 0 || incidents.length > 0) && (
            <button type="button" className="obs-btn" disabled={acking || unacked === 0} onClick={() => void handleAck()}>
              <Check size={12} />
              <span>{unacked > 0 ? `标为已读 (${unacked})` : "告警已读"}</span>
            </button>
          )}
        </div>
        {exportedPack && (
          <div className="obs-mono-path" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <span>已导出: {exportedPack.path} ({formatMb(exportedPack.sizeBytes)})</span>
            <button type="button" className="obs-btn ghost" onClick={() => void copyText(exportedPack.path, "诊断包路径")}>
              <Copy size={11} />
            </button>
          </div>
        )}
      </div>

      <div className="obs-section-head">
        <span>闪退与异常时间线 ({incidents.length})</span>
      </div>

      {incidents.length === 0 ? (
        <div className="obs-empty">
          <Check size={16} style={{ color: "var(--qj-status-success)" }} />
          <span>暂未检测到闪退或严重异常</span>
        </div>
      ) : (
        incidents.map((item) => {
          const isUnread = ackEpoch <= 0 || Date.parse(item.timestamp) > ackEpoch;
          const expanded = Boolean(expandedIds[item.id]);
          return (
            <div key={item.id} className={`obs-card${isUnread ? " danger-tint" : ""}`}>
              <div className="obs-row-wrap" style={{ justifyContent: "space-between" }}>
                <div className="obs-row-wrap">
                  {isUnread && <span className="obs-dot danger" title="未读异常" />}
                  <span className="obs-badge info">{PLANE_LABELS[item.plane]}</span>
                  <span className="obs-badge danger">{CRASH_KIND_LABELS[item.kind]}</span>
                  {item.pluginId && (
                    <button
                      type="button"
                      className="obs-badge warn mono clickable"
                      title="查看该插件关联日志"
                      onClick={() => {
                        if (item.pluginId) onOpenPluginLogs(item.pluginId);
                      }}
                    >
                      plugin:{item.pluginId}
                    </button>
                  )}
                </div>
                <span style={{ fontSize: "11px", color: "var(--qj-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                  {formatTime(item.timestamp)}
                </span>
              </div>
              <div style={{ fontSize: "12px", lineHeight: 1.45, wordBreak: "break-word" }}>{item.summary}</div>
              <div className="obs-row-wrap">
                {item.detail && (
                  <button type="button" className="obs-btn ghost" onClick={() => toggleDetail(item.id)}>
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span>{expanded ? "收起详情" : "展开堆栈/日志"}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="obs-btn primary"
                  onClick={() => {
                    void sendChatPrompt(buildIncidentPrompt(item), { prefillOnly: true });
                    showToast("已填入输入框，按回车即可让千机诊断", "info");
                  }}
                >
                  <Sparkles size={12} />
                  <span>发送给 AI 诊断</span>
                </button>
              </div>
              {expanded && item.detail && <pre className="obs-code-box">{item.detail}</pre>}
            </div>
          );
        })
      )}

      {toolIssues.length > 0 && (
        <>
          <div className="obs-section-head">
            <span>近期工具失败与慢调用 ({toolIssues.length})</span>
          </div>
          {toolIssues.map((issue) => (
            <div key={issue.id} className={`obs-card${issue.isError ? " warn-tint" : ""}`}>
              <div className="obs-row-wrap" style={{ justifyContent: "space-between" }}>
                <div className="obs-row-wrap">
                  <Wrench size={12} style={{ color: "var(--qj-text-muted)" }} />
                  <span className="obs-badge mono">{issue.toolName}</span>
                  <span className={`obs-badge ${issue.isError ? "danger" : "warn"}`}>
                    {issue.isError ? "执行失败" : "慢调用"}
                  </span>
                  {issue.durationMs !== undefined && (
                    <span style={{ fontSize: "11px", color: "var(--qj-text-muted)" }}>
                      {issue.durationMs >= 1000 ? `${(issue.durationMs / 1000).toFixed(1)}s` : `${Math.round(issue.durationMs)}ms`}
                    </span>
                  )}
                </div>
                <span style={{ fontSize: "11px", color: "var(--qj-text-muted)" }}>{formatTime(issue.timestamp)}</span>
              </div>
              <div className="obs-code-box" style={{ maxHeight: "96px" }}>{issue.preview}</div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
