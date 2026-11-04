import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  PluginInfo,
  PluginInstallChannel,
  PluginMutationResult,
  WorkspaceTrustListResult,
} from "@pid/protocol";
import {
  Archive,
  Check,
  CircleAlert,
  CloudDownload,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  Package,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { agent } from "../lib/agent";
import { getClientPluginErrors, subscribeClientPluginErrors } from "../lib/clientPluginRuntime";
import { describeError } from "../lib/errors";
import { sameLocalPath } from "../lib/pathIdentity";
import { pluginClient } from "../lib/pluginClient";
import { queryKeys } from "../lib/queries";

type PluginFilter = "all" | "user" | "workspace" | "builtin";
type Notice = { kind: "success" | "error"; text: string } | null;

const NO_PLUGINS: PluginInfo[] = [];

function tierLabel(plugin: PluginInfo): string {
  if (plugin.tier === "workspace") return "项目级";
  if (plugin.tier === "user") return "全局安装";
  return "内置默认";
}

function isLinkedLocalPlugin(plugin: PluginInfo): boolean {
  if (plugin.origin?.channel !== "local" || plugin.dir === undefined) return false;
  return sameLocalPath(plugin.dir, plugin.origin.spec);
}

function originLabel(plugin: PluginInfo): string | null {
  const origin = plugin.origin;
  if (origin === undefined) return null;
  if (origin.channel === "local") return isLinkedLocalPlugin(plugin) ? "本地链接" : "本地复制";
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

function statusBadge(plugin: PluginInfo, clientError: string | undefined): { label: string; className: string } {
  if (plugin.status === "errored" || clientError !== undefined) {
    return { label: "运行异常", className: "plugin-badge status-errored" };
  }
  if (plugin.status === "untrusted") {
    return { label: "待工作区信任", className: "plugin-badge status-untrusted" };
  }
  if (plugin.status === "active") {
    return { label: "运行中", className: "plugin-badge status-active" };
  }
  return { label: "已停用", className: "plugin-badge" };
}

export function PluginsSettingsPanel({ cwd }: { cwd: string }) {
  const isTauri = "__TAURI_INTERNALS__" in window;
  const queryClient = useQueryClient();
  const clientErrors = useSyncExternalStore(subscribeClientPluginErrors, getClientPluginErrors);

  const [filter, setFilter] = useState<PluginFilter>("all");
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState("");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const pluginsQuery = useQuery({
    queryKey: queryKeys.plugins(cwd),
    queryFn: () => pluginClient.list(cwd),
    enabled: isTauri,
  });

  const trustQuery = useQuery({
    queryKey: queryKeys.workspaceTrust(cwd),
    queryFn: () => pluginClient.trustList(cwd),
    enabled: isTauri && cwd.trim() !== "",
  });

  useEffect(() => {
    if (!isTauri) return undefined;
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
  }, [cwd, isTauri, queryClient]);

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

  const plugins = pluginsQuery.data ?? NO_PLUGINS;
  const counts = useMemo(() => ({
    all: plugins.length,
    user: plugins.filter((item) => item.tier === "user").length,
    workspace: plugins.filter((item) => item.tier === "workspace").length,
    builtin: plugins.filter((item) => item.tier === "builtin").length,
  }), [plugins]);

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
      label: `已保存插件 "${plugin.name}" 的配置并热应用。`,
    });
    setEditingConfigId(null);
  };

  return (
    <div className="plugins-panel">
      <p className="settings-panel-description">
        管理内置能力、用户全局插件（<code>~/.pid/plugins</code>）与项目级插件（<code>.pid/plugins</code>）。用户插件独立于安装包保存，升级客户端不会重置，支持本地源码热加载（HMR）与多渠道在线更新。
      </p>

      <div className="plugins-toolbar">
        <div className="plugins-filter-pills" role="tablist" aria-label="插件分类筛选">
          <button type="button" role="tab" aria-selected={filter === "all"} className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>
            全部 ({counts.all})
          </button>
          <button type="button" role="tab" aria-selected={filter === "user"} className={filter === "user" ? "active" : ""} onClick={() => setFilter("user")}>
            全局已安装 ({counts.user})
          </button>
          <button type="button" role="tab" aria-selected={filter === "workspace"} className={filter === "workspace" ? "active" : ""} onClick={() => setFilter("workspace")}>
            项目插件 ({counts.workspace})
          </button>
          <button type="button" role="tab" aria-selected={filter === "builtin"} className={filter === "builtin" ? "active" : ""} onClick={() => setFilter("builtin")}>
            内置默认 ({counts.builtin})
          </button>
        </div>

        <div className="plugins-toolbar-actions">
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
              <CloudDownload size={14} />
              <span>检查全部更新</span>
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => actionMutation.mutate({
              run: () => pluginClient.reload({ workspace: cwd }),
              label: "已重新扫描并热重载全部插件。",
            })}
          >
            <RefreshCw size={14} />
            <span>全部热重载</span>
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => {
              setNotice(null);
              setInstallOpen(true);
            }}
          >
            <Plus size={14} />
            <span>安装插件</span>
          </button>
        </div>
      </div>

      <label className="plugins-search-row">
        <Search size={15} />
        <input
          placeholder="搜索插件名称、ID、来源或描述…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {search !== "" && (
          <button type="button" className="icon-button" aria-label="清空搜索" onClick={() => setSearch("")}>
            <X size={13} />
          </button>
        )}
      </label>

      {notice !== null && (
        <div className={`plugins-notice ${notice.kind}`} role="status">
          <span>{notice.text}</span>
          <button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}>
            <X size={13} />
          </button>
        </div>
      )}

      {showTrustCard && currentTrust !== undefined && (
        <div className={`plugins-trust-card${currentTrust.trusted ? " trusted" : ""}`}>
          <div className="plugins-trust-card-body">
            <strong>
              {currentTrust.trusted ? "当前工作区已信任（允许运行 .pid/plugins 项目插件）" : "当前工作区尚未信任（已拦截 .pid/plugins 项目插件）"}
            </strong>
            <p>
              工作区：<code>{currentTrust.workspace}</code>
              {currentTrust.pluginIds.length > 0 && ` · 检测到项目插件：${currentTrust.pluginIds.join("、")}`}
            </p>
          </div>
          <div className="workspace-trust-actions">
            {currentTrust.trusted ? (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => trustMutation.mutate(false)}
              >
                <ShieldAlert size={14} />
                <span>撤销信任</span>
              </button>
            ) : (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => trustMutation.mutate(true)}
              >
                <ShieldCheck size={14} />
                <span>信任并启用项目插件</span>
              </button>
            )}
          </div>
        </div>
      )}

      {pluginsQuery.isPending ? (
        <div className="settings-empty">正在从 Harness Host 读取插件列表…</div>
      ) : pluginsQuery.isError ? (
        <div className="plugin-error-box">
          <span>读取插件列表失败：{describeError(pluginsQuery.error)}</span>
          <button type="button" className="plugin-mini-button" onClick={() => void pluginsQuery.refetch()}>
            重试
          </button>
        </div>
      ) : visiblePlugins.length === 0 ? (
        <div className="settings-empty">
          {search !== "" ? "没有匹配搜索条件的插件。" : "当前分类下暂无插件，可点击右上角“安装插件”从本地目录、离线包、Git 或 npm 添加。"}
        </div>
      ) : (
        <div className="plugins-list">
          {visiblePlugins.map((plugin) => {
            const clientError = clientErrors[plugin.id];
            const badge = statusBadge(plugin, clientError);
            const channel = originLabel(plugin);
            const combinedError = plugin.error ?? clientError;
            const switchDisabled = busy || plugin.status === "untrusted";

            return (
              <article
                key={`${plugin.tier}:${plugin.id}`}
                className="plugin-card"
                data-plugin-id={plugin.id}
                data-plugin-tier={plugin.tier}
              >
                <div className="plugin-card-top">
                  <div className="plugin-card-heading">
                    <div className="plugin-card-title-row">
                      <strong>{plugin.name}</strong>
                      <code className="plugin-id-code">{plugin.id}</code>
                      <span className="plugin-version">v{plugin.version}</span>
                    </div>
                    <div className="plugin-badges">
                      <span className={`plugin-badge${plugin.tier === "user" ? " tier-user" : ""}`}>
                        {tierLabel(plugin)}
                      </span>
                      <span className={badge.className}>{badge.label}</span>
                      {plugin.overridesBuiltin && (
                        <span className="plugin-badge tier-override">已覆盖内置默认</span>
                      )}
                      {channel !== null && <span className="plugin-badge">{channel}</span>}
                      {plugin.hasHost && <span className="plugin-badge">后端 Host</span>}
                      {plugin.hasClient && <span className="plugin-badge">前端 UI</span>}
                    </div>
                  </div>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={plugin.enabled}
                    aria-label={`${plugin.enabled ? "停用" : "启用"} ${plugin.name}`}
                    disabled={switchDisabled}
                    className={`settings-switch ${plugin.enabled ? "on" : ""}`}
                    onClick={() => {
                      const ws = scopeWorkspace(plugin);
                      const params = { id: plugin.id, ...(ws === undefined ? {} : { workspace: ws }) };
                      actionMutation.mutate({
                        run: () => (plugin.enabled ? pluginClient.disable(params) : pluginClient.enable(params)),
                        label: `${plugin.enabled ? "已停用" : "已启用"}插件 "${plugin.name}"。`,
                      });
                    }}
                  >
                    <span />
                  </button>
                </div>

                {plugin.description !== undefined && plugin.description !== "" && (
                  <p className="plugin-card-description">{plugin.description}</p>
                )}

                {(plugin.origin?.spec !== undefined || plugin.dir !== undefined) && (
                  <div className="plugin-card-meta">
                    {plugin.origin?.spec !== undefined && (
                      <span>来源：<code>{plugin.origin.spec}</code></span>
                    )}
                    {plugin.dir !== undefined && plugin.origin?.spec !== plugin.dir && (
                      <span>目录：<code>{plugin.dir}</code></span>
                    )}
                  </div>
                )}

                {combinedError !== undefined && (
                  <div className="plugin-error-box" role="alert">
                    <span>
                      <CircleAlert size={13} style={{ display: "inline", verticalAlign: "-2px", marginRight: 6 }} />
                      {combinedError}
                    </span>
                    <button
                      type="button"
                      className="plugin-mini-button"
                      disabled={busy}
                      onClick={() => actionMutation.mutate({
                        run: () => pluginClient.reload({ id: plugin.id, workspace: cwd }),
                        label: `已重新加载插件 "${plugin.name}"。`,
                      })}
                    >
                      重试加载
                    </button>
                  </div>
                )}

                {editingConfigId === plugin.id && (
                  <div className="plugin-config-editor">
                    <label htmlFor={`plugin-config-${plugin.id}`}>
                      插件配置 JSON（保存后自动热应用，持久化于 <code>~/.pid/plugins.json</code>）
                    </label>
                    <textarea
                      id={`plugin-config-${plugin.id}`}
                      value={configDraft}
                      onChange={(event) => setConfigDraft(event.target.value)}
                      spellCheck={false}
                    />
                    <div className="plugin-config-actions">
                      <button
                        type="button"
                        className="plugin-mini-button"
                        onClick={() => setConfigDraft("{}")}
                      >
                        重置为空对象
                      </button>
                      <div className="plugin-card-actions">
                        <button
                          type="button"
                          className="plugin-mini-button"
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
                  </div>
                )}

                <div className="plugin-card-footer">
                  <div>
                    {plugin.tier !== "builtin" && (
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
                              label: `${nextWatch ? "已开启" : "已关闭"} "${plugin.name}" 的文件保存热更新监听。`,
                            });
                          }}
                        />
                        <span>文件变更自动热更新 (HMR)</span>
                      </label>
                    )}
                  </div>

                  <div className="plugin-card-actions">
                    {plugin.dir !== undefined && isTauri && (
                      <button
                        type="button"
                        className="plugin-mini-button"
                        onClick={() => void agent.revealPathInFileManager(plugin.dir ?? "")}
                      >
                        <FolderOpen size={13} />
                        <span>打开目录</span>
                      </button>
                    )}

                    <button
                      type="button"
                      className="plugin-mini-button"
                      disabled={busy}
                      onClick={() => openConfigEditor(plugin)}
                    >
                      <Settings2 size={13} />
                      <span>{editingConfigId === plugin.id ? "收起配置" : "配置"}</span>
                    </button>

                    {plugin.tier !== "builtin" && (
                      <button
                        type="button"
                        className="plugin-mini-button"
                        disabled={busy}
                        onClick={() => actionMutation.mutate({
                          run: () => pluginClient.reload({ id: plugin.id, workspace: cwd }),
                          label: `已热重载插件 "${plugin.name}"。`,
                        })}
                      >
                        <RefreshCw size={13} />
                        <span>热重载</span>
                      </button>
                    )}

                    {canCheckUpdate(plugin) && (
                      <button
                        type="button"
                        className="plugin-mini-button"
                        disabled={busy}
                        onClick={() => actionMutation.mutate({
                          run: () => pluginClient.update({ id: plugin.id }),
                          label: `已完成插件 "${plugin.name}" 的更新与热加载。`,
                        })}
                      >
                        <CloudDownload size={13} />
                        <span>检查更新</span>
                      </button>
                    )}

                    {plugin.removable && (
                      confirmRemoveId === plugin.id ? (
                        <>
                          <button
                            type="button"
                            className="plugin-mini-button danger"
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
                                  ? `已移除自定义覆盖并恢复内置默认 "${plugin.name}"。`
                                  : `已卸载插件 "${plugin.name}"。`,
                              });
                            }}
                          >
                            {plugin.overridesBuiltin ? "确认恢复默认" : "确认卸载"}
                          </button>
                          <button
                            type="button"
                            className="plugin-mini-button"
                            onClick={() => setConfirmRemoveId(null)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="plugin-mini-button danger"
                          disabled={busy}
                          onClick={() => setConfirmRemoveId(plugin.id)}
                        >
                          {plugin.overridesBuiltin ? <RotateCcw size={13} /> : <Trash2 size={13} />}
                          <span>{plugin.overridesBuiltin ? "恢复内置默认" : "卸载"}</span>
                        </button>
                      )
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {installOpen && (
        <InstallPluginDialog
          onClose={() => setInstallOpen(false)}
          onInstalled={(result, label) => {
            setInstallOpen(false);
            applyMutationResult(result, label);
          }}
        />
      )}
    </div>
  );
}

