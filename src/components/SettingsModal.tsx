import { useEffect, useRef, useState, type ReactNode } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Archive,
  BarChart3,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileCode2,
  FileDown,
  FolderGit2,
  GitBranch,
  Globe2,
  Keyboard,
  KeyRound,
  Network,
  MonitorCog,
  Palette,
  Plus,
  Pencil,
  RefreshCw,
  Search,
  Save,
  ServerCog,
  Settings2,
  Shield,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
  Trash2,
  Workflow,
  Undo2,
  UserRound,
  ArrowDown,
  ArrowUp,
  X,
} from "lucide-react";
import { pi } from "../lib/pi";
import type {
  AppSettings,
  ModelProviderConfig,
  ModelProviderInput,
  ModelProviderModel,
  ResourceItem,
  SessionInfo,
  UsageSummary,
  WorktreeInfo,
} from "../types";

export type SettingsPage =
  | "general"
  | "appearance"
  | "agent"
  | "providers"
  | "personalization"
  | "shortcuts"
  | "archived"
  | "usage"
  | "skills"
  | "mcp"
  | "browser"
  | "computer"
  | "review"
  | "environment"
  | "hooks"
  | "git"
  | "worktrees"
  | "debug";

const DEFAULTS: AppSettings = {
  piBinary: "pi",
  provider: "",
  model: "",
  thinkingLevel: "medium",
  sessionDir: "",
  agentMode: "agent",
  permissionMode: "ask",
  alwaysConfirmShell: true,
  blockWriteOutsideWorkspace: true,
  shellAllowPrefixes: "",
  toolRules: [],
  defaultTaskEnvironment: "local",
  showThinking: true,
  autoConnect: false,
  followUpBehavior: "steer",
  requireCtrlEnter: false,
  preventSleep: true,
  language: "zh-CN",
  defaultFileOpener: "system",
  terminalShell: "PowerShell",
  terminalOutput: "summary",
  notificationsEnabled: true,
  notifyOnCompletion: true,
  notifyOnApproval: true,
  notifyOnlyWhenUnfocused: true,
  theme: "light",
  accentColor: "#ffffff",
  backgroundColor: "#0f0f10",
  foregroundColor: "#f5f5f5",
  uiFont: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  codeFont: 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  uiScale: 100,
  personality: "pragmatic",
  customInstructions: "",
  suggestedPrompts: true,
  memoryEnabled: true,
  planTrackingEnabled: true,
  hooksEnabled: false,
  hooksInheritEnvironment: false,
  hooks: [],
  subagentsEnabled: true,
  subagentMaxConcurrency: 3,
  browserEnabled: true,
  browserHeadless: true,
  browserConfirmActions: true,
  browserExecutable: "",
  computerEnabled: true,
  computerConfirmActions: true,
  mcpEnabled: true,
  mcpConfirmTools: true,
  mcpServers: [],
  reviewDelivery: "inline",
  branchPrefix: "pi/",
  allowForcePush: false,
  commitMessageInstructions: "",
  pullRequestInstructions: "",
  logLevel: "info",
  shortcutNewChat: "Ctrl+Shift+N",
  shortcutSettings: "Ctrl+,",
  shortcutTerminal: "Ctrl+Shift+T",
  shortcutChanges: "Ctrl+Shift+G",
  shortcutToggleSidebar: "Ctrl+B",
  archivedSessions: [],
};

const NAVIGATION: Array<{ label: string; items: Array<{ id: SettingsPage; label: string; icon: typeof Settings2; keywords: string }> }> = [
  {
    label: "个人",
    items: [
      { id: "general", label: "常规", icon: Settings2, keywords: "语言 启动 后续 文件 通知 language startup notifications" },
      { id: "appearance", label: "外观", icon: Palette, keywords: "主题 黑色 白色 字体 缩放 theme color font" },
      { id: "agent", label: "配置", icon: Bot, keywords: "模型 提供商 推理 权限 审批 沙箱 model provider approval sandbox" },
      { id: "personalization", label: "个性化", icon: UserRound, keywords: "人格 指令 记忆 提示 personality instructions memory" },
      { id: "shortcuts", label: "键盘快捷键", icon: Keyboard, keywords: "按键 绑定 命令 keys bindings" },
      { id: "usage", label: "使用情况和计费", icon: BarChart3, keywords: "token 费用 统计 活动 cost statistics" },
      { id: "debug", label: "调试", icon: SlidersHorizontal, keywords: "程序 会话 日志 诊断 binary logging" },
    ],
  },
  {
    label: "集成",
    items: [
      { id: "providers", label: "模型提供商", icon: ServerCog, keywords: "模型 提供商 API 密钥 endpoint provider model key" },
      { id: "skills", label: "技能", icon: Sparkles, keywords: "技能 skill instructions" },
      { id: "mcp", label: "MCP 服务器", icon: Network, keywords: "mcp tools stdio http server 工具 服务器" },
      { id: "browser", label: "浏览器", icon: Globe2, keywords: "edge chrome chromium 网页 自动化 截图 browser web automation screenshot" },
      { id: "computer", label: "电脑操控", icon: MonitorCog, keywords: "windows 鼠标 键盘 窗口 截图 computer use mouse keyboard" },
    ],
  },
  {
    label: "编码",
    items: [
      { id: "review", label: "代码审查", icon: Shield, keywords: "review 检查 审阅 delivery" },
      { id: "git", label: "Git", icon: FolderGit2, keywords: "branches commit pull request force push" },
      { id: "environment", label: "环境", icon: TerminalSquare, keywords: "shell 输出 命令 local worktree output commands" },
      { id: "hooks", label: "Hooks", icon: Workflow, keywords: "hooks lifecycle 自动 命令 tool session event" },
      { id: "worktrees", label: "Worktrees", icon: GitBranch, keywords: "并行 隔离 本地 检出 parallel isolated" },
    ],
  },
  {
    label: "已归档",
    items: [
      { id: "archived", label: "已归档的聊天", icon: Archive, keywords: "会话 任务 恢复 删除 历史 sessions restore" },
    ],
  },
];

