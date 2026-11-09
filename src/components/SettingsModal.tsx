import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import {
  Boxes,
  Check,
  ChevronDown,
  Cpu,
  Monitor,
  Moon,
  Palette,
  SlidersHorizontal,
  Sun,
  X,
} from "lucide-react";
import { agent } from "../lib/agent";
import { BUILTIN_APPEARANCE_CATALOG, type AppearanceCatalog, type AppearanceThemeDefinition } from "../lib/appearanceCatalog";
import { queryKeys } from "../lib/queries";
import { ModelsPage } from "./ModelsPage";
import { PluginsSettingsPanel } from "./PluginsSettingsPanel";
import type { AppSettings } from "../types";

export type SettingsPage = "general" | "appearance" | "providers" | "plugins";

export const DEFAULTS: AppSettings = {
  provider: "",
  model: "",
  thinkingLevel: "medium",
  agentMode: "agent",
  permissionMode: "ask",
  alwaysConfirmShell: true,
  blockWriteOutsideWorkspace: true,
  shellAllowPrefixes: "",
  toolRules: [],
  defaultTaskEnvironment: "local",
  showThinking: true,
  transcriptDensity: "normal",
  autoConnect: false,
  followUpBehavior: "steer",
  requireCtrlEnter: false,
  preventSleep: true,
  language: "zh-CN",
  defaultFileOpener: "system",
  terminalShell: "PowerShell",
  terminalShellArgs: "",
  terminalOutput: "summary",
  notificationsEnabled: true,
  notifyOnCompletion: true,
  notifyOnApproval: true,
  notifyOnlyWhenUnfocused: true,
  theme: "light",
  accentColor: "#006ee4",
  backgroundColor: "#fcfcfc",
  foregroundColor: "#111112",
  uiFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  codeFont: 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  uiScale: 100,
  messageFontSize: 15,
  personality: "pragmatic",
  customInstructions: "",
  suggestedPrompts: false,
  memoryEnabled: true,
  projectMemoryEnabled: true,
  planTrackingEnabled: true,
  hooksEnabled: false,
  hooksInheritEnvironment: false,
  hooks: [],
  subagentsEnabled: true,
  subagentMaxConcurrency: 3,
  browserEnabled: true,
  browserHeadless: true,
  browserProfileMode: "temporary",
  browserConfirmActions: true,
  browserExecutable: "",
  computerEnabled: true,
  computerConfirmActions: true,
  sandboxEnabled: false,
  mcpEnabled: true,
  mcpConfirmTools: true,
  mcpServers: [],
  reviewDelivery: "inline",
  branchPrefix: "pi/",
  allowForcePush: false,
  commitMessageInstructions: "",
  logLevel: "info",
  shortcutNewChat: "Ctrl+Shift+N",
  shortcutSettings: "Ctrl+,",
  shortcutTerminal: "Ctrl+Shift+T",
  shortcutChanges: "Ctrl+Shift+G",
  shortcutToggleSidebar: "Ctrl+B",
  archivedSessions: [],
};

const NAV_ITEMS: ReadonlyArray<{
  id: SettingsPage;
  label: string;
  heading: string;
  subtitle: string;
  icon: typeof SlidersHorizontal;
}> = [
  { id: "general", label: "通用", heading: "通用", subtitle: "管理对话发送习惯、外部代码编辑器与桌面通知偏好", icon: SlidersHorizontal },
  { id: "appearance", label: "外观", heading: "外观", subtitle: "定制工作台明暗主题、阅读排版字号与窗口显示比例", icon: Palette },
  { id: "providers", label: "模型", heading: "模型与密钥", subtitle: "配置默认推理偏好，按需展开服务商填写本机加密 API Key", icon: Cpu },
  { id: "plugins", label: "插件", heading: "连接器与插件", subtitle: "连接 MCP 工具服务、智能体核心能力与本地热更新扩展模块", icon: Boxes },
];

const NAV_SPRING = { type: "spring" as const, stiffness: 520, damping: 38, mass: 0.7 };

type Update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

