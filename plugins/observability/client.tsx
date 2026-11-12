/**
 * Client UI entry for `observability` (`系统可观测与诊断`).
 *
 * Contributes:
 * 1. Scoped `--qj-*` stylesheet (`observability-styles`)
 * 2. Bottom-right workspace status bar health pill (`observability-status-pill`)
 * 3. Right Workbench observability & crash forensics panel (`observability-panel`)
 * 4. `/logs` and `/obs` bare slash command interceptor (`observability-slash`)
 */
import { useCallback, useMemo, useState } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Activity, RefreshCw } from "lucide-react";
import {
  openWorkbenchTab,
  showToast,
  useHostRpcQuery,
  usePluginConfig,
  type WorkbenchSlotContext,
} from "@qianji/client";
import type { PluginInfo, PluginListResult } from "@qianji/protocol";
import { OBSERVABILITY_CSS } from "./styles";
import type {
  ObservabilityOverviewResult,
  ObservabilityPluginConfig,
} from "./types";
import { LogsTab } from "./ui-logs";
import { OverviewTab } from "./ui-overview";
import { PluginsHealthTab } from "./ui-plugins";

export const name = "observability-client";
export const inject = ["contributions", "styles"];

type PanelViewId = "overview" | "logs" | "plugins";

const DEFAULT_CONFIG: Required<ObservabilityPluginConfig> = {
  showStatusBarPill: true,
  autoRefreshMs: 3000,
  defaultTailLines: 200,
  dedupeMirroredStderr: true,
};

function normalizeRefreshMs(ms: number | undefined): number {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 1000 ? ms : 3000;
}

function countUnhealthyPlugins(plugins: readonly PluginInfo[] | undefined): number {
  if (!plugins) return 0;
  let count = 0;
  for (const p of plugins) {
    if (p.status === "errored" || Boolean(p.error) || Boolean(p.clientError)) {
      count += 1;
    }
  }
  return count;
}

