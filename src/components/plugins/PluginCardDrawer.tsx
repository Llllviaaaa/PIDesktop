import { motion } from "motion/react";
import type { McpServerStatus, PluginInfo, PluginMutationResult } from "@qianji/protocol";
import { Check } from "lucide-react";
import { pluginClient } from "../../lib/pluginClient";
import type { AppSettings } from "../../types";
import { CoreCapabilityDrawer } from "./CoreCapabilityDrawer";
import { hasRenderableConfigSchema, PluginConfigSchemaForm } from "./PluginConfigSchemaForm";
import { cleanDisplayName, CORE_EXTENSION_SET, type Notice } from "./pluginHelpers";

export interface PluginCardDrawerProps {
  plugin: PluginInfo;
  cwd: string;
  isTauri: boolean;
  busy: boolean;
  form?: AppSettings;
  onSyncAppSetting?: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  mcpStatuses: readonly McpServerStatus[];
  mcpReconnecting: boolean;
  onReconnectMcp: (serverId?: string) => void;
  onMcpServersUpdated: () => void;
  onNotify: (notice: Notice) => void;
  configDraft: string;
  onChangeConfigDraft: (next: string) => void;
  onCloseDrawer: () => void;
  onSaveConfig: (plugin: PluginInfo) => void;
  onRunTask: (task: { run: () => Promise<PluginMutationResult>; label: string }) => void;
}

export function PluginCardDrawer({
  plugin,
  cwd,
  isTauri,
  busy,
  form,
  onSyncAppSetting,
  mcpStatuses,
  mcpReconnecting,
  onReconnectMcp,
  onMcpServersUpdated,
  onNotify,
  configDraft,
  onChangeConfigDraft,
  onCloseDrawer,
  onSaveConfig,
  onRunTask,
}: PluginCardDrawerProps) {
  const isExternal = plugin.tier === "user" || plugin.tier === "workspace";
  const isStructuredCore = !isExternal
    && CORE_EXTENSION_SET.has(plugin.id)
    && form !== undefined
    && onSyncAppSetting !== undefined;
  const title = cleanDisplayName(plugin);
  const scopeWorkspace = plugin.tier === "workspace" ? (plugin.workspace ?? cwd) : undefined;

  if (isStructuredCore && form !== undefined && onSyncAppSetting !== undefined) {
    return (
      <motion.div
        className="plugin-structured-drawer"
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.15 }}
      >
        <CoreCapabilityDrawer
          plugin={plugin}
          cwd={cwd}
          isTauri={isTauri}
          form={form}
          onSyncAppSetting={onSyncAppSetting}
          mcpStatuses={mcpStatuses}
          mcpReconnecting={mcpReconnecting}
          onReconnectMcp={onReconnectMcp}
          onMcpServersUpdated={onMcpServersUpdated}
          onNotify={onNotify}
        />

        <details className="plugin-raw-json-details">
          <summary>高级底层 JSON 参数覆盖（~/.qianji/plugins.json）</summary>
          <div className="plugin-raw-json-body">
            <textarea
              id={`plugin-config-${plugin.id}`}
              value={configDraft}
              onChange={(event) => onChangeConfigDraft(event.target.value)}
              spellCheck={false}
            />
            <div className="plugin-config-footer">
              <button
                type="button"
                className="secondary-button"
                onClick={() => onChangeConfigDraft("{}")}
              >
                重置为空对象
              </button>
              <div className="plugin-config-footer-right">
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy}
                  onClick={() => onSaveConfig(plugin)}
                >
                  <Check size={13} />
                  <span>保存底层 JSON</span>
                </button>
              </div>
            </div>
          </div>
        </details>
      </motion.div>
    );
  }

  return (
    <motion.div
      className="plugin-config-drawer"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.15 }}
    >
      <div className="plugin-config-top">
        <label htmlFor={`plugin-config-${plugin.id}`}>
          {hasRenderableConfigSchema(plugin.configSchema)
            ? "插件选项配置（保存后立即热应用）"
            : <>JSON 配置（保存后立即热应用至 <code>~/.qianji/plugins.json</code>）</>}
        </label>
        {isExternal && (
          <label className="plugin-watch-toggle">
            <input
              type="checkbox"
              checked={plugin.watch}
              disabled={busy}
              onChange={(event) => {
                const nextWatch = event.target.checked;
                onRunTask({
                  run: () => pluginClient.configure({
                    id: plugin.id,
                    config: plugin.config ?? {},
                    watch: nextWatch,
                    ...(scopeWorkspace === undefined ? {} : { workspace: scopeWorkspace }),
                  }),
                  label: `${nextWatch ? "已开启" : "已关闭"} "${title}" 的源码热更新监听。`,
                });
              }}
            />
            <span>源码保存自动热更新 (HMR)</span>
          </label>
        )}
      </div>

      {plugin.configSchema !== undefined && hasRenderableConfigSchema(plugin.configSchema) ? (
        <>
          <PluginConfigSchemaForm
            pluginId={plugin.id}
            schema={plugin.configSchema}
            disabled={busy}
            value={(() => {
              try {
                const parsed: unknown = configDraft.trim() === "" ? {} : JSON.parse(configDraft);
                if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                  return parsed as Record<string, unknown>;
                }
              } catch {
                // Fall back to persisted config when raw JSON draft is temporarily invalid.
              }
              return plugin.config ?? {};
            })()}
            onChange={(nextObj) => {
              onChangeConfigDraft(JSON.stringify(nextObj, null, 2));
            }}
          />
          <details className="plugin-raw-json-details">
            <summary>编辑底层 JSON（~/.qianji/plugins.json）</summary>
            <div className="plugin-raw-json-body">
              <textarea
                id={`plugin-config-${plugin.id}`}
                value={configDraft}
                onChange={(event) => onChangeConfigDraft(event.target.value)}
                spellCheck={false}
              />
            </div>
          </details>
        </>
      ) : (
        <textarea
          id={`plugin-config-${plugin.id}`}
          value={configDraft}
          onChange={(event) => onChangeConfigDraft(event.target.value)}
          spellCheck={false}
        />
      )}

      <div className="plugin-config-footer">
        <button
          type="button"
          className="secondary-button"
          onClick={() => onChangeConfigDraft("{}")}
        >
          重置为空对象
        </button>
        <div className="plugin-config-footer-right">
          <button
            type="button"
            className="secondary-button"
            onClick={onCloseDrawer}
          >
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => onSaveConfig(plugin)}
          >
            <Check size={13} />
            <span>保存配置</span>
          </button>
        </div>
      </div>
    </motion.div>
  );
}
