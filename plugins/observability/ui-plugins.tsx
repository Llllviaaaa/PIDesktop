import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Blocks,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { callHostRpc, sendChatPrompt, showToast } from "@qianji/client";
import type { PluginInfo, PluginStatus, PluginTier } from "@qianji/protocol";

export interface PluginsHealthTabProps {
  cwd: string;
  plugins: PluginInfo[];
  pluginErrorCounts: Record<string, number>;
  loading: boolean;
  error: string | null;
  onRefreshAll: () => Promise<void>;
  onOpenPluginLogs: (pluginId: string) => void;
}

const TIER_LABELS: Record<PluginTier, string> = {
  builtin: "内置",
  user: "用户",
  workspace: "工作区",
};

const STATUS_META: Record<PluginStatus, { label: string; variant: string }> = {
  active: { label: "运行中", variant: "success" },
  errored: { label: "异常", variant: "danger" },
  pending: { label: "等待依赖", variant: "warn" },
  disabled: { label: "已停用", variant: "" },
  untrusted: { label: "未信任", variant: "warn" },
};

function computeSeverity(p: PluginInfo, logErrors: number): number {
  if (p.status === "errored" || Boolean(p.error) || Boolean(p.clientError)) return 3;
  if ((p.missingInject?.length ?? 0) > 0) return 2;
  if (logErrors > 0) return 1;
  return 0;
}

function buildPluginAiPrompt(p: PluginInfo, logErrors: number): string {
  const lines = [
    `请帮我诊断并修复千机（Qianji）插件 \`${p.id}\` (${p.name}) 的异常问题：`,
    `- 插件 ID: ${p.id} (v${p.version})`,
    `- 来源层级: ${p.tier}${p.dir ? ` (${p.dir})` : ""}`,
    `- 当前状态: ${p.status} (enabled=${String(p.enabled)})`,
    `- 历史错误日志数: ${logErrors}`,
  ];
  if (p.missingInject && p.missingInject.length > 0) {
    lines.push(`- 缺失 Cordis 依赖服务 (missingInject): ${p.missingInject.join(", ")}`);
  }
  if (p.error) {
    lines.push("", "### Host 端错误堆栈", "```text", p.error.slice(0, 2500), "```");
  }
  if (p.clientError) {
    lines.push(
      "",
      `### 前端槽位错误 (phase=${p.clientError.phase}${p.clientError.etag ? `, etag=${p.clientError.etag}` : ""})`,
      "```text",
      `${p.clientError.message}${p.clientError.stack ? `\n${p.clientError.stack}` : ""}`.slice(0, 2500),
      "```",
    );
  }
  lines.push("", "可先调用 `observability_inspect(topic: \"plugins\")` 或 `qianji_inspect(topic: \"plugins\")` 核实实时状态。");
  return lines.join("\n");
}

