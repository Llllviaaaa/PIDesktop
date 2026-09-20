import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Archive,
  BarChart3,
  Bot,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileCode2,
  FileDown,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Globe2,
  Keyboard,
  Network,
  MonitorCog,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Save,
  ServerCog,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Workflow,
  Undo2,
  Upload,
  ArrowDown,
  ArrowUp,
  X,
} from "lucide-react";
import { pi } from "../lib/pi";
import { createCustomAppearanceTheme, type AppearanceCatalog, type AppearanceThemeDefinition } from "../lib/appearanceCatalog";
import { PetAvatar } from "./PetCompanion";
import { ModelsPage } from "./ModelsPage";
import type {
  AppSettings,
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
  transcriptDensity: "normal",
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
  petEnabled: false,
  petCharacter: "cat",
  petSize: 96,
  accentColor: "#18181b",
  backgroundColor: "#ffffff",
  foregroundColor: "#1a1a1a",
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
  browserProfileMode: "temporary",
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

/** Individual settings panels; kept stable so callers can deep-link to any of them. */
const PAGE_INFO: Record<SettingsPage, { label: string; keywords: string }> = {
  general: { label: "常规", keywords: "语言 启动 后续 文件 通知 language startup notifications" },
  environment: { label: "环境", keywords: "shell 输出 命令 终端 local worktree output commands terminal" },
  appearance: { label: "外观", keywords: "主题 黑色 白色 字体 缩放 宠物 theme color font pet" },
  providers: { label: "模型", keywords: "模型 提供商 默认模型 推理 API 密钥 订阅 登录 OAuth ChatGPT Claude Copilot OpenRouter endpoint provider model key login" },
  agent: { label: "工作方式", keywords: "工作模式 权限 审批 沙箱 子 agent 规则 计划 approval sandbox rules plan" },
  personalization: { label: "个性化", keywords: "人格 指令 记忆 提示 personality instructions memory" },
  skills: { label: "技能", keywords: "技能 skill instructions" },
  mcp: { label: "MCP", keywords: "mcp tools stdio http server 工具 服务器" },
  browser: { label: "浏览器", keywords: "edge chrome chromium 网页 自动化 截图 browser web automation screenshot" },
  computer: { label: "电脑操控", keywords: "windows 鼠标 键盘 窗口 截图 computer use mouse keyboard" },
  git: { label: "Git", keywords: "branches commit pull request force push 分支 提交" },
  review: { label: "代码审查", keywords: "review 检查 审阅 delivery" },
  worktrees: { label: "Worktrees", keywords: "并行 隔离 本地 检出 parallel isolated" },
  hooks: { label: "Hooks", keywords: "hooks lifecycle 自动 命令 tool session event" },
  shortcuts: { label: "快捷键", keywords: "按键 绑定 命令 keys bindings" },
  archived: { label: "已归档", keywords: "会话 任务 恢复 删除 历史 sessions restore" },
  usage: { label: "用量", keywords: "token 费用 统计 活动 cost statistics 使用情况 计费" },
  debug: { label: "调试", keywords: "程序 会话 日志 诊断 binary logging" },
};

/**
 * Settings navigation, modeled on Open Vetta's flat tab list. Each entry owns one
 * or more panels: light panels stack as sections, heavy ones switch via sub-tabs.
 */
const SETTINGS_GROUPS: Array<{
  id: string;
  label: string;
  description: string;
  icon: typeof Settings2;
  pages: SettingsPage[];
  layout: "single" | "stack" | "tabs";
}> = [
  { id: "general", label: "通用", description: "启动、消息发送、通知与集成终端。", icon: Settings2, pages: ["general", "environment"], layout: "stack" },
  { id: "appearance", label: "外观", description: "", icon: Palette, pages: ["appearance"], layout: "single" },
  { id: "models", label: "模型", description: "", icon: ServerCog, pages: ["providers"], layout: "single" },
  { id: "agent", label: "Agent", description: "工作模式、审批规则与长期指令。", icon: Bot, pages: ["agent", "personalization"], layout: "stack" },
  { id: "capabilities", label: "能力扩展", description: "技能、MCP 服务器，以及浏览器和电脑操控工具。", icon: Boxes, pages: ["skills", "mcp", "browser", "computer"], layout: "tabs" },
  { id: "coding", label: "代码与 Git", description: "分支、审查、Worktree 与生命周期 Hooks。", icon: FolderGit2, pages: ["git", "review", "worktrees", "hooks"], layout: "tabs" },
  { id: "shortcuts", label: "快捷键", description: "", icon: Keyboard, pages: ["shortcuts"], layout: "single" },
  { id: "archived", label: "已归档", description: "", icon: Archive, pages: ["archived"], layout: "single" },
  { id: "advanced", label: "高级", description: "用量统计与 Pi 进程诊断。", icon: SlidersHorizontal, pages: ["usage", "debug"], layout: "stack" },
];

function groupForPage(page: SettingsPage) {
  return SETTINGS_GROUPS.find((group) => group.pages.includes(page)) ?? SETTINGS_GROUPS[0];
}

/** How a panel's own PageHeading renders once it sits inside a grouped page. */
const PanelHeadingMode = createContext<"page" | "section" | "description">("page");

export function SettingsModal({
  settings,
  cwd,
  appearanceCatalog,
  onReloadAppearance,
  onSave,
  onClose,
  initialPage = "general",
}: {
  settings: AppSettings | null;
  cwd: string;
  appearanceCatalog: AppearanceCatalog;
  onReloadAppearance: () => Promise<void>;
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
    return () => { cancelled = true; };
  }, [cwd, isTauri]);

  const normalizeSettings = (value: AppSettings): AppSettings => {
    return {
      ...value,
      language: "zh-CN",
      petSize: Math.min(224, Math.max(80, Number(value.petSize) || 96)),
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

  const needle = query.trim().toLowerCase();
  const visibleGroups = SETTINGS_GROUPS.filter((group) => !needle || [
    group.label,
    group.description,
    ...group.pages.map((page) => `${PAGE_INFO[page].label} ${PAGE_INFO[page].keywords}`),
  ].join(" ").toLowerCase().includes(needle));
  const activeGroup = groupForPage(active);

  const renderPanel = (page: SettingsPage) => (
    <>
      {page === "general" && <GeneralPage form={form} update={update} />}
      {page === "appearance" && <AppearancePage form={form} update={update} catalog={appearanceCatalog} cwd={cwd} onReload={onReloadAppearance} />}
      {page === "agent" && <AgentPage form={form} update={update} onOpenModels={() => setActive("providers")} />}
      {page === "personalization" && <PersonalizationPage
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
      {page === "shortcuts" && <ShortcutsPage form={form} update={update} />}
      {page === "archived" && <ArchivedPage archived={archived} loading={loadingData} onRestore={async (session) => {
        await pi.restoreSession(session.file);
        setArchived((items) => items.filter((item) => item.file !== session.file));
        setForm((current) => ({ ...current, archivedSessions: current.archivedSessions.filter((file) => file !== session.file) }));
      }} onDelete={async (session) => {
        if (!window.confirm(`将“${session.name || session.firstMessage || "未命名任务"}”移到 Pi Desktop 回收站吗？`)) return;
        await pi.deleteSession(session.file);
        setArchived((items) => items.filter((item) => item.file !== session.file));
      }} />}
      {page === "usage" && <UsagePage usage={usage} />}
      {page === "providers" && <ModelsPage form={form} update={update} />}
      {page === "skills" && <SkillsPage resources={resources} loading={loadingData} />}
      {page === "mcp" && <McpPage form={form} update={update} />}
      {page === "browser" && <BrowserPage form={form} update={update} />}
      {page === "computer" && <ComputerPage form={form} update={update} />}
      {page === "review" && <CodeReviewPage form={form} update={update} />}
      {page === "environment" && <EnvironmentPage form={form} update={update} />}
      {page === "hooks" && <HooksPage form={form} update={update} />}
      {page === "git" && <GitPage form={form} update={update} />}
      {page === "worktrees" && <WorktreesPage cwd={cwd} worktrees={worktrees} loading={loadingData} onCreated={(item) => setWorktrees((items) => [...items, item])} />}
      {page === "debug" && <DebugPage form={form} update={update} />}
    </>
  );

  return (
    <div className="settings-center" role="dialog" aria-modal="true" aria-label="设置">
      <aside className="settings-navigation">
        <div className="settings-nav-title">
          <button className="settings-back" onClick={closeSettings} title="返回应用" aria-label="返回应用"><ChevronRight size={16} /></button>
          <h1>设置</h1>
        </div>
        <label className="settings-search">
          <Search size={15} />
          <input autoFocus placeholder="搜索设置…" value={query} onChange={(event) => setQuery(event.target.value)} />
          {query && <button onClick={() => setQuery("")}><X size={13} /></button>}
        </label>
        <nav className="settings-nav-scroll">
          {visibleGroups.map((group) => {
            const Icon = group.icon;
            return (
              <button
                key={group.id}
                className={activeGroup.id === group.id ? "active" : ""}
                onClick={() => { setActive(group.pages[0]); setQuery(""); }}
              >
                <Icon size={16} /> <span>{group.label}</span>
              </button>
            );
          })}
          {visibleGroups.length === 0 && <div className="settings-no-results">没有匹配的设置</div>}
        </nav>
      </aside>

      <main className="settings-content">
        <header className="settings-content-header">
          <span />
          <div>
            <span className={`settings-save-status ${saveState}`} aria-live="polite">
              {saveState === "pending" || saveState === "saving" ? "正在保存…" : saveState === "saved" ? "已保存" : saveState === "error" ? "保存失败" : ""}
            </span>
            <button className="icon-button" onClick={closeSettings} title="关闭设置"><X size={18} /></button>
          </div>
        </header>
        <div className="settings-page-scroll">
          <div className={`settings-page ${active === "providers" ? "wide" : ""}`}>
            {activeGroup.layout === "single" ? renderPanel(active) : (
              <>
                <div className="settings-page-heading">
                  <h1>{activeGroup.label}</h1>
                  {activeGroup.description && <p>{activeGroup.description}</p>}
                </div>
                {activeGroup.layout === "tabs" ? (
                  <>
                    <div className="settings-subtabs" role="tablist" aria-label={activeGroup.label}>
                      {activeGroup.pages.map((page) => (
                        <button
                          key={page}
                          type="button"
                          role="tab"
                          aria-selected={active === page}
                          className={active === page ? "active" : ""}
                          onClick={() => setActive(page)}
                        >
                          {PAGE_INFO[page].label}
                        </button>
                      ))}
                    </div>
                    <PanelHeadingMode.Provider value="description">{renderPanel(active)}</PanelHeadingMode.Provider>
                  </>
                ) : (
                  <PanelHeadingMode.Provider value="section">
                    {activeGroup.pages.map((page) => <div key={page} className="settings-stack-panel">{renderPanel(page)}</div>)}
                  </PanelHeadingMode.Provider>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

type Update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

function PageHeading({ title, description }: { title: string; description: string }) {
  const mode = useContext(PanelHeadingMode);
  if (mode === "description") return <p className="settings-panel-description">{description}</p>;
  // Stacked panels read as one page: the group heading already introduces them.
  if (mode === "section") return null;
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
      <Row title="对话详细程度" description="摘要隐藏工具轨迹，详细默认展开工作过程。也可在对话里用 Ctrl+O 切换。"><select value={form.transcriptDensity} onChange={(event) => update("transcriptDensity", event.target.value as AppSettings["transcriptDensity"])}><option value="summary">摘要</option><option value="normal">普通</option><option value="verbose">详细</option></select></Row>
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

function ThemePreview({ theme }: { theme: AppearanceThemeDefinition }) {
  if (theme.mode === "system") {
    return <span className="theme-preview system"><i className="theme-system-half light"><b /><b /></i><i className="theme-system-half dark"><b /><b /></i></span>;
  }
  const palette = theme.palette;
  return <span className="theme-preview" style={{ background: palette?.app }}>
    <i style={{ background: palette?.sidebar }} />
    <i style={{ background: palette?.panel }} />
    <i style={{ background: palette?.panelStrong, borderColor: palette?.border }} />
  </span>;
}

function AppearancePage({
  form,
  update,
  catalog,
  cwd,
  onReload,
}: {
  form: AppSettings;
  update: Update;
  catalog: AppearanceCatalog;
  cwd: string;
  onReload: () => Promise<void>;
}) {
  const [extensionScope, setExtensionScope] = useState<"user" | "project">("user");
  const [extensionTarget, setExtensionTarget] = useState<"theme" | "pet" | null>(null);
  const [extensionState, setExtensionState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [extensionNotice, setExtensionNotice] = useState("");
  const customTheme = createCustomAppearanceTheme(form.backgroundColor, form.foregroundColor, form.accentColor);
  const displayedThemes = catalog.themes.map((theme) => theme.id === "custom" ? customTheme : theme);
  const themeOptions = displayedThemes.filter((theme) => theme.id !== "custom");
  const extensionCount = (kind: "theme" | "pet") => (
    kind === "theme"
      ? catalog.themes.filter((theme) => theme.scope !== "builtin").length
      : catalog.pets.filter((pet) => pet.scope !== "builtin").length
  );

  const updateCustomColor = (key: "accentColor" | "backgroundColor" | "foregroundColor", value: string) => {
    update(key, value);
    if (form.theme !== "custom") update("theme", "custom");
  };

  const resetCustomColors = () => {
    update("backgroundColor", "#ffffff");
    update("foregroundColor", "#1a1a1a");
    update("accentColor", "#18181b");
    update("theme", "custom");
  };

  const runExtensionAction = async (kind: "theme" | "pet", action: () => Promise<void>, success: string) => {
    setExtensionTarget(kind);
    setExtensionState("busy");
    setExtensionNotice("");
    try {
      await action();
      setExtensionState("done");
      setExtensionNotice(success);
    } catch (error) {
      setExtensionState("error");
      setExtensionNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const importExtension = async (kind: "theme" | "pet") => {
    const selected = await openDialog(kind === "theme"
      ? {
          title: "导入主题",
          multiple: false,
          directory: false,
          filters: [{ name: "主题 JSON", extensions: ["json"] }],
        }
      : {
          title: "导入宠物目录",
          multiple: false,
          directory: true,
        });
    const source = typeof selected === "string" ? selected : Array.isArray(selected) ? selected[0] : null;
    if (!source) return;
    await runExtensionAction(kind, async () => {
      await pi.installAppearanceExtension(source, cwd, kind, extensionScope);
      await onReload();
    }, kind === "theme" ? "主题已导入" : "宠物已导入");
  };

  const openExtensionDirectory = (kind: "theme" | "pet") => runExtensionAction(
    kind,
    () => pi.openAppearanceDirectory(cwd, kind, extensionScope).then(() => undefined),
    kind === "theme" ? "已打开主题目录" : "已打开宠物目录",
  );

  const renderExtensionControls = (kind: "theme" | "pet") => (
    <div className="appearance-extension-stack">
      <div className="appearance-extension-control">
        <div className="appearance-scope-control" aria-label={`${kind === "theme" ? "主题" : "宠物"}扩展作用域`}>
          <button type="button" className={extensionScope === "user" ? "active" : ""} onClick={() => setExtensionScope("user")}>用户</button>
          <button type="button" className={extensionScope === "project" ? "active" : ""} disabled={!cwd} onClick={() => setExtensionScope("project")}>项目</button>
        </div>
        <button type="button" className="icon-button" title={`安装本地${kind === "theme" ? "主题" : "宠物"}`} disabled={extensionState === "busy"} onClick={() => void importExtension(kind)}><Upload size={15} /></button>
        <button type="button" className="icon-button" title={`打开${extensionScope === "project" ? "项目" : "用户"}${kind === "theme" ? "主题" : "宠物"}目录`} disabled={extensionState === "busy"} onClick={() => void openExtensionDirectory(kind)}><FolderOpen size={15} /></button>
        <button type="button" className="icon-button" title={`重新扫描${kind === "theme" ? "主题" : "宠物"}`} disabled={extensionState === "busy"} onClick={() => void runExtensionAction(kind, onReload, "扩展列表已更新")}><RefreshCw className={extensionState === "busy" && extensionTarget === kind ? "spinner-icon" : ""} size={15} /></button>
      </div>
      {extensionTarget === kind && extensionNotice && <div className={`appearance-extension-notice ${extensionState}`} role="status">{extensionState === "error" ? <CircleAlert size={15} /> : <CheckCircle2 size={15} />}<span>{extensionNotice}</span></div>}
    </div>
  );

  return <>
    <PageHeading title="外观" description="自定义 Pi Desktop 的显示方式。" />
    <Card title="主题">
      <div className="appearance-picker-block">
        <div className="theme-grid" role="radiogroup" aria-label="主题">
          {themeOptions.map((theme) => <button key={theme.id} type="button" role="radio" aria-checked={form.theme === theme.id} className={form.theme === theme.id ? "active" : ""} onClick={() => update("theme", theme.id)}>
            <ThemePreview theme={theme} />
            <span><strong>{theme.label}</strong>{theme.scope !== "builtin" && <small>{theme.scope === "project" ? "项目" : "用户"}</small>}</span>
          </button>)}
        </div>
      </div>
      <Row title="自定义主题" description={form.theme === "custom" ? "当前正在使用；颜色更改会立即生效。" : "设置配色并应用为独立主题。"}>
        <div className="appearance-inline-colors">
          <label title="背景颜色"><span>背景</span><input aria-label="背景颜色" type="color" value={form.backgroundColor} onChange={(event) => updateCustomColor("backgroundColor", event.target.value)} /></label>
          <label title="文字颜色"><span>文字</span><input aria-label="文字颜色" type="color" value={form.foregroundColor} onChange={(event) => updateCustomColor("foregroundColor", event.target.value)} /></label>
          <label title="强调色"><span>强调</span><input aria-label="强调色" type="color" value={form.accentColor} onChange={(event) => updateCustomColor("accentColor", event.target.value)} /></label>
          {form.theme !== "custom" && <button type="button" className="secondary-button compact" onClick={() => update("theme", "custom")}>应用</button>}
          <button type="button" className="icon-button" title="恢复默认颜色" onClick={resetCustomColors}><Undo2 size={15} /></button>
        </div>
      </Row>
      <Row title="主题扩展" description={`${extensionCount("theme")} 个已安装；可安装到当前用户或项目。`}>{renderExtensionControls("theme")}</Row>
    </Card>

    <Card title="桌面宠物">
      <Row title="显示桌面宠物" description="在 Windows 桌面显示会响应任务状态、可自由拖动的小伙伴。"><Switch label="显示桌面宠物" checked={form.petEnabled} onChange={(value) => update("petEnabled", value)} /></Row>
      <div className="appearance-picker-block appearance-pet-picker-block">
        <div className="pet-character-picker" role="radiogroup" aria-label="桌面宠物角色">
          {catalog.pets.map((pet) => (
            <button key={pet.id} type="button" role="radio" aria-checked={form.petCharacter === pet.id} className={`pet-option-${pet.builtinCharacter ?? "custom"}${form.petCharacter === pet.id ? " active" : ""}`} onClick={() => update("petCharacter", pet.id)}>
              <span className="pet-option-preview"><PetAvatar pet={pet} /></span>
              <span><strong>{pet.label}</strong>{pet.scope !== "builtin" && <small>{pet.scope === "project" ? "项目" : "用户"}</small>}</span>
            </button>
          ))}
        </div>
      </div>
      <Row title="宠物大小" description="调整桌面宠物的显示大小，修改后会立即生效。">
        <label className="pet-size-control">
          <span className="pet-size-sample small" aria-hidden="true" />
          <input
            aria-label="宠物大小"
            type="range"
            min="80"
            max="224"
            step="4"
            value={form.petSize}
            onInput={(event) => update("petSize", Number(event.currentTarget.value))}
          />
          <span className="pet-size-sample large" aria-hidden="true" />
          <output>{form.petSize}px</output>
        </label>
      </Row>
      <Row title="宠物扩展" description={`${extensionCount("pet")} 个已安装；可安装到当前用户或项目。`}>{renderExtensionControls("pet")}</Row>
    </Card>

    {catalog.errors.length > 0 && <div className="settings-info appearance-errors"><CircleAlert size={17} /><span>{catalog.errors.map((error) => <small key={`${error.kind}-${error.name}`}>{error.name}：{error.message}</small>)}</span></div>}

    <Card title="偏好设置">
      <Row title="界面字体"><input value={form.uiFont} onChange={(event) => update("uiFont", event.target.value)} /></Row>
      <Row title="代码字体"><input value={form.codeFont} onChange={(event) => update("codeFont", event.target.value)} /></Row>
      <Row title="界面缩放" description="调整应用内容的整体显示大小。"><label className="appearance-number-control"><input aria-label="界面缩放百分比" type="number" min="75" max="150" step="5" value={form.uiScale} onChange={(event) => update("uiScale", Number(event.target.value))} /><span>%</span></label></Row>
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

function AgentPage({ form, update, onOpenModels }: { form: AppSettings; update: Update; onOpenModels: () => void }) {
  return <>
    <PageHeading title="配置" description="设置新聊天的工作模式、审批策略和本地 Agent 能力。" />
    <Card title="默认模型">
      <Row title="默认模型和推理等级" description="已移到「模型」页，与提供商连接放在一起。"><button className="secondary-button" onClick={onOpenModels}>打开模型设置<ChevronRight size={14} /></button></Row>
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
      <div className="tool-rules-heading"><span>按列表顺序匹配；只读与计划模式始终优先。完全访问下阻止规则仍然生效，确认规则则直接放行。</span><button type="button" className="secondary-button compact" onClick={() => update("toolRules", [...form.toolRules, { id: `rule-${Date.now().toString(36)}`, enabled: true, toolPattern: "bash", action: "confirm", commandPrefix: "", pathPrefix: "" }])}><Plus size={13} />添加规则</button></div>
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
    <PageHeading title="Agent 浏览器" description="让 Pi 使用 Grok 风格的 browser_* 工具，通过本机 Chromium 会话检查和操作网页。" />
    <Card title="Agent 浏览器工具">
      <Row title="启用 Agent 浏览器" description="为新启动的 Pi 任务注册 browser_navigate、browser_inspect、browser_click 等工具。"><Switch label="启用 Agent 浏览器" checked={form.browserEnabled} onChange={(value) => update("browserEnabled", value)} /></Row>
      <Row title="后台运行" description="使用无头浏览器并在 Pi Desktop 中显示页面结果和截图。"><Switch label="后台运行浏览器" checked={form.browserHeadless} onChange={(value) => update("browserHeadless", value)} /></Row>
      <Row title="网站数据" description="临时模式在任务结束后清理；保留模式使用 PIDesktop 专用配置保存 Cookie 和登录状态，不读取日常浏览器资料。"><select value={form.browserProfileMode} onChange={(event) => update("browserProfileMode", event.target.value as AppSettings["browserProfileMode"])}><option value="temporary">任务结束后清理</option><option value="persistent">保留在 PIDesktop 中</option></select></Row>
      <Row title="操作前审批" description="打开页面、新建或关闭标签、点击、输入、上传和下载前请求确认；检查、切换标签、导航、滚动和截图保持只读。"><Switch label="浏览器操作前审批" checked={form.browserConfirmActions} onChange={(value) => update("browserConfirmActions", value)} /></Row>
      <Row title="浏览器程序" description="留空时依次查找 Edge、Chrome 和 Chromium。"><input value={form.browserExecutable} onChange={(event) => update("browserExecutable", event.target.value)} placeholder="自动检测" /></Row>
    </Card>
    <div className="settings-info"><Globe2 size={17} /><span>browser_upload 仅允许访问当前工作区。设置修改将在新任务中生效。</span></div>
  </>;
}

function ComputerPage({ form, update }: { form: AppSettings; update: Update }) {
  return <>
    <PageHeading title="电脑操控" description="允许 Pi 使用 Grok 风格的 computer_* 工具查看桌面，并在审批后进入控制会话。" />
    <Card title="Computer Use">
      <Row title="启用计算机工具" description="为新任务注册 computer_start、computer_screenshot、computer_click 等工具。"><Switch label="启用计算机工具" checked={form.computerEnabled} onChange={(value) => update("computerEnabled", value)} /></Row>
      <Row title="交互操作前审批" description="computer_start 进入 control 以及点击、移动、滚动、输入和按键前必须确认；观察、截图和窗口检查保持只读。"><Switch label="计算机操作前审批" checked={form.computerConfirmActions} onChange={(value) => update("computerConfirmActions", value)} /></Row>
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
      <Row title="可执行程序" description="默认使用安装包内置 Pi；填写 PATH 命令或绝对路径可覆盖。"><input value={form.piBinary} onChange={(event) => update("piBinary", event.target.value)} placeholder="pi（内置）" /></Row>
      <Row title="会话目录" description="留空则使用 ~/.pi/agent/sessions。"><input value={form.sessionDir} onChange={(event) => update("sessionDir", event.target.value)} placeholder="~/.pi/agent/sessions" /></Row>
      <Row title="日志等级"><select value={form.logLevel} onChange={(event) => update("logLevel", event.target.value as AppSettings["logLevel"])}><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option><option value="debug">调试</option></select></Row>
    </Card>
    <div className="settings-info"><MonitorCog size={17} /><span>进程、模型、系统提示词和权限更改会在重新连接工作区后生效。</span></div>
    <div className="settings-info"><FileCode2 size={17} /><span>设置文件：%APPDATA%/pid-desktop/settings.json · 个人指令：personal-instructions.md</span></div>
  </>;
}
