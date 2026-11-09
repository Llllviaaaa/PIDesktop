import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  McpServerStatus,
  PluginInfo,
  PluginInstallChannel,
  PluginMutationResult,
  WorkspaceTrustListResult,
} from "@pid/protocol";
import {
  Archive,
  Blocks,
  BookMarked,
  Boxes,
  CalendarClock,
  Check,
  ChevronDown,
  CircleAlert,
  CloudDownload,
  Cpu,
  FolderOpen,
  GitBranch,
  GitFork,
  Globe,
  ListChecks,
  LoaderCircle,
  Monitor,
  Package,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { agent } from "../lib/agent";
import { getClientPluginErrors, subscribeClientPluginErrors } from "../lib/clientPluginRuntime";
import { describeError } from "../lib/errors";
import { mcpClient } from "../lib/mcpClient";
import { sameLocalPath } from "../lib/pathIdentity";
import { pluginClient } from "../lib/pluginClient";
import { queryKeys } from "../lib/queries";
import type { AppSettings, DesktopHookConfig, McpServerConfig } from "../types";

type PluginFilter = "all" | "builtin" | "user" | "workspace";
type Notice = { kind: "success" | "error"; text: string } | null;
type OpChipTone = "neutral" | "accent" | "green" | "warn";

interface OpChip {
  key: string;
  label: string;
  tone?: OpChipTone;
}

interface McpPresetTemplate {
  id: string;
  name: string;
  badge: string;
  command: string;
  buildArgs: (cwd: string) => string[];
  trustedReadOnly?: boolean;
}

const NO_PLUGINS: PluginInfo[] = [];
const NO_MCP_STATUS: McpServerStatus[] = [];

const PILL_SPRING = { type: "spring" as const, stiffness: 520, damping: 38, mass: 0.7 };

const CORE_EXTENSION_ORDER: readonly string[] = [
  "intelligent-ui",
  "mcp",
  "browser",
  "computer",
  "subagents",
  "plan",
  "memory",
  "schedule",
  "hooks",
  "sandbox",
];

const CORE_EXTENSION_SET = new Set<string>(CORE_EXTENSION_ORDER);

const MCP_PRESET_TEMPLATES: readonly McpPresetTemplate[] = [
  {
    id: "filesystem",
    name: "Filesystem 本地文件",
    badge: "+ 本地文件",
    command: "npx",
    buildArgs: (cwd) => ["-y", "@modelcontextprotocol/server-filesystem", cwd.trim() || "."],
  },
  {
    id: "playwright",
    name: "Playwright 浏览器",
    badge: "+ Playwright",
    command: "npx",
    buildArgs: () => ["-y", "@playwright/mcp@latest"],
  },
  {
    id: "memory-graph",
    name: "Memory 知识图谱",
    badge: "+ 知识图谱",
    command: "npx",
    buildArgs: () => ["-y", "@modelcontextprotocol/server-memory"],
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    badge: "+ 分步推理",
    command: "npx",
    buildArgs: () => ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    trustedReadOnly: true,
  },
  {
    id: "github",
    name: "GitHub 仓库协作",
    badge: "+ GitHub",
    command: "npx",
    buildArgs: () => ["-y", "@modelcontextprotocol/server-github"],
  },
];

const HOOK_EVENT_LABELS: ReadonlyArray<{ id: DesktopHookConfig["event"]; label: string }> = [
  { id: "session_start", label: "会话启动 (session_start)" },
  { id: "before_agent_start", label: "推理开始前 (before_agent_start)" },
  { id: "tool_call", label: "工具调用前 (tool_call)" },
  { id: "tool_result", label: "工具返回后 (tool_result)" },
  { id: "agent_end", label: "单轮结束 (agent_end)" },
  { id: "agent_settled", label: "任务完成 (agent_settled)" },
];

function cleanDisplayName(plugin: PluginInfo): string {
  const escapedId = plugin.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = plugin.name.replace(new RegExp(`\\s*[\\(（]${escapedId}[\\)）]\\s*$`, "i"), "").trim();
  return stripped || plugin.name;
}

function shouldShowVersion(version: string, tier: PluginInfo["tier"]): boolean {
  if (tier === "builtin") return false;
  if (!version) return false;
  if (version.startsWith("0.0.0")) return false;
  return true;
}

function iconAccentTone(id: string): string {
  if (id === "smart-rewind") return "violet";
  if (id === "intelligent-ui") return "indigo";
  if (id === "mcp") return "blue";
  if (id === "browser") return "sky";
  if (id === "computer") return "slate";
  if (id === "subagents") return "violet";
  if (id === "plan") return "emerald";
  if (id === "memory") return "amber";
  if (id === "schedule") return "teal";
  if (id === "hooks") return "neutral";
  if (id === "sandbox") return "rose";
  return "neutral";
}

function PluginCategoryIcon({ id, tier }: { id: string; tier: PluginInfo["tier"] }) {
  if (id === "smart-rewind") return <RotateCcw size={18} strokeWidth={1.8} />;
  if (id === "intelligent-ui") return <Sparkles size={18} strokeWidth={1.8} />;
  if (id === "mcp") return <Blocks size={18} strokeWidth={1.8} />;
  if (id === "browser") return <Globe size={18} strokeWidth={1.8} />;
  if (id === "computer") return <Monitor size={18} strokeWidth={1.8} />;
  if (id === "subagents") return <GitFork size={18} strokeWidth={1.8} />;
  if (id === "plan") return <ListChecks size={18} strokeWidth={1.8} />;
  if (id === "memory") return <BookMarked size={18} strokeWidth={1.8} />;
  if (id === "schedule") return <CalendarClock size={18} strokeWidth={1.8} />;
  if (id === "hooks") return <Terminal size={18} strokeWidth={1.8} />;
  if (id === "sandbox") return <Shield size={18} strokeWidth={1.8} />;
  if (id.startsWith("llm-") || id.includes("provider") || id === "pricing") return <Cpu size={17} strokeWidth={1.8} />;
  if (tier === "user" || tier === "workspace") return <Package size={18} strokeWidth={1.8} />;
  return <Boxes size={17} strokeWidth={1.8} />;
}

function isLinkedLocalPlugin(plugin: PluginInfo): boolean {
  if (plugin.origin?.channel !== "local" || plugin.dir === undefined) return false;
  return sameLocalPath(plugin.dir, plugin.origin.spec);
}

function originLabel(plugin: PluginInfo): string | null {
  const origin = plugin.origin;
  if (origin === undefined) return null;
  if (origin.channel === "local") return isLinkedLocalPlugin(plugin) ? "本地链接" : "本地目录";
  if (origin.channel === "archive") return "离线包";
  if (origin.channel === "git") return "Git 仓库";
  if (origin.channel === "npm") return "npm 包";
  return null;
}

function canCheckUpdate(plugin: PluginInfo): boolean {
  if (plugin.tier !== "user" || plugin.origin === undefined) return false;
  if (plugin.origin.channel === "git" || plugin.origin.channel === "npm") return true;
  if (plugin.origin.channel === "local" && !isLinkedLocalPlugin(plugin)) return true;
  return false;
}

function statusState(
  plugin: PluginInfo,
  clientError: string | undefined,
): { label: string; tone: "is-active" | "is-off" | "is-errored" | "is-pending" } {
  if (plugin.status === "errored" || clientError !== undefined) {
    return { label: "运行异常", tone: "is-errored" };
  }
  if (plugin.status === "untrusted") {
    return { label: "待信任", tone: "is-pending" };
  }
  if (plugin.status === "pending") {
    return { label: "待就绪", tone: "is-pending" };
  }
  if (plugin.status === "active") {
    return { label: "运行中", tone: "is-active" };
  }
  return { label: "已停用", tone: "is-off" };
}

function coreOperationalChips(
  plugin: PluginInfo,
  form: AppSettings | undefined,
  mcpStatuses: readonly McpServerStatus[],
): OpChip[] {
  if (plugin.tier !== "builtin" || !CORE_EXTENSION_SET.has(plugin.id)) return [];

  switch (plugin.id) {
    case "intelligent-ui":
      return [
        { key: "tools", label: "render_ui · update_ui", tone: "accent" },
        { key: "sandbox", label: "沙箱化富交互视图" },
      ];
    case "mcp": {
      const configured = form?.mcpServers ?? [];
      const enabledServers = configured.filter((s) => s.enabled);
      const connectedCount = mcpStatuses.filter((s) => s.connected).length;
      const erroredCount = mcpStatuses.filter((s) => !s.connected && Boolean(s.error)).length;
      const totalTools = mcpStatuses.reduce((sum, s) => sum + (s.toolCount || 0), 0);
      if (configured.length === 0 && mcpStatuses.length === 0) {
        return [
          { key: "empty", label: "暂未挂载服务 · 点击「配置」接入" },
          ...(form?.mcpConfirmTools !== false ? [{ key: "confirm", label: "调用前确认" }] : []),
        ];
      }
      const chips: OpChip[] = [
        {
          key: "conn",
          label: `${connectedCount}/${Math.max(enabledServers.length, mcpStatuses.length)} 在线`,
          tone: erroredCount > 0 ? "warn" : connectedCount > 0 ? "green" : "neutral",
        },
      ];
      if (totalTools > 0) {
        chips.push({ key: "tools", label: `${totalTools} 个工具`, tone: "accent" });
      }
      if (erroredCount > 0) {
        chips.push({ key: "err", label: `${erroredCount} 异常`, tone: "warn" });
      }
      return chips;
    }
    case "browser":
      return [
        { key: "headless", label: form?.browserHeadless !== false ? "无头静默" : "可视窗口" },
        { key: "profile", label: form?.browserProfileMode === "persistent" ? "持久化登录态" : "临时隔离会话" },
      ];
    case "computer":
      return [
        { key: "confirm", label: form?.computerConfirmActions !== false ? "点击键入需确认" : "免确认直控" },
      ];
    case "subagents": {
      const cap = Math.min(4, Math.max(1, form?.subagentMaxConcurrency ?? 3));
      return [
        { key: "concurrency", label: `最大并发 ${cap}`, tone: "accent" },
        { key: "iso", label: "独立上下文并行" },
      ];
    }
    case "plan":
      return [{ key: "plan", label: "结构化步骤看板" }];
    case "memory":
      return [
        {
          key: "mem",
          label: `${form?.memoryEnabled !== false ? "全局记忆" : "全局已关"} · ${form?.projectMemoryEnabled !== false ? "项目记忆" : "项目已关"}`,
        },
      ];
    case "schedule":
      return [{ key: "cron", label: "Cron 周期任务 · 延时唤醒" }];
    case "hooks": {
      const activeHooks = (form?.hooks ?? []).filter((h) => h.enabled).length;
      return [
        {
          key: "hooks",
          label: activeHooks > 0 ? `${activeHooks} 个生效钩子` : "支持生命周期脚本拦截",
          tone: activeHooks > 0 ? "accent" : "neutral",
        },
      ];
    }
    case "sandbox":
      return [
        {
          key: "write",
          label: form?.blockWriteOutsideWorkspace !== false ? "工作区外写保护" : "允许跨目录写入",
          tone: form?.blockWriteOutsideWorkspace !== false ? "green" : "warn",
        },
        { key: "shell", label: form?.alwaysConfirmShell !== false ? "Shell 需确认" : "Shell 自动放行" },
      ];
    default:
      return [];
  }
}

function parseShellArgLine(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

function parseKeyValuePairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(/[\n,;]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

const PLUGIN_TO_APP_SETTING: Partial<Record<string, keyof AppSettings>> = {
  plan: "planTrackingEnabled",
  mcp: "mcpEnabled",
  subagents: "subagentsEnabled",
  browser: "browserEnabled",
  computer: "computerEnabled",
  sandbox: "sandboxEnabled",
  memory: "memoryEnabled",
  hooks: "hooksEnabled",
};

export interface PluginsSettingsPanelProps {
  cwd: string;
  form?: AppSettings;
  onSyncAppSetting?: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function PluginsSettingsPanel({ cwd, form, onSyncAppSetting }: PluginsSettingsPanelProps) {
  const isTauri = "__TAURI_INTERNALS__" in window;
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
    onError: (error) => {
      setNotice({ kind: "error", text: describeError(error) });
    },
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
    mutationFn: async (task: { run: () => Promise<PluginMutationResult>; label: string }) => {
      const result = await task.run();
      return { result, label: task.label };
    },
    onSuccess: ({ result, label }) => {
      applyMutationResult(result, label);
    },
    onError: (error) => {
      setNotice({ kind: "error", text: describeError(error) });
    },
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
    onError: (error) => {
      setNotice({ kind: "error", text: describeError(error) });
    },
  });

  const counts = useMemo(() => {
    const coreCount = plugins.filter((item) => item.tier === "builtin" && CORE_EXTENSION_SET.has(item.id)).length;
    const userCount = plugins.filter((item) => item.tier === "user").length;
    const wsCount = plugins.filter((item) => item.tier === "workspace").length;
    return {
      all: userCount + wsCount + coreCount,
      builtin: coreCount,
      user: userCount,
      workspace: wsCount,
    };
  }, [plugins]);

  const updatableCount = useMemo(
    () => plugins.filter((item) => canCheckUpdate(item)).length,
    [plugins],
  );

  const visiblePlugins = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return plugins.filter((item) => {
      if (filter !== "all" && item.tier !== filter) return false;
      if (needle === "") return true;
      const haystack = `${item.id} ${item.name} ${item.description ?? ""} ${item.origin?.spec ?? ""}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [filter, plugins, search]);

  const { installedList, coreList, systemList } = useMemo(() => {
    const installed: PluginInfo[] = [];
    const core: PluginInfo[] = [];
    const system: PluginInfo[] = [];
    for (const item of visiblePlugins) {
      if (item.tier === "user" || item.tier === "workspace") {
        installed.push(item);
      } else if (CORE_EXTENSION_SET.has(item.id)) {
        core.push(item);
      } else {
        system.push(item);
      }
    }
    core.sort((a, b) => CORE_EXTENSION_ORDER.indexOf(a.id) - CORE_EXTENSION_ORDER.indexOf(b.id));
    return { installedList: installed, coreList: core, systemList: system };
  }, [visiblePlugins]);

  const isSearching = search.trim() !== "";
  const effectiveSystemOpen = isSearching || systemExpanded;

  const currentTrust = trustQuery.data?.current;
  const showTrustCard = currentTrust !== undefined && (
    currentTrust.hasProjectPlugins || currentTrust.hasProjectConfig || currentTrust.trusted
  );
  const busy = actionMutation.isPending || trustMutation.isPending;

  const scopeWorkspace = (plugin: PluginInfo): string | undefined =>
    plugin.tier === "workspace" ? (plugin.workspace ?? cwd) : undefined;

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
    const ws = scopeWorkspace(plugin);
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

  const renderPluginCard = (plugin: PluginInfo, compactSystem = false) => {
    const clientError = clientErrors[plugin.id];
    const status = statusState(plugin, clientError);
    const channel = originLabel(plugin);
    const combinedError = plugin.error ?? clientError;
    const cannotDisable = plugin.canDisable === false;
    const switchDisabled = busy || plugin.status === "untrusted" || cannotDisable;
    const isExternal = plugin.tier === "user" || plugin.tier === "workspace";
    const isStructuredCore = !isExternal
      && CORE_EXTENSION_SET.has(plugin.id)
      && form !== undefined
      && onSyncAppSetting !== undefined;
    const isEditing = editingConfigId === plugin.id;
    const title = cleanDisplayName(plugin);
    const opChips = compactSystem ? [] : coreOperationalChips(plugin, form, mcpStatuses);

    const extCapabilities: string[] = [];
    if (isExternal && channel !== null) extCapabilities.push(channel);
    if (isExternal && plugin.hasHost) extCapabilities.push("后端 Host");
    if (isExternal && plugin.hasClient) extCapabilities.push("前端 UI");

    return (
      <article
        key={`${plugin.tier}:${plugin.id}`}
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
              const ws = scopeWorkspace(plugin);
              const params = { id: plugin.id, ...(ws === undefined ? {} : { workspace: ws }) };
              actionMutation.mutate({
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
            {plugin.removable && confirmRemoveId === plugin.id ? (
              <>
                <button
                  type="button"
                  className="plugin-ghost-btn danger"
                  disabled={busy}
                  onClick={() => {
                    setConfirmRemoveId(null);
                    const ws = scopeWorkspace(plugin);
                    actionMutation.mutate({
                      run: () => pluginClient.remove({
                        id: plugin.id,
                        ...(ws === undefined ? {} : { workspace: ws }),
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
                  onClick={() => setConfirmRemoveId(null)}
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
                    disabled={mcpReconnectMutation.isPending}
                    onClick={() => mcpReconnectMutation.mutate(undefined)}
                  >
                    <RefreshCw size={12.5} />
                  </button>
                )}

                <button
                  type="button"
                  className={`plugin-ghost-btn ${isEditing ? "active" : ""}`}
                  disabled={busy}
                  onClick={() => openConfigEditor(plugin)}
                >
                  <Settings2 size={12.5} />
                  <span>{isEditing ? "收起" : "配置"}</span>
                </button>

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
                    onClick={() => actionMutation.mutate({
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
                    onClick={() => actionMutation.mutate({
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
                    onClick={() => setConfirmRemoveId(plugin.id)}
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
              onClick={() => actionMutation.mutate({
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
            isStructuredCore && form !== undefined && onSyncAppSetting !== undefined ? (
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
                  mcpReconnecting={mcpReconnectMutation.isPending}
                  onReconnectMcp={(serverId) => mcpReconnectMutation.mutate(serverId)}
                  onMcpServersUpdated={scheduleMcpRefresh}
                  onNotify={setNotice}
                />

                <details className="plugin-raw-json-details">
                  <summary>高级底层 JSON 参数覆盖（~/.pid/plugins.json）</summary>
                  <div className="plugin-raw-json-body">
                    <textarea
                      id={`plugin-config-${plugin.id}`}
                      value={configDraft}
                      onChange={(event) => setConfigDraft(event.target.value)}
                      spellCheck={false}
                    />
                    <div className="plugin-config-footer">
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => setConfigDraft("{}")}
                      >
                        重置为空对象
                      </button>
                      <div className="plugin-config-footer-right">
                        <button
                          type="button"
                          className="primary-button"
                          disabled={busy}
                          onClick={() => saveConfig(plugin)}
                        >
                          <Check size={13} />
                          <span>保存底层 JSON</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </details>
              </motion.div>
            ) : (
              <motion.div
                className="plugin-config-drawer"
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
              >
                <div className="plugin-config-top">
                  <label htmlFor={`plugin-config-${plugin.id}`}>
                    JSON 配置（保存后立即热应用至 <code>~/.pid/plugins.json</code>）
                  </label>
                  {isExternal && (
                    <label className="plugin-watch-toggle">
                      <input
                        type="checkbox"
                        checked={plugin.watch}
                        disabled={busy}
                        onChange={(event) => {
                          const nextWatch = event.target.checked;
                          const ws = scopeWorkspace(plugin);
                          actionMutation.mutate({
                            run: () => pluginClient.configure({
                              id: plugin.id,
                              config: plugin.config ?? {},
                              watch: nextWatch,
                              ...(ws === undefined ? {} : { workspace: ws }),
                            }),
                            label: `${nextWatch ? "已开启" : "已关闭"} "${title}" 的源码热更新监听。`,
                          });
                        }}
                      />
                      <span>源码保存自动热更新 (HMR)</span>
                    </label>
                  )}
                </div>
                <textarea
                  id={`plugin-config-${plugin.id}`}
                  value={configDraft}
                  onChange={(event) => setConfigDraft(event.target.value)}
                  spellCheck={false}
                />
                <div className="plugin-config-footer">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setConfigDraft("{}")}
                  >
                    重置为空对象
                  </button>
                  <div className="plugin-config-footer-right">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setEditingConfigId(null)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={busy}
                      onClick={() => saveConfig(plugin)}
                    >
                      <Check size={13} />
                      <span>保存配置</span>
                    </button>
                  </div>
                </div>
              </motion.div>
            )
          )}
        </AnimatePresence>
      </article>
    );
  };

  const renderEmptyHub = () => {
    if (isSearching) {
      return <div className="plugins-empty">没有匹配当前搜索词的连接器或插件。</div>;
    }

    if (filter === "user") {
      return (
        <div className="plugins-quickstart-hub">
          <div className="plugins-quickstart-head">
            <h3>尚未添加外部全局插件</h3>
            <p>
              支持全栈扩展（Node.js 后端工具注入 + React TSX 前端组件毫秒级热更新）。选择任一来源即可快速接入：
            </p>
          </div>

          <div className="plugins-quickstart-grid">
            <button
              type="button"
              className="plugins-quickstart-card"
              onClick={() => {
                setNotice(null);
                setInstallChannel("local");
              }}
            >
              <strong>本地目录热链开发</strong>
              <span>直接挂载包含 package.json 的源码目录，保存代码后自动 HMR 热重载。</span>
              <em>选择本地目录 →</em>
            </button>

            <button
              type="button"
              className="plugins-quickstart-card"
              onClick={() => {
                setNotice(null);
                setInstallChannel("npm");
              }}
            >
              <strong>npm / Git 仓库拉取</strong>
              <span>从 npm 注册表或 GitHub 仓库拉取社区扩展，默认启用脚本隔离保护。</span>
              <em>填写包名或仓库 →</em>
            </button>

            <button
              type="button"
              className="plugins-quickstart-card"
              onClick={() => {
                setNotice(null);
                setInstallChannel("archive");
              }}
            >
              <strong>导入离线压缩包</strong>
              <span>在内网或离线环境下直接导入 .tgz / .tar.gz / .zip 插件分发包。</span>
              <em>选择压缩包 →</em>
            </button>
          </div>
        </div>
      );
    }

    if (filter === "workspace") {
      const wsDirDisplay = cwd.trim() ? `${cwd.replace(/[\\/]+$/, "")}/.pid/plugins` : ".pid/plugins";
      return (
        <div className="plugins-quickstart-hub">
          <div className="plugins-quickstart-head">
            <h3>当前工作区暂无项目级扩展</h3>
            <p>
              项目级扩展随代码仓库共享，仅对当前工作区生效，并在首次发现时受「工作区信任」安全门控保护。
            </p>
          </div>

          <div className="plugins-workspace-pathbar">
            <code>{wsDirDisplay}/&lt;plugin-name&gt;/package.json</code>
            <div style={{ display: "flex", gap: 8 }}>
              {isTauri && cwd.trim() !== "" && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void agent.revealPathInFileManager(cwd)}
                >
                  <FolderOpen size={13} />
                  <span>打开工作区</span>
                </button>
              )}
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => actionMutation.mutate({
                  run: () => pluginClient.reload({ workspace: cwd }),
                  label: "已重新扫描当前工作区 .pid/plugins 目录。",
                })}
              >
                <RefreshCw size={13} />
                <span>重新扫描</span>
              </button>
            </div>
          </div>

          <div className="plugins-workspace-steps">
            <div className="plugins-workspace-step">
              <strong>1. 创建插件目录</strong>
              <small>在仓库下新建 .pid/plugins/my-tool 并写入含 pid 字段的 package.json。</small>
            </div>
            <div className="plugins-workspace-step">
              <strong>2. 编写 Host / UI 入口</strong>
              <small>支持直接导出 TypeScript 工具定义或前端 TSX 状态挂件，免预编译。</small>
            </div>
            <div className="plugins-workspace-step">
              <strong>3. 批准工作区信任</strong>
              <small>点击「重新扫描」并在顶部信任横幅确认后，团队成员检出仓库即可使用。</small>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="plugins-empty">
        当前分类下暂无插件，点击右上角「安装插件」可从本地目录、压缩包、Git 或 npm 接入。
      </div>
    );
  };

  const filterTabs: ReadonlyArray<{ id: PluginFilter; label: string; count: number }> = [
    { id: "all", label: "全部", count: counts.all },
    { id: "builtin", label: "核心能力", count: counts.builtin },
    { id: "user", label: "已安装", count: counts.user },
    { id: "workspace", label: "项目级", count: counts.workspace },
  ];

  const hasBothGroups = installedList.length > 0 && coreList.length > 0;

  return (
    <div className="plugins-panel">
      <div className="plugins-header-stack">
        <div className="plugins-top-search-row">
          <label className="plugins-search-box">
            <Search size={14} />
            <input
              placeholder="搜索连接器、MCP 服务或扩展模块…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            {search !== "" && (
              <button type="button" aria-label="清空搜索" onClick={() => setSearch("")}>
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
                onClick={() => actionMutation.mutate({
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
              onClick={() => actionMutation.mutate({
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
              onClick={() => {
                setNotice(null);
                setInstallChannel("local");
              }}
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
                  onClick={() => setFilter(tab.id)}
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

      <AnimatePresence initial={false}>
        {notice !== null && (
          <motion.div
            className={`plugins-notice ${notice.kind}`}
            role="status"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14 }}
          >
            <span>{notice.text}</span>
            <button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}>
              <X size={13} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {showTrustCard && currentTrust !== undefined && (
        <div className={`plugins-trust-banner${currentTrust.trusted ? " trusted" : ""}`}>
          <div className="plugins-trust-body">
            <strong>
              {currentTrust.trusted ? "工作区已信任（允许加载 .pid/plugins 项目扩展）" : "工作区尚未信任（已拦截 .pid/plugins 项目扩展）"}
            </strong>
            <p>
              <code>{currentTrust.workspace}</code>
              {currentTrust.pluginIds.length > 0 && ` · 包含：${currentTrust.pluginIds.join("、")}`}
            </p>
          </div>
          <div>
            {currentTrust.trusted ? (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => trustMutation.mutate(false)}
              >
                <ShieldAlert size={13} />
                <span>撤销信任</span>
              </button>
            ) : (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => trustMutation.mutate(true)}
              >
                <ShieldCheck size={13} />
                <span>信任并启用项目插件</span>
              </button>
            )}
          </div>
        </div>
      )}

      {pluginsQuery.isPending ? (
        <div className="plugins-empty">正在读取插件列表…</div>
      ) : pluginsQuery.isError ? (
        <div className="plugin-inline-alert error">
          <span>读取插件列表失败：{describeError(pluginsQuery.error)}</span>
          <button type="button" className="plugin-ghost-btn" onClick={() => void pluginsQuery.refetch()}>
            重试
          </button>
        </div>
      ) : installedList.length === 0 && coreList.length === 0 && systemList.length === 0 ? (
        renderEmptyHub()
      ) : (
        <div className="plugins-groups">
          {installedList.length > 0 && (
            <section className="plugins-group">
              {hasBothGroups && (
                <h2 className="plugins-group-heading">
                  <span>已安装扩展</span>
                  <em>{installedList.length}</em>
                </h2>
              )}
              <div className="plugins-bento-grid">
                {installedList.map((item) => renderPluginCard(item))}
              </div>
            </section>
          )}

          {coreList.length > 0 && (
            <section className="plugins-group">
              {hasBothGroups && (
                <h2 className="plugins-group-heading">
                  <span>核心智能体能力</span>
                  <em>{coreList.length}</em>
                </h2>
              )}
              <div className="plugins-bento-grid">
                {coreList.map((item) => renderPluginCard(item))}
              </div>
            </section>
          )}

          {systemList.length > 0 && (
            <section className="plugins-group">
              <button
                type="button"
                className="plugins-disclosure-btn"
                aria-expanded={effectiveSystemOpen}
                onClick={() => setSystemExpanded((v) => !v)}
              >
                <span>
                  <Boxes size={13.5} />
                  <span>底层运行时与协议模块（{systemList.length} 项）</span>
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
                    {systemList.map((item) => renderPluginCard(item, true))}
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
          )}
        </div>
      )}

      <AnimatePresence>
        {installChannel !== null && (
          <InstallPluginDialog
            isTauri={isTauri}
            initialChannel={installChannel}
            onClose={() => setInstallChannel(null)}
            onInstalled={(result, label) => {
              setInstallChannel(null);
              applyMutationResult(result, label);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function CoreCapabilityDrawer({
  plugin,
  cwd,
  isTauri,
  form,
  onSyncAppSetting,
  mcpStatuses,
  mcpReconnecting,
  onReconnectMcp,
  onMcpServersUpdated,
  onNotify,
}: {
  plugin: PluginInfo;
  cwd: string;
  isTauri: boolean;
  form: AppSettings;
  onSyncAppSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  mcpStatuses: readonly McpServerStatus[];
  mcpReconnecting: boolean;
  onReconnectMcp: (serverId?: string) => void;
  onMcpServersUpdated: () => void;
  onNotify: (notice: Notice) => void;
}) {
  const [mcpTransport, setMcpTransport] = useState<"stdio" | "http">("stdio");
  const [mcpName, setMcpName] = useState("");
  const [mcpCmdLine, setMcpCmdLine] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpEnvLine, setMcpEnvLine] = useState("");
  const [mcpReadOnly, setMcpReadOnly] = useState(false);

  const [hookEvent, setHookEvent] = useState<DesktopHookConfig["event"]>("tool_call");
  const [hookCmd, setHookCmd] = useState("");
  const [hookBlocking, setHookBlocking] = useState(false);

  if (plugin.id === "mcp") {
    const servers = form.mcpServers ?? [];
    const statusMap = new Map(mcpStatuses.map((s) => [s.id, s]));

    const addMcpServer = (server: McpServerConfig) => {
      const next = [...servers.filter((item) => item.id !== server.id), server];
      onSyncAppSetting("mcpServers", next);
      onMcpServersUpdated();
      onNotify({ kind: "success", text: `已添加 MCP 服务 "${server.name}"，正在自动连接…` });
    };

    const handleAddPreset = (preset: McpPresetTemplate) => {
      if (servers.some((s) => s.id === preset.id)) return;
      addMcpServer({
        id: preset.id,
        name: preset.name,
        enabled: true,
        transport: "stdio",
        command: preset.command,
        args: preset.buildArgs(cwd),
        cwd: cwd.trim(),
        env: {},
        inheritEnvironment: true,
        url: "",
        headers: {},
        trustedReadOnly: preset.trustedReadOnly ?? false,
      });
    };

    const handleAddCustomMcp = () => {
      const cleanName = mcpName.trim();
      if (mcpTransport === "stdio") {
        const tokens = parseShellArgLine(mcpCmdLine.trim());
        if (tokens.length === 0) {
          onNotify({ kind: "error", text: "请填写 STDIO 启动命令（例如 npx -y @playwright/mcp@latest）。" });
          return;
        }
        const [command, ...args] = tokens;
        const baseId = (cleanName || command).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "mcp";
        const uniqueId = servers.some((s) => s.id === baseId) ? `${baseId}-${Date.now().toString(36).slice(-4)}` : baseId;
        addMcpServer({
          id: uniqueId,
          name: cleanName || command,
          enabled: true,
          transport: "stdio",
          command,
          args,
          cwd: cwd.trim(),
          env: parseKeyValuePairs(mcpEnvLine),
          inheritEnvironment: true,
          url: "",
          headers: {},
          trustedReadOnly: mcpReadOnly,
        });
        setMcpName("");
        setMcpCmdLine("");
        setMcpEnvLine("");
        setMcpReadOnly(false);
        return;
      }

      const trimmedUrl = mcpUrl.trim();
      if (!/^https?:\/\//i.test(trimmedUrl)) {
        onNotify({ kind: "error", text: "请填写以 http:// 或 https:// 开头的远程 MCP 地址。" });
        return;
      }
      const hostFallback = (() => {
        try {
          return new URL(trimmedUrl).hostname;
        } catch {
          return "remote-mcp";
        }
      })();
      const baseId = (cleanName || hostFallback).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "http-mcp";
      const uniqueId = servers.some((s) => s.id === baseId) ? `${baseId}-${Date.now().toString(36).slice(-4)}` : baseId;
      addMcpServer({
        id: uniqueId,
        name: cleanName || hostFallback,
        enabled: true,
        transport: "http",
        command: "",
        args: [],
        cwd: "",
        env: {},
        inheritEnvironment: false,
        url: trimmedUrl,
        headers: parseKeyValuePairs(mcpEnvLine),
        trustedReadOnly: mcpReadOnly,
      });
      setMcpName("");
      setMcpUrl("");
      setMcpEnvLine("");
      setMcpReadOnly(false);
    };

    return (
      <div className="plugin-mcp-hub">
        <div className="plugin-mcp-topbar">
          <div className="plugin-structured-copy">
            <strong>工具调用安全确认</strong>
            <small>开启后，非只读 MCP 工具在首次执行副作用操作前会请求你的批准</small>
          </div>
          <div className="plugin-structured-control">
            <button
              type="button"
              role="switch"
              aria-checked={form.mcpConfirmTools}
              aria-label="MCP 工具调用前确认"
              className={`settings-switch ${form.mcpConfirmTools ? "on" : ""}`}
              onClick={() => onSyncAppSetting("mcpConfirmTools", !form.mcpConfirmTools)}
            >
              <span />
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={mcpReconnecting || servers.length === 0}
              onClick={() => onReconnectMcp(undefined)}
            >
              <RefreshCw size={12.5} />
              <span>重连全部</span>
            </button>
          </div>
        </div>

        {servers.length > 0 && (
          <div className="plugin-mcp-server-list">
            {servers.map((srv) => {
              const st = statusMap.get(srv.id);
              const cmdSummary = srv.transport === "http"
                ? srv.url
                : [srv.command, ...srv.args].join(" ");
              return (
                <div key={srv.id} className="plugin-mcp-server-item">
                  <div className="plugin-mcp-server-main">
                    <div className="plugin-mcp-server-title">
                      <strong>{srv.name || srv.id}</strong>
                      <span className="plugin-quiet-pill">{srv.transport.toUpperCase()}</span>
                      {srv.trustedReadOnly && <span className="plugin-quiet-pill">只读免确认</span>}
                      {!srv.enabled ? (
                        <span className="plugin-op-chip">已停用</span>
                      ) : st?.connected ? (
                        <span className="plugin-op-chip tone-green">已连接 · {st.toolCount} 个工具</span>
                      ) : st?.error ? (
                        <span className="plugin-op-chip tone-warn" title={st.error}>连接失败：{st.error.slice(0, 38)}</span>
                      ) : (
                        <span className="plugin-op-chip">待连接</span>
                      )}
                    </div>
                    <div className="plugin-mcp-server-cmd" title={cmdSummary}>{cmdSummary}</div>
                  </div>

                  <div className="plugin-mcp-server-actions">
                    <button
                      type="button"
                      className="plugin-ghost-btn icon-only"
                      title="重新连接该服务"
                      aria-label={`重新连接 ${srv.name || srv.id}`}
                      disabled={mcpReconnecting || !srv.enabled}
                      onClick={() => onReconnectMcp(srv.id)}
                    >
                      <RefreshCw size={12.5} />
                    </button>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={srv.enabled}
                      aria-label={`${srv.enabled ? "停用" : "启用"} MCP ${srv.name || srv.id}`}
                      className={`settings-switch ${srv.enabled ? "on" : ""}`}
                      onClick={() => {
                        const next = servers.map((item) => (
                          item.id === srv.id ? { ...item, enabled: !item.enabled } : item
                        ));
                        onSyncAppSetting("mcpServers", next);
                        onMcpServersUpdated();
                      }}
                    >
                      <span />
                    </button>
                    <button
                      type="button"
                      className="plugin-ghost-btn danger icon-only"
                      title="移除该 MCP 服务"
                      aria-label={`移除 ${srv.name || srv.id}`}
                      onClick={() => {
                        onSyncAppSetting("mcpServers", servers.filter((item) => item.id !== srv.id));
                        onMcpServersUpdated();
                      }}
                    >
                      <Trash2 size={12.5} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="plugin-mcp-templates">
          <span className="plugin-mcp-section-label">一键挂载官方常用连接器</span>
          <div className="plugin-mcp-template-row">
            {MCP_PRESET_TEMPLATES.map((preset) => {
              const exists = servers.some((s) => s.id === preset.id);
              return (
                <button
                  key={preset.id}
                  type="button"
                  className="plugin-mcp-template-pill"
                  disabled={exists}
                  onClick={() => handleAddPreset(preset)}
                >
                  <span>{exists ? `✓ ${preset.name}` : preset.badge}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="plugin-mcp-add-card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span className="plugin-mcp-section-label">添加自定义 MCP 服务</span>
            <div className="settings-segmented">
              <button
                type="button"
                className={mcpTransport === "stdio" ? "active" : ""}
                onClick={() => setMcpTransport("stdio")}
              >
                {mcpTransport === "stdio" && <span className="settings-segmented-thumb" />}
                <span>STDIO 命令行</span>
              </button>
              <button
                type="button"
                className={mcpTransport === "http" ? "active" : ""}
                onClick={() => setMcpTransport("http")}
              >
                {mcpTransport === "http" && <span className="settings-segmented-thumb" />}
                <span>HTTP 远程</span>
              </button>
            </div>
          </div>

          <div className="plugin-mcp-add-grid">
            <input
              placeholder="显示名称（如 Postgres）"
              value={mcpName}
              onChange={(event) => setMcpName(event.target.value)}
            />
            {mcpTransport === "stdio" ? (
              <input
                className="mono"
                placeholder="启动命令，例如 npx -y @modelcontextprotocol/server-postgres postgresql://..."
                value={mcpCmdLine}
                onChange={(event) => setMcpCmdLine(event.target.value)}
              />
            ) : (
              <input
                className="mono"
                placeholder="远程 MCP Endpoint，例如 https://mcp.example.com/mcp"
                value={mcpUrl}
                onChange={(event) => setMcpUrl(event.target.value)}
              />
            )}
          </div>

          <input
            className="mono"
            placeholder={
              mcpTransport === "stdio"
                ? "环境变量（可选，格式 KEY=VALUE，多项用逗号分隔，例如 GITHUB_PERSONAL_ACCESS_TOKEN=ghp_...）"
                : "请求头（可选，格式 Authorization=Bearer xxx，多项用逗号分隔）"
            }
            value={mcpEnvLine}
            onChange={(event) => setMcpEnvLine(event.target.value)}
          />

          <div className="plugin-mcp-add-foot">
            <label className="plugin-watch-toggle">
              <input
                type="checkbox"
                checked={mcpReadOnly}
                onChange={(event) => setMcpReadOnly(event.target.checked)}
              />
              <span>信任为只读查询服务（工具调用免弹窗确认）</span>
            </label>
            <button type="button" className="primary-button" onClick={handleAddCustomMcp}>
              <Plus size={13} />
              <span>添加连接器</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (plugin.id === "browser") {
    const pickBrowserExe = async () => {
      if (!isTauri) return;
      const picked = await openDialog({
        directory: false,
        multiple: false,
        title: "选择 Chrome / Edge 浏览器可执行文件",
      });
      if (typeof picked === "string" && picked !== "") {
        onSyncAppSetting("browserExecutable", picked);
      }
    };

    return (
      <div>
        <div className="plugin-structured-row">
          <div className="plugin-structured-copy">
            <strong>无头静默模式 (Headless)</strong>
            <small>在后台完成网页渲染与读取；关闭后将弹出真实浏览器窗口以便观察操作</small>
          </div>
          <div className="plugin-structured-control">
            <button
              type="button"
              role="switch"
              aria-checked={form.browserHeadless}
              aria-label="无头静默模式"
              className={`settings-switch ${form.browserHeadless ? "on" : ""}`}
              onClick={() => onSyncAppSetting("browserHeadless", !form.browserHeadless)}
            >
              <span />
            </button>
          </div>
        </div>

        <div className="plugin-structured-row">
          <div className="plugin-structured-copy">
            <strong>网页点击与表单提交前确认</strong>
            <small>防止智能体在未授权情况下触发外部站点提交或修改操作</small>
          </div>
          <div className="plugin-structured-control">
            <button
              type="button"
              role="switch"
              aria-checked={form.browserConfirmActions}
              aria-label="网页点击与表单提交前确认"
              className={`settings-switch ${form.browserConfirmActions ? "on" : ""}`}
              onClick={() => onSyncAppSetting("browserConfirmActions", !form.browserConfirmActions)}
            >
              <span />
            </button>
          </div>
        </div>

        <div className="plugin-structured-row">
          <div className="plugin-structured-copy">
            <strong>浏览器会话与 Cookie 策略</strong>
            <small>持久化模式将保留登录态至 ~/.pid/browser-profile，方便复用已登录站点</small>
          </div>
          <div className="plugin-structured-control">
            <div className="settings-segmented">
              {(["temporary", "persistent"] as const).map((mode) => {
                const active = form.browserProfileMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    className={active ? "active" : ""}
                    onClick={() => onSyncAppSetting("browserProfileMode", mode)}
                  >
                    {active && <span className="settings-segmented-thumb" />}
                    <span>{mode === "temporary" ? "临时隔离" : "持久登录态"}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="plugin-structured-row">
          <div className="plugin-structured-copy">
            <strong>自定义 Chrome / Edge 可执行路径</strong>
            <small>留空将自动探测系统已安装的 Chromium 内核浏览器</small>
          </div>
          <div className="plugin-structured-control">
            <input
              className="plugin-structured-input mono"
              placeholder="自动探测本机浏览器"
              value={form.browserExecutable}
              onChange={(event) => onSyncAppSetting("browserExecutable", event.target.value)}
            />
            {isTauri && (
              <button type="button" className="secondary-button" onClick={() => void pickBrowserExe()}>
                浏览…
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (plugin.id === "computer") {
    return (
      <div className="plugin-structured-row">
        <div className="plugin-structured-copy">
          <strong>桌面鼠标点击与键盘输入前确认</strong>
          <small>截图观察可直接执行；涉及移动点击、快捷键与文本键入时先请求批准</small>
        </div>
        <div className="plugin-structured-control">
          <button
            type="button"
            role="switch"
            aria-checked={form.computerConfirmActions}
            aria-label="桌面鼠标点击与键盘输入前确认"
            className={`settings-switch ${form.computerConfirmActions ? "on" : ""}`}
            onClick={() => onSyncAppSetting("computerConfirmActions", !form.computerConfirmActions)}
          >
            <span />
          </button>
        </div>
      </div>
    );
  }

  if (plugin.id === "subagents") {
    const currentCap = Math.min(4, Math.max(1, form.subagentMaxConcurrency || 3));
    return (
      <div className="plugin-structured-row">
        <div className="plugin-structured-copy">
          <strong>子智能体最大并行数</strong>
          <small>主智能体拆解大型检索或修改任务时，允许同时运行的独立子会话上限</small>
        </div>
        <div className="plugin-structured-control">
          <div className="settings-segmented">
            {[1, 2, 3, 4].map((n) => {
              const active = currentCap === n;
              return (
                <button
                  key={n}
                  type="button"
                  className={active ? "active" : ""}
                  onClick={() => onSyncAppSetting("subagentMaxConcurrency", n)}
                >
                  {active && <span className="settings-segmented-thumb" />}
                  <span>{n} 并发</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  if (plugin.id === "memory") {
    return (
      <div>
        <div className="plugin-structured-row">
          <div className="plugin-structured-copy">
            <strong>全局跨会话长期记忆 (~/.pid/memory.md)</strong>
            <small>自动加载并允许智能体沉淀你的个人偏好、常用工具链与代码风格约定</small>
          </div>
          <div className="plugin-structured-control">
            <button
              type="button"
              role="switch"
              aria-checked={form.memoryEnabled}
              aria-label="全局跨会话长期记忆"
              className={`settings-switch ${form.memoryEnabled ? "on" : ""}`}
              onClick={() => onSyncAppSetting("memoryEnabled", !form.memoryEnabled)}
            >
              <span />
            </button>
          </div>
        </div>

        <div className="plugin-structured-row">
          <div className="plugin-structured-copy">
            <strong>项目上下文指令 (AGENTS.md / CLAUDE.md)</strong>
            <small>进入工作区时自动注入项目根目录下的架构规范与构建约定文档</small>
          </div>
          <div className="plugin-structured-control">
            <button
              type="button"
              role="switch"
              aria-checked={form.projectMemoryEnabled}
              aria-label="项目上下文指令"
              className={`settings-switch ${form.projectMemoryEnabled ? "on" : ""}`}
              onClick={() => onSyncAppSetting("projectMemoryEnabled", !form.projectMemoryEnabled)}
            >
              <span />
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (plugin.id === "sandbox") {
    return (
      <div>
        <div className="plugin-structured-row">
          <div className="plugin-structured-copy">
            <strong>拦截工作区目录外的文件写入</strong>
            <small>禁止模型未经允许修改当前项目根目录以外的系统或个人文件</small>
          </div>
          <div className="plugin-structured-control">
            <button
              type="button"
              role="switch"
              aria-checked={form.blockWriteOutsideWorkspace}
              aria-label="拦截工作区目录外的文件写入"
              className={`settings-switch ${form.blockWriteOutsideWorkspace ? "on" : ""}`}
              onClick={() => onSyncAppSetting("blockWriteOutsideWorkspace", !form.blockWriteOutsideWorkspace)}
            >
              <span />
            </button>
          </div>
        </div>

        <div className="plugin-structured-row">
          <div className="plugin-structured-copy">
            <strong>终端命令执行前请求确认</strong>
            <small>除下方白名单前缀外，执行 bash / PowerShell 命令前需人工批准</small>
          </div>
          <div className="plugin-structured-control">
            <button
              type="button"
              role="switch"
              aria-checked={form.alwaysConfirmShell}
              aria-label="终端命令执行前请求确认"
              className={`settings-switch ${form.alwaysConfirmShell ? "on" : ""}`}
              onClick={() => onSyncAppSetting("alwaysConfirmShell", !form.alwaysConfirmShell)}
            >
              <span />
            </button>
          </div>
        </div>

        <div className="plugin-structured-row">
          <div className="plugin-structured-copy">
            <strong>免确认安全命令前缀</strong>
            <small>用逗号分隔只读或测试命令前缀（例如 git status, git diff, npm test）</small>
          </div>
          <div className="plugin-structured-control">
            <input
              className="plugin-structured-input mono"
              placeholder="例如 git status, git diff, npm test"
              value={form.shellAllowPrefixes}
              onChange={(event) => onSyncAppSetting("shellAllowPrefixes", event.target.value)}
            />
          </div>
        </div>
      </div>
    );
  }

  if (plugin.id === "hooks") {
    const hooks = form.hooks ?? [];
    const addHook = () => {
      const cmd = hookCmd.trim();
      if (!cmd) {
        onNotify({ kind: "error", text: "请填写钩子触发时要执行的 Shell 命令。" });
        return;
      }
      const nextHook: DesktopHookConfig = {
        id: `hook-${Date.now().toString(36)}`,
        name: `${hookEvent} 钩子`,
        enabled: true,
        event: hookEvent,
        command: cmd,
        timeoutSeconds: 15,
        blocking: hookBlocking,
      };
      onSyncAppSetting("hooks", [...hooks, nextHook]);
      if (!form.hooksEnabled) onSyncAppSetting("hooksEnabled", true);
      setHookCmd("");
      setHookBlocking(false);
    };

    return (
      <div className="plugin-mcp-hub">
        <div className="plugin-structured-row" style={{ paddingTop: 0 }}>
          <div className="plugin-structured-copy">
            <strong>向钩子子进程继承桌面环境变量</strong>
            <small>允许自动化钩子脚本读取当前用户 PATH 与开发工具环境变量</small>
          </div>
          <div className="plugin-structured-control">
            <button
              type="button"
              role="switch"
              aria-checked={form.hooksInheritEnvironment}
              aria-label="向钩子子进程继承桌面环境变量"
              className={`settings-switch ${form.hooksInheritEnvironment ? "on" : ""}`}
              onClick={() => onSyncAppSetting("hooksInheritEnvironment", !form.hooksInheritEnvironment)}
            >
              <span />
            </button>
          </div>
        </div>

        {hooks.length > 0 && (
          <div className="plugin-mcp-server-list">
            {hooks.map((item) => (
              <div key={item.id} className="plugin-mcp-server-item">
                <div className="plugin-mcp-server-main">
                  <div className="plugin-mcp-server-title">
                    <strong>{item.event}</strong>
                    {item.blocking && <span className="plugin-op-chip tone-warn">可拦截</span>}
                  </div>
                  <div className="plugin-mcp-server-cmd">{item.command}</div>
                </div>
                <div className="plugin-mcp-server-actions">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={item.enabled}
                    aria-label={`切换钩子 ${item.event}`}
                    className={`settings-switch ${item.enabled ? "on" : ""}`}
                    onClick={() => {
                      onSyncAppSetting(
                        "hooks",
                        hooks.map((h) => (h.id === item.id ? { ...h, enabled: !h.enabled } : h)),
                      );
                    }}
                  >
                    <span />
                  </button>
                  <button
                    type="button"
                    className="plugin-ghost-btn danger icon-only"
                    aria-label={`删除钩子 ${item.event}`}
                    onClick={() => onSyncAppSetting("hooks", hooks.filter((h) => h.id !== item.id))}
                  >
                    <Trash2 size={12.5} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="plugin-mcp-add-card">
          <span className="plugin-mcp-section-label">新增生命周期自动化钩子</span>
          <div className="plugin-mcp-add-grid">
            <select
              value={hookEvent}
              onChange={(event) => setHookEvent(event.target.value as DesktopHookConfig["event"])}
            >
              {HOOK_EVENT_LABELS.map((ev) => (
                <option key={ev.id} value={ev.id}>{ev.label}</option>
              ))}
            </select>
            <input
              className="mono"
              placeholder="执行命令，例如 npm run lint:quick 或 python scripts/audit.py"
              value={hookCmd}
              onChange={(event) => setHookCmd(event.target.value)}
            />
          </div>
          <div className="plugin-mcp-add-foot">
            <label className="plugin-watch-toggle">
              <input
                type="checkbox"
                checked={hookBlocking}
                onChange={(event) => setHookBlocking(event.target.checked)}
              />
              <span>阻塞模式（退出码非 0 时阻止该动作继续执行）</span>
            </label>
            <button type="button" className="primary-button" onClick={addHook}>
              <Plus size={13} />
              <span>添加钩子</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="plugin-structured-row">
      <div className="plugin-structured-copy">
        <strong>内置能力已就绪</strong>
        <small>
          该模块开箱即用，智能体会根据对话需求自动调用对应工具；如需调整右上角开关即可随时启停。
        </small>
      </div>
    </div>
  );
}

function InstallPluginDialog({
  isTauri,
  initialChannel = "local",
  onClose,
  onInstalled,
}: {
  isTauri: boolean;
  initialChannel?: PluginInstallChannel;
  onClose: () => void;
  onInstalled: (result: PluginMutationResult, label: string) => void;
}) {
  const [channel, setChannel] = useState<PluginInstallChannel>(initialChannel);
  const [source, setSource] = useState("");
  const [linkLocal, setLinkLocal] = useState(true);
  const [gitRef, setGitRef] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !installMutation.isPending) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  const installMutation = useMutation({
    mutationFn: () => {
      const trimmedSource = source.trim();
      const trimmedRef = gitRef.trim();
      const spec = channel === "git" && trimmedRef !== "" && !trimmedSource.includes("#")
        ? `${trimmedSource}#${trimmedRef}`
        : trimmedSource;
      return pluginClient.install({
        channel,
        spec,
        ...(channel === "local" ? { link: linkLocal, watch: linkLocal } : {}),
      });
    },
    onSuccess: (result) => {
      const installedName = result.plugin?.name ?? source.trim();
      onInstalled(result, `已成功安装并加载插件 "${installedName}"。`);
    },
    onError: (err) => {
      setError(describeError(err));
    },
  });

  const browseSource = async () => {
    if (!isTauri) return;
    setError("");
    if (channel === "local") {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "选择本地插件目录（包含 package.json）",
      });
      if (typeof picked === "string" && picked !== "") setSource(picked);
      return;
    }
    if (channel === "archive") {
      const picked = await openDialog({
        directory: false,
        multiple: false,
        title: "选择离线插件压缩包",
        filters: [{ name: "插件压缩包", extensions: ["tgz", "gz", "zip"] }],
      });
      if (typeof picked === "string" && picked !== "") setSource(picked);
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (source.trim() === "") {
      setError("请填写插件来源路径、仓库地址或 npm 包名。");
      return;
    }
    setError("");
    installMutation.mutate();
  };

  const channels: ReadonlyArray<{ id: PluginInstallChannel; label: string; icon: typeof FolderOpen }> = [
    { id: "local", label: "本地目录", icon: FolderOpen },
    { id: "archive", label: "离线压缩包", icon: Archive },
    { id: "git", label: "Git 仓库", icon: GitBranch },
    { id: "npm", label: "npm 在线包", icon: Package },
  ];

  return (
    <motion.div
      className="plugin-install-backdrop"
      data-escape-layer
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={() => !installMutation.isPending && onClose()}
    >
      <motion.form
        className="plugin-install-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="安装插件"
        initial={{ opacity: 0, scale: 0.965, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.975, y: 6 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="plugin-install-header">
          <h2>安装外部插件</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭安装窗口"
            disabled={installMutation.isPending}
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>

        <LayoutGroup id="plugin-install-channel-tabs">
          <div className="plugin-channel-tabs" role="tablist" aria-label="安装渠道">
            {channels.map((item) => {
              const Icon = item.icon;
              const active = channel === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={active ? "active" : ""}
                  onClick={() => {
                    setChannel(item.id);
                    setError("");
                  }}
                >
                  {active && (
                    <motion.span
                      layoutId="plugin-channel-tab-pill"
                      className="plugin-channel-tab-bg"
                      transition={PILL_SPRING}
                    />
                  )}
                  <Icon size={14} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </LayoutGroup>

        {channel === "local" && (
          <>
            <div className="plugin-install-field">
              <label htmlFor="plugin-install-source">本地插件目录路径</label>
              <div className="plugin-path-picker">
                <input
                  id="plugin-install-source"
                  placeholder="例如 D:\plugins\my-pid-plugin"
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                />
                {isTauri && (
                  <button type="button" className="secondary-button" onClick={() => void browseSource()}>
                    浏览目录…
                  </button>
                )}
              </div>
              <small>目录下需包含 <code>package.json</code>，支持直接加载 TypeScript / TSX 源码。</small>
            </div>
            <label className="plugin-watch-toggle">
              <input
                type="checkbox"
                checked={linkLocal}
                onChange={(event) => setLinkLocal(event.target.checked)}
              />
              <span>开发链接模式（保持原目录引用，修改源码保存后自动热更新）</span>
            </label>
          </>
        )}

        {channel === "archive" && (
          <div className="plugin-install-field">
            <label htmlFor="plugin-install-source">离线压缩包路径</label>
            <div className="plugin-path-picker">
              <input
                id="plugin-install-source"
                placeholder="支持 .tgz / .tar.gz / .zip"
                value={source}
                onChange={(event) => setSource(event.target.value)}
              />
              {isTauri && (
                <button type="button" className="secondary-button" onClick={() => void browseSource()}>
                  选择文件…
                </button>
              )}
            </div>
            <small>自动校验路径安全并解压至 <code>~/.pid/plugins/</code>。</small>
          </div>
        )}

        {channel === "git" && (
          <>
            <div className="plugin-install-field">
              <label htmlFor="plugin-install-source">Git 仓库地址</label>
              <input
                id="plugin-install-source"
                placeholder="例如 https://github.com/org/pid-plugin.git"
                value={source}
                onChange={(event) => setSource(event.target.value)}
              />
            </div>
            <div className="plugin-install-field">
              <label htmlFor="plugin-install-ref">分支或标签（可选）</label>
              <input
                id="plugin-install-ref"
                placeholder="例如 main 或 v1.2.0"
                value={gitRef}
                onChange={(event) => setGitRef(event.target.value)}
              />
            </div>
          </>
        )}

        {channel === "npm" && (
          <div className="plugin-install-field">
            <label htmlFor="plugin-install-source">npm 包名与版本</label>
            <input
              id="plugin-install-source"
              placeholder="例如 pid-plugin-csv 或 @scope/pid-plugin@^1.0.0"
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
            <small>由内嵌引擎安全拉取（默认启用 <code>--ignore-scripts</code> 隔离）。</small>
          </div>
        )}

        {error !== "" && (
          <div className="plugin-inline-alert error" role="alert">
            <span>{error}</span>
          </div>
        )}

        <div className="plugin-install-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={installMutation.isPending}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={installMutation.isPending}
          >
            {installMutation.isPending ? <LoaderCircle size={14} className="spinner-icon" /> : <Plus size={14} />}
            <span>{installMutation.isPending ? "正在安装…" : "立即安装并加载"}</span>
          </button>
        </div>
      </motion.form>
    </motion.div>
  );
}