export function SettingsModal({
  settings,
  cwd,
  onSave,
  onClose,
  initialPage = "general",
}: {
  settings: AppSettings | null;
  cwd: string;
  onSave: (settings: AppSettings) => Promise<void> | void;
  onClose: () => void;
  initialPage?: SettingsPage;
}) {
  const [form, setForm] = useState<AppSettings>({ ...DEFAULTS, ...settings, language: "zh-CN" });
  const [active, setActive] = useState<SettingsPage>(initialPage);
  const [query, setQuery] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saving" | "saved" | "error">("idle");
  const [resources, setResources] = useState<ResourceItem[]>([]);
  const [archived, setArchived] = useState<SessionInfo[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [providers, setProviders] = useState<ModelProviderConfig[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState("");
  const [memoryText, setMemoryText] = useState("");
  const [memoryState, setMemoryState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [loadingData, setLoadingData] = useState(true);
  const editedRef = useRef(false);
  const pendingSaveRef = useRef<AppSettings | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const saveStatusTimerRef = useRef<number | null>(null);
  const inFlightSaveRef = useRef<Promise<void> | null>(null);
  const isTauri = "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    if (!editedRef.current) setForm({ ...DEFAULTS, ...settings, language: "zh-CN" });
  }, [settings]);
  useEffect(() => setActive(initialPage), [initialPage]);
  useEffect(() => () => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    if (saveStatusTimerRef.current !== null) window.clearTimeout(saveStatusTimerRef.current);
  }, []);
  useEffect(() => {
    if (!isTauri) {
      setLoadingData(false);
      setProvidersLoading(false);
      return;
    }
    let cancelled = false;
    setLoadingData(true);
    void Promise.all([
      pi.listArchivedSessions(),
      pi.listResources(cwd),
      cwd ? pi.listWorktrees(cwd).catch(() => []) : Promise.resolve([]),
      pi.getLocalMemory().catch(() => ""),
    ]).then(([nextArchived, nextResources, nextWorktrees, nextMemory]) => {
      if (cancelled) return;
      setArchived(nextArchived);
      setForm((current) => ({ ...current, archivedSessions: nextArchived.map((session) => session.file) }));
      setResources(nextResources);
      setWorktrees(nextWorktrees);
      setMemoryText(nextMemory);
      setLoadingData(false);
    });
    void pi.usageSummary().then((summary) => { if (!cancelled) setUsage(summary); });
    void pi.listModelProviders()
      .then((items) => { if (!cancelled) { setProviders(items); setProvidersError(""); } })
      .catch((error) => { if (!cancelled) setProvidersError(String(error)); })
      .finally(() => { if (!cancelled) setProvidersLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, isTauri]);

  const normalizeSettings = (value: AppSettings): AppSettings => {
    const dark = value.theme !== "light";
    return {
      ...value,
      language: "zh-CN",
      accentColor: dark ? "#ffffff" : "#111111",
      backgroundColor: dark ? "#0f0f10" : "#ffffff",
      foregroundColor: dark ? "#f5f5f5" : "#111111",
    };
  };

  async function flushSettings() {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (inFlightSaveRef.current) await inFlightSaveRef.current;
    const next = pendingSaveRef.current;
    if (!next) return;
    pendingSaveRef.current = null;
    setSaveState("saving");
    const task = Promise.resolve(onSave(normalizeSettings(next)))
      .then(() => {
        if (!pendingSaveRef.current) {
          editedRef.current = false;
          setForm((current) => maskMcpCredentials(current));
        }
        setSaveState("saved");
        if (saveStatusTimerRef.current !== null) window.clearTimeout(saveStatusTimerRef.current);
        saveStatusTimerRef.current = window.setTimeout(() => setSaveState("idle"), 1400);
      })
      .catch(() => setSaveState("error"));
    inFlightSaveRef.current = task;
    await task;
    inFlightSaveRef.current = null;
    if (pendingSaveRef.current) await flushSettings();
  }

  function scheduleSave(next: AppSettings) {
    pendingSaveRef.current = next;
    setSaveState("pending");
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void flushSettings(), 320);
  }

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setForm((current) => {
      const next = { ...current, [key]: value };
      editedRef.current = true;
      scheduleSave(next);
      return next;
    });

  const closeSettings = () => {
    void flushSettings().finally(onClose);
  };

  const filteredNavigation = NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => `${item.label} ${item.keywords}`.toLowerCase().includes(query.toLowerCase())),
  })).filter((section) => section.items.length > 0);

  return (
    <div className="settings-center" role="dialog" aria-modal="true" aria-label="设置">
      <aside className="settings-navigation">
        <button className="settings-back" onClick={closeSettings}><ChevronRight size={16} /> 返回应用</button>
        <label className="settings-search">
          <Search size={16} />
          <input autoFocus placeholder="搜索设置…" value={query} onChange={(event) => setQuery(event.target.value)} />
          {query && <button onClick={() => setQuery("")}><X size={13} /></button>}
        </label>
        <div className="settings-nav-scroll">
          {filteredNavigation.map((section) => (
            <section key={section.label}>
              <h3>{section.label}</h3>
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    className={active === item.id ? "active" : ""}
                    onClick={() => { setActive(item.id); setQuery(""); }}
                  >
                    <Icon size={16} /> {item.label}
                  </button>
                );
              })}
            </section>
          ))}
          {filteredNavigation.length === 0 && <div className="settings-no-results">没有匹配的设置</div>}
        </div>
      </aside>

      <main className="settings-content">
        <header className="settings-content-header">
          <strong>{NAVIGATION.flatMap((section) => section.items).find((item) => item.id === active)?.label}</strong>
          <div>
            <span className={`settings-save-status ${saveState}`} aria-live="polite">
              {saveState === "pending" || saveState === "saving" ? "正在保存…" : saveState === "saved" ? "已保存" : saveState === "error" ? "保存失败" : ""}
            </span>
            <button className="icon-button" onClick={closeSettings} title="关闭设置"><X size={18} /></button>
          </div>
        </header>
        <div className="settings-page-scroll">
          <div className="settings-page">
            {active === "general" && <GeneralPage form={form} update={update} />}
            {active === "appearance" && <AppearancePage form={form} update={update} />}
            {active === "agent" && <AgentPage form={form} update={update} providers={providers} />}
            {active === "personalization" && <PersonalizationPage
              form={form}
              update={update}
              memoryText={memoryText}
              memoryState={memoryState}
              onMemoryChange={(value) => { setMemoryText(value); setMemoryState("idle"); }}
              onMemorySave={async () => {
                setMemoryState("saving");
                try {
                  await pi.setLocalMemory(memoryText);
                  setMemoryState("saved");
                } catch {
                  setMemoryState("error");
                }
              }}
              onMemoryExport={async () => {
                const destination = await saveDialog({
                  title: "导出本地记忆",
                  defaultPath: "pidesktop-memory.md",
                  filters: [{ name: "Markdown", extensions: ["md"] }],
                });
                if (typeof destination !== "string") return;
                setMemoryState("saving");
                try {
                  await pi.setLocalMemory(memoryText);
                  await pi.exportLocalMemory(destination);
                  setMemoryState("saved");
                } catch {
                  setMemoryState("error");
                }
              }}
              onMemoryDelete={async () => {
                if (!window.confirm("删除 PIDesktop 本地记忆文件吗？此操作不能撤销。")) return;
                try {
                  await pi.deleteLocalMemory();
                  setMemoryText("");
                  setMemoryState("idle");
                } catch {
                  setMemoryState("error");
                }
              }}
            />}
            {active === "shortcuts" && <ShortcutsPage form={form} update={update} />}
            {active === "archived" && <ArchivedPage archived={archived} loading={loadingData} onRestore={async (session) => {
              await pi.restoreSession(session.file);
              setArchived((items) => items.filter((item) => item.file !== session.file));
              setForm((current) => ({ ...current, archivedSessions: current.archivedSessions.filter((file) => file !== session.file) }));
            }} onDelete={async (session) => {
              if (!window.confirm(`将“${session.name || session.firstMessage || "未命名任务"}”移到 Pi Desktop 回收站吗？`)) return;
              await pi.deleteSession(session.file);
              setArchived((items) => items.filter((item) => item.file !== session.file));
            }} />}
            {active === "usage" && <UsagePage usage={usage} />}
            {active === "providers" && <ProvidersPage providers={providers} loading={providersLoading} error={providersError} onReload={async () => {
              setProvidersLoading(true);
              try {
                setProviders(await pi.listModelProviders());
                setProvidersError("");
              } catch (error) {
                setProvidersError(String(error));
              } finally {
                setProvidersLoading(false);
              }
            }} />}
            {active === "skills" && <SkillsPage resources={resources} loading={loadingData} />}
            {active === "mcp" && <McpPage form={form} update={update} />}
            {active === "browser" && <BrowserPage form={form} update={update} />}
            {active === "computer" && <ComputerPage form={form} update={update} />}
            {active === "review" && <CodeReviewPage form={form} update={update} />}
            {active === "environment" && <EnvironmentPage form={form} update={update} />}
            {active === "hooks" && <HooksPage form={form} update={update} />}
            {active === "git" && <GitPage form={form} update={update} />}
            {active === "worktrees" && <WorktreesPage cwd={cwd} worktrees={worktrees} loading={loadingData} onCreated={(item) => setWorktrees((items) => [...items, item])} />}
            {active === "debug" && <DebugPage form={form} update={update} />}
          </div>
        </div>
      </main>
    </div>
  );
}

type Update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

function PageHeading({ title, description }: { title: string; description: string }) {
  return <div className="settings-page-heading"><h1>{title}</h1><p>{description}</p></div>;
}

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return <section className="settings-card">{title && <h2>{title}</h2>}<div>{children}</div></section>;
}

