import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { AppSettings, DesktopHookConfig } from "../../types";
import { HOOK_EVENT_LABELS, type Notice } from "./pluginHelpers";

export interface HooksCapabilityDrawerProps {
  form: AppSettings;
  onSyncAppSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onNotify: (notice: Notice) => void;
}

export function HooksCapabilityDrawer({
  form,
  onSyncAppSetting,
  onNotify,
}: HooksCapabilityDrawerProps) {
  const [hookEvent, setHookEvent] = useState<DesktopHookConfig["event"]>("tool_call");
  const [hookCmd, setHookCmd] = useState("");
  const [hookBlocking, setHookBlocking] = useState(false);

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