function InstallPluginDialog({
  onClose,
  onInstalled,
}: {
  onClose: () => void;
  onInstalled: (result: PluginMutationResult, label: string) => void;
}) {
  const [channel, setChannel] = useState<PluginInstallChannel>("local");
  const [source, setSource] = useState("");
  const [linkLocal, setLinkLocal] = useState(true);
  const [gitRef, setGitRef] = useState("");
  const [error, setError] = useState("");

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

  return (
    <div className="plugin-install-backdrop" onClick={() => !installMutation.isPending && onClose()}>
      <form
        className="plugin-install-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="安装插件"
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

        <div className="plugin-channel-tabs" role="tablist" aria-label="安装渠道">
          <button
            type="button"
            role="tab"
            aria-selected={channel === "local"}
            className={channel === "local" ? "active" : ""}
            onClick={() => { setChannel("local"); setError(""); }}
          >
            <FolderOpen size={15} />
            <span>本地目录</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={channel === "archive"}
            className={channel === "archive" ? "active" : ""}
            onClick={() => { setChannel("archive"); setError(""); }}
          >
            <Archive size={15} />
            <span>离线压缩包</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={channel === "git"}
            className={channel === "git" ? "active" : ""}
            onClick={() => { setChannel("git"); setError(""); }}
          >
            <GitBranch size={15} />
            <span>Git 仓库</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={channel === "npm"}
            className={channel === "npm" ? "active" : ""}
            onClick={() => { setChannel("npm"); setError(""); }}
          >
            <Package size={15} />
            <span>npm 在线包</span>
          </button>
        </div>

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
                <button type="button" className="secondary-button" onClick={() => void browseSource()}>
                  浏览目录…
                </button>
              </div>
              <small>目录下需包含 <code>package.json</code>，支持直接加载 TypeScript / TSX 源码，无需预构建。</small>
            </div>
            <label className="plugin-watch-toggle">
              <input
                type="checkbox"
                checked={linkLocal}
                onChange={(event) => setLinkLocal(event.target.checked)}
              />
              <span>开发链接模式（推荐：保持原目录引用，修改源码保存后自动热更新）</span>
            </label>
          </>
        )}

        {channel === "archive" && (
          <div className="plugin-install-field">
            <label htmlFor="plugin-install-source">离线压缩包路径</label>
            <div className="plugin-path-picker">
              <input
                id="plugin-install-source"
                placeholder="支持 .tgz / .tar.gz / .zip（npm pack 产物可直接安装）"
                value={source}
                onChange={(event) => setSource(event.target.value)}
              />
              <button type="button" className="secondary-button" onClick={() => void browseSource()}>
                选择文件…
              </button>
            </div>
            <small>自动校验压缩包内路径安全并解压至用户插件目录 <code>~/.pid/plugins/</code>。</small>
          </div>
        )}

        {channel === "git" && (
          <>
            <div className="plugin-install-field">
              <label htmlFor="plugin-install-source">Git 仓库地址</label>
              <input
                id="plugin-install-source"
                placeholder="例如 https://github.com/org/pid-plugin.git 或 github:org/repo"
                value={source}
                onChange={(event) => setSource(event.target.value)}
              />
              <small>使用本机 Git 浅克隆，后续可在插件卡片上点击“检查更新”一键拉取最新提交。</small>
            </div>
            <div className="plugin-install-field">
              <label htmlFor="plugin-install-ref">分支或标签（可选）</label>
              <input
                id="plugin-install-ref"
                placeholder="例如 main 或 v1.2.0，留空使用默认分支"
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
              placeholder="例如 dsh-better-sidebar-csv 或 @scope/pid-plugin@^1.0.0"
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
            <small>由内嵌引擎直接拉取（默认启用 <code>--ignore-scripts</code> 安全隔离），无需本机安装 Node.js。</small>
          </div>
        )}

        {error !== "" && (
          <div className="plugin-error-box" role="alert">
            <span>{error}</span>
          </div>
        )}

        <small className="setting-value-muted">
          全局插件独立保存在用户数据目录 <code>~/.pid/plugins</code> 与 <code>~/.pid/plugins.json</code> 中，升级 PI-Desktop 安装包后仍保持生效。
        </small>

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
            {installMutation.isPending ? <LoaderCircle size={14} className="animate-spin" /> : <Plus size={14} />}
            <span>{installMutation.isPending ? "正在安装…" : "立即安装并加载"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
