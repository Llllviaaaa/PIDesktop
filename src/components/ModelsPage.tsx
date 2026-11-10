import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { useSyncOnChange } from "../hooks/useSyncOnChange";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/queries";
import { describeError } from "../lib/errors";
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CloudDownload,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { agent } from "../lib/agent";
import { harnessProviders, type ProviderModelSummary, type ProviderSummary } from "../lib/harnessProviders";
import {
  buildModelCatalog,
  canDisconnect,
  credentialSourceText,
  defaultBaseUrlPlaceholder,
  endpointPreview,
  enrichModel,
  formatTokenCount,
  groupProviders,
  inferModelThinkingLevels,
  isCustomProvider,
  modelKey,
  PROVIDER_APIS,
  requiresBaseUrl,
  slugifyProviderId,
  type CapabilitySource,
  type EnrichedModel,
  type ModelCatalog,
} from "../lib/modelProviders";
import {
  customThinkingLevelsForModel,
  mergeThinkingLevels,
  modelThinkingKey,
  normalizeThinkingLevelId,
  preferredThinkingLevelForModel,
  resolveThinkingLevels,
  STANDARD_THINKING_LEVELS,
  thinkingLabel,
  withModelCustomThinkingLevels,
} from "../lib/thinkingLevels";
import {
  BUILTIN_PROVIDER_PRESETS,
  ProviderBrandIcon,
  type BuiltinProviderPreset,
} from "./ProviderBrandIcon";
import { useAppStore } from "../store";
import type {
  AppSettings,
  ModelProviderConfig,
  ModelProviderInput,
  ModelProviderModel,
  ModelThinkingLevel,
} from "../types";

type Update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

const ALL_THINKING_LABELS: Record<string, string> = {
  off: "关",
  none: "无",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  auto: "自动",
};

interface CheckState {
  providerId: string;
  status: "checking" | "ok" | "error";
  message: string;
}

type Notice = { kind: "success" | "error"; text: string } | null;

type AccordionEntry =
  | { kind: "provider"; id: string; provider: ProviderSummary; presetMeta?: BuiltinProviderPreset }
  | { kind: "preset"; id: string; preset: BuiltinProviderPreset };

function errorText(error: unknown): string {
  return describeError(error);
}

const MODEL_THINKING_OPTIONS: ReadonlyArray<readonly [ModelThinkingLevel, string]> = [
  ["off", "不支持思考"],
  ["minimal", "思考 · 最少"],
  ["low", "思考 · 低"],
  ["medium", "思考 · 中"],
  ["high", "思考 · 高"],
  ["xhigh", "思考 · 极高"],
  ["max", "思考 · 最高"],
  ["auto", "思考 · 自动"],
];

const CONTEXT_WINDOW_PRESETS: ReadonlyArray<readonly [number, string]> = [
  [32_768, "32K"],
  [65_536, "64K"],
  [128_000, "128K"],
  [131_072, "128K (131K)"],
  [200_000, "200K"],
  [256_000, "256K"],
  [400_000, "400K"],
  [1_000_000, "1M"],
  [1_048_576, "1M (1048K)"],
];

function effectiveModelThinking(reasoning: boolean, level?: ModelThinkingLevel | null): ModelThinkingLevel {
  if (!reasoning) return "off";
  if (level && level !== "off") return level;
  return "medium";
}

function modelTraitBadges(
  reasoning: boolean,
  thinkingLevel: ModelThinkingLevel | null | undefined,
  input: readonly string[],
  contextWindow: number | null | undefined,
): Array<{ key: string; label: string; tone: "ctx" | "think" | "vision" }> {
  const badges: Array<{ key: string; label: string; tone: "ctx" | "think" | "vision" }> = [];
  const ctx = formatTokenCount(contextWindow ?? null);
  if (ctx) badges.push({ key: "ctx", label: `上下文 ${ctx}`, tone: "ctx" });
  if (reasoning) {
    const lvl = effectiveModelThinking(reasoning, thinkingLevel);
    const shortLabel = ALL_THINKING_LABELS[lvl] ?? thinkingLabel(lvl);
    badges.push({ key: "think", label: `思考·${shortLabel}`, tone: "think" });
  }
  if (input.includes("image")) {
    badges.push({ key: "vision", label: "支持图片", tone: "vision" });
  }
  return badges;
}

const NO_PROVIDERS: ProviderSummary[] = [];
const NO_CONFIGS: ModelProviderConfig[] = [];

async function checkProviderWithElapsed(providerId: string): Promise<{ ok: boolean; message: string }> {
  const started = performance.now();
  const result = await harnessProviders.check(providerId);
  const elapsedSec = ((performance.now() - started) / 1000).toFixed(1);
  return {
    ok: result.ok,
    message: result.ok ? `${result.message} · ${elapsedSec}s` : result.message,
  };
}

