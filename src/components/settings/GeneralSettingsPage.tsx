import { useQuery } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { LayoutGroup, motion } from "motion/react";
import { agent } from "../../lib/agent";
import { queryKeys } from "../../lib/queries";
import type { AppSettings } from "../../types";
import { NAV_SPRING, Row, Section, SettingsSelect, SettingsSwitch, type Update } from "./settingsPrimitives";

export function GeneralPage({ form, update }: { form: AppSettings; update: Update }) {
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const editorsQuery = useQuery({
    queryKey: queryKeys.workspaceEditors(),
    queryFn: () => agent.listWorkspaceEditors(),
    enabled: inTauri,
    staleTime: Infinity,
  });
  const defaultWorkspaceQuery = useQuery({
    queryKey: ["default-workspace-dir", form.defaultWorkspace ?? ""],
    queryFn: () => agent.quickChatDir(),
    enabled: inTauri,
    staleTime: Infinity,
  });
  const editors = editorsQuery.data ?? [];
  const savedMissing = form.defaultFileOpener !== "system" && !editors.some((editor) => editor.id === form.defaultFileOpener);
  const customDefaultWorkspace = form.defaultWorkspace?.trim() ?? "";
  const resolvedDefaultWorkspace = customDefaultWorkspace || defaultWorkspaceQuery.data || "";

  const pickDefaultWorkspace = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "选择默认工作目录",
      ...(resolvedDefaultWorkspace ? { defaultPath: resolvedDefaultWorkspace } : {}),
    });
    if (typeof selected === "string" && selected.trim()) {
      update("defaultWorkspace", selected.trim());
    }
  };

  const editorOptions = [
    { value: "system", label: "自动选择已安装编辑器" },
    ...editors.map((editor) => ({ value: editor.id, label: editor.name })),
    ...(savedMissing ? [{ value: form.defaultFileOpener, label: `${form.defaultFileOpener}（未检测到）` }] : []),
  ];

  return (
    <>
      <Section title="对话与输入">
        <Row title="使用 Ctrl + Enter 发送消息" description="开启后按 Enter 换行、Ctrl + Enter 发送；关闭时按 Enter 发送、Shift + Enter 或 Ctrl + Enter 换行">
          <SettingsSwitch
            label="使用 Ctrl+Enter 发送"
            checked={form.requireCtrlEnter}
            onChange={(value) => update("requireCtrlEnter", value)}
          />
        </Row>
        <Row title="回复生成期间的发送策略" description="智能体正在流式输出时，继续发送新消息的处理方式">
          <LayoutGroup id="general-followup-seg">
            <div className="settings-segmented" role="radiogroup" aria-label="运行中发送方式">
              {([
                ["steer", "立即引导"],
                ["followUp", "排队下一轮"],
              ] as const).map(([value, label]) => {
                const active = form.followUpBehavior === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={active ? "active" : ""}
                    onClick={() => update("followUpBehavior", value)}
                  >
                    {active && <motion.span layoutId="followup-seg-thumb" className="settings-segmented-thumb" transition={NAV_SPRING} />}
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </LayoutGroup>
        </Row>
        <Row title="任务运行期间防止系统休眠" description="后台执行长耗时编码或自动化任务时保持本机唤醒状态">
          <SettingsSwitch
            label="任务运行期间防止系统休眠"
            checked={form.preventSleep}
            onChange={(value) => update("preventSleep", value)}
          />
        </Row>
      </Section>

      <Section title="工作区与系统">
        <Row title="默认工作目录" description="新建会话未选项目或创建通用定时任务时使用的默认目录">
          <div className="settings-default-workspace-control">
            <code className="settings-workspace-path" title={resolvedDefaultWorkspace || "内置默认工作目录"}>
              {customDefaultWorkspace || (resolvedDefaultWorkspace ? `${resolvedDefaultWorkspace}（内置默认）` : "内置默认工作目录")}
            </code>
            <div className="settings-workspace-actions">
              {inTauri && resolvedDefaultWorkspace && (
                <button
                  type="button"
                  className="secondary-button settings-inline-btn"
                  onClick={() => void agent.openWorkspaceInFileManager(resolvedDefaultWorkspace)}
                >
                  打开
                </button>
              )}
              {inTauri && (
                <button
                  type="button"
                  className="secondary-button settings-inline-btn"
                  onClick={() => void pickDefaultWorkspace()}
                >
                  更改…
                </button>
              )}
              {Boolean(customDefaultWorkspace) && (
                <button
                  type="button"
                  className="secondary-button settings-inline-btn"
                  onClick={() => update("defaultWorkspace", "")}
                >
                  恢复默认
                </button>
              )}
            </div>
          </div>
        </Row>
        <Row title="默认外部编辑器" description="点击工作区文件跳转源码行号或外部打开项目时优先调用的编辑器">
          <SettingsSelect
            label="默认外部编辑器"
            value={form.defaultFileOpener}
            options={editorOptions}
            onChange={(next) => update("defaultFileOpener", next)}
          />
        </Row>
        <Row title="桌面系统通知" description="窗口处于后台时，在任务执行完毕或需要工具授权时推送通知">
          <SettingsSwitch
            label="桌面通知"
            checked={form.notificationsEnabled}
            onChange={(value) => update("notificationsEnabled", value)}
          />
        </Row>
      </Section>
    </>
  );
}
