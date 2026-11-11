import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { McpServerStatus, PluginInfo } from "@qianji/protocol";
import type { AppSettings } from "../../types";
import { HooksCapabilityDrawer } from "./HooksCapabilityDrawer";
import { McpCapabilityDrawer } from "./McpCapabilityDrawer";
import type { Notice } from "./pluginHelpers";

export interface CoreCapabilityDrawerProps {
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
}

export function CoreCapabilityDrawer({
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
}: CoreCapabilityDrawerProps) {
  if (plugin.id === "mcp") {
    return (
      <McpCapabilityDrawer
        cwd={cwd}
        form={form}
        onSyncAppSetting={onSyncAppSetting}
        mcpStatuses={mcpStatuses}
        mcpReconnecting={mcpReconnecting}
        onReconnectMcp={onReconnectMcp}
        onMcpServersUpdated={onMcpServersUpdated}
        onNotify={onNotify}
      />
    );
  }

  if (plugin.id === "hooks") {
    return (
      <HooksCapabilityDrawer
        form={form}
        onSyncAppSetting={onSyncAppSetting}
        onNotify={onNotify}
      />
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
            <small>持久化模式将保留登录态至 ~/.qianji/browser-profile，方便复用已登录站点</small>
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
            <strong>全局跨会话长期记忆 (~/.qianji/memory.md)</strong>
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
