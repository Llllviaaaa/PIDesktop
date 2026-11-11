import { AnimatePresence } from "motion/react";
import type { McpServerStatus, PluginInfo, PluginMutationResult } from "@qianji/protocol";
import {
  CircleAlert,
  CloudDownload,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Settings2,
  Trash2,
} from "lucide-react";
import { agent } from "../../lib/agent";
import { pluginClient } from "../../lib/pluginClient";
import type { AppSettings } from "../../types";
import { PluginCardDrawer } from "./PluginCardDrawer";
import {
  canCheckUpdate,
  cleanDisplayName,
  coreOperationalChips,
  iconAccentTone,
  originLabel,
  PLUGIN_TO_APP_SETTING,
  PluginCategoryIcon,
  shouldShowVersion,
  statusState,
  type Notice,
} from "./pluginHelpers";

export interface PluginCardProps {
  plugin: PluginInfo;
  compactSystem?: boolean;
  cwd: string;
  isTauri: boolean;
  busy: boolean;
  clientError?: string;
  form?: AppSettings;
  onSyncAppSetting?: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  mcpStatuses: readonly McpServerStatus[];
  mcpReconnecting: boolean;
  onReconnectMcp: (serverId?: string) => void;
  onMcpServersUpdated: () => void;
  onNotify: (notice: Notice) => void;
  isEditing: boolean;
  onToggleEdit: (plugin: PluginInfo) => void;
  configDraft: string;
  onChangeConfigDraft: (next: string) => void;
  onCloseDrawer: () => void;
  onSaveConfig: (plugin: PluginInfo) => void;
  confirmRemove: boolean;
  onSetConfirmRemove: (id: string | null) => void;
  onRunTask: (task: { run: () => Promise<PluginMutationResult>; label: string }) => void;
}

