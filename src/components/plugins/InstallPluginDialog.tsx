import { useEffect, useState, type FormEvent } from "react";
import { LayoutGroup, motion } from "motion/react";
import { useMutation } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { PluginInstallChannel, PluginMutationResult } from "@qianji/protocol";
import { Archive, FolderOpen, GitBranch, LoaderCircle, Package, Plus, X } from "lucide-react";
import { describeError } from "../../lib/errors";
import { pluginClient } from "../../lib/pluginClient";
import { PILL_SPRING } from "./pluginHelpers";

export interface InstallPluginDialogProps {
  isTauri: boolean;
  initialChannel?: PluginInstallChannel;
  onClose: () => void;
  onInstalled: (result: PluginMutationResult, label: string) => void;
}

export function InstallPluginDialog({
  isTauri,
  initialChannel = "local",
  onClose,
  onInstalled,
}: InstallPluginDialogProps) {
  const [channel, setChannel] = useState<PluginInstallChannel>(initialChannel);
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !installMutation.isPending) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [installMutation.isPending, onClose]);

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
                  placeholder="例如 D:\plugins\my-qianji-plugin"
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
            <small>自动校验路径安全并解压至 <code>~/.qianji/plugins/</code>。</small>
          </div>
        )}

        {channel === "git" && (
          <>
            <div className="plugin-install-field">
              <label htmlFor="plugin-install-source">Git 仓库地址</label>
              <input
                id="plugin-install-source"
                placeholder="例如 https://github.com/org/qianji-plugin.git"
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
              placeholder="例如 qianji-plugin-csv 或 @scope/qianji-plugin@^1.0.0"
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