export function ModelsPage({ form, update }: { form: AppSettings; update: Update }) {
  const hasHost = "__TAURI_INTERNALS__" in window || Boolean(new URLSearchParams(window.location.search).get("host"));
  const reloadProviderCatalog = useAppStore((state) => state.reloadProviderCatalog);
  const queryClient = useQueryClient();

  const providersQuery = useQuery({
    queryKey: queryKeys.modelProviders(),
    queryFn: () => harnessProviders.list(),
    enabled: hasHost,
  });
  const configsQuery = useQuery({
    queryKey: queryKeys.modelConfigs(),
    queryFn: () => agent.listModelProviders(),
    enabled: hasHost,
  });

  const providers = providersQuery.data ?? NO_PROVIDERS;
  const configs = configsQuery.data ?? NO_CONFIGS;

  const refreshMutation = useMutation({
    mutationFn: async () => {
      await Promise.all([
        queryClient.fetchQuery({ queryKey: queryKeys.modelProviders(), queryFn: () => harnessProviders.list(), staleTime: 0 }),
        queryClient.invalidateQueries({ queryKey: queryKeys.modelConfigs() }),
      ]);
    },
  });
  const refresh = () => refreshMutation.mutateAsync().catch(() => undefined);
  const retry = () => {
    refreshMutation.reset();
    void providersQuery.refetch();
    void configsQuery.refetch();
  };

  const loading = providersQuery.isFetching || refreshMutation.isPending;
  const failure = refreshMutation.error ?? providersQuery.error;
  const loadError = failure ? errorText(failure) : "";

  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null | undefined>(undefined);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckState | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [editor, setEditor] = useState<ModelProviderInput | null>(null);

  const presetMap = useMemo(
    () => new Map(BUILTIN_PROVIDER_PRESETS.map((p) => [p.id, p])),
    [],
  );
  const modelsJsonIds = useMemo(() => new Set(configs.map((config) => config.id)), [configs]);
  const existingProviderIds = useMemo(() => new Set(providers.map((p) => p.id)), [providers]);
  const catalog = useMemo(() => {
    const presetFallbacks: ProviderSummary[] = BUILTIN_PROVIDER_PRESETS.map((preset) => ({
      id: preset.id,
      name: preset.name,
      configured: false,
      keySource: "none",
      baseUrl: preset.baseUrl,
      models: preset.models.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: m.reasoning,
        ...(m.thinkingLevel ? { thinkingLevel: m.thinkingLevel } : {}),
        input: [...m.input],
        contextWindow: m.contextWindow ?? null,
        maxTokens: m.maxTokens ?? null,
        cost: m.cost ? { input: m.cost.input, output: m.cost.output } : null,
      })),
    }));
    return buildModelCatalog([...presetFallbacks, ...providers]);
  }, [providers]);
  const groups = useMemo(() => groupProviders(providers, query), [providers, query]);

  const availablePresets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return BUILTIN_PROVIDER_PRESETS.filter((preset) => {
      if (existingProviderIds.has(preset.id)) return false;
      if (!needle) return true;
      return (
        preset.name.toLowerCase().includes(needle) ||
        preset.id.toLowerCase().includes(needle) ||
        preset.subtitle.toLowerCase().includes(needle) ||
        preset.models.some((m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle))
      );
    });
  }, [existingProviderIds, query]);

  const entries = useMemo<AccordionEntry[]>(() => {
    const list: AccordionEntry[] = [];
    for (const group of groups) {
      for (const provider of group.providers) {
        list.push({
          kind: "provider",
          id: provider.id,
          provider,
          presetMeta: presetMap.get(provider.id),
        });
      }
    }
    for (const preset of availablePresets) {
      list.push({ kind: "preset", id: preset.id, preset });
    }
    return list;
  }, [availablePresets, groups, presetMap]);

  const activeExpandedId = expandedId === undefined ? (entries[0]?.id ?? null) : expandedId;
  const connectedCount = useMemo(() => providers.filter((p) => p.configured).length, [providers]);
  const hidden = useMemo(() => new Set(form.hiddenModels ?? []), [form.hiddenModels]);

  const applyProviders = (next: ProviderSummary[], text: string) => {
    queryClient.setQueryData(queryKeys.modelProviders(), next);
    setNotice({ kind: "success", text });
    void reloadProviderCatalog();
  };

  const connect = async (provider: ProviderSummary, apiKey: string) => {
    if (connecting !== null) return;
    setConnecting(provider.id);
    setNotice(null);
    setCheck(null);
    try {
      await harnessProviders.setKey(provider.id, apiKey);
      applyProviders(await harnessProviders.list(), `已连接 ${provider.name}`);
    } catch (error) {
      setNotice({ kind: "error", text: `连接 ${provider.name} 失败：${errorText(error)}` });
    } finally {
      setConnecting(null);
    }
  };

  const activatePreset = async (
    preset: BuiltinProviderPreset,
    apiKey: string,
    baseUrl: string,
    selectedIds?: ReadonlySet<string>,
  ) => {
    if (connecting !== null) return;
    setConnecting(preset.id);
    setNotice(null);
    try {
      const chosen = preset.models.filter((m) => !selectedIds || selectedIds.has(m.id));
      const modelsToSave = (chosen.length > 0 ? chosen : preset.models).map((m) => ({ ...m, input: [...m.input] }));
      const draft: ModelProviderInput = {
        originalId: null,
        id: preset.id,
        name: preset.name,
        baseUrl: baseUrl.trim() || preset.baseUrl,
        api: preset.api,
        apiKey: apiKey.trim(),
        keepExistingApiKey: false,
        authHeader: false,
        models: modelsToSave,
      };
      await agent.saveModelProvider(draft);
      if (apiKey.trim() && !apiKey.trim().startsWith("$")) {
        await harnessProviders.setKey(preset.id, apiKey.trim());
      }
      await refresh();
      setExpandedId(preset.id);
      setNotice({ kind: "success", text: `已启用 ${preset.name}` });
      void reloadProviderCatalog();
    } catch (error) {
      setNotice({ kind: "error", text: `启用 ${preset.name} 失败：${errorText(error)}` });
    } finally {
      setConnecting(null);
    }
  };

  const disconnect = async (provider: ProviderSummary) => {
    if (connecting !== null) return;
    setConnecting(provider.id);
    setNotice(null);
    setCheck(null);
    try {
      await harnessProviders.setKey(provider.id, "");
      applyProviders(await harnessProviders.list(), `已断开 ${provider.name}`);
    } catch (error) {
      setNotice({ kind: "error", text: `断开失败：${errorText(error)}` });
    } finally {
      setConnecting(null);
    }
  };

  const runCheck = async (provider: ProviderSummary) => {
    setCheck({ providerId: provider.id, status: "checking", message: "" });
    const result = await checkProviderWithElapsed(provider.id);
    setCheck({
      providerId: provider.id,
      status: result.ok ? "ok" : "error",
      message: result.message,
    });
  };

  const setModelsVisible = (provider: ProviderSummary, modelIds: readonly string[], visible: boolean) => {
    const next = new Set(hidden);
    for (const id of modelIds) {
      if (visible) next.delete(modelKey(provider.id, id));
      else next.add(modelKey(provider.id, id));
    }
    update("hiddenModels", [...next].sort());
  };

  const setModelThinking = useCallback(
    (providerId: string, modelId: string, level: string) => {
      const key = modelThinkingKey(providerId, modelId);
      update("modelThinkingLevels", {
        ...(form.modelThinkingLevels ?? {}),
        [key]: level,
      });
      if (form.provider === providerId && form.model === modelId) {
        update("thinkingLevel", level);
      }
    },
    [form.model, form.modelThinkingLevels, form.provider, update],
  );

  const setModelCustomLevels = useCallback(
    (providerId: string, modelId: string, nextLevels: readonly string[], nextSelectedLevel?: string) => {
      const patched = withModelCustomThinkingLevels(form, providerId, modelId, nextLevels);
      update("modelCustomThinkingLevels", patched.modelCustomThinkingLevels);
      if (patched.customThinkingLevels !== form.customThinkingLevels) {
        update("customThinkingLevels", patched.customThinkingLevels);
      }
      if (nextSelectedLevel !== undefined) {
        const key = modelThinkingKey(providerId, modelId);
        update("modelThinkingLevels", {
          ...(form.modelThinkingLevels ?? {}),
          [key]: nextSelectedLevel,
        });
        if (form.provider === providerId && form.model === modelId) {
          update("thinkingLevel", nextSelectedLevel);
        }
      }
    },
    [form, update],
  );

  const afterConfigChange = async (text: string, nextSelected?: string) => {
    await refresh();
    if (nextSelected) setExpandedId(nextSelected);
    setNotice({ kind: "success", text });
    void reloadProviderCatalog();
  };

  const deleteCustom = async (provider: ProviderSummary) => {
    if (!window.confirm(`从 providers.json 删除提供商“${provider.name}”及其模型？`)) return;
    try {
      await agent.deleteModelProvider(provider.id);
      setExpandedId(null);
      await afterConfigChange(`已移除 ${provider.name}`);
    } catch (error) {
      setNotice({ kind: "error", text: `删除失败：${errorText(error)}` });
    }
  };

  return (
    <div className="models-single-stream">
      <DefaultPreferencesCard
        providers={providers}
        hidden={hidden}
        form={form}
        update={update}
      />

      <section className="settings-layered-section">
        <div className="models-section-head">
          <div className="models-section-title-wrap">
            <h2>服务商与 API 密钥</h2>
            {connectedCount > 0 && (
              <span className="models-connected-count">已启用 {connectedCount}</span>
            )}
          </div>

          <div className="models-section-tools">
            <label className="models-inline-search">
              <Search size={13} />
              <input
                placeholder="搜索服务商或模型…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button type="button" onClick={() => setQuery("")} title="清除">
                  <X size={12} />
                </button>
              )}
            </label>

            <button
              type="button"
              className="icon-button"
              disabled={loading || !hasHost}
              onClick={() => void refresh()}
              title="重新读取凭据与模型目录"
              aria-label="刷新模型目录"
            >
              <RefreshCw size={14} className={loading ? "spinner-icon" : ""} />
            </button>

            <button
              type="button"
              className="secondary-button models-add-trigger"
              onClick={() => setEditor(emptyDraft())}
              disabled={!hasHost}
            >
              <Plus size={13} strokeWidth={2.1} />
              <span>添加自定义提供商</span>
            </button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {notice && (
            <motion.div
              className={`models-notice ${notice.kind}`}
              role="status"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.14 }}
            >
              {notice.kind === "success" ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
              <span>{notice.text}</span>
              <button type="button" className="icon-button" onClick={() => setNotice(null)} title="关闭">
                <X size={13} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {loadError ? (
          <div className="settings-soft-card models-state-box">
            <CircleAlert size={18} />
            <strong>无法读取模型目录</strong>
            <p>{loadError}</p>
            <button type="button" className="secondary-button" onClick={retry}>重试</button>
          </div>
        ) : loading && entries.length === 0 ? (
          <div className="settings-soft-card models-state-box">
            <LoaderCircle size={16} className="spinner-icon" />
            <span>正在读取服务商目录…</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="settings-soft-card models-state-box">
            <span>没有匹配搜索条件的服务商</span>
          </div>
        ) : (
          <div className="settings-soft-card models-accordion-card">
            {entries.map((entry) => {
              const isOpen = activeExpandedId === entry.id;
              const toggleOpen = () => {
                setExpandedId(isOpen ? null : entry.id);
                setCheck(null);
              };

              if (entry.kind === "provider") {
                const { provider, presetMeta } = entry;
                const config = configs.find((item) => item.id === provider.id);
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
                            custom={isCustomProvider(provider, modelsJsonIds)}
                            config={config}
                            form={form}
                            connecting={connecting === provider.id}
                            check={check?.providerId === provider.id ? check : null}
                            hidden={hidden}
                            onConnect={(apiKey) => void connect(provider, apiKey)}
                            onDisconnect={() => void disconnect(provider)}
                            onCheck={() => void runCheck(provider)}
                            onVisibility={(modelIds, visible) => setModelsVisible(provider, modelIds, visible)}
                            onModelThinkingChange={(modelId, level) => setModelThinking(provider.id, modelId, level)}
                            onModelCustomLevelsChange={(modelId, levels, selected) =>
                              setModelCustomLevels(provider.id, modelId, levels, selected)
                            }
                            onEdit={() => config && setEditor(draftFromConfig(config, form))}
                            onDelete={() => void deleteCustom(provider)}
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
                          busy={connecting === preset.id}
                          hasHost={hasHost}
                          onActivate={(apiKey, baseUrl, selectedIds) => void activatePreset(preset, apiKey, baseUrl, selectedIds)}
                          onOpenAdvanced={(selectedIds) =>
                            setEditor({
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
        {editor && (
          <CustomProviderEditor
            initial={editor}
            takenIds={new Set(providers.map((provider) => provider.id).filter((id) => id !== editor.originalId))}
            catalog={catalog}
            onClose={() => setEditor(null)}
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
              setEditor(null);
              await afterConfigChange(saved.originalId ? `已更新 ${saved.name || saved.id}` : `已添加 ${saved.name || saved.id}`, saved.id);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`settings-switch models-switch ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function DefaultPreferencesCard({
  providers,
  hidden,
  form,
  update,
}: {
  providers: ProviderSummary[];
  hidden: ReadonlySet<string>;
  form: AppSettings;
  update: Update;
}) {
  const connected = providers.filter((provider) => provider.configured);
  const options = connected
    .map((provider) => ({
      provider,
      models: provider.models.filter(
        (model) => !hidden.has(modelKey(provider.id, model.id)) || (provider.id === form.provider && model.id === form.model),
      ),
    }))
    .filter((group) => group.models.length > 0);
  const currentProvider = providers.find((provider) => provider.id === form.provider);
  const staleDefault = Boolean(form.provider && form.model && providers.length > 0 && !currentProvider?.configured);

  return (
    <section className="settings-layered-section">
      <h2>默认偏好</h2>
      <div className="settings-soft-card">
        <div className="setting-row">
          <span>
            <strong>默认对话模型</strong>
            <small>新对话与后台自动化任务默认选用的模型；思考等级按模型在下方独立配置</small>
          </span>
          <div>
            <ModelCombobox
              groups={options}
              providerId={form.provider}
              modelId={form.model}
              warning={staleDefault}
              onChange={(provider, model) => {
                update("provider", provider);
                update("model", model);
                const picked = options
                  .find((g) => g.provider.id === provider)
                  ?.models.find((m) => m.id === model);
                if (picked) {
                  const resolved = preferredThinkingLevelForModel(
                    picked,
                    form,
                    provider,
                    inferModelThinkingLevels(picked.id, picked.reasoning),
                  );
                  update("thinkingLevel", resolved);
                }
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function ModelCombobox({
  groups,
  providerId,
  modelId,
  warning,
  onChange,
}: {
  groups: Array<{ provider: ProviderSummary; models: ProviderModelSummary[] }>;
  providerId: string;
  modelId: string;
  warning: boolean;
  onChange: (providerId: string, modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const needle = query.trim().toLowerCase();
  const filtered = groups
    .map((group) => ({
      ...group,
      models: group.models.filter(
        (model) =>
          !needle ||
          model.name.toLowerCase().includes(needle) ||
          model.id.toLowerCase().includes(needle) ||
          group.provider.name.toLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.models.length > 0);
  const current = groups.find((group) => group.provider.id === providerId)?.models.find((model) => model.id === modelId);
  const providerName = groups.find((group) => group.provider.id === providerId)?.provider.name ?? providerId;

  const choose = (nextProvider: string, nextModel: string) => {
    onChange(nextProvider, nextModel);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="models-combo" ref={rootRef}>
      <button
        type="button"
        className={`models-combo-trigger ${warning ? "warning" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{current?.name ?? (modelId || "跟随会话选择")}</span>
        {modelId && <small>{providerName}</small>}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="models-combo-popover" data-escape-layer>
          <label className="models-inline-search full">
            <Search size={13} />
            <input autoFocus placeholder="搜索已启用模型…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="models-combo-scroll" role="listbox">
            {!needle && (
              <button
                type="button"
                role="option"
                aria-selected={!modelId}
                className={`models-combo-option ${!modelId ? "selected" : ""}`}
                onClick={() => choose("", "")}
              >
                <span>
                  <strong>跟随会话选择</strong>
                  <small className="plain">沿用对话输入框最近选择的模型</small>
                </span>
                {!modelId && <Check size={13} />}
              </button>
            )}
            {filtered.map((group) => (
              <section key={group.provider.id}>
                <h4>{group.provider.name}</h4>
                {group.models.map((model) => {
                  const active = group.provider.id === providerId && model.id === modelId;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`models-combo-option ${active ? "selected" : ""}`}
                      onClick={() => choose(group.provider.id, model.id)}
                    >
                      <span>
                        <strong>{model.name}</strong>
                        <small>{model.id}</small>
                      </span>
                      {active && <Check size={13} />}
                    </button>
                  );
                })}
              </section>
            ))}
            {groups.length === 0 && <div className="models-combo-empty">启用至少一个服务商后可指定默认模型</div>}
            {groups.length > 0 && filtered.length === 0 && needle && <div className="models-combo-empty">没有匹配的模型</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function PresetAccordionBody({
  preset,
  form,
  busy,
  hasHost,
  onActivate,
  onOpenAdvanced,
}: {
  preset: BuiltinProviderPreset;
  form: AppSettings;
  busy: boolean;
  hasHost: boolean;
  onActivate: (apiKey: string, baseUrl: string, selectedIds: ReadonlySet<string>) => void;
  onOpenAdvanced: (selectedIds: ReadonlySet<string>) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
  const [showCustomUrl, setShowCustomUrl] = useState(Boolean(preset.keyless));
  const [reveal, setReveal] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(preset.models.map((m) => m.id)));

  useSyncOnChange([preset.id], () => {
    setApiKey("");
    setBaseUrl(preset.baseUrl);
    setShowCustomUrl(Boolean(preset.keyless));
    setReveal(false);
    setSelectedIds(new Set(preset.models.map((m) => m.id)));
  });

  const canSubmit = hasHost && !busy && selectedIds.size > 0 && (Boolean(preset.keyless) || Boolean(apiKey.trim()));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) onActivate(apiKey, baseUrl, selectedIds);
  };

  const togglePresetModel = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size > 1) next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="models-acc-drawer">
      <form className="models-drawer-form" onSubmit={submit}>
        <div className="models-key-row">
          <span className="models-key-input">
            <KeyRound size={13} />
            <input
              type={reveal ? "text" : "password"}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={preset.keyless ? "本地服务免密钥（可直接启用）" : `输入 ${preset.name} API Key（sk-... 或 $ENV_VAR）`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={busy}
            />
            {apiKey && (
              <button
                type="button"
                className="models-key-eye"
                onClick={() => setReveal((v) => !v)}
                title={reveal ? "隐藏密钥" : "显示密钥"}
              >
                {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            )}
          </span>
          <button type="submit" className="primary-button" disabled={!canSubmit}>
            {busy && <LoaderCircle size={13} className="spinner-icon" />}
            <span>保存并启用</span>
          </button>
        </div>

        <div className="models-drawer-meta-bar">
          <button
            type="button"
            className="models-subtle-link"
            onClick={() => setShowCustomUrl((v) => !v)}
          >
            <span>{showCustomUrl ? "收起代理地址" : `自定义代理地址（默认 ${preset.baseUrl}）`}</span>
          </button>

          <button
            type="button"
            className="models-subtle-link"
            onClick={() => onOpenAdvanced(selectedIds)}
            disabled={!hasHost}
          >
            <SlidersHorizontal size={12} />
            <span>从 API 拉取 / 高级模型配置</span>
          </button>
        </div>

        {showCustomUrl && (
          <div className="models-url-override">
            <input
              className="models-plain-input"
              value={baseUrl}
              spellCheck={false}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={preset.baseUrl}
              disabled={busy}
            />
          </div>
        )}
      </form>

      <div className="models-mini-list">
        {preset.models.map((model) => {
          const checked = selectedIds.has(model.id);
          const resolvedLevel = model.reasoning
            ? preferredThinkingLevelForModel(model, form, preset.id, inferModelThinkingLevels(model.id, model.reasoning))
            : "off";
          const badges = modelTraitBadges(model.reasoning, resolvedLevel, model.input, model.contextWindow);
          return (
            <label key={model.id} className={`models-mini-row is-checkable ${checked ? "" : "is-muted"}`}>
              <span className="models-mini-name">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => togglePresetModel(model.id)}
                />
                <strong>{model.name}</strong>
                {model.name !== model.id && <code>{model.id}</code>}
              </span>
              <span className="models-capability-badges">
                {badges.map((badge) => (
                  <span key={badge.key} className={`models-cap-pill is-${badge.tone}`}>{badge.label}</span>
                ))}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function ProviderAccordionBody({
  provider,
  custom,
  config,
  form,
  connecting,
  check,
  hidden,
  onConnect,
  onDisconnect,
  onCheck,
  onVisibility,
  onModelThinkingChange,
  onModelCustomLevelsChange,
  onEdit,
  onDelete,
}: {
  provider: ProviderSummary;
  custom: boolean;
  config: ModelProviderConfig | undefined;
  form: AppSettings;
  connecting: boolean;
  check: CheckState | null;
  hidden: ReadonlySet<string>;
  onConnect: (apiKey: string) => void;
  onDisconnect: () => void;
  onCheck: () => void;
  onVisibility: (modelIds: readonly string[], visible: boolean) => void;
  onModelThinkingChange: (modelId: string, level: string) => void;
  onModelCustomLevelsChange: (modelId: string, levels: readonly string[], nextSelected?: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [replacingKey, setReplacingKey] = useState(false);
  useSyncOnChange([connecting, provider.configured], () => {
    if (!connecting) setReplacingKey(false);
  });

  const effectiveUrl = config?.baseUrl || provider.baseUrl || "";

  return (
    <div className="models-acc-drawer">
      {check && check.status !== "checking" && (
        <div className={`models-check-banner ${check.status}`}>
          {check.status === "ok" ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
          <span>{check.message}</span>
        </div>
      )}

      {provider.configured && !replacingKey ? (
        <div className="models-connected-bar">
          <div className="models-connected-info">
            <span className="models-masked-key">••••••••••••••••••••</span>
            <small>{credentialSourceText(provider)}</small>
          </div>
          <div className="models-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={check?.status === "checking"}
              onClick={onCheck}
            >
              {check?.status === "checking" ? <LoaderCircle size={13} className="spinner-icon" /> : <CircleCheck size={13} />}
              <span>{check?.status === "checking" ? "检测中…" : "测试连接"}</span>
            </button>
            {provider.keySource === "stored" && (
              <button type="button" className="secondary-button" onClick={() => setReplacingKey(true)}>
                <span>更换密钥</span>
              </button>
            )}
            {custom && config && (
              <button type="button" className="secondary-button" onClick={onEdit}>
                <Pencil size={12} />
                <span>管理</span>
              </button>
            )}
            {canDisconnect(provider) && (
              <button type="button" className="secondary-button danger" onClick={onDisconnect}>
                <span>断开</span>
              </button>
            )}
            {custom && config && (
              <button type="button" className="icon-button" onClick={onDelete} title="移除提供商">
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <ConnectForm
          busy={connecting}
          replacing={replacingKey}
          providerName={provider.name}
          onConnect={onConnect}
          onCancelReplace={() => setReplacingKey(false)}
        />
      )}

      {effectiveUrl && (
        <div className="models-drawer-meta-bar">
          <span className="models-endpoint-inline">
            端点：<code>{effectiveUrl}</code>
          </span>
          {custom && config && (
            <button type="button" className="models-subtle-link" onClick={onEdit}>
              <SlidersHorizontal size={12} />
              <span>编辑地址与模型</span>
            </button>
          )}
        </div>
      )}

      {provider.models.length > 0 && (
        <div className="models-mini-list">
          {provider.models.map((model) => {
            const visible = !hidden.has(modelKey(provider.id, model.id));
            const ctxBadge = formatTokenCount(model.contextWindow ?? null);
            const hasVision = model.input.includes("image");
            return (
              <div key={model.id} className={`models-mini-row ${visible ? "" : "is-muted"}`}>
                <span className="models-mini-name">
                  <strong>{model.name}</strong>
                  {model.name !== model.id && <code>{model.id}</code>}
                </span>
                <span className="models-mini-right">
                  {(ctxBadge || model.reasoning || hasVision) && (
                    <span className="models-capability-badges">
                      {ctxBadge && (
                        <span className="models-cap-pill is-ctx">上下文 {ctxBadge}</span>
                      )}
                      {model.reasoning && (
                        <ModelThinkingBadgeControl
                          providerId={provider.id}
                          model={model}
                          form={form}
                          onSelectLevel={(level) => onModelThinkingChange(model.id, level)}
                          onUpdateCustomLevels={(levels, nextSelected) =>
                            onModelCustomLevelsChange(model.id, levels, nextSelected)
                          }
                        />
                      )}
                      {hasVision && (
                        <span className="models-cap-pill is-vision">支持图片</span>
                      )}
                    </span>
                  )}
                  <Toggle
                    checked={visible}
                    label={`在模型选择器中显示 ${model.name}`}
                    onChange={(value) => onVisibility([model.id], value)}
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ModelThinkingBadgeControl({
  providerId,
  model,
  form,
  onSelectLevel,
  onUpdateCustomLevels,
}: {
  providerId: string;
  model: ProviderModelSummary;
  form: AppSettings;
  onSelectLevel: (level: string) => void;
  onUpdateCustomLevels: (levels: readonly string[], nextSelected?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState("");
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const inferred = useMemo(
    () => inferModelThinkingLevels(model.id, model.reasoning),
    [model.id, model.reasoning],
  );
  const customLevels = useMemo(
    () => customThinkingLevelsForModel(form, providerId, model.id),
    [form, model.id, providerId],
  );
  const baseLevels = useMemo(
    () =>
      resolveThinkingLevels(
        inferred,
        {
          id: model.id,
          name: model.name,
          provider: providerId,
          reasoning: model.reasoning,
          ...(model.thinkingLevels && model.thinkingLevels.length > 0
            ? { thinkingLevels: model.thinkingLevels }
            : {}),
        },
        null,
      ),
    [inferred, model.id, model.name, model.reasoning, model.thinkingLevels, providerId],
  );
  const levels = useMemo(
    () => mergeThinkingLevels(baseLevels, customLevels),
    [baseLevels, customLevels],
  );
  const baseSet = useMemo(() => new Set(baseLevels), [baseLevels]);

  const currentLevel = preferredThinkingLevelForModel(model, form, providerId, inferred);
  const shortLabel = ALL_THINKING_LABELS[currentLevel] ?? thinkingLabel(currentLevel);
  const normalizedDraft = normalizeThinkingLevelId(customDraft);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const hostRoot = document.getElementById("root");
    const viewW = hostRoot?.clientWidth || window.innerWidth;
    const viewH = hostRoot?.clientHeight || window.innerHeight;
    const rect = trigger.getBoundingClientRect();
    const popWidth = popoverRef.current?.offsetWidth || 236;
    const popHeight = popoverRef.current?.offsetHeight || 260;
    const left = Math.min(
      Math.max(12, rect.right - popWidth),
      Math.max(12, viewW - popWidth - 12),
    );
    const spaceBelow = viewH - rect.bottom - 12;
    const top = spaceBelow >= popHeight || rect.top < popHeight
      ? rect.bottom + 6
      : Math.max(12, rect.top - popHeight - 6);
    setCoords({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [levels.length, open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (triggerRef.current?.contains(target) || popoverRef.current?.contains(target))) {
        return;
      }
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onScroll = (event: Event) => {
      if (popoverRef.current?.contains(event.target as Node | null)) return;
      updatePosition();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, updatePosition]);

  const handleAddCustom = (event: FormEvent) => {
    event.preventDefault();
    if (!normalizedDraft) return;
    if (normalizedDraft === "off") {
      onSelectLevel("off");
      setCustomDraft("");
      setOpen(false);
      return;
    }
    const nextCustom = customLevels.includes(normalizedDraft)
      ? customLevels
      : [...customLevels, normalizedDraft];
    onUpdateCustomLevels(nextCustom, normalizedDraft);
    setCustomDraft("");
    setOpen(false);
  };

  const handleRemoveCustom = (target: string) => {
    const nextCustom = customLevels.filter((item) => item !== target);
    if (currentLevel === target) {
      const remaining = levels.filter((item) => item !== target);
      const fallback = remaining.includes("medium")
        ? "medium"
        : (remaining.find((item) => item !== "off") ?? "off");
      onUpdateCustomLevels(nextCustom, fallback);
    } else {
      onUpdateCustomLevels(nextCustom);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`models-cap-pill models-think-trigger ${currentLevel === "off" ? "is-think-off" : "is-think"} ${open ? "is-open" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${model.name} 思考等级：${thinkingLabel(currentLevel)}`}
        title={`点击配置 ${model.name} 的思考等级`}
        onClick={() => setOpen((value) => !value)}
      >
        <span>思考·{shortLabel}</span>
        <ChevronDown size={11} strokeWidth={2} />
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popoverRef}
            className="models-think-popover"
            role="dialog"
            aria-label={`${model.name} 思考等级设置`}
            data-escape-layer
            style={{
              top: coords?.top ?? -9999,
              left: coords?.left ?? -9999,
              visibility: coords ? "visible" : "hidden",
            }}
          >
            <div className="models-think-popover-head">
              <strong>{model.name}</strong>
              <small>模型思考等级</small>
            </div>

            <div className="models-think-popover-list" role="radiogroup" aria-label={`${model.name} 思考等级`}>
              {levels.map((lvl) => {
                const active = lvl === currentLevel;
                const removable = !baseSet.has(lvl) && customLevels.includes(lvl);
                const label = thinkingLabel(lvl);
                return (
                  <div
                    key={lvl}
                    className={`models-think-option-row ${active ? "is-active" : ""}`}
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className="models-think-option-btn"
                      onClick={() => {
                        onSelectLevel(lvl);
                        setOpen(false);
                      }}
                    >
                      <span className="models-think-option-label">
                        <span>{label}</span>
                        {label !== lvl && <code>{lvl}</code>}
                      </span>
                      {active && <Check size={13} strokeWidth={2.2} />}
                    </button>
                    {removable && (
                      <button
                        type="button"
                        className="models-think-option-remove"
                        aria-label={`移除 ${model.name} 自定义思考等级 ${lvl}`}
                        title={`移除自定义档位 ${lvl}`}
                        onClick={() => handleRemoveCustom(lvl)}
                      >
                        <X size={11} strokeWidth={2} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <form className="models-think-popover-custom" onSubmit={handleAddCustom}>
              <input
                value={customDraft}
                onChange={(event) => setCustomDraft(event.target.value)}
                placeholder="新增档位，如 auto / 16384"
                aria-label={`${model.name} 新增自定义思考等级`}
                spellCheck={false}
              />
              <button type="submit" disabled={!normalizedDraft}>
                <Plus size={12} strokeWidth={2} />
                <span>添加</span>
              </button>
            </form>
          </div>,
          document.getElementById("root") ?? document.body,
        )}
    </>
  );
}

function ConnectForm({
  busy,
  replacing,
  providerName,
  onConnect,
  onCancelReplace,
}: {
  busy: boolean;
  replacing: boolean;
  providerName: string;
  onConnect: (apiKey: string) => void;
  onCancelReplace: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (apiKey.trim()) onConnect(apiKey.trim());
  };
  return (
    <form className="models-key-row" onSubmit={submit}>
      <span className="models-key-input">
        <KeyRound size={13} />
        <input
          type={reveal ? "text" : "password"}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={`输入 ${providerName} API Key（如 sk-...）`}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          disabled={busy}
        />
        {apiKey && (
          <button
            type="button"
            className="models-key-eye"
            onClick={() => setReveal((v) => !v)}
            title={reveal ? "隐藏密钥" : "显示密钥"}
          >
            {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
      </span>
      <button type="submit" className="primary-button" disabled={busy || !apiKey.trim()}>
        {busy && <LoaderCircle size={13} className="spinner-icon" />}
        <span>{replacing ? "保存密钥" : "保存并启用"}</span>
      </button>
      {replacing && (
        <button type="button" className="secondary-button" onClick={onCancelReplace}>
          取消
        </button>
      )}
    </form>
  );
}

function emptyDraft(): ModelProviderInput {
  return {
    originalId: null,
    id: "",
    name: "",
    baseUrl: "",
    api: "openai-completions",
    apiKey: "",
    keepExistingApiKey: false,
    authHeader: false,
    models: [],
  };
}

function draftFromConfig(config: ModelProviderConfig, form?: AppSettings): ModelProviderInput {
  return {
    originalId: config.id,
    id: config.id,
    name: config.name === config.id ? "" : config.name,
    baseUrl: config.baseUrl,
    api: config.api || "openai-completions",
    apiKey: "",
    keepExistingApiKey: config.hasApiKey,
    authHeader: config.authHeader,
    models: config.models.map((model) => {
      const resolvedThinking = model.reasoning && form
        ? preferredThinkingLevelForModel(model, form, config.id, inferModelThinkingLevels(model.id, true))
        : model.thinkingLevel;
      const extraCustom = model.reasoning && form
        ? customThinkingLevelsForModel(form, config.id, model.id)
        : [];
      const mergedLevels = model.thinkingLevels && model.thinkingLevels.length > 0
        ? mergeThinkingLevels(model.thinkingLevels, extraCustom)
        : model.thinkingLevels;
      return {
        ...model,
        ...(resolvedThinking ? { thinkingLevel: resolvedThinking } : {}),
        ...(mergedLevels ? { thinkingLevels: mergedLevels } : {}),
        input: [...model.input],
      };
    }),
  };
}

const SOURCE_LABELS: Record<Exclude<CapabilitySource, "api">, { label: string; hint: string }> = {
  catalog: { label: "内置目录", hint: "能力和上下文来自内置目录中的同名模型" },
  guess: { label: "按名称推测", hint: "能力按模型名称自动识别" },
  default: { label: "默认值", hint: "使用默认参数，可点击详情修改" },
};

function CapabilitySourceTag({ entry }: { entry: EnrichedModel | undefined }) {
  if (!entry || entry.source === "api") return null;
  const { label, hint } = SOURCE_LABELS[entry.source];
  const title = entry.match ? `${hint}：${entry.match.providerId}/${entry.match.model.id}` : hint;
  return <em className={`models-source ${entry.source}`} title={title}>{label}</em>;
}

function CustomProviderEditor({
  initial,
  takenIds,
  catalog,
  onClose,
  onSaved,
}: {
  initial: ModelProviderInput;
  takenIds: ReadonlySet<string>;
  catalog: ModelCatalog;
  onClose: () => void;
  onSaved: (saved: ModelProviderInput) => Promise<void>;
}) {
  const editing = Boolean(initial.originalId);
  const [draft, setDraft] = useState<ModelProviderInput>(initial);
  const [idTouched, setIdTouched] = useState(editing || Boolean(initial.id));
  const [discovered, setDiscovered] = useState<ModelProviderModel[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sources, setSources] = useState<Record<string, EnrichedModel>>({});
  const [discovering, setDiscovering] = useState(false);
  const [manualId, setManualId] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  const patch = (next: Partial<ModelProviderInput>) => setDraft((current) => ({ ...current, ...next }));
  const setName = (name: string) => patch(idTouched ? { name } : { name, id: slugifyProviderId(name) });
  const selectedIds = new Set(draft.models.map((model) => model.id));
  const needle = modelQuery.trim().toLowerCase();
  const filteredDiscovered = discovered.filter(
    (model) => !needle || model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
  );
  const preview = endpointPreview(draft.api, draft.baseUrl);
  const idError = !draft.id.trim()
    ? ""
    : !/^[a-z0-9][a-z0-9._-]*$/i.test(draft.id)
      ? "只能包含字母、数字、点、下划线和连字符"
      : takenIds.has(draft.id)
        ? "该 ID 已被其他提供商使用"
        : "";

  const toggleModel = (model: ModelProviderModel) => {
    if (selectedIds.has(model.id)) {
      patch({ models: draft.models.filter((item) => item.id !== model.id) });
      if (expanded === model.id) setExpanded(null);
      return;
    }
    const enriched = enrichModel(model, catalog);
    setSources((current) => ({ ...current, [model.id]: enriched }));
    patch({ models: [...draft.models, enriched.model] });
  };
  const removeSelectedModel = (id: string) => {
    patch({ models: draft.models.filter((item) => item.id !== id) });
    if (expanded === id) setExpanded(null);
  };
  const changeModel = (id: string, next: Partial<ModelProviderModel>) => {
    patch({ models: draft.models.map((model) => (model.id === id ? { ...model, ...next } : model)) });
    setSources(({ [id]: _edited, ...rest }) => rest);
  };
  const addManual = () => {
    const id = manualId.trim();
    if (!id || selectedIds.has(id)) return;
    const known = discovered.find((model) => model.id === id);
    if (known) {
      patch({ models: [...draft.models, known] });
    } else {
      const enriched = enrichModel({ id, name: "", reasoning: false, input: ["text"], contextWindow: null, maxTokens: null }, catalog);
      patch({ models: [...draft.models, enriched.model] });
      setSources((current) => ({ ...current, [id]: enriched }));
    }
    setManualId("");
  };
  const discover = async () => {
    setDiscovering(true);
    setError("");
    try {
      const enriched = (await agent.discoverModelProviderModels({ ...draft, id: draft.id || "discover" })).map((model) =>
        enrichModel(model, catalog),
      );
      const models = enriched.map((entry) => entry.model);
      const byEnriched = new Map(models.map((item) => [item.id, item]));
      // Also sync capabilities onto any already-selected models that lacked explicit limits.
      if (draft.models.length > 0) {
        patch({
          models: draft.models.map((existing) => {
            const synced = byEnriched.get(existing.id);
            if (!synced) return enrichModel(existing, catalog).model;
            return {
              ...existing,
              contextWindow: existing.contextWindow ?? synced.contextWindow,
              maxTokens: existing.maxTokens ?? synced.maxTokens,
              reasoning: existing.reasoning || synced.reasoning,
              thinkingLevel: existing.thinkingLevel ?? synced.thinkingLevel,
              thinkingLevels: existing.thinkingLevels ?? synced.thinkingLevels,
              input: existing.input.includes("image") || synced.input.includes("image") ? ["text", "image"] : ["text"],
              cost: existing.cost ?? synced.cost,
            };
          }),
        });
      }
      setSources((current) => ({ ...current, ...Object.fromEntries(enriched.map((entry) => [entry.model.id, entry])) }));
      setDiscovered(models);
      setPickerOpen(models.length > 0);
      if (models.length === 0) setError("该接口没有返回模型列表，请手动添加模型 ID。");
    } catch (nextError) {
      setError(`获取模型失败：${errorText(nextError)}`);
    } finally {
      setDiscovering(false);
    }
  };
  const save = async () => {
    if (!draft.id.trim() || idError) return setError(idError || "请填写提供商 ID");
    if (requiresBaseUrl(draft.api) && !draft.baseUrl.trim()) return setError("请填写 API 地址");
    if (draft.models.length === 0) return setError("至少选择或添加一个模型");
    setBusy(true);
    setError("");
    try {
      // Strictly persist ONLY the user's selected `draft.models`, with normalized capabilities.
      const normalizedDraft: ModelProviderInput = {
        ...draft,
        models: draft.models.map((item) => {
          const level = effectiveModelThinking(item.reasoning, item.thinkingLevel);
          const rawTiers = level === "off"
            ? undefined
            : item.thinkingLevels?.length
              ? Array.from(new Set(["off", ...item.thinkingLevels, level]))
              : undefined;
          return {
            ...item,
            reasoning: level !== "off",
            thinkingLevel: level,
            ...(rawTiers ? { thinkingLevels: rawTiers } : { thinkingLevels: undefined }),
            contextWindow: item.contextWindow || 128_000,
            input: item.input.includes("image") ? ["text", "image"] : ["text"],
          };
        }),
      };
      await agent.saveModelProvider(normalizedDraft);
      await onSaved(normalizedDraft);
    } catch (nextError) {
      setError(errorText(nextError));
      setBusy(false);
    }
  };

  return (
    <motion.div
      className="models-editor-backdrop"
      data-escape-layer
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <motion.div
        className="models-editor"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? "编辑自定义提供商" : "添加自定义提供商"}
        initial={{ opacity: 0, scale: 0.965, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.975, y: 6 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      >
        <header>
          <strong>{editing ? `编辑 ${initial.name || initial.id}` : "添加自定义提供商"}</strong>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} title="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="models-editor-body">
          <div className="models-editor-fields">
            <label>
              <span>名称</span>
              <input
                autoFocus={!editing}
                value={draft.name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如 公司网关 或 本地 Ollama"
              />
            </label>
            <label>
              <span>提供商 ID</span>
              <input
                value={draft.id}
                disabled={editing}
                onChange={(event) => {
                  setIdTouched(true);
                  patch({ id: event.target.value.trim() });
                }}
                placeholder="根据名称自动生成"
              />
              {idError && <em className="models-field-error">{idError}</em>}
            </label>
            <label>
              <span>接口协议</span>
              <select value={draft.api} onChange={(event) => patch({ api: event.target.value })}>
                {PROVIDER_APIS.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>API 密钥</span>
              <span className="models-key-input">
                <KeyRound size={13} />
                <input
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={draft.apiKey}
                  onChange={(event) =>
                    patch({ apiKey: event.target.value, keepExistingApiKey: event.target.value ? false : draft.keepExistingApiKey })
                  }
                  placeholder={draft.keepExistingApiKey ? "已配置，留空则保留" : "sk-…、$ENV_VAR 或留空"}
                />
              </span>
            </label>
            <label className="wide">
              <span>API 地址</span>
              <input
                value={draft.baseUrl}
                onChange={(event) => patch({ baseUrl: event.target.value })}
                placeholder={defaultBaseUrlPlaceholder(draft.api)}
                spellCheck={false}
              />
              {preview && <em className="models-field-hint">请求端点预览：<code>{preview}</code></em>}
            </label>
            <label className="wide models-editor-inline">
              <Toggle checked={draft.authHeader} label="Authorization Bearer" onChange={(value) => patch({ authHeader: value })} />
              <span>
                <span>强制注入 <code>Authorization: Bearer</code> 请求头</span>
                <small>仅当非标准反向代理网关要求时开启。</small>
              </span>
            </label>
          </div>

          <div className="models-editor-models">
            <div className="models-editor-models-head">
              <h3>
                已选模型
                <span>仅同步保留已选的 {draft.models.length} 个模型</span>
              </h3>
              <div className="models-editor-head-actions">
                {discovered.length > 0 && !pickerOpen && (
                  <button
                    type="button"
                    className="models-subtle-link"
                    onClick={() => setPickerOpen(true)}
                  >
                    <span>展开 API 候选（{discovered.length}）</span>
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={discovering || (requiresBaseUrl(draft.api) && !draft.baseUrl.trim())}
                  onClick={() => void discover()}
                >
                  {discovering ? <LoaderCircle size={13} className="spinner-icon" /> : <CloudDownload size={13} />}
                  <span>{discovering ? "正在获取…" : "从 API 获取"}</span>
                </button>
              </div>
            </div>

            <div className="models-key-row">
              <span className="models-key-input">
                <Plus size={13} />
                <input
                  value={manualId}
                  spellCheck={false}
                  onChange={(event) => setManualId(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addManual();
                    }
                  }}
                  placeholder="手动输入模型 ID，回车添加"
                />
              </span>
              {manualId.trim() && (
                <button type="button" className="secondary-button" onClick={addManual}>
                  <span>添加 ID</span>
                </button>
              )}
            </div>

            {pickerOpen && discovered.length > 0 && (
              <div className="models-api-picker-box">
                <div className="models-api-picker-head">
                  <span>
                    API 可用模型（共 {discovered.length} 个，已选 {draft.models.filter((m) => discovered.some((d) => d.id === m.id)).length} 个）
                  </span>
                  <div className="models-api-picker-tools">
                    <label className="models-inline-search">
                      <Search size={12} />
                      <input
                        placeholder="搜索 API 模型…"
                        value={modelQuery}
                        onChange={(event) => setModelQuery(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="models-picker-done-btn"
                      onClick={() => setPickerOpen(false)}
                    >
                      <Check size={12} />
                      <span>完成选择</span>
                    </button>
                  </div>
                </div>
                <div className="models-api-picker-list">
                  {filteredDiscovered.length === 0 ? (
                    <div className="models-model-empty">没有匹配“{modelQuery}”的候选模型</div>
                  ) : (
                    filteredDiscovered.map((candidate) => {
                      const checked = selectedIds.has(candidate.id);
                      const badges = modelTraitBadges(
                        candidate.reasoning,
                        candidate.thinkingLevel,
                        candidate.input,
                        candidate.contextWindow,
                      );
                      return (
                        <label
                          key={candidate.id}
                          className={`models-api-candidate ${checked ? "is-checked" : ""}`}
                        >
                          <span className="models-api-candidate-left">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleModel(candidate)}
                            />
                            <strong>{candidate.name || candidate.id}</strong>
                            {candidate.name && candidate.name !== candidate.id && <code>{candidate.id}</code>}
                          </span>
                          <span className="models-capability-badges">
                            {badges.map((badge) => (
                              <span key={badge.key} className={`models-cap-pill is-${badge.tone}`}>{badge.label}</span>
                            ))}
                            <CapabilitySourceTag entry={sources[candidate.id]} />
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            <div className="models-editor-model-list">
              {draft.models.length === 0 ? (
                <div className="models-model-empty">
                  {discovered.length > 0
                    ? "请从上方 API 候选列表中勾选要启用的模型（未选模型不会被同步）。"
                    : "填写 API 地址后点击“从 API 获取”按需勾选，或手动输入模型 ID 回车添加。"}
                </div>
              ) : (
                draft.models.map((current) => {
                  const hasImage = current.input.includes("image");
                  const currentThinking = effectiveModelThinking(current.reasoning, current.thinkingLevel);
                  const currentCtx = current.contextWindow ?? 128_000;
                  const hasPresetCtx = CONTEXT_WINDOW_PRESETS.some(([val]) => val === currentCtx);

                  return (
                    <div key={current.id} className="models-editor-model selected">
                      <div className="models-editor-model-row">
                        <div className="models-selected-title">
                          <strong>{current.name || current.id}</strong>
                          {current.name && current.name !== current.id && <code>{current.id}</code>}
                          <CapabilitySourceTag entry={sources[current.id]} />
                        </div>

                        <div className="models-inline-cap-controls">
                          <select
                            className="models-cap-select"
                            aria-label={`${current.id} 最大上下文`}
                            title="最大上下文窗口"
                            value={String(currentCtx)}
                            onChange={(event) => changeModel(current.id, { contextWindow: Number(event.target.value) })}
                          >
                            {!hasPresetCtx && (
                              <option value={String(currentCtx)}>
                                上下文 {formatTokenCount(currentCtx) || currentCtx}
                              </option>
                            )}
                            {CONTEXT_WINDOW_PRESETS.map(([val, label]) => (
                              <option key={val} value={String(val)}>上下文 {label}</option>
                            ))}
                          </select>

                          <select
                            className={`models-cap-select ${currentThinking !== "off" ? "is-active-think" : ""}`}
                            aria-label={`${current.id} 思考等级`}
                            title="模型思考能力与默认推理等级"
                            value={currentThinking}
                            onChange={(event) => {
                              const nextLevel = event.target.value as ModelThinkingLevel;
                              changeModel(current.id, {
                                reasoning: nextLevel !== "off",
                                thinkingLevel: nextLevel,
                              });
                            }}
                          >
                            {MODEL_THINKING_OPTIONS.map(([val, label]) => (
                              <option key={val} value={val}>{label}</option>
                            ))}
                            {Array.from(
                              new Set([
                                ...(current.thinkingLevels ?? []),
                                currentThinking,
                              ]),
                            )
                              .filter((lvl) => lvl && !MODEL_THINKING_OPTIONS.some(([opt]) => opt === lvl))
                              .map((lvl) => (
                                <option key={lvl} value={lvl}>{`思考 · ${thinkingLabel(lvl)}`}</option>
                              ))}
                          </select>

                          <button
                            type="button"
                            className={`models-cap-toggle ${hasImage ? "is-on" : ""}`}
                            aria-pressed={hasImage}
                            title="切换该模型是否支持图片多模态输入"
                            onClick={() => changeModel(current.id, { input: hasImage ? ["text"] : ["text", "image"] })}
                          >
                            <span>{hasImage ? "支持图片" : "不支持图片"}</span>
                          </button>

                          <button
                            type="button"
                            className="models-subtle-link"
                            onClick={() => setExpanded(expanded === current.id ? null : current.id)}
                          >
                            {expanded === current.id ? "收起" : "详情"}
                          </button>

                          <button
                            type="button"
                            className="models-remove-selected"
                            title={`移除 ${current.name || current.id}`}
                            aria-label={`移除 ${current.name || current.id}`}
                            onClick={() => removeSelectedModel(current.id)}
                          >
                            <X size={13} />
                          </button>
                        </div>
                      </div>

                      {expanded === current.id && (
                        <div className="models-editor-model-details">
                          <label>
                            <span>显示名称</span>
                            <input
                              value={current.name}
                              onChange={(event) => changeModel(current.id, { name: event.target.value })}
                              placeholder={current.id}
                            />
                          </label>
                          <label>
                            <span>上下文</span>
                            <input
                              type="number"
                              min="1"
                              value={current.contextWindow ?? ""}
                              onChange={(event) =>
                                changeModel(current.id, { contextWindow: event.target.value ? Number(event.target.value) : null })
                              }
                            />
                          </label>
                          <label>
                            <span>最大输出</span>
                            <input
                              type="number"
                              min="1"
                              value={current.maxTokens ?? ""}
                              onChange={(event) =>
                                changeModel(current.id, { maxTokens: event.target.value ? Number(event.target.value) : null })
                              }
                            />
                          </label>
                          <label>
                            <span>输入单价 ($/M)</span>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={current.cost?.input ?? ""}
                              placeholder="自动估算"
                              onChange={(event) => {
                                const raw = event.target.value;
                                const nextInput = raw === "" ? null : Number(raw);
                                const nextOutput = current.cost?.output ?? 0;
                                changeModel(current.id, {
                                  cost:
                                    nextInput === null && !current.cost?.output
                                      ? null
                                      : { ...current.cost, input: nextInput ?? 0, output: nextOutput },
                                });
                              }}
                            />
                          </label>
                          <label>
                            <span>输出单价 ($/M)</span>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={current.cost?.output ?? ""}
                              placeholder="自动估算"
                              onChange={(event) => {
                                const raw = event.target.value;
                                const nextOutput = raw === "" ? null : Number(raw);
                                const nextInput = current.cost?.input ?? 0;
                                changeModel(current.id, {
                                  cost:
                                    nextOutput === null && !current.cost?.input
                                      ? null
                                      : { ...current.cost, input: nextInput, output: nextOutput ?? 0 },
                                });
                              }}
                            />
                          </label>
                          {currentThinking !== "off" && (
                            <ModelThinkingLevelsEditor
                              model={current}
                              currentThinking={currentThinking}
                              onChange={(nextLevels, nextDefault) =>
                                changeModel(current.id, {
                                  thinkingLevels: nextLevels,
                                  ...(nextDefault ? { thinkingLevel: nextDefault, reasoning: nextDefault !== "off" } : {}),
                                })
                              }
                            />
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
        <footer>
          {error ? (
            <span className="models-field-error">
              <CircleAlert size={13} />
              <span>{error}</span>
            </span>
          ) : (
            <span className="models-hint">配置将持久化保存至 ~/.qianji/providers.json</span>
          )}
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="primary-button" onClick={() => void save()} disabled={busy}>
            {busy && <LoaderCircle size={13} className="spinner-icon" />}
            <span>{editing ? "保存" : "添加"}</span>
          </button>
        </footer>
      </motion.div>
    </motion.div>
  );
}

function ModelThinkingLevelsEditor({
  model,
  currentThinking,
  onChange,
}: {
  model: ModelProviderModel;
  currentThinking: string;
  onChange: (nextLevels: string[] | undefined, nextDefault?: string) => void;
}) {
  const [customInput, setCustomInput] = useState("");
  const inferred = useMemo(
    () => inferModelThinkingLevels(model.id, true) ?? ["off", "minimal", "low", "medium", "high"],
    [model.id],
  );
  const activeLevels = useMemo(() => {
    const raw = model.thinkingLevels?.length ? model.thinkingLevels : inferred;
    const set = new Set<string>(["off", ...raw]);
    if (currentThinking && currentThinking !== "off") set.add(currentThinking);
    return [...set];
  }, [currentThinking, inferred, model.thinkingLevels]);

  const candidateLevels = useMemo(() => {
    const set = new Set<string>(STANDARD_THINKING_LEVELS.filter((item) => item !== "off"));
    for (const item of activeLevels) {
      if (item !== "off") set.add(item);
    }
    return [...set];
  }, [activeLevels]);

  const toggleTier = (tier: string) => {
    const enabled = activeLevels.includes(tier);
    const nonOff = activeLevels.filter((item) => item !== "off");
    if (enabled && nonOff.length <= 1) return;
    const next = enabled
      ? activeLevels.filter((item) => item !== tier)
      : [...activeLevels, tier];
    const nextDefault = enabled && currentThinking === tier
      ? next.find((item) => item !== "off")
      : undefined;
    onChange(next, nextDefault);
  };

  const addCustomTier = () => {
    const normalized = normalizeThinkingLevelId(customInput);
    if (!normalized || normalized === "off") return;
    const next = activeLevels.includes(normalized)
      ? activeLevels
      : [...activeLevels, normalized];
    onChange(next, normalized);
    setCustomInput("");
  };

  return (
    <div className="models-thinking-levels-field">
      <div className="models-thinking-levels-head">
        <span>支持的思考档位</span>
        {model.thinkingLevels?.length ? (
          <button
            type="button"
            className="models-subtle-link"
            onClick={() => onChange(undefined)}
          >
            恢复自动推断
          </button>
        ) : (
          <small>自动推断（点击可按需增减）</small>
        )}
      </div>
      <div className="models-thinking-levels-chips">
        {candidateLevels.map((tier) => {
          const on = activeLevels.includes(tier);
          return (
            <button
              key={tier}
              type="button"
              aria-pressed={on}
              className={`models-thinking-tier-chip ${on ? "is-on" : ""}`}
              onClick={() => toggleTier(tier)}
              title={`${thinkingLabel(tier)} (${tier})`}
            >
              <span>{thinkingLabel(tier)}</span>
              {thinkingLabel(tier) !== tier && <code>{tier}</code>}
            </button>
          );
        })}
        <span className="models-thinking-tier-custom">
          <input
            value={customInput}
            onChange={(event) => setCustomInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addCustomTier();
              }
            }}
            placeholder="新增档位，如 ultra / 16384"
            aria-label={`${model.id} 新增思考档位`}
            spellCheck={false}
          />
          {normalizeThinkingLevelId(customInput) && (
            <button type="button" onClick={addCustomTier} aria-label="确认添加档位">
              <Plus size={12} />
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
