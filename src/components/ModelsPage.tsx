import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, CircleAlert, CircleCheck, LoaderCircle, Plus, RefreshCw, Search, X } from "lucide-react";
import { isCustomProvider } from "../lib/modelProviders";
import { modelThinkingKey } from "../lib/thinkingLevels";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import type { AppSettings } from "../types";
import { CustomProviderEditor } from "./models/CustomProviderEditor";
import { DefaultPreferencesCard } from "./models/DefaultPreferencesCard";
import { draftFromConfig, effectiveModelThinking, emptyDraft, type Update } from "./models/modelPageHelpers";
import { PresetAccordionBody } from "./models/PresetAccordionBody";
import { ProviderAccordionBody } from "./models/ProviderAccordionBody";
import { useModelsPageState } from "./models/useModelsPageState";

export function ModelsPage({ form, update }: { form: AppSettings; update: Update }) {
  const state = useModelsPageState(form, update);

  return (
    <div className="models-single-stream">
      <DefaultPreferencesCard
        providers={state.providers}
        hidden={state.hidden}
        form={form}
        update={update}
      />

      <section className="settings-layered-section">
        <div className="models-section-head">
          <div className="models-section-title-wrap">
            <h2>服务商与 API 密钥</h2>
            {state.connectedCount > 0 && (
              <span className="models-connected-count">已启用 {state.connectedCount}</span>
            )}
          </div>

          <div className="models-section-tools">
            <label className="models-inline-search">
              <Search size={13} />
              <input
                placeholder="搜索服务商或模型…"
                value={state.query}
                onChange={(event) => state.setQuery(event.target.value)}
              />
              {state.query && (
                <button type="button" onClick={() => state.setQuery("")} title="清除">
                  <X size={12} />
                </button>
              )}
            </label>

            <button
              type="button"
              className="icon-button"
              disabled={state.loading || !state.hasHost}
              onClick={() => void state.refresh()}
              title="重新读取凭据与模型目录"
              aria-label="刷新模型目录"
            >
              <RefreshCw size={14} className={state.loading ? "spinner-icon" : ""} />
            </button>

            <button
              type="button"
              className="secondary-button models-add-trigger"
              onClick={() => state.setEditor(emptyDraft())}
              disabled={!state.hasHost}
            >
              <Plus size={13} strokeWidth={2.1} />
              <span>添加自定义提供商</span>
            </button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {state.notice && (
            <motion.div
              className={`models-notice ${state.notice.kind}`}
              role="status"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.14 }}
            >
              {state.notice.kind === "success" ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
              <span>{state.notice.text}</span>
              <button type="button" className="icon-button" onClick={() => state.setNotice(null)} title="关闭">
                <X size={13} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {state.loadError ? (
          <div className="settings-soft-card models-state-box">
            <CircleAlert size={18} />
            <strong>无法读取模型目录</strong>
            <p>{state.loadError}</p>
            <button type="button" className="secondary-button" onClick={state.retry}>重试</button>
          </div>
        ) : state.loading && state.entries.length === 0 ? (
          <div className="settings-soft-card models-state-box">
            <LoaderCircle size={16} className="spinner-icon" />
            <span>正在读取服务商目录…</span>
          </div>
        ) : state.entries.length === 0 ? (
          <div className="settings-soft-card models-state-box">
            <span>没有匹配搜索条件的服务商</span>
          </div>
        ) : (
          <div className="settings-soft-card models-accordion-card">
            {state.entries.map((entry) => {
              const isOpen = state.activeExpandedId === entry.id;
              const toggleOpen = () => {
                state.setExpandedId(isOpen ? null : entry.id);
                state.setCheck(null);
              };

              if (entry.kind === "provider") {
                const { provider, presetMeta } = entry;
                const config = state.configs.find((item) => item.id === provider.id);
                const summary = presetMeta?.subtitle
                  ?? (provider.models.slice(0, 3).map((m) => m.name || m.id).join(" · ") || provider.id);

                return (
                  <div
                    key={`provider:${provider.id}`}
                    className={`models-acc-item ${isOpen ? "is-open" : ""}`}
                    data-provider-id={provider.id}
                  >
                    <button
                      type="button"
                      className="models-acc-header"
                      aria-expanded={isOpen}
                      onClick={toggleOpen}
                    >
                      <ProviderBrandIcon id={provider.id} name={provider.name} size="sm" />
                      <span className="models-acc-titles">
                        <strong>{provider.name}</strong>
                        <small>{summary}</small>
                      </span>
                      <span className="models-acc-right">
                        {provider.configured ? (
                          <span className="models-acc-status is-on">
                            <i />
                            <span>已启用</span>
                          </span>
                        ) : (
                          <span className="models-acc-status">配置密钥</span>
                        )}
                        <ChevronDown size={15} className={`models-acc-chevron ${isOpen ? "open" : ""}`} />
                      </span>
                    </button>

                    <AnimatePresence initial={false}>
                      {isOpen && (
                        <motion.div
                          className="models-acc-collapse"
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                        >
                          <ProviderAccordionBody
                            provider={provider}
                            custom={isCustomProvider(provider, state.modelsJsonIds)}
                            config={config}
                            form={form}
                            connecting={state.connecting === provider.id}
                            check={state.check?.providerId === provider.id ? state.check : null}
                            hidden={state.hidden}
                            onConnect={(apiKey) => void state.connect(provider, apiKey)}
                            onDisconnect={() => void state.disconnect(provider)}
                            onCheck={() => void state.runCheck(provider)}
                            onVisibility={(modelIds, visible) => state.setModelsVisible(provider, modelIds, visible)}
                            onModelThinkingChange={(modelId, level) => state.setModelThinking(provider.id, modelId, level)}
                            onModelCustomLevelsChange={(modelId, levels, selected) =>
                              state.setModelCustomLevels(provider.id, modelId, levels, selected)
                            }
                            onEdit={() => config && state.setEditor(draftFromConfig(config, form))}
                            onDelete={() => void state.deleteCustom(provider)}
                          />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              }

              const { preset } = entry;
              return (
                <div
                  key={`preset:${preset.id}`}
                  className={`models-acc-item ${isOpen ? "is-open" : ""}`}
                  data-provider-id={preset.id}
                >
                  <button
                    type="button"
                    className="models-acc-header"
                    aria-expanded={isOpen}
                    onClick={toggleOpen}
                  >
                    <ProviderBrandIcon id={preset.id} name={preset.name} size="sm" />
                    <span className="models-acc-titles">
                      <strong>{preset.name}</strong>
                      <small>{preset.subtitle}</small>
                    </span>
                    <span className="models-acc-right">
                      <span className="models-acc-status">
                        {preset.keyless ? "免密钥直连" : "配置密钥"}
                      </span>
                      <ChevronDown size={15} className={`models-acc-chevron ${isOpen ? "open" : ""}`} />
                    </span>
                  </button>

                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        className="models-acc-collapse"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                      >
                        <PresetAccordionBody
                          preset={preset}
                          form={form}
                          busy={state.connecting === preset.id}
                          hasHost={state.hasHost}
                          onActivate={(apiKey, baseUrl, selectedIds) => void state.activatePreset(preset, apiKey, baseUrl, selectedIds)}
                          onOpenAdvanced={(selectedIds) =>
                            state.setEditor({
                              originalId: null,
                              id: preset.id,
                              name: preset.name,
                              baseUrl: preset.baseUrl,
                              api: preset.api,
                              apiKey: "",
                              keepExistingApiKey: false,
                              authHeader: false,
                              models: preset.models
                                .filter((m) => selectedIds.has(m.id))
                                .map((m) => ({ ...m, input: [...m.input] })),
                            })
                          }
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <AnimatePresence>
        {state.editor && (
          <CustomProviderEditor
            initial={state.editor}
            takenIds={new Set(state.providers.map((provider) => provider.id).filter((id) => id !== state.editor?.originalId))}
            catalog={state.catalog}
            onClose={() => state.setEditor(null)}
            onSaved={async (saved) => {
              const nextMap = { ...(form.modelThinkingLevels ?? {}) };
              if (saved.originalId && saved.originalId !== saved.id) {
                for (const existingKey of Object.keys(nextMap)) {
                  if (existingKey.startsWith(`${saved.originalId}/`)) {
                    delete nextMap[existingKey];
                  }
                }
              }
              for (const m of saved.models) {
                const key = modelThinkingKey(saved.id, m.id);
                nextMap[key] = m.reasoning ? effectiveModelThinking(true, m.thinkingLevel) : "off";
              }
              update("modelThinkingLevels", nextMap);
              if (form.provider === saved.id) {
                const matchingDefault = saved.models.find((m) => m.id === form.model);
                if (matchingDefault) {
                  update(
                    "thinkingLevel",
                    matchingDefault.reasoning ? effectiveModelThinking(true, matchingDefault.thinkingLevel) : "off",
                  );
                }
              }
              state.setEditor(null);
              await state.afterConfigChange(saved.originalId ? `已更新 ${saved.name || saved.id}` : `已添加 ${saved.name || saved.id}`, saved.id);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
