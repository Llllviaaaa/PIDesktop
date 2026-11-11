import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  McpServerStatus,
  PluginInfo,
  PluginInstallChannel,
  PluginMutationResult,
  WorkspaceTrustListResult,
} from "@qianji/protocol";
import { getClientPluginErrors, subscribeClientPluginErrors } from "../../lib/clientPluginRuntime";
import { describeError } from "../../lib/errors";
import { mcpClient } from "../../lib/mcpClient";
import { pluginClient } from "../../lib/pluginClient";
import { queryKeys } from "../../lib/queries";
import { skillClient } from "../../lib/skillClient";
import type { AppSettings } from "../../types";
import {
  canCheckUpdate,
  cleanDisplayName,
  CORE_EXTENSION_ORDER,
  CORE_EXTENSION_SET,
  type Notice,
  type PluginFilter,
} from "./pluginHelpers";

const NO_PLUGINS: PluginInfo[] = [];
const NO_MCP_STATUS: McpServerStatus[] = [];

export function usePluginsPanelState(cwd: string, form?: AppSettings) {
  const queryClient = useQueryClient();
  const clientErrors = useSyncExternalStore(subscribeClientPluginErrors, getClientPluginErrors);

  const [filter, setFilter] = useState<PluginFilter>("all");
  const [search, setSearch] = useState("");
  const [systemExpanded, setSystemExpanded] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [installChannel, setInstallChannel] = useState<PluginInstallChannel | null>(null);
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const pluginsQuery = useQuery({
    queryKey: queryKeys.plugins(cwd),
    queryFn: () => pluginClient.list(cwd),
  });
  const trustQuery = useQuery({
    queryKey: queryKeys.workspaceTrust(cwd),
    queryFn: () => pluginClient.trustList(cwd),
    enabled: cwd.trim() !== "",
  });
  const skillsQuery = useQuery({
    queryKey: queryKeys.skills(cwd),
    queryFn: () => skillClient.list(cwd),
  });

  const plugins = pluginsQuery.data ?? NO_PLUGINS;
  const mcpPluginEnabled = useMemo(() => {
    const item = plugins.find((p) => p.id === "mcp" && p.tier === "builtin");
    return item ? item.enabled : (form?.mcpEnabled ?? true);
  }, [form?.mcpEnabled, plugins]);

  const mcpStatusQuery = useQuery({
    queryKey: queryKeys.mcpStatus(),
    queryFn: () => mcpClient.status(),
    enabled: mcpPluginEnabled,
    refetchInterval: editingConfigId === "mcp" ? 5_000 : false,
  });
  const mcpStatuses = mcpStatusQuery.data ?? NO_MCP_STATUS;

  const mcpReconnectMutation = useMutation({
    mutationFn: (serverId?: string) => mcpClient.reconnect(serverId),
    onSuccess: (servers, serverId) => {
      queryClient.setQueryData(queryKeys.mcpStatus(), servers);
      setNotice({
        kind: "success",
        text: serverId ? `已重新连接 MCP 服务 "${serverId}"。` : "已刷新并重连全部 MCP 服务。",
      });
    },
    onError: (error) => setNotice({ kind: "error", text: describeError(error) }),
  });

  useEffect(() => {
    const stopChanged = pluginClient.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins(cwd) });
    });
    const stopTrust = pluginClient.onTrustChanged(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceTrust(cwd) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins(cwd) });
    });
    return () => {
      stopChanged();
      stopTrust();
    };
  }, [cwd, queryClient]);

  const applyMutationResult = (result: PluginMutationResult, successText: string) => {
    if (cwd.trim() === "") {
      queryClient.setQueryData(queryKeys.plugins(cwd), result.plugins);
    } else {
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins(cwd) });
    }
    setNotice({ kind: "success", text: successText });
  };

  const actionMutation = useMutation({
    mutationFn: async (task: { run: () => Promise<PluginMutationResult>; label: string }) => ({
      result: await task.run(),
      label: task.label,
    }),
    onSuccess: ({ result, label }) => applyMutationResult(result, label),
    onError: (error) => setNotice({ kind: "error", text: describeError(error) }),
  });

  const trustMutation = useMutation({
    mutationFn: (trusted: boolean) => pluginClient.setTrust({ workspace: cwd, trusted }),
    onSuccess: (result: WorkspaceTrustListResult, trusted) => {
      queryClient.setQueryData(queryKeys.workspaceTrust(cwd), result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.plugins(cwd) });
      setNotice({
        kind: "success",
        text: trusted ? "已信任当前工作区并加载项目插件。" : "已撤销工作区信任，项目插件已停止加载。",
      });
    },
    onError: (error) => setNotice({ kind: "error", text: describeError(error) }),
  });

  const counts = useMemo(() => {
    const coreCount = plugins.filter((item) => item.tier === "builtin" && CORE_EXTENSION_SET.has(item.id)).length;
    const userCount = plugins.filter((item) => item.tier === "user").length;
    const wsCount = plugins.filter((item) => item.tier === "workspace").length;
    return { all: userCount + wsCount + coreCount, builtin: coreCount, user: userCount, workspace: wsCount };
  }, [plugins]);

  const updatableCount = useMemo(() => plugins.filter((item) => canCheckUpdate(item)).length, [plugins]);

  const { installedList, coreList, systemList } = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const installed: PluginInfo[] = [];
    const core: PluginInfo[] = [];
    const system: PluginInfo[] = [];
    for (const item of plugins) {
      if (filter !== "all" && item.tier !== filter) continue;
      if (needle !== "") {
        const haystack = `${item.id} ${item.name} ${item.description ?? ""} ${item.origin?.spec ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      if (item.tier === "user" || item.tier === "workspace") installed.push(item);
      else if (CORE_EXTENSION_SET.has(item.id)) core.push(item);
      else system.push(item);
    }
    core.sort((a, b) => CORE_EXTENSION_ORDER.indexOf(a.id) - CORE_EXTENSION_ORDER.indexOf(b.id));
    return { installedList: installed, coreList: core, systemList: system };
  }, [filter, plugins, search]);

  const openConfigEditor = (plugin: PluginInfo) => {
    if (editingConfigId === plugin.id) {
      setEditingConfigId(null);
      return;
    }
    setEditingConfigId(plugin.id);
    setConfigDraft(JSON.stringify(plugin.config ?? {}, null, 2));
  };

  const saveConfig = (plugin: PluginInfo) => {
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = configDraft.trim() === "" ? {} : JSON.parse(configDraft);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        setNotice({ kind: "error", text: "插件配置必须是 JSON 对象（例如 {\"key\": \"value\"}）。" });
        return;
      }
      parsed = value as Record<string, unknown>;
    } catch (error) {
      setNotice({ kind: "error", text: `JSON 格式错误：${describeError(error)}` });
      return;
    }
    const ws = plugin.tier === "workspace" ? (plugin.workspace ?? cwd) : undefined;
    actionMutation.mutate({
      run: () => pluginClient.configure({
        id: plugin.id,
        config: parsed,
        ...(ws === undefined ? {} : { workspace: ws }),
      }),
      label: `已保存插件 "${cleanDisplayName(plugin)}" 的配置并热应用。`,
    });
    setEditingConfigId(null);
  };

  const scheduleMcpRefresh = () => {
    window.setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.mcpStatus() });
    }, 650);
  };

  return {
    clientErrors,
    filter,
    setFilter,
    search,
    setSearch,
    systemExpanded,
    setSystemExpanded,
    notice,
    setNotice,
    installChannel,
    setInstallChannel,
    editingConfigId,
    setEditingConfigId,
    configDraft,
    setConfigDraft,
    confirmRemoveId,
    setConfirmRemoveId,
    pluginsQuery,
    trustQuery,
    skillsQuery,
    mcpStatuses,
    mcpReconnectMutation,
    applyMutationResult,
    actionMutation,
    trustMutation,
    counts,
    updatableCount,
    installedList,
    coreList,
    systemList,
    openConfigEditor,
    saveConfig,
    scheduleMcpRefresh,
  };
}