export function PluginsHealthTab({
  cwd,
  plugins,
  pluginErrorCounts,
  loading,
  error,
  onRefreshAll,
  onOpenPluginLogs,
}: PluginsHealthTabProps) {
  const [onlyUnhealthy, setOnlyUnhealthy] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [expandedBlocks, setExpandedBlocks] = useState<Record<string, boolean>>({});

  const enriched = useMemo(() => {
    const mapped = plugins.map((plugin) => {
      const errorCount = pluginErrorCounts[plugin.id] ?? 0;
      const severity = computeSeverity(plugin, errorCount);
      return { plugin, errorCount, severity };
    });
    mapped.sort((a, b) => {
      if (b.severity !== a.severity) return b.severity - a.severity;
      if (b.errorCount !== a.errorCount) return b.errorCount - a.errorCount;
      return a.plugin.id.localeCompare(b.plugin.id);
    });
    return mapped;
  }, [pluginErrorCounts, plugins]);

  const unhealthyCount = useMemo(
    () => enriched.filter((item) => item.severity > 0).length,
    [enriched],
  );

  const visibleItems = onlyUnhealthy
    ? enriched.filter((item) => item.severity > 0)
    : enriched;

  const toggleBlock = (key: string) => {
    setExpandedBlocks((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const runPluginAction = async (
    actionKey: string,
    rpcMethod: string,
    pluginId: string,
    successToast: string,
  ) => {
    if (busyKey !== null) return;
    setBusyKey(actionKey);
    try {
      await callHostRpc(rpcMethod, {
        id: pluginId,
        ...(cwd ? { workspace: cwd } : {}),
      });
      await onRefreshAll();
      showToast(successToast, "info");
    } catch (err) {
      showToast(`插件操作失败：${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setBusyKey(null);
    }
  };

  if (loading && plugins.length === 0) {
    return <div className="obs-scroll"><div className="obs-empty">正在读取全量插件健康状态…</div></div>;
  }

  return (
    <div className="obs-scroll" data-testid="obs-plugins-tab">
      {error && (
        <div className="obs-card danger-tint">
          <div className="obs-row-wrap" style={{ color: "var(--qj-status-danger)" }}>
            <AlertTriangle size={14} />
            <span>无法读取插件列表：{error}</span>
          </div>
        </div>
      )}

      <div className="obs-row-wrap" style={{ justifyContent: "space-between" }}>
        <div className="obs-row-wrap">
          <button
            type="button"
            className={`obs-btn${!onlyUnhealthy ? " primary" : ""}`}
            onClick={() => setOnlyUnhealthy(false)}
          >
            <span>全部插件 ({enriched.length})</span>
          </button>
          <button
            type="button"
            className={`obs-btn${onlyUnhealthy ? " primary" : ""}`}
            onClick={() => setOnlyUnhealthy(true)}
          >
            <span>异常与告警 ({unhealthyCount})</span>
          </button>
        </div>
      </div>

      {visibleItems.length === 0 ? (
        <div className="obs-empty">
          <Check size={16} style={{ color: "var(--qj-status-success)" }} />
          <span>{onlyUnhealthy ? "所有插件运行健康，暂无异常或报错记录" : "未发现已注册插件"}</span>
        </div>
      ) : (
        visibleItems.map(({ plugin: p, errorCount, severity }) => {
          const statusMeta = STATUS_META[p.status];
          const hostErrKey = `${p.id}:host`;
          const clientErrKey = `${p.id}:client`;
          const hostExpanded = expandedBlocks[hostErrKey] !== false;
          const clientExpanded = expandedBlocks[clientErrKey] !== false;
          const canToggleEnable = p.enabled ? p.canDisable !== false : true;

          return (
            <div
              key={`${p.tier}:${p.id}`}
              className={`obs-card${severity >= 3 ? " danger-tint" : severity > 0 ? " warn-tint" : ""}`}
            >
              <div className="obs-row-wrap" style={{ justifyContent: "space-between" }}>
                <div className="obs-row-wrap">
                  <Blocks size={13} style={{ color: "var(--qj-text-secondary)" }} />
                  <strong style={{ fontSize: "12.5px" }}>{p.name}</strong>
                  <span className="obs-badge mono">{p.id}</span>
                </div>
                <div className="obs-row-wrap">
                  <span className="obs-badge">{TIER_LABELS[p.tier]}</span>
                  <span className={`obs-badge ${statusMeta.variant}`}>{statusMeta.label}</span>
                  {errorCount > 0 && (
                    <span className="obs-badge warn">日志报错 {errorCount}</span>
                  )}
                </div>
              </div>

              {p.missingInject && p.missingInject.length > 0 && (
                <div className="obs-mono-path" style={{ color: "var(--qj-status-warning)" }}>
                  缺失依赖服务 (missingInject): {p.missingInject.join(", ")}
                </div>
              )}

              {p.error && (
                <div>
                  <button type="button" className="obs-btn ghost" onClick={() => toggleBlock(hostErrKey)}>
                    {hostExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span style={{ color: "var(--qj-status-danger)" }}>Host 错误详情</span>
                  </button>
                  {hostExpanded && <pre className="obs-code-box">{p.error}</pre>}
                </div>
              )}

              {p.clientError && (
                <div>
                  <button type="button" className="obs-btn ghost" onClick={() => toggleBlock(clientErrKey)}>
                    {clientExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span style={{ color: "var(--qj-status-danger)" }}>
                      前端{p.clientError.phase === "load" ? "加载" : "渲染"}熔断
                      {p.clientError.etag ? ` (${p.clientError.etag})` : ""}
                    </span>
                  </button>
                  {clientExpanded && (
                    <pre className="obs-code-box">
                      {p.clientError.message}
                      {p.clientError.stack ? `\n${p.clientError.stack}` : ""}
                    </pre>
                  )}
                </div>
              )}

              <div className="obs-row-wrap">
                <button
                  type="button"
                  className="obs-btn"
                  disabled={busyKey !== null}
                  onClick={() => void runPluginAction(`${p.id}:reload`, "plugin.reload", p.id, `已重载插件 ${p.name}`)}
                >
                  <RotateCcw size={11} />
                  <span>重载</span>
                </button>

                {canToggleEnable && (
                  <button
                    type="button"
                    className={`obs-btn${p.enabled ? "" : " primary"}`}
                    disabled={busyKey !== null}
                    onClick={() =>
                      void runPluginAction(
                        `${p.id}:toggle`,
                        p.enabled ? "plugin.disable" : "plugin.enable",
                        p.id,
                        `${p.enabled ? "已停用" : "已启用"}插件 ${p.name}`,
                      )
                    }
                  >
                    <span>{p.enabled ? "停用" : "启用"}</span>
                  </button>
                )}

                {p.clientError && (
                  <button
                    type="button"
                    className="obs-btn danger"
                    disabled={busyKey !== null}
                    onClick={() =>
                      void runPluginAction(
                        `${p.id}:clearClientError`,
                        "plugin.clearClientError",
                        p.id,
                        `已清除 ${p.name} 前端渲染熔断`,
                      )
                    }
                  >
                    <span>清除渲染熔断</span>
                  </button>
                )}

                <button type="button" className="obs-btn" onClick={() => onOpenPluginLogs(p.id)}>
                  <FileText size={11} />
                  <span>关联日志</span>
                </button>

                <button
                  type="button"
                  className="obs-btn primary"
                  onClick={() => {
                    void sendChatPrompt(buildPluginAiPrompt(p, errorCount), { prefillOnly: true });
                    showToast("已填入输入框，按回车即可让千机修复诊断", "info");
                  }}
                >
                  <Sparkles size={11} />
                  <span>AI 修复诊断</span>
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
