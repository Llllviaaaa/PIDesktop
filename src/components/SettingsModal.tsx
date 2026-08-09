import { useEffect, useMemo, useState, type ReactNode } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  Archive,
  BarChart3,
  Bell,
  Blocks,
  Bot,
  ChevronRight,
  FileCode2,
  FolderGit2,
  GitBranch,
  Keyboard,
  MonitorCog,
  Palette,
  RefreshCw,
  Search,
  Settings2,
  Shield,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  TerminalSquare,
  Trash2,
  Undo2,
  UserRound,
  X,
} from "lucide-react";
import { pi } from "../lib/pi";
import type { AppSettings, ResourceItem, SessionInfo, UsageSummary, WorktreeInfo } from "../types";

export type SettingsPage =
  | "general"
  | "appearance"
  | "notifications"
  | "personalization"
  | "shortcuts"
  | "archived"
  | "usage"
  | "models"
  | "resources"
  | "permissions"
  | "terminal"
  | "git"
  | "worktrees"
  | "advanced";

const DEFAULTS: AppSettings = {
  piBinary: "pi",
  provider: "",
  model: "",
  thinkingLevel: "medium",
  sessionDir: "",
  permissionMode: "ask",
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
  theme: "dark",
  accentColor: "#ffffff",
  backgroundColor: "#0f0f10",
  foregroundColor: "#f5f5f5",
  uiFont: "Inter, Segoe UI, system-ui, sans-serif",
  codeFont: "JetBrains Mono, Consolas, monospace",
  uiScale: 100,
  personality: "pragmatic",
  customInstructions: "",
  suggestedPrompts: true,
  memoryEnabled: true,
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
      { id: "general", label: "常规", icon: Settings2, keywords: "权限 语言 启动 后续 文件 permissions language startup" },
      { id: "appearance", label: "外观", icon: Palette, keywords: "主题 黑色 白色 字体 缩放 theme color font" },
      { id: "notifications", label: "通知", icon: Bell, keywords: "完成 审批 系统 提醒 completion approval" },
      { id: "personalization", label: "个性化", icon: UserRound, keywords: "人格 指令 记忆 提示 personality instructions memory" },
      { id: "shortcuts", label: "键盘快捷键", icon: Keyboard, keywords: "按键 绑定 命令 keys bindings" },
      { id: "archived", label: "已归档任务", icon: Archive, keywords: "会话 任务 恢复 删除 历史 sessions restore" },
      { id: "usage", label: "使用情况", icon: BarChart3, keywords: "token 费用 统计 活动 cost statistics" },
    ],
  },
  {
    label: "集成",
    items: [
      { id: "models", label: "模型与提供商", icon: Bot, keywords: "pi 模型 提供商 推理 model provider" },
      { id: "resources", label: "扩展与技能", icon: Blocks, keywords: "软件包 插件 技能 提示词 resources plugins" },
    ],
  },
  {
    label: "编码",
    items: [
      { id: "permissions", label: "权限", icon: Shield, keywords: "审批 沙箱 读取 写入 完全访问 approval sandbox" },
      { id: "terminal", label: "终端", icon: TerminalSquare, keywords: "shell 输出 命令 output commands" },
      { id: "git", label: "Git", icon: FolderGit2, keywords: "review branches commit pull request force push" },
      { id: "worktrees", label: "Worktree", icon: GitBranch, keywords: "并行 隔离 本地 检出 parallel isolated" },
      { id: "advanced", label: "高级", icon: SlidersHorizontal, keywords: "程序 会话 日志 诊断 binary logging" },
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
  const [saving, setSaving] = useState(false);
  const [resources, setResources] = useState<ResourceItem[]>([]);
  const [archived, setArchived] = useState<SessionInfo[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const original = useMemo(() => JSON.stringify({ ...DEFAULTS, ...settings, language: "zh-CN" }), [settings]);
  const dirty = JSON.stringify(form) !== original;

  useEffect(() => setForm({ ...DEFAULTS, ...settings, language: "zh-CN" }), [settings]);
  useEffect(() => setActive(initialPage), [initialPage]);
  useEffect(() => {
    let cancelled = false;
    setLoadingData(true);
    void Promise.all([
      pi.listArchivedSessions(),
      pi.listResources(cwd),
      cwd ? pi.listWorktrees(cwd).catch(() => []) : Promise.resolve([]),
    ]).then(([nextArchived, nextResources, nextWorktrees]) => {
      if (cancelled) return;
      setArchived(nextArchived);
      setForm((current) => ({ ...current, archivedSessions: nextArchived.map((session) => session.file) }));
      setResources(nextResources);
      setWorktrees(nextWorktrees);
      setLoadingData(false);
    });
    void pi.usageSummary().then((summary) => { if (!cancelled) setUsage(summary); });
    return () => { cancelled = true; };
  }, [cwd]);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const filteredNavigation = NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => `${item.label} ${item.keywords}`.toLowerCase().includes(query.toLowerCase())),
  })).filter((section) => section.items.length > 0);

  const save = async () => {
    setSaving(true);
    try {
      const dark = form.theme !== "light";
      await onSave({
        ...form,
        language: "zh-CN",
        accentColor: dark ? "#ffffff" : "#111111",
        backgroundColor: dark ? "#0f0f10" : "#ffffff",
        foregroundColor: dark ? "#f5f5f5" : "#111111",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-center" role="dialog" aria-modal="true" aria-label="设置">
      <aside className="settings-navigation">
        <button className="settings-back" onClick={onClose}><ChevronRight size={16} /> 返回应用</button>
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
        <div className="settings-version"><span className="brand-mark">π</span><span><strong>Pi Desktop</strong><small>设置保存在此设备</small></span></div>
      </aside>

      <main className="settings-content">
        <header className="settings-content-header">
          <div>
            <span>Pi Desktop</span>
            <strong>{NAVIGATION.flatMap((section) => section.items).find((item) => item.id === active)?.label}</strong>
          </div>
          <div>
            {dirty && <span className="unsaved-indicator">有未保存的更改</span>}
            <button className="secondary-button" onClick={() => setForm({ ...DEFAULTS, ...settings, language: "zh-CN" })} disabled={!dirty}>重置</button>
            <button className="primary-button" onClick={() => void save()} disabled={!dirty || saving}>{saving ? "正在保存…" : "保存"}</button>
            <button className="icon-button" onClick={onClose} title="关闭设置"><X size={18} /></button>
          </div>
        </header>
        <div className="settings-page-scroll">
          <div className="settings-page">
            {active === "general" && <GeneralPage form={form} update={update} />}
            {active === "appearance" && <AppearancePage form={form} update={update} />}
            {active === "notifications" && <NotificationsPage form={form} update={update} />}
            {active === "personalization" && <PersonalizationPage form={form} update={update} />}
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
            {active === "models" && <ModelsPage form={form} update={update} />}
            {active === "resources" && <ResourcesPage cwd={cwd} resources={resources} loading={loadingData} onReload={async () => setResources(await pi.listResources(cwd))} />}
            {active === "permissions" && <PermissionsPage form={form} update={update} />}
            {active === "terminal" && <TerminalPage form={form} update={update} />}
            {active === "git" && <GitPage form={form} update={update} />}
            {active === "worktrees" && <WorktreesPage cwd={cwd} worktrees={worktrees} loading={loadingData} onCreated={(item) => setWorktrees((items) => [...items, item])} />}
            {active === "advanced" && <AdvancedPage form={form} update={update} />}
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
      <Row title="重新连接上次工作区" description="启动时恢复上一次打开的本地工作区。"><Switch label="重新连接上次工作区" checked={form.autoConnect} onChange={(value) => update("autoConnect", value)} /></Row>
      <Row title="运行时防止休眠" description="执行长时间本地任务时保持电脑唤醒。"><Switch label="运行时防止休眠" checked={form.preventSleep} onChange={(value) => update("preventSleep", value)} /></Row>
      <Row title="默认文件打开方式"><select value={form.defaultFileOpener} onChange={(event) => update("defaultFileOpener", event.target.value as AppSettings["defaultFileOpener"])}><option value="system">系统默认</option><option value="cursor">Cursor</option><option value="vscode">Visual Studio Code</option></select></Row>
      <Row title="界面语言"><select value="zh-CN" disabled><option value="zh-CN">简体中文</option></select></Row>
    </Card>
  </>;
}

function AppearancePage({ form, update }: { form: AppSettings; update: Update }) {
  const themes: Array<[AppSettings["theme"], string]> = [["system", "跟随系统"], ["light", "白色"], ["dark", "黑色"]];
  return <>
    <PageHeading title="外观" description="选择黑白主题，并调整字体与界面大小。" />
    <div className="theme-grid">
      {themes.map(([theme, label]) => <button key={theme} className={form.theme === theme ? "active" : ""} onClick={() => update("theme", theme)}><span className={`theme-preview ${theme}`}><i /><i /><i /></span><strong>{label}</strong></button>)}
    </div>
    <div className="settings-info"><Palette size={17} /><span>界面只使用黑、白和中性灰；状态警告仍保留必要的辨识颜色。</span></div>
    <Card title="字体与缩放">
      <Row title="界面字体"><input value={form.uiFont} onChange={(event) => update("uiFont", event.target.value)} /></Row>
      <Row title="代码字体"><input value={form.codeFont} onChange={(event) => update("codeFont", event.target.value)} /></Row>
      <Row title="界面缩放" description={`${form.uiScale}%`}><input className="scale-slider" type="range" min="75" max="150" step="5" value={form.uiScale} onChange={(event) => update("uiScale", Number(event.target.value))} /></Row>
    </Card>
  </>;
}

function NotificationsPage({ form, update }: { form: AppSettings; update: Update }) {
  return <>
    <PageHeading title="通知" description="选择 Pi Desktop 在何时提醒你。" />
    <Card>
      <Row title="启用通知" description="允许系统显示任务完成和审批通知。"><Switch label="启用通知" checked={form.notificationsEnabled} onChange={(value) => update("notificationsEnabled", value)} /></Row>
      <Row title="任务完成" description="Pi 完成长时间任务时通知。"><Switch label="任务完成" checked={form.notifyOnCompletion} onChange={(value) => update("notifyOnCompletion", value)} /></Row>
      <Row title="需要审批" description="Pi 等待权限决定时通知。"><Switch label="需要审批" checked={form.notifyOnApproval} onChange={(value) => update("notifyOnApproval", value)} /></Row>
      <Row title="仅窗口未聚焦时" description="Pi Desktop 已处于活动状态时不显示通知。"><Switch label="仅窗口未聚焦时" checked={form.notifyOnlyWhenUnfocused} onChange={(value) => update("notifyOnlyWhenUnfocused", value)} /></Row>
    </Card>
  </>;
}

function PersonalizationPage({ form, update }: { form: AppSettings; update: Update }) {
  return <>
    <PageHeading title="个性化" description="为每个本地会话设置 Pi 的工作风格和长期指令。" />
    <Card title="交流风格">
      <div className="personality-grid">{(["friendly", "pragmatic", "none"] as const).map((personality) => <button key={personality} className={form.personality === personality ? "active" : ""} onClick={() => update("personality", personality)}><Sparkles size={17} /><strong>{personality === "friendly" ? "友好" : personality === "pragmatic" ? "务实" : "无额外风格"}</strong><small>{personality === "friendly" ? "温和、清晰、协作" : personality === "pragmatic" ? "直接、简洁、注重实现" : "不添加额外表达风格"}</small></button>)}</div>
    </Card>
    <Card title="个人指令">
      <p className="card-description">重新连接后，这些指令会追加到 Pi 的系统提示词。项目中的 AGENTS.md 和 CLAUDE.md 仍按各自作用域加载。</p>
      <textarea className="large-settings-textarea" value={form.customInstructions} onChange={(event) => update("customInstructions", event.target.value)} placeholder="例如：优先使用 PowerShell，保留已有用户改动，并先运行针对性测试。" />
      <Row title="项目记忆文件" description="加载 Pi 发现的 AGENTS.md 和 CLAUDE.md 上下文。"><Switch label="项目记忆文件" checked={form.memoryEnabled} onChange={(value) => update("memoryEnabled", value)} /></Row>
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
    <PageHeading title="已归档任务" description="恢复旧任务，或将其移到可恢复的 Pi Desktop 回收站。" />
    <Card>{loading ? <div className="settings-empty"><RefreshCw className="spinner-icon" size={18} /> 正在加载任务…</div> : archived.length === 0 ? <div className="settings-empty"><Archive size={22} />暂无已归档任务</div> : <div className="archive-list">{archived.map((session) => <div key={session.file}><span><strong>{session.name || session.firstMessage || "未命名任务"}</strong><small>{session.cwd} · {session.messageCount} 条消息</small></span><button className="secondary-button" onClick={() => void onRestore(session)}><Undo2 size={13} /> 恢复</button><button className="icon-button danger" onClick={() => void onDelete(session)}><Trash2 size={14} /></button></div>)}</div>}</Card>
  </>;
}

function UsagePage({ usage }: { usage: UsageSummary | null }) {
  const number = (value?: number) => (value ?? 0).toLocaleString();
  return <>
    <PageHeading title="使用情况" description="查看由本机 Pi 会话文件汇总的活动数据。" />
    {!usage ? <div className="settings-empty"><RefreshCw className="spinner-icon" size={18} /> 正在计算使用情况…</div> : <>
      <div className="usage-hero"><span><small>累计 token</small><strong>{number(usage.totalTokens)}</strong></span><span><small>记录费用</small><strong>${usage.totalCost.toFixed(4)}</strong></span><span><small>任务</small><strong>{number(usage.sessions)}</strong></span><span><small>消息</small><strong>{number(usage.messages)}</strong></span></div>
      <Card title="Token 活动"><div className="usage-breakdown"><span><i style={{ width: `${Math.max(5, usage.inputTokens / Math.max(1, usage.totalTokens) * 100)}%` }} /><strong>输入</strong><em>{number(usage.inputTokens)}</em></span><span><i style={{ width: `${Math.max(5, usage.outputTokens / Math.max(1, usage.totalTokens) * 100)}%` }} /><strong>输出</strong><em>{number(usage.outputTokens)}</em></span><span><i style={{ width: `${Math.max(5, usage.reasoningTokens / Math.max(1, usage.totalTokens) * 100)}%` }} /><strong>推理</strong><em>{number(usage.reasoningTokens)}</em></span><span><i style={{ width: `${Math.max(5, usage.cacheReadTokens / Math.max(1, usage.totalTokens) * 100)}%` }} /><strong>缓存读取</strong><em>{number(usage.cacheReadTokens)}</em></span></div></Card>
    </>}
    <div className="settings-info"><BarChart3 size={17} /><span>这些数据由 Pi JSONL 使用记录在本地计算；实际账单和订阅额度以模型提供商为准。</span></div>
  </>;
}

function ModelsPage({ form, update }: { form: AppSettings; update: Update }) {
  const reasoningLabels: Record<string, string> = { off: "关闭", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
  return <>
    <PageHeading title="模型与提供商" description="选择新进程使用的 Pi 提供商、默认模型和推理等级。" />
    <Card title="默认模型">
      <Row title="提供商" description="留空则使用 Pi 已配置的提供商。"><input value={form.provider} onChange={(event) => update("provider", event.target.value)} placeholder="使用 Pi 默认值" /></Row>
      <Row title="模型" description="填写模型 ID 或 Pi 模糊匹配模式。"><input value={form.model} onChange={(event) => update("model", event.target.value)} placeholder="使用 Pi 默认值" /></Row>
      <Row title="推理等级"><select value={form.thinkingLevel} onChange={(event) => update("thinkingLevel", event.target.value)}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option key={level} value={level}>{reasoningLabels[level]}</option>)}</select></Row>
    </Card>
    <div className="settings-info"><Bot size={17} /><span>实时可用模型来自 Pi 已认证的提供商注册表，并可在每个对话中单独选择。</span></div>
  </>;
}

function ResourcesPage({ cwd, resources, loading, onReload }: { cwd: string; resources: ResourceItem[]; loading: boolean; onReload: () => Promise<void> }) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const kindLabels: Record<string, string> = { package: "软件包", extension: "扩展", skill: "技能", prompt: "提示词" };
  const scopeLabels: Record<string, string> = { user: "用户", project: "项目" };
  const action = async (kind: "install" | "remove" | "update", value?: string) => {
    setBusy(true);
    try {
      setResult(await pi.packageAction(kind, value, cwd));
      await onReload();
      if (kind === "install") setSource("");
    } catch (error) {
      setResult(String(error));
    } finally {
      setBusy(false);
    }
  };
  return <>
    <PageHeading title="扩展与技能" description="查看用户和项目作用域中发现的 Pi 软件包、扩展、技能和提示词。" />
    <div className="package-toolbar"><input value={source} onChange={(event) => setSource(event.target.value)} placeholder="npm 软件包、Git 地址或本地路径" /><button className="primary-button" disabled={busy || !source.trim()} onClick={() => void action("install", source)}>{busy ? "正在处理…" : "安装"}</button><button className="secondary-button" disabled={busy} onClick={() => void action("update")}>全部更新</button></div>
    {result && <pre className="package-result">{result}</pre>}
    <Card>{loading ? <div className="settings-empty"><RefreshCw className="spinner-icon" size={18} /> 正在发现资源…</div> : resources.length === 0 ? <div className="settings-empty"><Blocks size={22} />未发现资源</div> : <div className="resource-list">{resources.map((item) => <button key={`${item.kind}-${item.path}`} onClick={() => item.path.includes(":") && void openPath(item.path).catch(() => undefined)}><span className={`resource-kind ${item.kind}`}>{kindLabels[item.kind] || item.kind}</span><span><strong>{item.name}</strong><small>{item.path}</small></span><em>{scopeLabels[item.scope] || item.scope}</em>{item.kind === "package" ? <span role="button" className="resource-remove" title="移除软件包" onClick={(event) => { event.stopPropagation(); void action("remove", item.path); }}><Trash2 size={13} /></span> : <ChevronRight size={14} />}</button>)}</div>}</Card>
    <div className="settings-info"><Blocks size={17} /><span>软件包操作使用 Pi 自身的安装、移除和更新命令；重新连接工作区后资源即可使用。</span></div>
  </>;
}

function PermissionsPage({ form, update }: { form: AppSettings; update: Update }) {
  const modes: Array<[AppSettings["permissionMode"], string, string]> = [
    ["read-only", "只读", "Pi 可以检查工作区，但模型工具不能编辑文件或运行命令。"],
    ["ask", "先询问", "模型发起文件更改或命令前需要确认。"],
    ["workspace-write", "工作区写入", "允许写入工作区；运行命令或访问外部位置前仍需询问。"],
    ["full-access", "完全访问", "允许 Pi 工具调用跳过 Pi Desktop 审批门禁。"],
  ];
  return <>
    <PageHeading title="权限" description="控制 Pi 在工作区启动时应用的默认审批策略。" />
    <div className="permission-options">{modes.map(([mode, title, description]) => <button key={mode} className={form.permissionMode === mode ? "active" : ""} onClick={() => update("permissionMode", mode)}><span className="permission-radio" /><span><strong>{title}</strong><small>{description}</small></span></button>)}</div>
    <div className="security-note expanded"><ShieldAlert size={18} /><span><strong>Pi 不提供 Codex 的操作系统级沙箱。</strong>这些策略由内置 Pi Desktop 扩展在模型工具执行前实施。需要强隔离时，请使用虚拟机、容器、Windows 沙盒或受限账户。</span></div>
  </>;
}

function TerminalPage({ form, update }: { form: AppSettings; update: Update }) {
  return <>
    <PageHeading title="终端" description="配置集成终端的显示方式，以及命令输出进入对话的范围。" />
    <Card>
      <Row title="集成终端 Shell" description="选择新终端标签页使用的 Shell。"><select value={form.terminalShell} onChange={(event) => update("terminalShell", event.target.value)}><option>PowerShell</option><option>Command Prompt</option><option>Git Bash</option><option>WSL</option></select></Row>
      <Row title="对话中的命令输出"><select value={form.terminalOutput} onChange={(event) => update("terminalOutput", event.target.value as AppSettings["terminalOutput"])}><option value="summary">摘要</option><option value="full">完整输出</option></select></Row>
    </Card>
  </>;
}

function GitPage({ form, update }: { form: AppSettings; update: Update }) {
  return <>
    <PageHeading title="Git" description="统一代码检查、分支、提交和拉取请求行为。" />
    <Card>
      <Row title="检查结果位置" description="在当前对话或独立对话中运行代码检查。"><select value={form.reviewDelivery} onChange={(event) => update("reviewDelivery", event.target.value as AppSettings["reviewDelivery"])}><option value="inline">当前对话</option><option value="detached">独立对话</option></select></Row>
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
    <PageHeading title="Worktree" description="在隔离的 Git Worktree 中运行独立 Pi 任务，不影响当前本地检出。" />
    <div className="worktree-actions"><button className="primary-button" disabled={!cwd || creating} onClick={() => void create()}><GitBranch size={14} />{creating ? "正在创建…" : "创建 Worktree"}</button></div>
    <Card>{loading ? <div className="settings-empty">正在加载 Worktree…</div> : worktrees.length === 0 ? <div className="settings-empty"><GitBranch size={22} />打开 Git 工作区以管理 Worktree</div> : <div className="worktree-list">{worktrees.map((item) => <button key={item.path} onClick={() => void openPath(item.path)}><GitBranch size={17} /><span><strong>{item.isMain ? "本地检出" : item.branch || "游离 Worktree"}</strong><small>{item.path}</small></span><code>{item.head?.slice(0, 8)}</code><ChevronRight size={15} /></button>)}</div>}</Card>
  </>;
}

function AdvancedPage({ form, update }: { form: AppSettings; update: Update }) {
  return <>
    <PageHeading title="高级" description="配置 Pi 进程、会话和诊断相关的底层选项。" />
    <Card title="Pi 进程">
      <Row title="可执行程序" description="PATH 中的命令或可执行程序绝对路径。"><input value={form.piBinary} onChange={(event) => update("piBinary", event.target.value)} placeholder="pi" /></Row>
      <Row title="会话目录" description="留空则使用 ~/.pi/agent/sessions。"><input value={form.sessionDir} onChange={(event) => update("sessionDir", event.target.value)} placeholder="~/.pi/agent/sessions" /></Row>
      <Row title="日志等级"><select value={form.logLevel} onChange={(event) => update("logLevel", event.target.value as AppSettings["logLevel"])}><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option><option value="debug">调试</option></select></Row>
    </Card>
    <div className="settings-info"><MonitorCog size={17} /><span>进程、模型、系统提示词和权限更改会在重新连接工作区后生效。</span></div>
    <div className="settings-info"><FileCode2 size={17} /><span>设置文件：%APPDATA%/pid-desktop/settings.json · 个人指令：personal-instructions.md</span></div>
  </>;
}
