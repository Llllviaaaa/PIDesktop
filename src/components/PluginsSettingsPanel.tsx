import { AnimatePresence, motion } from "motion/react";
import type { PluginInfo } from "@qianji/protocol";
import { Boxes, ChevronDown, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { describeError } from "../lib/errors";
import type { AppSettings } from "../types";
import { InstallPluginDialog } from "./plugins/InstallPluginDialog";
import { PluginCard } from "./plugins/PluginCard";
import type { PluginFilter } from "./plugins/pluginHelpers";
import { PluginsEmptyHub } from "./plugins/PluginsEmptyHub";
import { PluginsHeaderBar } from "./plugins/PluginsHeaderBar";
import { SkillsSettingsSection } from "./plugins/SkillsSettingsSection";
import { usePluginsPanelState } from "./plugins/usePluginsPanelState";

export interface PluginsSettingsPanelProps {
  cwd: string;
  form?: AppSettings;
  onSyncAppSetting?: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function PluginsSettingsPanel({ cwd, form, onSyncAppSetting }: PluginsSettingsPanelProps) {
  const isTauri = "__TAURI_INTERNALS__" in window;
  const state = usePluginsPanelState(cwd, form);

  const isSearching = state.search.trim() !== "";
  const effectiveSystemOpen = isSearching || state.systemExpanded;
  const currentTrust = state.trustQuery.data?.current;
  const showTrustCard = currentTrust !== undefined && (
    currentTrust.hasProjectPlugins || currentTrust.hasProjectConfig || currentTrust.trusted
  );
  const busy = state.actionMutation.isPending || state.trustMutation.isPending;

  const filterTabs: ReadonlyArray<{ id: PluginFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: state.counts.all },
    { id: "builtin", label: "核心能力", count: state.counts.builtin },
    { id: "user", label: "已安装", count: state.counts.user },
    { id: "workspace", label: "项目级", count: state.counts.workspace },
    { id: "skills", label: "技能包", count: state.skillsQuery.data?.length ?? 0 },
  ];
  const hasBothGroups = state.installedList.length > 0 && state.coreList.length > 0;

  const renderCard = (plugin: PluginInfo, compactSystem = false) => (
    <PluginCard
      key={`${plugin.tier}:${plugin.id}`}
      plugin={plugin}
      compactSystem={compactSystem}
      cwd={cwd}
      isTauri={isTauri}
      busy={busy}
      clientError={state.clientErrors[plugin.id]}
      form={form}
      onSyncAppSetting={onSyncAppSetting}
      mcpStatuses={state.mcpStatuses}
      mcpReconnecting={state.mcpReconnectMutation.isPending}
      onReconnectMcp={(serverId) => state.mcpReconnectMutation.mutate(serverId)}
      onMcpServersUpdated={state.scheduleMcpRefresh}
      onNotify={state.setNotice}
      isEditing={state.editingConfigId === plugin.id}
      onToggleEdit={state.openConfigEditor}
      configDraft={state.configDraft}
      onChangeConfigDraft={state.setConfigDraft}
      onCloseDrawer={() => state.setEditingConfigId(null)}
      onSaveConfig={state.saveConfig}
      confirmRemove={state.confirmRemoveId === plugin.id}
      onSetConfirmRemove={state.setConfirmRemoveId}
      onRunTask={(task) => state.actionMutation.mutate(task)}
    />
  );

  return (
    <div className="plugins-panel">
      <PluginsHeaderBar
        cwd={cwd}
        busy={busy}
        search={state.search}
        onChangeSearch={state.setSearch}
        filter={state.filter}
        onChangeFilter={state.setFilter}
        filterTabs={filterTabs}
        updatableCount={state.updatableCount}
        onOpenInstall={(ch) => {
          state.setNotice(null);
          state.setInstallChannel(ch);
        }}
        onRunTask={(task) => state.actionMutation.mutate(task)}
      />

      <AnimatePresence initial={false}>
        {state.notice !== null && (
          <motion.div
            className={`plugins-notice ${state.notice.kind}`}
            role="status"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14 }}
          >
            <span>{state.notice.text}</span>
            <button type="button" className="icon-button" aria-label="关闭提示" onClick={() => state.setNotice(null)}>
              <X size={13} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {state.filter === "skills" ? (
        <SkillsSettingsSection cwd={cwd} search={state.search} onNotify={state.setNotice} />
      ) : (
        <>
          {showTrustCard && currentTrust !== undefined && (
            <div className={`plugins-trust-banner${currentTrust.trusted ? " trusted" : ""}`}>
              <div className="plugins-trust-body">
                <strong>
                  {currentTrust.trusted ? "工作区已信任（允许加载 .qianji/plugins 项目扩展）" : "工作区尚未信任（已拦截 .qianji/plugins 项目扩展）"}
                </strong>
                <p>
                  <code>{currentTrust.workspace}</code>
                  {currentTrust.pluginIds.length > 0 && ` · 包含：${currentTrust.pluginIds.join("、")}`}
                </p>
              </div>
              <div>
                {currentTrust.trusted ? (
                  <button type="button" className="secondary-button" disabled={busy} onClick={() => state.trustMutation.mutate(false)}>
                    <ShieldAlert size={13} />
                    <span>撤销信任</span>
                  </button>
                ) : (
                  <button type="button" className="primary-button" disabled={busy} onClick={() => state.trustMutation.mutate(true)}>
                    <ShieldCheck size={13} />
                    <span>信任并启用项目插件</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {state.pluginsQuery.isPending ? (
            <div className="plugins-empty">正在读取插件列表…</div>
          ) : state.pluginsQuery.isError ? (
            <div className="plugin-inline-alert error">
              <span>读取插件列表失败：{describeError(state.pluginsQuery.error)}</span>
              <button type="button" className="plugin-ghost-btn" onClick={() => void state.pluginsQuery.refetch()}>重试</button>
            </div>
          ) : state.installedList.length === 0 && state.coreList.length === 0 && state.systemList.length === 0 ? (
            <PluginsEmptyHub
              cwd={cwd}
              isTauri={isTauri}
              busy={busy}
              isSearching={isSearching}
              filter={state.filter}
              onOpenInstall={(ch) => {
                state.setNotice(null);
                state.setInstallChannel(ch);
              }}
              onRunTask={(task) => state.actionMutation.mutate(task)}
            />
          ) : (
            <div className="plugins-groups">
              {state.installedList.length > 0 && (
                <section className="plugins-group">
                  {hasBothGroups && (
                    <h2 className="plugins-group-heading">
                      <span>已安装扩展</span>
                      <em>{state.installedList.length}</em>
                    </h2>
                  )}
                  <div className="plugins-bento-grid">{state.installedList.map((item) => renderCard(item))}</div>
                </section>
              )}
              {state.coreList.length > 0 && (
                <section className="plugins-group">
                  {hasBothGroups && (
                    <h2 className="plugins-group-heading">
                      <span>核心智能体能力</span>
                      <em>{state.coreList.length}</em>
                    </h2>
                  )}
                  <div className="plugins-bento-grid">{state.coreList.map((item) => renderCard(item))}</div>
                </section>
              )}
              {state.systemList.length > 0 && (
                <section className="plugins-group">
                  <button
                    type="button"
                    className="plugins-disclosure-btn"
                    aria-expanded={effectiveSystemOpen}
                    onClick={() => state.setSystemExpanded((v) => !v)}
                  >
                    <span>
                      <Boxes size={13.5} />
                      <span>底层运行时与协议模块（{state.systemList.length} 项）</span>
                    </span>
                    <ChevronDown size={14} className={effectiveSystemOpen ? "open" : ""} />
                  </button>
                  <AnimatePresence initial={false}>
                    {effectiveSystemOpen && (
                      <motion.div
                        className="plugins-bento-grid is-system"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.14 }}
                      >
                        {state.systemList.map((item) => renderCard(item, true))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </section>
              )}
            </div>
          )}
        </>
      )}

      <AnimatePresence>
        {state.installChannel !== null && (
          <InstallPluginDialog
            isTauri={isTauri}
            initialChannel={state.installChannel}
            onClose={() => state.setInstallChannel(null)}
            onInstalled={(result, label) => {
              state.setInstallChannel(null);
              state.applyMutationResult(result, label);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
