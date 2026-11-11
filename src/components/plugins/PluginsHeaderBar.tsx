import { LayoutGroup, motion } from "motion/react";
import type { PluginInstallChannel, PluginMutationResult } from "@qianji/protocol";
import { CloudDownload, Plus, RefreshCw, Search, X } from "lucide-react";
import { pluginClient } from "../../lib/pluginClient";
import { PILL_SPRING, type PluginFilter } from "./pluginHelpers";

export interface PluginsHeaderBarProps {
  cwd: string;
  busy: boolean;
  search: string;
  onChangeSearch: (next: string) => void;
  filter: PluginFilter;
  onChangeFilter: (next: PluginFilter) => void;
  filterTabs: ReadonlyArray<{ id: PluginFilter; label: string; count: number }>;
  updatableCount: number;
  onOpenInstall: (channel: PluginInstallChannel) => void;
  onRunTask: (task: { run: () => Promise<PluginMutationResult>; label: string }) => void;
}

export function PluginsHeaderBar({
  cwd,
  busy,
  search,
  onChangeSearch,
  filter,
  onChangeFilter,
  filterTabs,
  updatableCount,
  onOpenInstall,
  onRunTask,
}: PluginsHeaderBarProps) {
  return (
    <div className="plugins-header-stack">
      <div className="plugins-top-search-row">
        <label className="plugins-search-box">
          <Search size={14} />
          <input
            placeholder="搜索连接器、MCP 服务、技能或扩展模块…"
            value={search}
            onChange={(event) => onChangeSearch(event.target.value)}
          />
          {search !== "" && (
            <button type="button" aria-label="清空搜索" onClick={() => onChangeSearch("")}>
              <X size={12} />
            </button>
          )}
        </label>

        <div className="plugins-toolbar-right">
          {updatableCount > 0 && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => onRunTask({
                run: () => pluginClient.update({}),
                label: "已完成全部可更新插件的更新检查。",
              })}
            >
              <CloudDownload size={13} />
              <span>更新</span>
            </button>
          )}
          <button
            type="button"
            className="secondary-button plugins-reload-icon-btn"
            disabled={busy}
            title="热重载全部插件"
            aria-label="热重载全部插件"
            onClick={() => onRunTask({
              run: () => pluginClient.reload({ workspace: cwd }),
              label: "已重新扫描并热重载全部插件。",
            })}
          >
            <RefreshCw size={13.5} />
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => onOpenInstall("local")}
          >
            <Plus size={14} />
            <span>安装插件</span>
          </button>
        </div>
      </div>

      <LayoutGroup id="plugins-filter-bar">
        <div className="settings-segmented plugins-full-segmented" role="tablist" aria-label="插件分类筛选">
          {filterTabs.map((tab) => {
            const active = filter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={active ? "active" : ""}
                onClick={() => onChangeFilter(tab.id)}
              >
                {active && (
                  <motion.span
                    layoutId="plugins-filter-pill"
                    className="settings-segmented-thumb"
                    transition={PILL_SPRING}
                  />
                )}
                <span>{tab.label}</span>
                <small className="plugins-tab-count">{tab.count}</small>
              </button>
            );
          })}
        </div>
      </LayoutGroup>
    </div>
  );
}
