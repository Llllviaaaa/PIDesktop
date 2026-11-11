import type { PluginInstallChannel, PluginMutationResult } from "@qianji/protocol";
import { FolderOpen, RefreshCw } from "lucide-react";
import { agent } from "../../lib/agent";
import { pluginClient } from "../../lib/pluginClient";
import type { PluginFilter } from "./pluginHelpers";

export interface PluginsEmptyHubProps {
  cwd: string;
  isTauri: boolean;
  busy: boolean;
  isSearching: boolean;
  filter: PluginFilter;
  onOpenInstall: (channel: PluginInstallChannel) => void;
  onRunTask: (task: { run: () => Promise<PluginMutationResult>; label: string }) => void;
}

export function PluginsEmptyHub({
  cwd,
  isTauri,
  busy,
  isSearching,
  filter,
  onOpenInstall,
  onRunTask,
}: PluginsEmptyHubProps) {
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
            onClick={() => onOpenInstall("local")}
          >
            <strong>本地目录热链开发</strong>
            <span>直接挂载包含 package.json 的源码目录，保存代码后自动 HMR 热重载。</span>
            <em>选择本地目录 →</em>
          </button>

          <button
            type="button"
            className="plugins-quickstart-card"
            onClick={() => onOpenInstall("npm")}
          >
            <strong>npm / Git 仓库拉取</strong>
            <span>从 npm 注册表或 GitHub 仓库拉取社区扩展，默认启用脚本隔离保护。</span>
            <em>填写包名或仓库 →</em>
          </button>

          <button
            type="button"
            className="plugins-quickstart-card"
            onClick={() => onOpenInstall("archive")}
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
    const wsDirDisplay = cwd.trim() ? `${cwd.replace(/[\\/]+$/, "")}/.qianji/plugins` : ".qianji/plugins";
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
              onClick={() => onRunTask({
                run: () => pluginClient.reload({ workspace: cwd }),
                label: "已重新扫描当前工作区 .qianji/plugins 目录。",
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
            <small>在仓库下新建 .qianji/plugins/my-tool 并写入含 qianji 字段的 package.json。</small>
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
}