function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="setting-row"><span><strong>{title}</strong>{description && <small>{description}</small>}</span><div>{children}</div></div>;
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`settings-switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)}><span /></button>;
}

function GeneralPage({ form, update }: { form: AppSettings; update: Update }) {
  return <>
    <PageHeading title="常规" description="控制 Pi Desktop 的启动、消息发送和项目文件打开方式。" />
    <Card title="任务">
      <Row title="跟进消息行为" description="Pi 工作时再次发送消息所执行的操作。"><select value={form.followUpBehavior} onChange={(event) => update("followUpBehavior", event.target.value as AppSettings["followUpBehavior"])}><option value="steer">调整当前任务</option><option value="followUp">排队到下一轮</option></select></Row>
      <Row title="使用 Ctrl+Enter 发送" description="Enter 插入换行，Ctrl+Enter 发送提示词。"><Switch label="使用 Ctrl+Enter 发送" checked={form.requireCtrlEnter} onChange={(value) => update("requireCtrlEnter", value)} /></Row>
      <Row title="显示推理过程" description="在任务中保留可展开的推理内容。"><Switch label="显示推理过程" checked={form.showThinking} onChange={(value) => update("showThinking", value)} /></Row>
      <Row title="显示建议提示词" description="在新任务页显示与编程相关的快捷提示词。"><Switch label="显示建议提示词" checked={form.suggestedPrompts} onChange={(value) => update("suggestedPrompts", value)} /></Row>
    </Card>
    <Card title="应用">
      <Row title="恢复上次任务" description="启动时重新打开上一次任务及其 Pi 会话；前端刷新时会直接接回仍在运行的任务。"><Switch label="恢复上次任务" checked={form.autoConnect} onChange={(value) => update("autoConnect", value)} /></Row>
      <Row title="运行时防止休眠" description="执行长时间本地任务时保持电脑唤醒。"><Switch label="运行时防止休眠" checked={form.preventSleep} onChange={(value) => update("preventSleep", value)} /></Row>
      <Row title="默认文件打开方式"><select value={form.defaultFileOpener} onChange={(event) => update("defaultFileOpener", event.target.value as AppSettings["defaultFileOpener"])}><option value="system">自动选择已安装的编辑器</option><option value="cursor">Cursor</option><option value="vscode">Visual Studio Code</option><option value="antigravity">Antigravity</option><option value="windsurf">Windsurf</option></select></Row>
      <Row title="界面语言"><select value="zh-CN" disabled><option value="zh-CN">简体中文</option></select></Row>
    </Card>
    <Card title="通知">
      <Row title="启用通知" description="允许系统显示任务完成和审批通知。"><Switch label="启用通知" checked={form.notificationsEnabled} onChange={(value) => update("notificationsEnabled", value)} /></Row>
      <Row title="任务完成" description="Pi 完成长时间任务时通知。"><Switch label="任务完成" checked={form.notifyOnCompletion} onChange={(value) => update("notifyOnCompletion", value)} /></Row>
      <Row title="需要审批" description="Pi 等待权限决定时通知。"><Switch label="需要审批" checked={form.notifyOnApproval} onChange={(value) => update("notifyOnApproval", value)} /></Row>
      <Row title="仅窗口未聚焦时" description="Pi Desktop 已处于活动状态时不显示通知。"><Switch label="仅窗口未聚焦时" checked={form.notifyOnlyWhenUnfocused} onChange={(value) => update("notifyOnlyWhenUnfocused", value)} /></Row>
    </Card>
  </>;
}

function AppearancePage({ form, update }: { form: AppSettings; update: Update }) {
  const themes: Array<[AppSettings["theme"], string]> = [["system", "跟随系统"], ["light", "白色"], ["dark", "黑色"]];
  return <>
    <PageHeading title="外观" description="选择黑白主题，并调整字体与界面大小。" />
    <div className="theme-grid">
      {themes.map(([theme, label]) => <button key={theme} className={form.theme === theme ? "active" : ""} onClick={() => update("theme", theme)}>
        {theme === "system"
          ? <span className="theme-preview system"><i className="theme-system-half light"><b /><b /></i><i className="theme-system-half dark"><b /><b /></i></span>
          : <span className={`theme-preview ${theme}`}><i /><i /><i /></span>}
        <strong>{label}</strong>
      </button>)}
    </div>
    <div className="settings-info"><Palette size={17} /><span>界面只使用黑、白和中性灰；状态警告仍保留必要的辨识颜色。</span></div>
    <Card title="字体与缩放">
      <Row title="界面字体"><input value={form.uiFont} onChange={(event) => update("uiFont", event.target.value)} /></Row>
      <Row title="代码字体"><input value={form.codeFont} onChange={(event) => update("codeFont", event.target.value)} /></Row>
      <Row title="界面缩放" description={`${form.uiScale}%`}><input className="scale-slider" type="range" min="75" max="150" step="5" value={form.uiScale} onChange={(event) => update("uiScale", Number(event.target.value))} /></Row>
    </Card>
  </>;
}

function PersonalizationPage({
  form,
  update,
  memoryText,
  memoryState,
  onMemoryChange,
  onMemorySave,
  onMemoryExport,
  onMemoryDelete,
}: {
  form: AppSettings;
  update: Update;
  memoryText: string;
  memoryState: "idle" | "saving" | "saved" | "error";
  onMemoryChange: (value: string) => void;
  onMemorySave: () => Promise<void>;
  onMemoryExport: () => Promise<void>;
  onMemoryDelete: () => Promise<void>;
}) {
  return <>
    <PageHeading title="个性化" description="为每个本地会话设置 Pi 的工作风格和长期指令。" />
    <Card title="交流风格">
      <div className="personality-grid">{(["friendly", "pragmatic", "none"] as const).map((personality) => <button key={personality} className={form.personality === personality ? "active" : ""} onClick={() => update("personality", personality)}><Sparkles size={17} /><strong>{personality === "friendly" ? "友好" : personality === "pragmatic" ? "务实" : "无额外风格"}</strong><small>{personality === "friendly" ? "温和、清晰、协作" : personality === "pragmatic" ? "直接、简洁、注重实现" : "不添加额外表达风格"}</small></button>)}</div>
    </Card>
    <Card title="个人指令">
      <p className="card-description">重新连接后，这些指令会追加到 Pi 的系统提示词。项目中的 AGENTS.md 和 CLAUDE.md 仍按各自作用域加载。</p>
      <textarea className="large-settings-textarea" value={form.customInstructions} onChange={(event) => update("customInstructions", event.target.value)} placeholder="例如：优先使用 PowerShell，保留已有用户改动，并先运行针对性测试。" />
      <Row title="加载记忆" description="把本地记忆和 Pi 发现的 AGENTS.md、CLAUDE.md 一起加入新任务上下文。"><Switch label="加载记忆" checked={form.memoryEnabled} onChange={(value) => update("memoryEnabled", value)} /></Row>
    </Card>
    <Card title="本地记忆">
      <p className="card-description">只保存在当前 Windows 账户的 PIDesktop 配置目录中；保存后从新任务开始注入。</p>
      <textarea
        className="large-settings-textarea memory-textarea"
        value={memoryText}
        onChange={(event) => onMemoryChange(event.target.value)}
        placeholder="记录长期有效的项目偏好、工作习惯和约定。"
      />
      <div className="memory-actions">
        <span className={`memory-state ${memoryState}`}>{memoryState === "saving" ? "正在保存…" : memoryState === "saved" ? "已保存" : memoryState === "error" ? "操作失败" : ""}</span>
        <button className="secondary-button" disabled={memoryState === "saving"} onClick={() => void onMemoryExport()}><FileDown size={14} />导出</button>
        <button className="icon-button danger" disabled={!memoryText || memoryState === "saving"} title="删除本地记忆" onClick={() => void onMemoryDelete()}><Trash2 size={14} /></button>
        <button className="primary-button" disabled={memoryState === "saving"} onClick={() => void onMemorySave()}><Save size={14} />保存记忆</button>
      </div>
    </Card>
  </>;
}

function ShortcutsPage({ form, update }: { form: AppSettings; update: Update }) {
  const rows: Array<[keyof AppSettings, string, string]> = [
    ["shortcutNewChat", "新任务", "创建新的 Pi 任务"],
    ["shortcutSettings", "打开设置", "打开设置中心"],
    ["shortcutTerminal", "切换终端", "打开或关闭终端面板"],
    ["shortcutChanges", "切换更改", "打开或关闭 Git 更改面板"],
    ["shortcutToggleSidebar", "切换侧栏", "显示或隐藏项目导航"],
  ];
  return <>
    <PageHeading title="键盘快捷键" description="查看并自定义常用操作的快捷键。" />
    <Card>{rows.map(([key, title, description]) => <Row key={key} title={title} description={description}><input className="shortcut-input" value={String(form[key])} onChange={(event) => update(key, event.target.value as never)} /></Row>)}</Card>
    <button className="secondary-button reset-shortcuts" onClick={() => rows.forEach(([key]) => update(key, DEFAULTS[key] as never))}><Undo2 size={14} /> 重置快捷键</button>
  </>;
}

function ArchivedPage({ archived, loading, onRestore, onDelete }: { archived: SessionInfo[]; loading: boolean; onRestore: (session: SessionInfo) => Promise<void>; onDelete: (session: SessionInfo) => Promise<void> }) {
  return <>
    <PageHeading title="已归档的聊天" description="查看和恢复此前归档的聊天。" />
    <Card>{loading ? <div className="settings-empty"><RefreshCw className="spinner-icon" size={18} /> 正在加载聊天…</div> : archived.length === 0 ? <div className="settings-empty"><Archive size={22} />暂无已归档的聊天</div> : <div className="archive-list">{archived.map((session) => <div key={session.file}><span><strong>{session.name || session.firstMessage || "未命名聊天"}</strong><small>{session.cwd} · {session.messageCount} 条消息</small></span><button className="secondary-button" onClick={() => void onRestore(session)}><Undo2 size={13} /> 恢复</button><button className="icon-button danger" onClick={() => void onDelete(session)}><Trash2 size={14} /></button></div>)}</div>}</Card>
  </>;
}

function UsagePage({ usage }: { usage: UsageSummary | null }) {
  const number = (value?: number) => (value ?? 0).toLocaleString();
  return <>
    <PageHeading title="使用情况和计费" description="查看由本机 Pi 会话文件汇总的活动数据。" />
    {!usage ? <div className="settings-empty"><RefreshCw className="spinner-icon" size={18} /> 正在计算使用情况…</div> : <>
      <div className="usage-hero"><span><small>累计 token</small><strong>{number(usage.totalTokens)}</strong></span><span><small>记录费用</small><strong>${usage.totalCost.toFixed(4)}</strong></span><span><small>任务</small><strong>{number(usage.sessions)}</strong></span><span><small>消息</small><strong>{number(usage.messages)}</strong></span></div>
      <Card title="Token 活动"><div className="usage-breakdown"><span><i style={{ width: `${Math.max(5, usage.inputTokens / Math.max(1, usage.totalTokens) * 100)}%` }} /><strong>输入</strong><em>{number(usage.inputTokens)}</em></span><span><i style={{ width: `${Math.max(5, usage.outputTokens / Math.max(1, usage.totalTokens) * 100)}%` }} /><strong>输出</strong><em>{number(usage.outputTokens)}</em></span><span><i style={{ width: `${Math.max(5, usage.reasoningTokens / Math.max(1, usage.totalTokens) * 100)}%` }} /><strong>推理</strong><em>{number(usage.reasoningTokens)}</em></span><span><i style={{ width: `${Math.max(5, usage.cacheReadTokens / Math.max(1, usage.totalTokens) * 100)}%` }} /><strong>缓存读取</strong><em>{number(usage.cacheReadTokens)}</em></span></div></Card>
    </>}
    <div className="settings-info"><BarChart3 size={17} /><span>这些数据由 Pi JSONL 使用记录在本地计算；实际账单和订阅额度以模型提供商为准。</span></div>
  </>;
}

function AgentPage({ form, update, providers }: { form: AppSettings; update: Update; providers: ModelProviderConfig[] }) {
  const reasoningLabels: Record<string, string> = { off: "关闭", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
  const selectedProvider = providers.find((provider) => provider.id === form.provider);
  const modelOptions = selectedProvider
    ? selectedProvider.models.map((model) => ({ provider: selectedProvider.id, model }))
    : providers.flatMap((provider) => provider.models.map((model) => ({ provider: provider.id, model })));
  return <>
    <PageHeading title="配置" description="设置新聊天使用的默认模型、推理等级和审批策略。" />
    <Card title="默认模型">
      <Row title="提供商" description="留空则使用 Pi 已配置的提供商。"><input list="provider-options" value={form.provider} onChange={(event) => update("provider", event.target.value)} placeholder="使用 Pi 默认值" /><datalist id="provider-options">{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</datalist></Row>
      <Row title="模型" description="填写模型 ID 或 Pi 模糊匹配模式。"><input list="provider-model-options" value={form.model} onChange={(event) => update("model", event.target.value)} placeholder="使用 Pi 默认值" /><datalist id="provider-model-options">{modelOptions.map(({ provider, model }) => <option key={`${provider}-${model.id}`} value={model.id}>{provider} · {model.name}</option>)}</datalist></Row>
      <Row title="推理等级"><select value={form.thinkingLevel} onChange={(event) => update("thinkingLevel", event.target.value)}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option key={level} value={level}>{reasoningLabels[level]}</option>)}</select></Row>
    </Card>
    <Card title="权限">
      <Row title="默认工作模式" description="执行可修改代码；计划和问答仅使用只读工具。"><select value={form.agentMode} onChange={(event) => update("agentMode", event.target.value as AppSettings["agentMode"])}><option value="agent">执行</option><option value="plan">计划</option><option value="ask">问答</option></select></Row>
      <Row title="审批与文件访问" description="控制 Pi 何时请求确认，以及允许访问的文件范围。"><select value={form.permissionMode} onChange={(event) => update("permissionMode", event.target.value as AppSettings["permissionMode"])}><option value="read-only">只读</option><option value="ask">先询问</option><option value="workspace-write">工作区写入</option><option value="full-access">完全访问</option></select></Row>
    </Card>
    <Card title="计划跟踪">
      <Row title="启用持久计划" description="为新任务提供 update_plan 工具；步骤状态随会话分支保存，并显示在对话中。"><Switch label="启用持久计划" checked={form.planTrackingEnabled} onChange={(value) => update("planTrackingEnabled", value)} /></Row>
    </Card>
    <Card title="本地子 Agent">
      <Row title="启用任务委派" description="提供 delegate_task 工具，用隔离上下文运行探索、计划、审查或 worker。"><Switch label="启用本地子 Agent" checked={form.subagentsEnabled} onChange={(value) => update("subagentsEnabled", value)} /></Row>
      <Row title="最大并发" description="一次工具调用最多 8 个任务；实际同时运行数量限制为 1 到 4。"><input type="number" min="1" max="4" value={form.subagentMaxConcurrency} onChange={(event) => update("subagentMaxConcurrency", Math.max(1, Math.min(4, Number(event.target.value) || 1)))} /></Row>
    </Card>
    <Card title="Rules v1">
      <Row title="始终确认 Shell" description="bash / shell / exec 在执行前必须确认。"><Switch label="始终确认 Shell" checked={form.alwaysConfirmShell} onChange={(value) => update("alwaysConfirmShell", value)} /></Row>
      <Row title="阻止工作区外写入" description="直接拦截对工作区根目录之外路径的写入。"><Switch label="阻止工作区外写入" checked={form.blockWriteOutsideWorkspace} onChange={(value) => update("blockWriteOutsideWorkspace", value)} /></Row>
      <label className="stacked-setting"><span>Shell 允许前缀</span><textarea value={form.shellAllowPrefixes} onChange={(event) => update("shellAllowPrefixes", event.target.value)} placeholder={"git status\nnpm test\npnpm lint"} rows={4} /><small className="field-hint">每行或逗号分隔；仅在关闭“始终确认 Shell”后生效。</small></label>
    </Card>
    <Card title="工具规则">
      <div className="tool-rules-heading"><span>按列表顺序匹配；只读与计划模式始终优先。</span><button type="button" className="secondary-button compact" onClick={() => update("toolRules", [...form.toolRules, { id: `rule-${Date.now().toString(36)}`, enabled: true, toolPattern: "bash", action: "confirm", commandPrefix: "", pathPrefix: "" }])}><Plus size={13} />添加规则</button></div>
      {form.toolRules.length === 0 && <div className="settings-empty compact">没有自定义工具规则</div>}
      <div className="tool-rule-list">{form.toolRules.map((rule, index) => {
        const change = (patch: Partial<typeof rule>) => update("toolRules", form.toolRules.map((item) => item.id === rule.id ? { ...item, ...patch } : item));
        const move = (direction: -1 | 1) => {
          const target = index + direction;
          if (target < 0 || target >= form.toolRules.length) return;
          const next = [...form.toolRules];
          [next[index], next[target]] = [next[target], next[index]];
          update("toolRules", next);
        };
        return <div className="tool-rule-row" key={rule.id}>
          <Switch label={`启用规则 ${rule.id}`} checked={rule.enabled} onChange={(enabled) => change({ enabled })} />
          <input aria-label="工具模式" value={rule.toolPattern} onChange={(event) => change({ toolPattern: event.target.value })} placeholder="bash 或 mcp__github__*" />
          <select aria-label="规则动作" value={rule.action} onChange={(event) => change({ action: event.target.value as typeof rule.action })}><option value="allow">允许</option><option value="confirm">询问</option><option value="block">阻止</option></select>
          <input aria-label="命令前缀" value={rule.commandPrefix} onChange={(event) => change({ commandPrefix: event.target.value })} placeholder="命令前缀（可选）" />
          <input aria-label="路径前缀" value={rule.pathPrefix} onChange={(event) => change({ pathPrefix: event.target.value })} placeholder="路径前缀（可选）" />
          <span className="tool-rule-actions"><button type="button" className="icon-button" disabled={index === 0} onClick={() => move(-1)} title="上移"><ArrowUp size={13} /></button><button type="button" className="icon-button" disabled={index === form.toolRules.length - 1} onClick={() => move(1)} title="下移"><ArrowDown size={13} /></button><button type="button" className="icon-button danger" onClick={() => update("toolRules", form.toolRules.filter((item) => item.id !== rule.id))} title="删除规则"><Trash2 size={13} /></button></span>
        </div>;
      })}</div>
    </Card>
    <div className="settings-info"><Bot size={17} /><span>模型、计划工具和 Rules 设置应用于新启动的 Pi 聊天；工作模式与权限可在当前聊天的输入框中即时切换。</span></div>
  </>;
}

const HOOK_EVENTS: Array<[AppSettings["hooks"][number]["event"], string]> = [
  ["session_start", "会话启动"],
  ["before_agent_start", "每轮开始前"],
  ["agent_end", "模型运行结束"],
  ["agent_settled", "任务完全结束"],
  ["tool_call", "工具调用前"],
  ["tool_result", "工具返回后"],
];

function HooksPage({ form, update }: { form: AppSettings; update: Update }) {
  const addHook = () => update("hooks", [...form.hooks, {
    id: `hook-${Date.now().toString(36)}`,
    name: "新 Hook",
    enabled: true,
    event: "agent_settled",
    command: "",
    timeoutSeconds: 30,
    blocking: false,
  }]);
  const changeHook = (id: string, patch: Partial<AppSettings["hooks"][number]>) => {
    update("hooks", form.hooks.map((hook) => hook.id === id ? { ...hook, ...patch } : hook));
  };
  return <>
    <PageHeading title="Hooks" description="在 Pi 生命周期事件上运行本机命令；事件数据以 JSON 写入标准输入。" />
    <Card title="Hook 运行器">
      <Row title="启用 Hooks" description="仅新启动的任务加载这些命令。"><Switch label="启用 Hooks" checked={form.hooksEnabled} onChange={(value) => update("hooksEnabled", value)} /></Row>
      <Row title="继承完整环境" description="关闭时过滤 API key、令牌、密码、凭据、Authorization 和 Cookie。"><Switch label="Hooks 继承完整环境" checked={form.hooksInheritEnvironment} onChange={(value) => update("hooksInheritEnvironment", value)} /></Row>
    </Card>
    <div className="hook-toolbar"><button type="button" className="primary-button" onClick={addHook}><Plus size={14} />添加 Hook</button></div>
    {form.hooks.length === 0 && <div className="settings-empty"><Workflow size={24} />尚未配置 Hook</div>}
    {form.hooks.map((hook) => <section className="hook-editor" key={hook.id}>
      <header><span><Workflow size={16} /><strong>{hook.name || hook.id}</strong></span><div><Switch label={`启用 ${hook.name || hook.id}`} checked={hook.enabled} onChange={(enabled) => changeHook(hook.id, { enabled })} /><button type="button" className="icon-button danger" title="删除 Hook" onClick={() => update("hooks", form.hooks.filter((item) => item.id !== hook.id))}><Trash2 size={15} /></button></div></header>
      <div>
        <Row title="名称"><input value={hook.name} onChange={(event) => changeHook(hook.id, { name: event.target.value })} /></Row>
        <Row title="事件"><select value={hook.event} onChange={(event) => changeHook(hook.id, { event: event.target.value as typeof hook.event, blocking: false })}>{HOOK_EVENTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Row>
        <Row title="命令" description="Windows 使用 cmd.exe /c；macOS/Linux 使用 /bin/sh -lc。不要把凭据直接写进命令。"><textarea rows={3} value={hook.command} onChange={(event) => changeHook(hook.id, { command: event.target.value })} placeholder="npm test" /></Row>
        <Row title="超时（秒）"><input type="number" min="1" max="300" value={hook.timeoutSeconds} onChange={(event) => changeHook(hook.id, { timeoutSeconds: Math.max(1, Math.min(300, Number(event.target.value) || 1)) })} /></Row>
        <Row title="失败时阻断工具" description="其余事件失败会通知，但不改变任务结果。">{hook.event === "tool_call" ? <Switch label="Hook 失败时阻断工具" checked={hook.blocking} onChange={(blocking) => changeHook(hook.id, { blocking })} /> : <span className="setting-value-muted">仅“工具调用前”可用</span>}</Row>
      </div>
    </section>)}
    <div className="security-note expanded"><ShieldAlert size={18} /><span><strong>Hooks 是你授权的本机代码。</strong>它们不经过模型工具审批。只配置你信任的命令，并保持“继承完整环境”关闭，除非命令确实需要凭据。</span></div>
  </>;
}

const PROVIDER_APIS = [
  ["openai-completions", "OpenAI Chat Completions"],
  ["openai-responses", "OpenAI Responses"],
  ["anthropic-messages", "Anthropic Messages"],
  ["azure-openai-responses", "Azure OpenAI Responses"],
  ["openai-codex-responses", "OpenAI Codex Responses"],
  ["mistral-conversations", "Mistral Conversations"],
  ["google-generative-ai", "Google Generative AI"],
  ["google-vertex", "Google Vertex AI"],
  ["bedrock-converse-stream", "Amazon Bedrock Converse"],
] as const;

function emptyProviderDraft(): ModelProviderInput {
  return {
    originalId: null,
    id: "",
    name: "",
    baseUrl: "",
    api: "openai-completions",
    apiKey: "",
    keepExistingApiKey: false,
    authHeader: false,
    models: [{ id: "", name: "", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384 }],
  };
}

function ProvidersPage({ providers, loading, error, onReload }: { providers: ModelProviderConfig[]; loading: boolean; error: string; onReload: () => Promise<void> }) {
  const [draft, setDraft] = useState<ModelProviderInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "warning" | "error"; text: string } | null>(null);
  const sourceLabels: Record<ModelProviderConfig["apiKeySource"], string> = { none: "未配置凭据", stored: "已安全隐藏", environment: "环境变量", command: "命令获取" };

  const editProvider = (provider: ModelProviderConfig) => {
    setNotice(null);
    setDraft({
      originalId: provider.id,
      id: provider.id,
      name: provider.name === provider.id ? "" : provider.name,
      baseUrl: provider.baseUrl,
      api: provider.api || "openai-completions",
      apiKey: "",
      keepExistingApiKey: provider.hasApiKey,
      authHeader: provider.authHeader,
      models: provider.models.map((model) => ({ ...model, input: [...model.input] })),
    });
  };

  const changeModel = (index: number, patch: Partial<ModelProviderModel>) => {
    if (!draft) return;
    setDraft({ ...draft, models: draft.models.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model) });
  };

  const saveProvider = async () => {
    if (!draft) return;
    setBusy(true);
    setNotice(null);
    try {
      await pi.saveModelProvider(draft);
      await onReload();
      setDraft(null);
      setNotice({ kind: "success", text: "提供商配置已写入 Pi 的 models.json。" });
    } catch (nextError) {
      setNotice({ kind: "error", text: String(nextError) });
    } finally {
      setBusy(false);
    }
  };

  const removeProvider = async (provider: ModelProviderConfig) => {
    if (!window.confirm(`删除模型提供商“${provider.name}”及其 ${provider.models.length} 个配置模型吗？`)) return;
    setBusy(true);
    setNotice(null);
    try {
      await pi.deleteModelProvider(provider.id);
      await onReload();
      if (draft?.originalId === provider.id) setDraft(null);
      setNotice({ kind: "success", text: `已删除 ${provider.name}。` });
    } catch (nextError) {
      setNotice({ kind: "error", text: String(nextError) });
    } finally {
      setBusy(false);
    }
  };

  const checkProvider = async (id: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await pi.checkModelProvider(id);
      setNotice({ kind: result.ok ? "success" : "warning", text: result.message });
    } catch (nextError) {
      setNotice({ kind: "error", text: String(nextError) });
    } finally {
      setBusy(false);
    }
  };

  return <>
    <PageHeading title="模型提供商" description="管理 Pi 原生 models.json 中的 API 提供商、凭据和模型目录。" />
    <div className="provider-toolbar">
      <button className="primary-button" disabled={busy} onClick={() => { setDraft(emptyProviderDraft()); setNotice(null); }}><Plus size={14} />添加提供商</button>
      <button className="secondary-button" disabled={loading || busy} onClick={() => void onReload()}><RefreshCw className={loading ? "spinner-icon" : ""} size={14} />刷新</button>
    </div>
    {(error || notice) && <div className={`provider-notice ${error || notice?.kind === "error" ? "error" : notice?.kind ?? "warning"}`}>
      {error || notice?.kind === "error" ? <CircleAlert size={16} /> : notice?.kind === "success" ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
      <span>{error || notice?.text}</span>
    </div>}

    {draft && <section className="provider-editor">
      <header><span><ServerCog size={17} /><strong>{draft.originalId ? `编辑 ${draft.originalId}` : "添加模型提供商"}</strong></span><button className="icon-button" onClick={() => setDraft(null)} title="关闭编辑器"><X size={16} /></button></header>
      <div className="provider-fields">
        <label><span>提供商 ID <em>必填</em></span><input autoFocus={!draft.originalId} disabled={Boolean(draft.originalId)} value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="例如 openrouter 或 local-ollama" /></label>
        <label><span>显示名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="不填则显示提供商 ID" /></label>
        <label className="wide"><span>API 地址 <em>必填</em></span><input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
        <label><span>API 协议</span><select value={draft.api} onChange={(event) => setDraft({ ...draft, api: event.target.value })}>{PROVIDER_APIS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>API 密钥或引用</span><div className="provider-secret-input"><KeyRound size={14} /><input type="password" autoComplete="new-password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value, keepExistingApiKey: event.target.value ? false : draft.keepExistingApiKey })} placeholder={draft.keepExistingApiKey ? "已配置，留空则保留" : "sk-…、$ENV_VAR 或 !command"} /></div></label>
      </div>
      <div className="provider-options-row">
        <span><strong>Authorization Bearer</strong><small>仅当非标准接口要求自动生成 Authorization 请求头时开启。</small></span><Switch label="Authorization Bearer" checked={draft.authHeader} onChange={(value) => setDraft({ ...draft, authHeader: value })} />
        {draft.originalId && draft.keepExistingApiKey && <button className="secondary-button compact" onClick={() => setDraft({ ...draft, apiKey: "", keepExistingApiKey: false })}>清除已配置凭据</button>}
      </div>
      <div className="provider-models-heading"><span><strong>模型</strong><small>只需要模型 ID；其余字段留空时由 Pi 使用默认值。</small></span><button className="secondary-button compact" onClick={() => setDraft({ ...draft, models: [...draft.models, { id: "", name: "", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384 }] })}><Plus size={13} />添加模型</button></div>
      <div className="provider-models">
        {draft.models.length === 0 && <div className="provider-model-empty">此提供商没有自定义模型；可用于覆盖 Pi 内置提供商的地址。</div>}
        {draft.models.map((model, index) => <div className="provider-model-row" key={`${index}-${model.id}`}>
          <div className="provider-model-main"><label><span>模型 ID</span><input value={model.id} onChange={(event) => changeModel(index, { id: event.target.value })} placeholder="model-id" /></label><label><span>显示名称</span><input value={model.name} onChange={(event) => changeModel(index, { name: event.target.value })} placeholder="可选" /></label></div>
          <div className="provider-model-meta"><label><span>上下文</span><input type="number" min="1" value={model.contextWindow ?? ""} onChange={(event) => changeModel(index, { contextWindow: event.target.value ? Number(event.target.value) : null })} placeholder="128000" /></label><label><span>最大输出</span><input type="number" min="1" value={model.maxTokens ?? ""} onChange={(event) => changeModel(index, { maxTokens: event.target.value ? Number(event.target.value) : null })} placeholder="16384" /></label><label className="provider-model-toggle"><Switch label="推理模型" checked={model.reasoning} onChange={(value) => changeModel(index, { reasoning: value })} /><span>推理</span></label><label className="provider-model-toggle"><Switch label="支持图片" checked={model.input.includes("image")} onChange={(value) => changeModel(index, { input: value ? ["text", "image"] : ["text"] })} /><span>图片</span></label><button className="icon-button danger" title="移除模型" onClick={() => setDraft({ ...draft, models: draft.models.filter((_, modelIndex) => modelIndex !== index) })}><Trash2 size={14} /></button></div>
        </div>)}
      </div>
      <footer>{draft.originalId && <button className="secondary-button" disabled={busy} onClick={() => void checkProvider(draft.originalId!)}><CheckCircle2 size={14} />检查配置</button>}<span /><button className="secondary-button" disabled={busy} onClick={() => setDraft(null)}>取消</button><button className="primary-button" disabled={busy || !draft.id.trim()} onClick={() => void saveProvider()}>{busy ? "正在保存…" : "保存提供商"}</button></footer>
    </section>}

    <Card title="已配置的提供商">
      {loading ? <div className="settings-empty"><RefreshCw className="spinner-icon" size={18} />正在读取 models.json…</div> : providers.length === 0 ? <div className="settings-empty"><ServerCog size={22} />尚未配置模型提供商</div> : <div className="provider-list">{providers.map((provider) => <div key={provider.id}>
        <span className="provider-icon"><ServerCog size={16} /></span><span><strong>{provider.name}</strong><small>{provider.id} · {provider.api || "继承 Pi 内置协议"}</small><code>{provider.baseUrl || "使用 Pi 内置 API 地址"}</code></span><span className={`provider-credential ${provider.hasApiKey ? "configured" : ""}`}><KeyRound size={12} />{sourceLabels[provider.apiKeySource]}</span><em>{provider.models.length} 个模型</em><button className="icon-button" title="编辑提供商" onClick={() => editProvider(provider)}><Pencil size={14} /></button><button className="icon-button danger" disabled={busy} title="删除提供商" onClick={() => void removeProvider(provider)}><Trash2 size={14} /></button>
      </div>)}</div>}
    </Card>
    <div className="settings-info"><ServerCog size={17} /><span>配置直接保存到 <code>~/.pi/agent/models.json</code>。密钥不会从后端回传到页面，编辑时留空会保留原值；新任务会自动使用更新后的模型目录。</span></div>
  </>;
}

function SkillsPage({ resources, loading }: { resources: ResourceItem[]; loading: boolean }) {
  const skills = resources.filter((item) => item.kind === "skill");
  return <>
    <PageHeading title="技能" description="查看用户和当前项目中可供 Pi 调用的技能。" />
    <Card>{loading ? <div className="settings-empty"><RefreshCw className="spinner-icon" size={18} />正在发现技能…</div> : skills.length === 0 ? <div className="settings-empty"><Sparkles size={22} />未发现技能</div> : <div className="resource-list">{skills.map((item) => <button key={`${item.scope}-${item.path}`} onClick={() => void openPath(item.path).catch(() => undefined)}><span className="resource-kind skill">技能</span><span><strong>{item.name}</strong><small>{item.path}</small></span><em>{item.scope === "project" ? "项目" : "用户"}</em><ChevronRight size={14} /></button>)}</div>}</Card>
    <div className="settings-info"><Sparkles size={17} /><span>技能由 <code>SKILL.md</code> 定义。项目技能只在当前工作区受信任后加载，软件包内的技能请在“插件”中管理。</span></div>
  </>;
}

function linesToRecord(value: string): Record<string, string> {
  return Object.fromEntries(value.split(/\r?\n/).map((line) => {
    const separator = line.indexOf("=");
    return separator < 1 ? null : [line.slice(0, separator).trim(), line.slice(separator + 1)];
  }).filter((entry): entry is [string, string] => Boolean(entry)));
}

function recordToLines(value: Record<string, string>): string {
  return Object.entries(value).map(([key, entry]) => `${key}=${entry}`).join("\n");
}

function maskMcpCredentials(settings: AppSettings): AppSettings {
  return {
    ...settings,
    mcpServers: settings.mcpServers.map((server) => ({
      ...server,
      env: Object.fromEntries(Object.keys(server.env).map((key) => [key, "••••••••"])),
      headers: Object.fromEntries(Object.keys(server.headers).map((key) => [key, "••••••••"])),
    })),
  };
}

function McpPage({ form, update }: { form: AppSettings; update: Update }) {
  const addServer = (transport: "stdio" | "http") => {
    const id = `server-${Date.now().toString(36)}`;
    update("mcpServers", [...form.mcpServers, {
      id,
      name: transport === "stdio" ? "本地 MCP" : "远程 MCP",
      enabled: true,
      transport,
      command: "",
      args: [],
      cwd: "",
      env: {},
      inheritEnvironment: false,
      url: "",
      headers: {},
      trustedReadOnly: false,
    }]);
  };
  const changeServer = (id: string, patch: Partial<AppSettings["mcpServers"][number]>) => {
    update("mcpServers", form.mcpServers.map((server) => server.id === id ? { ...server, ...patch } : server));
  };
  const removeServer = (id: string) => update("mcpServers", form.mcpServers.filter((server) => server.id !== id));

  return <>
    <PageHeading title="MCP 服务器" description="连接本地或远程 Model Context Protocol 服务器，并把它们的真实工具注册给 Pi。" />
    <Card title="MCP 主机">
      <Row title="启用 MCP" description="新任务会连接已启用的服务器，并动态注册发现到的工具。"><Switch label="启用 MCP" checked={form.mcpEnabled} onChange={(value) => update("mcpEnabled", value)} /></Row>
      <Row title="工具调用前审批" description="每次执行 MCP 工具前显示服务器、工具名和参数。"><Switch label="MCP 工具调用前审批" checked={form.mcpConfirmTools} onChange={(value) => update("mcpConfirmTools", value)} /></Row>
    </Card>
    <div className="mcp-toolbar">
      <button className="primary-button" onClick={() => addServer("stdio")}><Plus size={14} />添加本地服务器</button>
      <button className="secondary-button" onClick={() => addServer("http")}><Plus size={14} />添加 HTTP 服务器</button>
    </div>
    {form.mcpServers.length === 0 && <div className="settings-empty mcp-empty"><Network size={24} />尚未配置 MCP 服务器。</div>}
    {form.mcpServers.map((server) => <section className="mcp-server-editor" key={server.id}>
      <header>
        <span><Network size={16} /><strong>{server.name || server.id}</strong><small>{server.transport === "stdio" ? "STDIO" : "Streamable HTTP"}</small></span>
        <div><Switch label={`启用 ${server.name || server.id}`} checked={server.enabled} onChange={(enabled) => changeServer(server.id, { enabled })} /><button className="icon-button danger" title="删除服务器" onClick={() => removeServer(server.id)}><Trash2 size={15} /></button></div>
      </header>
      <div className="mcp-server-fields">
        <Row title="名称"><input value={server.name} onChange={(event) => changeServer(server.id, { name: event.target.value })} placeholder="文件系统" /></Row>
        <Row title="服务器 ID" description="用于生成 mcp__server__tool 工具名；必须唯一。"><input value={server.id} onChange={(event) => changeServer(server.id, { id: event.target.value.replace(/[^a-zA-Z0-9_-]/g, "-") })} /></Row>
        <Row title="传输方式"><select value={server.transport} onChange={(event) => changeServer(server.id, { transport: event.target.value as "stdio" | "http" })}><option value="stdio">STDIO（本地进程）</option><option value="http">Streamable HTTP</option></select></Row>
        {server.transport === "stdio" ? <>
          <Row title="命令" description="例如 npx、uvx 或服务器可执行文件的绝对路径。"><input value={server.command} onChange={(event) => changeServer(server.id, { command: event.target.value })} placeholder="npx" /></Row>
          <Row title="参数" description="每行一个参数。"><textarea value={server.args.join("\n")} onChange={(event) => changeServer(server.id, { args: event.target.value.split(/\r?\n/).filter((value) => value.length > 0) })} placeholder={'-y\n@modelcontextprotocol/server-filesystem\nD:\\Projects'} /></Row>
          <Row title="工作目录" description="留空时使用当前任务工作区。"><input value={server.cwd} onChange={(event) => changeServer(server.id, { cwd: event.target.value })} placeholder="使用任务工作区" /></Row>
          <Row title="环境变量" description="每行 KEY=value；适合 STDIO 服务器凭据。"><textarea value={recordToLines(server.env)} onChange={(event) => changeServer(server.id, { env: linesToRecord(event.target.value) })} placeholder="TOKEN=…" /></Row>
          <Row title="继承完整环境" description="默认会过滤父进程中的 API key、令牌、密码和 Cookie。"><Switch label="继承完整父进程环境" checked={server.inheritEnvironment} onChange={(inheritEnvironment) => changeServer(server.id, { inheritEnvironment })} /></Row>
        </> : <>
          <Row title="MCP 端点"><input value={server.url} onChange={(event) => changeServer(server.id, { url: event.target.value })} placeholder="https://example.com/mcp" /></Row>
          <Row title="请求头" description="每行 Header=value；可用于预配置 Bearer 令牌。"><textarea value={recordToLines(server.headers)} onChange={(event) => changeServer(server.id, { headers: linesToRecord(event.target.value) })} placeholder="Authorization=Bearer …" /></Row>
        </>}
        <Row title="受信任只读服务器" description="仅在你确认该服务器所有非破坏性工具都只读时启用；只读权限模式据此决定是否允许调用。"><Switch label="将服务器标记为受信任只读" checked={server.trustedReadOnly} onChange={(trustedReadOnly) => changeServer(server.id, { trustedReadOnly })} /></Row>
      </div>
    </section>)}
    <div className="settings-info"><ShieldAlert size={17} /><span>MCP 服务器拥有其进程或远程账户对应的权限。STDIO 凭据和 HTTP 请求头由当前 Windows 账户加密保存，重新打开设置时只显示掩码；工具注解来自服务器，只有“受信任只读服务器”开关代表你的明确授权。保存后请新建任务，并运行 <code>/mcp-diagnose</code> 查看连接和工具数量。</span></div>
  </>;
}

function BrowserPage({ form, update }: { form: AppSettings; update: Update }) {
  return <>
    <PageHeading title="Agent 浏览器" description="让 Pi 通过独立的本机 Edge、Chrome 或 Chromium 会话检查和操作网页。" />
    <Card title="Agent 浏览器工具">
      <Row title="启用 Agent 浏览器" description="为新启动的 Pi 任务注册 browser 工具。"><Switch label="启用 Agent 浏览器" checked={form.browserEnabled} onChange={(value) => update("browserEnabled", value)} /></Row>
      <Row title="后台运行" description="使用无头浏览器并在 Pi Desktop 中显示页面结果和截图。"><Switch label="后台运行浏览器" checked={form.browserHeadless} onChange={(value) => update("browserHeadless", value)} /></Row>
      <Row title="操作前审批" description="打开页面、点击或输入内容前请求确认；检查和截图保持只读。"><Switch label="浏览器操作前审批" checked={form.browserConfirmActions} onChange={(value) => update("browserConfirmActions", value)} /></Row>
      <Row title="浏览器程序" description="留空时依次查找 Edge、Chrome 和 Chromium。"><input value={form.browserExecutable} onChange={(event) => update("browserExecutable", event.target.value)} placeholder="自动检测" /></Row>
    </Card>
    <div className="settings-info"><Globe2 size={17} /><span>浏览器使用独立临时配置目录，不读取你的日常浏览器登录状态。设置修改将在新任务中生效。</span></div>
  </>;
}

function ComputerPage({ form, update }: { form: AppSettings; update: Update }) {
  return <>
    <PageHeading title="电脑操控" description="允许 Pi 查看并在审批后操作 Windows 桌面应用。" />
    <Card title="Computer Use">
      <Row title="启用计算机工具" description="为新任务注册 computer 工具，包括截图、窗口列表、点击、输入和按键。"><Switch label="启用计算机工具" checked={form.computerEnabled} onChange={(value) => update("computerEnabled", value)} /></Row>
      <Row title="交互操作前审批" description="切换窗口、点击、输入和按键前必须确认；截图和窗口列表保持只读。"><Switch label="计算机操作前审批" checked={form.computerConfirmActions} onChange={(value) => update("computerConfirmActions", value)} /></Row>
    </Card>
    <div className="security-note expanded"><ShieldAlert size={18} /><span><strong>系统边界仍然有效。</strong>Windows 会阻止向更高权限或受保护窗口注入输入；Pi Desktop 不会绕过 UIPI。桌面截图可能包含敏感信息，启用后请留意任务上下文。</span></div>
  </>;
}

function CodeReviewPage({ form, update }: { form: AppSettings; update: Update }) {
  return <>
    <PageHeading title="代码审查" description="设置审查结果如何回到你的工作流。" />
    <Card>
      <Row title="审查结果位置" description="在当前聊天中继续，或为审查结果创建独立聊天。"><select value={form.reviewDelivery} onChange={(event) => update("reviewDelivery", event.target.value as AppSettings["reviewDelivery"])}><option value="inline">当前聊天</option><option value="detached">独立聊天</option></select></Row>
    </Card>
  </>;
}

function EnvironmentPage({ form, update }: { form: AppSettings; update: Update }) {
  return <>
    <PageHeading title="环境" description="配置新聊天的工作环境和集成终端。" />
    <Card title="新聊天">
      <Row title="默认工作环境" description="在当前检出中工作，或为任务创建隔离 Git Worktree。"><select value={form.defaultTaskEnvironment} onChange={(event) => update("defaultTaskEnvironment", event.target.value as AppSettings["defaultTaskEnvironment"])}><option value="local">Local（当前工作区）</option><option value="worktree">Worktree（隔离检出）</option></select></Row>
    </Card>
    <Card title="集成终端">
      <Row title="集成终端 Shell" description="选择新终端标签页使用的 Shell。"><select value={form.terminalShell} onChange={(event) => update("terminalShell", event.target.value)}><option>PowerShell</option><option>Command Prompt</option><option>Git Bash</option><option>WSL</option></select></Row>
      <Row title="对话中的命令输出"><select value={form.terminalOutput} onChange={(event) => update("terminalOutput", event.target.value as AppSettings["terminalOutput"])}><option value="summary">摘要</option><option value="full">完整输出</option></select></Row>
    </Card>
  </>;
}

function GitPage({ form, update }: { form: AppSettings; update: Update }) {
  return <>
    <PageHeading title="Git" description="设置分支、提交和拉取请求行为。" />
    <Card>
      <Row title="分支前缀"><input value={form.branchPrefix} onChange={(event) => update("branchPrefix", event.target.value)} placeholder="pi/" /></Row>
      <Row title="允许强制推送" description="允许重写远程分支的工作流。"><Switch label="允许强制推送" checked={form.allowForcePush} onChange={(value) => update("allowForcePush", value)} /></Row>
    </Card>
    <Card title="生成指令">
      <label className="stacked-setting"><span>提交消息</span><textarea value={form.commitMessageInstructions} onChange={(event) => update("commitMessageInstructions", event.target.value)} placeholder="生成提交消息时使用的可选指令" /></label>
      <label className="stacked-setting"><span>拉取请求说明</span><textarea value={form.pullRequestInstructions} onChange={(event) => update("pullRequestInstructions", event.target.value)} placeholder="生成 PR 说明时使用的可选指令" /></label>
    </Card>
  </>;
}

function WorktreesPage({ cwd, worktrees, loading, onCreated }: { cwd: string; worktrees: WorktreeInfo[]; loading: boolean; onCreated: (item: WorktreeInfo) => void }) {
  const [creating, setCreating] = useState(false);
  const create = async () => {
    if (!cwd) return;
    setCreating(true);
    try { onCreated(await pi.createWorktree(cwd)); } finally { setCreating(false); }
  };
  return <>
    <PageHeading title="Worktrees" description="在隔离的 Git Worktree 中运行独立 Pi 任务，不影响当前本地检出。" />
    <div className="worktree-actions"><button className="primary-button" disabled={!cwd || creating} onClick={() => void create()}><GitBranch size={14} />{creating ? "正在创建…" : "创建 Worktree"}</button></div>
    <Card>{loading ? <div className="settings-empty">正在加载 Worktree…</div> : worktrees.length === 0 ? <div className="settings-empty"><GitBranch size={22} />打开 Git 工作区以管理 Worktree</div> : <div className="worktree-list">{worktrees.map((item) => <button key={item.path} onClick={() => void openPath(item.path)}><GitBranch size={17} /><span><strong>{item.isMain ? "本地检出" : item.branch || "游离 Worktree"}</strong><small>{item.path}</small></span><code>{item.head?.slice(0, 8)}</code><ChevronRight size={15} /></button>)}</div>}</Card>
  </>;
}

function DebugPage({ form, update }: { form: AppSettings; update: Update }) {
  return <>
    <PageHeading title="调试" description="查看并配置 Pi 进程、会话和诊断选项。" />
    <Card title="Pi 进程">
      <Row title="可执行程序" description="PATH 中的命令或可执行程序绝对路径。"><input value={form.piBinary} onChange={(event) => update("piBinary", event.target.value)} placeholder="pi" /></Row>
      <Row title="会话目录" description="留空则使用 ~/.pi/agent/sessions。"><input value={form.sessionDir} onChange={(event) => update("sessionDir", event.target.value)} placeholder="~/.pi/agent/sessions" /></Row>
      <Row title="日志等级"><select value={form.logLevel} onChange={(event) => update("logLevel", event.target.value as AppSettings["logLevel"])}><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option><option value="debug">调试</option></select></Row>
    </Card>
    <div className="settings-info"><MonitorCog size={17} /><span>进程、模型、系统提示词和权限更改会在重新连接工作区后生效。</span></div>
    <div className="settings-info"><FileCode2 size={17} /><span>设置文件：%APPDATA%/pid-desktop/settings.json · 个人指令：personal-instructions.md</span></div>
  </>;
}