function ObservabilityStatusPill({ slotContext }: { slotContext: WorkbenchSlotContext }) {
  const config = usePluginConfig<ObservabilityPluginConfig>("observability", DEFAULT_CONFIG);
  const showPill = config.showStatusBarPill !== false;
  const autoRefreshMs = normalizeRefreshMs(config.autoRefreshMs);
  const pluginParams = useMemo(
    () => (slotContext.cwd ? { workspace: slotContext.cwd } : {}),
    [slotContext.cwd],
  );

  const overviewQuery = useHostRpcQuery<ObservabilityOverviewResult>(
    "observability.overview",
    {},
    { enabled: showPill, refreshIntervalMs: autoRefreshMs },
  );
  const pluginsQuery = useHostRpcQuery<PluginListResult>(
    "plugin.list",
    pluginParams,
    { enabled: showPill, refreshIntervalMs: autoRefreshMs },
  );

  if (!showPill) {
    return null;
  }

  const unhealthyPlugins = countUnhealthyPlugins(pluginsQuery.data?.plugins);
  const unackedCrashes = overviewQuery.data?.counts.unackedCrashes ?? 0;
  const criticalTotal = unhealthyPlugins + unackedCrashes;
  const errorLogsToday = overviewQuery.data?.counts.errorLogsToday ?? 0;

  let variantClass = "";
  let dotClass = "";
  let label = "观测";
  let title = "系统运行正常 — 点击打开可观测与日志诊断面板";

  if (criticalTotal > 0) {
    variantClass = " danger";
    dotClass = " danger";
    label = `观测 · ${criticalTotal} 异常`;
    title = `检测到 ${unackedCrashes} 条未读闪退/异常，${unhealthyPlugins} 个异常插件 — 点击查看诊断`;
  } else if (errorLogsToday > 0) {
    variantClass = " warn";
    dotClass = " warn";
    label = `观测 · ${errorLogsToday} 错误`;
    title = `今日累计 ${errorLogsToday} 条错误日志 — 点击打开可观测面板`;
  }

  return (
    <button
      type="button"
      className={`obs-status-pill${variantClass}`}
      data-testid="observability-status-pill"
      title={title}
      onClick={() => openWorkbenchTab("observability-panel")}
    >
      <span className={`obs-dot${dotClass}`} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function ObservabilityWorkbenchPanel({ slotContext }: { slotContext: WorkbenchSlotContext }) {
  const config = usePluginConfig<ObservabilityPluginConfig>("observability", DEFAULT_CONFIG);
  const autoRefreshMs = normalizeRefreshMs(config.autoRefreshMs);
  const defaultTailLines = config.defaultTailLines ?? DEFAULT_CONFIG.defaultTailLines;
  const defaultDedupeStderr = config.dedupeMirroredStderr !== false;

  const [activeView, setActiveView] = useState<PanelViewId>("overview");
  const [logPluginFilter, setLogPluginFilter] = useState<string>("");

  const pluginParams = useMemo(
    () => (slotContext.cwd ? { workspace: slotContext.cwd } : {}),
    [slotContext.cwd],
  );

  const overviewQuery = useHostRpcQuery<ObservabilityOverviewResult>(
    "observability.overview",
    {},
    { refreshIntervalMs: autoRefreshMs },
  );
  const pluginsQuery = useHostRpcQuery<PluginListResult>(
    "plugin.list",
    pluginParams,
    { refreshIntervalMs: autoRefreshMs },
  );

  const handleRefreshAll = useCallback(async () => {
    await Promise.all([overviewQuery.refetch(), pluginsQuery.refetch()]);
  }, [overviewQuery, pluginsQuery]);

  const handleOpenPluginLogs = useCallback((pluginId: string) => {
    setLogPluginFilter(pluginId);
    setActiveView("logs");
  }, []);

  const unackedCrashes = overviewQuery.data?.counts.unackedCrashes ?? 0;
  const totalIncidents = overviewQuery.data?.counts.totalIncidents ?? 0;
  const unhealthyPlugins = countUnhealthyPlugins(pluginsQuery.data?.plugins);

  return (
    <div className="obs-panel" data-testid="observability-panel">
      <div className="obs-subnav">
        <div className="obs-subtabs" role="tablist" aria-label="可观测诊断视图">
          <button
            type="button"
            role="tab"
            aria-selected={activeView === "overview"}
            className={`obs-subtab${activeView === "overview" ? " active" : ""}`}
            onClick={() => setActiveView("overview")}
          >
            <span>概览与闪退</span>
            {unackedCrashes > 0 ? (
              <span className="obs-tab-badge danger">{unackedCrashes}</span>
            ) : totalIncidents > 0 ? (
              <span className="obs-tab-badge">{totalIncidents}</span>
            ) : null}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeView === "logs"}
            className={`obs-subtab${activeView === "logs" ? " active" : ""}`}
            onClick={() => setActiveView("logs")}
          >
            <span>三端日志</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeView === "plugins"}
            className={`obs-subtab${activeView === "plugins" ? " active" : ""}`}
            onClick={() => setActiveView("plugins")}
          >
            <span>插件健康</span>
            {unhealthyPlugins > 0 && (
              <span className="obs-tab-badge danger">{unhealthyPlugins}</span>
            )}
          </button>
        </div>

        <button
          type="button"
          className="obs-btn ghost"
          title="手动刷新观测数据"
          onClick={() => void handleRefreshAll()}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {activeView === "overview" && (
        <OverviewTab
          overview={overviewQuery.data}
          loading={overviewQuery.loading}
          error={overviewQuery.error}
          onRefresh={overviewQuery.refetch}
          onOpenPluginLogs={handleOpenPluginLogs}
        />
      )}

      {activeView === "logs" && (
        <LogsTab
          defaultTailLines={defaultTailLines}
          defaultDedupeStderr={defaultDedupeStderr}
          autoRefreshMs={autoRefreshMs}
          pluginIdFilter={logPluginFilter}
          onPluginIdFilterChange={setLogPluginFilter}
        />
      )}

      {activeView === "plugins" && (
        <PluginsHealthTab
          cwd={slotContext.cwd}
          plugins={pluginsQuery.data?.plugins ?? []}
          pluginErrorCounts={overviewQuery.data?.pluginErrorCounts ?? {}}
          loading={pluginsQuery.loading}
          error={pluginsQuery.error}
          onRefreshAll={handleRefreshAll}
          onOpenPluginLogs={handleOpenPluginLogs}
        />
      )}
    </div>
  );
}

export function apply(ctx: Context): void {
  ctx.styles.inject(OBSERVABILITY_CSS, "observability-styles");

  ctx.contributions.registerStatusBarItem({
    id: "observability-status-pill",
    align: "right",
    order: 20,
    render: (slotContext) => <ObservabilityStatusPill slotContext={slotContext} />,
  });

  ctx.contributions.registerRightWorkbenchTab({
    id: "observability-panel",
    label: "可观测",
    icon: <Activity size={13} />,
    order: 25,
    render: (slotContext) => <ObservabilityWorkbenchPanel slotContext={slotContext} />,
  });

  ctx.contributions.registerSlashInterceptor({
    id: "observability-slash",
    order: 20,
    onSlashCommand: (cmdName, rawArgs) => {
      const normalized = cmdName.trim().toLowerCase();
      if ((normalized === "logs" || normalized === "obs") && rawArgs.trim() === "") {
        openWorkbenchTab("observability-panel");
        showToast("已打开系统可观测与诊断面板", "info");
        return true;
      }
      return false;
    },
  });
}

export default {
  name,
  inject,
  apply,
};