export function PluginCard({
  plugin,
  compactSystem = false,
  cwd,
  isTauri,
  busy,
  clientError: runtimeClientError,
  form,
  onSyncAppSetting,
  mcpStatuses,
  mcpReconnecting,
  onReconnectMcp,
  onMcpServersUpdated,
  onNotify,
  isEditing,
  onToggleEdit,
  configDraft,
  onChangeConfigDraft,
  onCloseDrawer,
  onSaveConfig,
  confirmRemove,
  onSetConfirmRemove,
  onRunTask,
}: PluginCardProps) {
  const clientError = runtimeClientError ?? plugin.clientError?.message;
  const status = statusState(plugin, clientError);
  const channel = originLabel(plugin);
  const combinedError = plugin.error ?? clientError;
  const cannotDisable = plugin.canDisable === false;
  const switchDisabled = busy || plugin.status === "untrusted" || cannotDisable;
  const isExternal = plugin.tier === "user" || plugin.tier === "workspace";
  const title = cleanDisplayName(plugin);
  const opChips = compactSystem ? [] : coreOperationalChips(plugin, form, mcpStatuses);
  const scopeWorkspace = plugin.tier === "workspace" ? (plugin.workspace ?? cwd) : undefined;

  const extCapabilities: string[] = [];
  if (isExternal && channel !== null) extCapabilities.push(channel);
  if (isExternal && plugin.hasHost) extCapabilities.push("后端 Host");
  if (isExternal && plugin.hasClient) extCapabilities.push("前端 UI");

  return (
    <article
      className={[
        "plugin-bento-card",
        compactSystem ? "is-compact" : "",
        !plugin.enabled ? "is-disabled" : "",
        isEditing ? "is-editing" : "",
      ].filter(Boolean).join(" ")}
      data-plugin-id={plugin.id}
      data-plugin-tier={plugin.tier}
      data-enabled={plugin.enabled ? "true" : "false"}
    >
      <div className="plugin-card-head">
        <div className={`plugin-icon-tile tone-${iconAccentTone(plugin.id)}`} aria-hidden="true">
          <PluginCategoryIcon id={plugin.id} tier={plugin.tier} />
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={plugin.enabled}
          aria-label={`${plugin.enabled ? "停用" : "启用"} ${plugin.name}`}
          title={cannotDisable ? "核心网关模块需保持启用" : undefined}
          disabled={switchDisabled}
          className={`settings-switch ${plugin.enabled ? "on" : ""}`}
          onClick={() => {
            if (cannotDisable) return;
            const nextEnabled = !plugin.enabled;
            const params = {
              id: plugin.id,
              ...(scopeWorkspace === undefined ? {} : { workspace: scopeWorkspace }),
            };
            onRunTask({
              run: async () => {
                const result = nextEnabled
                  ? await pluginClient.enable(params)
                  : await pluginClient.disable(params);
                const syncedKey = PLUGIN_TO_APP_SETTING[plugin.id];
                if (syncedKey !== undefined && plugin.tier !== "workspace") {
                  onSyncAppSetting?.(syncedKey, nextEnabled as AppSettings[typeof syncedKey]);
                }
                return result;
              },
              label: `${nextEnabled ? "已启用" : "已停用"} "${title}"。`,
            });
          }}
        >
          <span />
        </button>
      </div>

      <div className="plugin-card-body">
        <div className="plugin-card-title-row">
          <strong>{title}</strong>
          {shouldShowVersion(plugin.version, plugin.tier) && (
            <span className="plugin-version">v{plugin.version}</span>
          )}
          {cannotDisable && <span className="plugin-quiet-pill">必需</span>}
          {plugin.overridesBuiltin && <span className="plugin-quiet-pill">覆盖内置</span>}
        </div>

        {plugin.description !== undefined && plugin.description !== "" && (
          <p className="plugin-card-desc">{plugin.description}</p>
        )}

        {opChips.length > 0 && (
          <div className="plugin-op-chips">
            {opChips.map((chip) => (
              <span
                key={chip.key}
                className={`plugin-op-chip${chip.tone ? ` tone-${chip.tone}` : ""}`}
              >
                {chip.label}
              </span>
            ))}
          </div>
        )}

        {extCapabilities.length > 0 && (
          <div className="plugin-card-ext-meta" title={plugin.origin?.spec}>
            {extCapabilities.map((item, idx) => (
              <span key={item}>
                {idx > 0 && <i aria-hidden="true">·</i>}
                {item}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="plugin-card-foot">
        <div className={`plugin-status-line ${status.tone}`}>
          <span className="plugin-status-dot" aria-hidden="true" />
          <span>{status.label}</span>
        </div>

        <div className="plugin-card-actions">
          {plugin.removable && confirmRemove ? (
            <>
              <button
                type="button"
                className="plugin-ghost-btn danger"
                disabled={busy}
                onClick={() => {
                  onSetConfirmRemove(null);
                  onRunTask({
                    run: () => pluginClient.remove({
                      id: plugin.id,
                      ...(scopeWorkspace === undefined ? {} : { workspace: scopeWorkspace }),
                    }),
                    label: plugin.overridesBuiltin
                      ? `已移除自定义覆盖并恢复内置默认 "${title}"。`
                      : `已卸载插件 "${title}"。`,
                  });
                }}
              >
                {plugin.overridesBuiltin ? "确认恢复默认" : "确认卸载"}
              </button>
              <button
                type="button"
                className="plugin-ghost-btn muted"
                onClick={() => onSetConfirmRemove(null)}
              >
                取消
              </button>
            </>
          ) : (
            <>
              {plugin.id === "mcp" && !isExternal && (form?.mcpServers.length ?? 0) > 0 && (
                <button
                  type="button"
                  className="plugin-ghost-btn icon-only"
                  title="重连全部 MCP 服务"
                  aria-label="重连全部 MCP 服务"
                  disabled={mcpReconnecting}
                  onClick={() => onReconnectMcp(undefined)}
                >
                  <RefreshCw size={12.5} />
                </button>
              )}

              {!cannotDisable && (
                <button
                  type="button"
                  className={`plugin-ghost-btn ${isEditing ? "active" : ""}`}
                  disabled={busy}
                  onClick={() => onToggleEdit(plugin)}
                >
                  <Settings2 size={12.5} />
                  <span>{isEditing ? "收起" : "配置"}</span>
                </button>
              )}

              {plugin.dir !== undefined && isTauri && isExternal && (
                <button
                  type="button"
                  className="plugin-ghost-btn icon-only"
                  title="在文件管理器中打开"
                  aria-label="在文件管理器中打开"
                  onClick={() => void agent.revealPathInFileManager(plugin.dir ?? "")}
                >
                  <FolderOpen size={13} />
                </button>
              )}

              {isExternal && (
                <button
                  type="button"
                  className="plugin-ghost-btn icon-only"
                  disabled={busy}
                  title="热重载"
                  aria-label="热重载"
                  onClick={() => onRunTask({
                    run: () => pluginClient.reload({ id: plugin.id, workspace: cwd }),
                    label: `已热重载插件 "${title}"。`,
                  })}
                >
                  <RefreshCw size={12.5} />
                </button>
              )}

              {canCheckUpdate(plugin) && (
                <button
                  type="button"
                  className="plugin-ghost-btn icon-only"
                  disabled={busy}
                  title="更新"
                  aria-label="更新"
                  onClick={() => onRunTask({
                    run: () => pluginClient.update({ id: plugin.id }),
                    label: `已完成插件 "${title}" 的更新与热加载。`,
                  })}
                >
                  <CloudDownload size={13} />
                </button>
              )}

              {plugin.removable && (
                <button
                  type="button"
                  className="plugin-ghost-btn danger icon-only"
                  disabled={busy}
                  title={plugin.overridesBuiltin ? "恢复默认" : "卸载"}
                  aria-label={plugin.overridesBuiltin ? "恢复默认" : "卸载"}
                  onClick={() => onSetConfirmRemove(plugin.id)}
                >
                  {plugin.overridesBuiltin ? <RotateCcw size={12.5} /> : <Trash2 size={12.5} />}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {plugin.status === "pending" && (
        <div className="plugin-inline-alert pending" role="status">
          <span>
            等待前置服务就绪
            {plugin.missingInject !== undefined && plugin.missingInject.length > 0
              ? `：${plugin.missingInject.join("、")}`
              : "…"}
          </span>
        </div>
      )}

      {combinedError !== undefined && (
        <div className="plugin-inline-alert error" role="alert">
          <span>
            <CircleAlert size={13} style={{ display: "inline", verticalAlign: "-2px", marginRight: 6 }} />
            {combinedError}
          </span>
          <button
            type="button"
            className="plugin-ghost-btn"
            disabled={busy}
            onClick={() => onRunTask({
              run: () => pluginClient.reload({ id: plugin.id, workspace: cwd }),
              label: `已重新加载插件 "${title}"。`,
            })}
          >
            重试
          </button>
        </div>
      )}

      <AnimatePresence initial={false}>
        {isEditing && (
          <PluginCardDrawer
            plugin={plugin}
            cwd={cwd}
            isTauri={isTauri}
            busy={busy}
            form={form}
            onSyncAppSetting={onSyncAppSetting}
            mcpStatuses={mcpStatuses}
            mcpReconnecting={mcpReconnecting}
            onReconnectMcp={onReconnectMcp}
            onMcpServersUpdated={onMcpServersUpdated}
            onNotify={onNotify}
            configDraft={configDraft}
            onChangeConfigDraft={onChangeConfigDraft}
            onCloseDrawer={onCloseDrawer}
            onSaveConfig={onSaveConfig}
            onRunTask={onRunTask}
          />
        )}
      </AnimatePresence>
    </article>
  );
}
