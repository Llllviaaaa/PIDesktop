import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agent } from "../../lib/agent";
import { harnessProviders, type ProviderSummary } from "../../lib/harnessProviders";
import { buildModelCatalog, groupProviders, modelKey } from "../../lib/modelProviders";
import { queryKeys } from "../../lib/queries";
import { modelThinkingKey, withModelCustomThinkingLevels } from "../../lib/thinkingLevels";
import { BUILTIN_PROVIDER_PRESETS, type BuiltinProviderPreset } from "../ProviderBrandIcon";
import { useAppStore } from "../../store";
import type { AppSettings, ModelProviderConfig, ModelProviderInput } from "../../types";
import {
  checkProviderWithElapsed,
  errorText,
  type AccordionEntry,
  type CheckState,
  type Notice,
  type Update,
} from "./modelPageHelpers";

const NO_PROVIDERS: ProviderSummary[] = [];
const NO_CONFIGS: ModelProviderConfig[] = [];

export function useModelsPageState(form: AppSettings, update: Update) {
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

  const presetMap = useMemo(() => new Map(BUILTIN_PROVIDER_PRESETS.map((p) => [p.id, p])), []);
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

  return {
    hasHost,
    providers,
    configs,
    loading,
    loadError,
    refresh,
    retry,
    query,
    setQuery,
    setExpandedId,
    connecting,
    check,
    setCheck,
    notice,
    setNotice,
    editor,
    setEditor,
    modelsJsonIds,
    catalog,
    entries,
    activeExpandedId,
    connectedCount,
    hidden,
    connect,
    activatePreset,
    disconnect,
    runCheck,
    setModelsVisible,
    setModelThinking,
    setModelCustomLevels,
    afterConfigChange,
    deleteCustom,
  };
}