export function SettingsModal({
  settings,
  cwd,
  appearanceCatalog = BUILTIN_APPEARANCE_CATALOG,
  onSave,
  onClose,
  initialPage = "general",
}: {
  settings: AppSettings | null;
  cwd: string;
  appearanceCatalog?: AppearanceCatalog;
  onSave: (settings: AppSettings) => Promise<void> | void;
  onClose: () => void;
  initialPage?: SettingsPage;
}) {
  const [form, setForm] = useState<AppSettings>({ ...DEFAULTS, ...settings, language: "zh-CN" });
  const [active, setActive] = useState<SettingsPage>(initialPage);
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saving" | "saved" | "error">("idle");
  const editedRef = useRef(false);
  const pendingSaveRef = useRef<AppSettings | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const saveStatusTimerRef = useRef<number | null>(null);
  const inFlightSaveRef = useRef<Promise<void> | null>(null);
  const pageScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (pageScrollRef.current) pageScrollRef.current.scrollTop = 0;
  }, [active]);

  useEffect(() => {
    if (!editedRef.current) setForm({ ...DEFAULTS, ...settings, language: "zh-CN" });
  }, [settings]);

  const [requestedPage, setRequestedPage] = useState(initialPage);
  if (requestedPage !== initialPage) {
    setRequestedPage(initialPage);
    setActive(initialPage);
  }

  useEffect(() => () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    if (saveStatusTimerRef.current !== null) window.clearTimeout(saveStatusTimerRef.current);
  }, []);

  const flushSettings = useCallback(async () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (inFlightSaveRef.current) await inFlightSaveRef.current;
    while (pendingSaveRef.current) {
      const next = pendingSaveRef.current;
      pendingSaveRef.current = null;
      setSaveState("saving");
      const task = Promise.resolve(onSave({ ...next, language: "zh-CN" }))
        .then(() => {
          if (!pendingSaveRef.current) editedRef.current = false;
          setSaveState("saved");
          if (saveStatusTimerRef.current !== null) window.clearTimeout(saveStatusTimerRef.current);
          saveStatusTimerRef.current = window.setTimeout(() => setSaveState("idle"), 1200);
        })
        .catch(() => setSaveState("error"));
      inFlightSaveRef.current = task;
      await task;
      inFlightSaveRef.current = null;
    }
  }, [onSave]);

  const scheduleSave = useCallback((next: AppSettings) => {
    pendingSaveRef.current = next;
    setSaveState("pending");
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void flushSettings(), 260);
  }, [flushSettings]);

  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setForm((current) => {
      const next = { ...current, [key]: value };
      editedRef.current = true;
      scheduleSave(next);
      return next;
    });
  }, [scheduleSave]);

  const closeSettings = useCallback(() => {
    void flushSettings().finally(onClose);
  }, [flushSettings, onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (document.querySelector("[data-escape-layer]")) return;
        event.preventDefault();
        closeSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSettings]);

  const activeMeta = NAV_ITEMS.find((item) => item.id === active) ?? NAV_ITEMS[0];
  const isWideGrid = active === "plugins";

  return (
    <motion.div
      className="settings-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeSettings();
      }}
    >
      <motion.div
        className="settings-center"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        initial={{ opacity: 0, scale: 0.965, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.975, y: 6 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      >
        <aside className="settings-navigation">
          <div className="settings-modal-brand">设置</div>

          <LayoutGroup id="settings-sidebar-nav">
            <nav className="settings-nav-scroll" aria-label="设置分类">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = active === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={isActive ? "active" : ""}
                    onClick={() => setActive(item.id)}
                  >
                    {isActive && (
                      <motion.span
                        layoutId="settings-nav-pill"
                        className="settings-nav-pill"
                        transition={NAV_SPRING}
                      />
                    )}
                    <Icon size={15.5} strokeWidth={1.85} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </LayoutGroup>

          <div className="settings-nav-footer">
            <span className="settings-nav-app">Pi Desktop · v0.3.0</span>
            <kbd>Ctrl+,</kbd>
          </div>
        </aside>

        <main className="settings-content">
          <header className="settings-stage-header">
            <div className="settings-header-titles">
              <h1>{activeMeta.heading}</h1>
              <span className={`settings-save-status ${saveState}`} aria-live="polite">
                {saveState === "pending" || saveState === "saving"
                  ? "正在保存…"
                  : saveState === "saved"
                    ? "已保存"
                    : saveState === "error"
                      ? "保存失败"
                      : ""}
              </span>
            </div>
            <button
              type="button"
              className="settings-close-circle"
              onClick={closeSettings}
              title="返回应用 (Esc)"
              aria-label="返回应用"
            >
              <X size={15} strokeWidth={2} />
            </button>
          </header>

          <div ref={pageScrollRef} className="settings-page-scroll">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={active}
                className={`settings-page ${isWideGrid ? "is-wide" : ""}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
              >
                <p className="settings-header-sub">{activeMeta.subtitle}</p>
                {active === "general" && <GeneralPage form={form} update={update} />}
                {active === "appearance" && <AppearancePage form={form} update={update} catalog={appearanceCatalog} />}
                {active === "providers" && <ModelsPage form={form} update={update} />}
                {active === "plugins" && <PluginsSettingsPanel cwd={cwd} form={form} onSyncAppSetting={update} />}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </motion.div>
    </motion.div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-layered-section">
      <h2>{title}</h2>
      <div className="settings-soft-card">{children}</div>
    </section>
  );
}

function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <span>
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </span>
      <div>{children}</div>
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`settings-switch ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function SettingsSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
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

  const current = options.find((opt) => opt.value === value)?.label ?? value;

  return (
    <div className="settings-custom-select" ref={rootRef}>
      <button
        type="button"
        className="settings-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current}</span>
        <ChevronDown size={14} strokeWidth={1.8} />
      </button>
      {open && (
        <div className="settings-select-popover" role="listbox" data-escape-layer>
          {options.map((opt) => {
            const selected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={selected}
                className={selected ? "selected" : ""}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span>{opt.label}</span>
                {selected && <Check size={13} strokeWidth={2.2} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GeneralPage({ form, update }: { form: AppSettings; update: Update }) {
  const inTauri = "__TAURI_INTERNALS__" in window;
  const editorsQuery = useQuery({
    queryKey: queryKeys.workspaceEditors(),
    queryFn: () => agent.listWorkspaceEditors(),
    enabled: inTauri,
    staleTime: Infinity,
  });
  const editors = editorsQuery.data ?? [];
  const savedMissing = form.defaultFileOpener !== "system" && !editors.some((editor) => editor.id === form.defaultFileOpener);

  const editorOptions = [
    { value: "system", label: "自动选择已安装编辑器" },
    ...editors.map((editor) => ({ value: editor.id, label: editor.name })),
    ...(savedMissing ? [{ value: form.defaultFileOpener, label: `${form.defaultFileOpener}（未检测到）` }] : []),
  ];

  return (
    <>
      <Section title="对话与输入">
        <Row title="使用 Ctrl + Enter 发送消息" description="开启后按 Enter 换行，按 Ctrl + Enter 提交对话指令">
          <Switch
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
          <Switch
            label="任务运行期间防止系统休眠"
            checked={form.preventSleep}
            onChange={(value) => update("preventSleep", value)}
          />
        </Row>
      </Section>

      <Section title="工作区与系统">
        <Row title="默认外部编辑器" description="点击工作区文件跳转源码行号或外部打开项目时优先调用的编辑器">
          <SettingsSelect
            label="默认外部编辑器"
            value={form.defaultFileOpener}
            options={editorOptions}
            onChange={(next) => update("defaultFileOpener", next)}
          />
        </Row>
        <Row title="桌面系统通知" description="窗口处于后台时，在任务执行完毕或需要工具授权时推送通知">
          <Switch
            label="桌面通知"
            checked={form.notificationsEnabled}
            onChange={(value) => update("notificationsEnabled", value)}
          />
        </Row>
      </Section>
    </>
  );
}

function ThemeModeIcon({ theme }: { theme: AppearanceThemeDefinition }) {
  if (theme.id === "system") return <Monitor size={13} strokeWidth={1.85} />;
  if (theme.mode === "dark") return <Moon size={13} strokeWidth={1.85} />;
  return <Sun size={13} strokeWidth={1.85} />;
}

function MiniWindowGraphic({ mode }: { mode: "light" | "dark" }) {
  return (
    <div className={`theme-preview-window is-${mode}`} aria-hidden="true">
      <div className="tp-sidebar">
        <span className="tp-dot" />
        <span className="tp-line" />
        <span className="tp-line" style={{ width: "64%" }} />
      </div>
      <div className="tp-stage">
        <span className="tp-bubble-user" />
        <span className="tp-bubble-agent" />
        <span className="tp-composer" />
      </div>
    </div>
  );
}

function ThemePreviewIllustration({ theme }: { theme: AppearanceThemeDefinition }) {
  if (theme.id === "system" || theme.mode === "system") {
    return (
      <div className="theme-preview-system-split" aria-hidden="true">
        <MiniWindowGraphic mode="light" />
        <MiniWindowGraphic mode="dark" />
      </div>
    );
  }
  return <MiniWindowGraphic mode={theme.mode === "dark" ? "dark" : "light"} />;
}

function AppearancePage({
  form,
  update,
  catalog,
}: {
  form: AppSettings;
  update: Update;
  catalog: AppearanceCatalog;
}) {
  return (
    <>
      <section className="settings-layered-section">
        <h2>主题模式</h2>
        <div className="theme-mode-grid" role="radiogroup" aria-label="主题模式">
          {catalog.themes.map((theme) => {
            const selected = form.theme === theme.id;
            return (
              <button
                key={theme.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`theme-mode-card ${selected ? "active" : ""}`}
                onClick={() => update("theme", theme.id)}
              >
                <ThemePreviewIllustration theme={theme} />
                <div className="theme-mode-footer">
                  <span className="theme-mode-label-group">
                    <span className="theme-mode-icon" aria-hidden="true">
                      <ThemeModeIcon theme={theme} />
                    </span>
                    <span className="theme-mode-label">{theme.label}</span>
                  </span>
                  {selected && (
                    <span className="theme-mode-check" aria-hidden="true">
                      <Check size={10} strokeWidth={2.6} />
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <Section title="排版与缩放">
        <Row title="对话阅读字号" description="消息正文、列表与代码片段的基准字号">
          <LayoutGroup id="appearance-fontsize-seg">
            <div className="settings-segmented" role="radiogroup" aria-label="对话字号">
              {[13, 14, 15, 16, 18].map((size) => {
                const active = form.messageFontSize === size;
                return (
                  <button
                    key={size}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={active ? "active" : ""}
                    onClick={() => update("messageFontSize", size)}
                  >
                    {active && <motion.span layoutId="fontsize-seg-thumb" className="settings-segmented-thumb" transition={NAV_SPRING} />}
                    <span>{size}px</span>
                  </button>
                );
              })}
            </div>
          </LayoutGroup>
        </Row>
        <Row title="全局界面缩放" description="按比例缩放整个工作台窗口与控件尺寸">
          <LayoutGroup id="appearance-uiscale-seg">
            <div className="settings-segmented" role="radiogroup" aria-label="界面缩放">
              {[90, 100, 110, 125].map((scale) => {
                const active = form.uiScale === scale;
                return (
                  <button
                    key={scale}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={active ? "active" : ""}
                    onClick={() => update("uiScale", scale)}
                  >
                    {active && <motion.span layoutId="uiscale-seg-thumb" className="settings-segmented-thumb" transition={NAV_SPRING} />}
                    <span>{scale}%</span>
                  </button>
                );
              })}
            </div>
          </LayoutGroup>
        </Row>
        <Row title="消息密度" description="控制对话气泡与工具调用卡片之间的纵向留白节奏">
          <LayoutGroup id="appearance-density-seg">
            <div className="settings-segmented" role="radiogroup" aria-label="消息密度">
              {([
                ["summary", "精简"],
                ["normal", "标准"],
                ["verbose", "详细"],
              ] as const).map(([val, label]) => {
                const active = form.transcriptDensity === val;
                return (
                  <button
                    key={val}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={active ? "active" : ""}
                    onClick={() => update("transcriptDensity", val)}
                  >
                    {active && <motion.span layoutId="density-seg-thumb" className="settings-segmented-thumb" transition={NAV_SPRING} />}
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </LayoutGroup>
        </Row>
        <Row title="展示推理思考过程" description="控制是否在回复上方展示可折叠思考链（关闭后隐藏思考内容；若需模型跳过深度推理耗时，请将推理强度设为「关」）">
          <Switch
            label="显示思考过程"
            checked={form.showThinking}
            onChange={(value) => update("showThinking", value)}
          />
        </Row>
      </Section>
    </>
  );
}
