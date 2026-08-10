import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Blocks,
  Clock3,
  FileDiff,
  FolderOpen,
  GitPullRequest,
  Globe2,
  Menu,
  Minus,
  MoreHorizontal,
  Pencil,
  Settings,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { pi, subscribeToPi } from "./lib/pi";
import { usePiStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { Message } from "./components/Message";
import { Composer } from "./components/Composer";
import { SettingsModal, type SettingsPage } from "./components/SettingsModal";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { InspectorPanel, type InspectorTab } from "./components/InspectorPanel";
import type { AttachmentPayload, SessionInfo } from "./types";

const STARTERS = [
  "解释这个代码库及其架构",
  "检查当前改动中是否存在问题",
  "运行测试并修复失败项",
  "找出当前最重要的未完成工作",
];

type HubView = "pull-requests" | "sites" | "scheduled" | "plugins";

const ACTIVE_RUNTIME_KEY = "pid-desktop:active-runtime";
const LAST_TASK_KEY = "pid-desktop:last-task";

interface PersistedTask {
  cwd: string;
  sessionFile: string;
}

function readPersistedTask(): PersistedTask | null {
  try {
    const raw = window.localStorage.getItem(LAST_TASK_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PersistedTask>;
    return typeof value.cwd === "string" && typeof value.sessionFile === "string"
      ? { cwd: value.cwd, sessionFile: value.sessionFile }
      : null;
  } catch {
    return null;
  }
}

export default function App() {
  const store = usePiStore();
  const {
    connection,
    cwd,
    messages,
    sessions,
    settings,
    sessionFile,
    sessionId,
    sessionName,
    isStreaming,
    isCompacting,
    retryStatus,
    model,
    thinkingLevel,
    availableModels,
    availableThinkingLevels,
    commands,
    stats,
    git,
    browser,
    terminal,
    piLog,
    extensionRequest,
    extensionStatuses,
    extensionWidgets,
    composerPrefill,
    runtimeId,
    runtimes,
    toasts,
  } = store;
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("general");
  const [hubView, setHubView] = useState<HubView | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [taskEnvironment, setTaskEnvironment] = useState<"local" | "worktree">("local");
  const [draftWorkspace, setDraftWorkspace] = useState(() => window.localStorage.getItem("pid-desktop:last-workspace") || "");
  const [quickChat, setQuickChat] = useState(false);
  const [goalStartedAt, setGoalStartedAt] = useState<number | null>(null);
  const [goalElapsed, setGoalElapsed] = useState(0);
  const [goalEditPrefill, setGoalEditPrefill] = useState<string | null>(null);
  const [runtimeRecoveryDone, setRuntimeRecoveryDone] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const autoConnectedRef = useRef(false);
  const isTauri = "__TAURI_INTERNALS__" in window;
  const appWindow = isTauri ? getCurrentWindow() : null;

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void (async () => {
      cleanup = await subscribeToPi({
        onEvent: store.handleEvent,
        onStatus: store.handleStatus,
        onLog: store.handleLog,
      });
      if (disposed) {
        cleanup();
        return;
      }
      await Promise.all([store.loadSettings(), store.refreshSessions()]);
      const preferredRuntimeId = window.localStorage.getItem(ACTIVE_RUNTIME_KEY);
      await store.restoreRuntimes(preferredRuntimeId);
      if (!disposed) setRuntimeRecoveryDone(true);
    })().catch((error) => {
      store.appendLog(`初始化失败：${error instanceof Error ? error.message : String(error)}`);
      if (!disposed) setRuntimeRecoveryDone(true);
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [isTauri, store.appendLog, store.handleEvent, store.handleStatus, store.handleLog, store.loadSettings, store.refreshSessions, store.restoreRuntimes]);

  useEffect(() => {
    if (!runtimeRecoveryDone || !settings?.autoConnect || autoConnectedRef.current || connection !== "disconnected") return;
    const lastTask = readPersistedTask();
    const lastWorkspace = lastTask?.cwd || window.localStorage.getItem("pid-desktop:last-workspace");
    if (!lastWorkspace) return;
    const sessionFile = lastTask?.sessionFile && sessions.some((session) => session.file === lastTask.sessionFile)
      ? lastTask.sessionFile
      : undefined;
    autoConnectedRef.current = true;
    void store.connect(lastWorkspace, sessionFile);
  }, [connection, runtimeRecoveryDone, sessions, settings?.autoConnect, store.connect]);

  useEffect(() => {
    if (!runtimeId || !cwd) return;
    window.localStorage.setItem(ACTIVE_RUNTIME_KEY, runtimeId);
    window.localStorage.setItem("pid-desktop:last-workspace", cwd);
    if (sessionFile) {
      window.localStorage.setItem(LAST_TASK_KEY, JSON.stringify({ cwd, sessionFile } satisfies PersistedTask));
    }
  }, [cwd, runtimeId, sessionFile]);

  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
    root.dataset.theme = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
    const dark = (root.dataset.theme || "dark") === "dark";
    root.style.setProperty("--accent-custom", dark ? "#ffffff" : "#111111");
    root.style.setProperty("--code-font", settings.codeFont);
    root.style.fontFamily = settings.uiFont;
    root.style.setProperty("--app", dark ? "#0f0f10" : "#ffffff");
    root.style.setProperty("--text", dark ? "#f5f5f5" : "#111111");
    const appRoot = document.getElementById("root");
    if (appRoot) {
      const scale = settings.uiScale / 100;
      appRoot.style.zoom = String(scale);
      appRoot.style.width = `${100 / scale}%`;
      appRoot.style.height = `${100 / scale}%`;
    }
  }, [settings]);

  useEffect(() => {
    if (isTauri) return;
    document.documentElement.dataset.theme = new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark";
  }, [isTauri]);

  useEffect(() => {
    if (!settings) return;
    const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, "").replace("control", "ctrl");
    const shortcutFor = (event: KeyboardEvent) => [
      event.ctrlKey ? "Ctrl" : "",
      event.altKey ? "Alt" : "",
      event.shiftKey ? "Shift" : "",
      event.metaKey ? "Meta" : "",
      event.key.length === 1 ? event.key.toUpperCase() : event.key,
    ].filter(Boolean).join("+");
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = normalize(shortcutFor(event));
      if (shortcut === normalize(settings.shortcutSettings) || (event.ctrlKey && event.key === ",")) {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (settingsOpen && event.key === "Escape") {
        event.preventDefault();
        setSettingsOpen(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if (shortcut === normalize(settings.shortcutNewChat) && connection === "running") {
        event.preventDefault();
        store.prepareNewTask();
        setQuickChat(false);
        setHubView(null);
      } else if (shortcut === normalize(settings.shortcutTerminal)) {
        event.preventDefault();
        setInspectorTab((value) => value === "terminal" ? null : "terminal");
      } else if (shortcut === normalize(settings.shortcutChanges)) {
        event.preventDefault();
        setInspectorTab((value) => value === "changes" ? null : "changes");
      } else if (shortcut === normalize(settings.shortcutToggleSidebar)) {
        event.preventDefault();
        setSidebarVisible((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [connection, settings, settingsOpen, store.prepareNewTask]);

  useEffect(() => {
    setTitleDraft(sessionName || (sessionId ? `任务 ${sessionId.slice(0, 8)}` : "新任务"));
  }, [sessionId, sessionName]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: isStreaming ? "auto" : "smooth", block: "end" });
  }, [isStreaming, messages.length, messages[messages.length - 1]?.content]);

  useEffect(() => {
    if (draftWorkspace || sessions.length === 0) return;
    const firstProject = sessions.find((session) => !session.cwd.toLowerCase().endsWith("quick-chat"))?.cwd;
    if (firstProject) setDraftWorkspace(firstProject);
  }, [draftWorkspace, sessions]);

  useEffect(() => {
    if (!isStreaming) {
      setGoalStartedAt(null);
      setGoalElapsed(0);
      return;
    }
    setGoalStartedAt((value) => value ?? Date.now());
  }, [isStreaming]);

  useEffect(() => {
    if (!goalStartedAt) return;
    const update = () => setGoalElapsed(Math.max(0, Math.floor((Date.now() - goalStartedAt) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [goalStartedAt]);

  const selectWorkspace = useCallback((workspace: string) => {
    window.localStorage.setItem("pid-desktop:last-workspace", workspace);
    setDraftWorkspace(workspace);
    setQuickChat(false);
  }, []);

  const pickFolder = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: "为 Pi 打开工作区" });
    if (typeof selected !== "string") return;
    selectWorkspace(selected);
  }, [selectWorkspace]);

  const pickAttachments = useCallback(async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      title: "向任务添加文件",
    });
    const files = typeof selected === "string" ? [selected] : selected ?? [];
    const loaded = await Promise.all(files.map(async (file) => {
      try {
        return await pi.readAttachment(file);
      } catch (error) {
        store.appendLog(`附件读取失败：${String(error)}`);
        return null;
      }
    }));
    setAttachments((current) => {
      const next = [...current];
      for (const item of loaded) {
        if (item && !next.some((existing) => existing.path === item.path)) next.push(item);
      }
      return next;
    });
  }, [store.appendLog]);

  const openSession = useCallback(async (session: SessionInfo) => {
    const workspace = session.cwd || cwd;
    if (!workspace) return;
    window.localStorage.setItem("pid-desktop:last-workspace", workspace);
    setDraftWorkspace(workspace);
    setQuickChat(workspace.toLowerCase().endsWith("quick-chat"));
    setHubView(null);
    await store.switchSession(workspace, session.file);
  }, [cwd, store.switchSession]);

  const newWorktreeChat = useCallback(async () => {
    if (!cwd) return;
    const worktree = await pi.createWorktree(cwd, git?.branch);
    window.localStorage.setItem("pid-desktop:last-workspace", worktree.path);
    await store.connect(worktree.path);
  }, [cwd, git?.branch, store.connect]);

  const permissionLabel = settings?.permissionMode === "read-only"
    ? "只读"
    : settings?.permissionMode === "workspace-write"
      ? "工作区写入"
      : settings?.permissionMode === "full-access"
        ? "完全访问"
        : "先询问";
  const connected = connection === "running";
  const newTask = messages.length === 0;
  const workspaceOptions = useMemo(
    () => [draftWorkspace, cwd, ...sessions.map((session) => session.cwd)]
      .filter((item): item is string => Boolean(item) && !item.toLowerCase().endsWith("quick-chat")),
    [cwd, draftWorkspace, sessions],
  );
  const runningSessionFiles = useMemo(
    () => Object.values(runtimes).filter((runtime) => runtime.isStreaming && runtime.sessionFile).map((runtime) => runtime.sessionFile as string),
    [runtimes],
  );
  const approvalSessionFiles = useMemo(
    () => Object.values(runtimes).filter((runtime) => runtime.extensionRequest && runtime.sessionFile).map((runtime) => runtime.sessionFile as string),
    [runtimes],
  );
  const taskWorkspaceName = quickChat
    ? "快速对话"
    : draftWorkspace.split(/[\\/]/).filter(Boolean).pop() || "一个项目";
  const statusText = isCompacting
    ? "正在压缩上下文…"
    : retryStatus || (isStreaming ? "Pi 正在工作…" : connected ? "就绪" : connection === "starting" ? "正在启动 Pi…" : "未连接");
  const currentGoal = useMemo(
    () => [...messages].reverse().find((message) => message.role === "user")?.content.trim() || sessionName || "处理当前任务",
    [messages, sessionName],
  );

  const sendFromComposer = useCallback(async (text: string, behavior?: "steer" | "followUp") => {
    let current = usePiStore.getState();
    let workspace = quickChat ? await pi.quickChatDir() : draftWorkspace || current.cwd;
    if (!workspace) {
        const selected = await open({ directory: true, multiple: false, title: "选择任务项目" });
        if (typeof selected !== "string") return;
        workspace = selected;
        selectWorkspace(selected);
    }
    const normalize = (value: string) => value.replace(/[\\/]+$/, "").toLowerCase();
    if (current.connection !== "running" || normalize(current.cwd) !== normalize(workspace)) {
      window.localStorage.setItem("pid-desktop:last-workspace", workspace);
      await current.connect(workspace);
      current = usePiStore.getState();
      if (current.connection !== "running") return;
    }
    if (taskEnvironment === "worktree" && current.messages.length === 0) {
      try {
        const worktree = await pi.createWorktree(current.cwd, current.git?.branch);
        window.localStorage.setItem("pid-desktop:last-workspace", worktree.path);
        await current.connect(worktree.path);
        current = usePiStore.getState();
        if (current.connection !== "running") return;
      } catch (error) {
        current.appendLog(`创建 Worktree 失败：${String(error)}`);
        return;
      }
    }
    await current.sendMessage(text, attachments, behavior);
    setAttachments([]);
  }, [attachments, draftWorkspace, quickChat, selectWorkspace, taskEnvironment]);

  const startNewTask = useCallback((asQuickChat = false) => {
    const current = usePiStore.getState();
    if (current.cwd && !current.cwd.toLowerCase().endsWith("quick-chat")) setDraftWorkspace(current.cwd);
    current.prepareNewTask();
    setQuickChat(asQuickChat);
    if (asQuickChat) setTaskEnvironment("local");
    setInspectorTab(null);
    setHubView(null);
  }, []);

  const openSettingsPage = useCallback((page: SettingsPage) => {
    setSettingsPage(page);
    setSettingsOpen(true);
  }, []);

  const requestReview = useCallback(async () => {
    if (settings?.reviewDelivery === "detached") {
      const current = usePiStore.getState();
      const workspace = current.cwd;
      current.prepareNewTask();
      if (workspace) await usePiStore.getState().connect(workspace);
    }
    await usePiStore.getState().sendMessage("检查当前 Git 更改的正确性、回归风险、安全问题和缺失测试。按严重程度列出发现，并提供准确的文件引用。");
  }, [settings?.reviewDelivery]);

  const renderComposer = (variant: "task-start" | "follow-up") => (
    <Composer
      variant={variant}
      isStreaming={isStreaming}
      disabled={connection === "starting"}
      attachments={attachments}
      commands={commands}
      models={availableModels}
      model={model}
      thinkingLevel={thinkingLevel}
      thinkingLevels={availableThinkingLevels}
      prefill={goalEditPrefill ?? composerPrefill}
      pendingCount={store.steeringQueue.length + store.followUpQueue.length}
      requireCtrlEnter={settings?.requireCtrlEnter}
      defaultFollowUpBehavior={settings?.followUpBehavior}
      workspace={quickChat ? "" : draftWorkspace}
      workspaceOptions={workspaceOptions}
      environment={taskEnvironment}
      quickChat={quickChat}
      permissionLabel={permissionLabel}
      onSend={sendFromComposer}
      onStop={() => void store.abort()}
      onPickAttachments={() => void pickAttachments()}
      onRemoveAttachment={(path) => setAttachments((items) => items.filter((item) => item.path !== path))}
      onModelChange={(next) => void store.setModel(next)}
      onThinkingChange={(level) => void store.setThinkingLevel(level)}
      onWorkspaceSelect={selectWorkspace}
      onPickWorkspace={() => void pickFolder()}
      onQuickChat={() => { setQuickChat(true); setTaskEnvironment("local"); }}
      onEnvironmentChange={setTaskEnvironment}
      onPermissionClick={() => openSettingsPage("permissions")}
      onPrefillConsumed={() => {
        setGoalEditPrefill(null);
        store.clearComposerPrefill();
      }}
    />
  );

  return (
    <div className="app-shell">
      <header className="topbar" data-tauri-drag-region>
        <div className="topbar-left" data-tauri-drag-region>
          {!sidebarVisible && (
            <button className="icon-button" onClick={() => setSidebarVisible(true)} title="显示侧栏"><Menu size={17} /></button>
          )}
          <button className="workspace-title" onClick={() => void pickFolder()} title={(newTask ? draftWorkspace : cwd) || "打开工作区"}>
            <FolderOpen size={14} />
            <span>{quickChat && newTask ? "快速对话" : (newTask ? draftWorkspace : cwd).split(/[\\/]/).filter(Boolean).pop() || "打开工作区"}</span>
          </button>
          <span className="topbar-separator">/</span>
          {editingTitle && connected ? (
            <input
              autoFocus
              className="title-input"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              onBlur={() => {
                setEditingTitle(false);
                if (titleDraft.trim() !== sessionName) void store.setSessionName(titleDraft);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setTitleDraft(sessionName || "新任务");
                  setEditingTitle(false);
                }
              }}
            />
          ) : (
            <button className="chat-title" onClick={() => connected && setEditingTitle(true)}>
              <span>{titleDraft || "新任务"}</span>
              {connected && <Pencil size={11} />}
            </button>
          )}
        </div>
        <div className="topbar-right" data-tauri-drag-region>
          <button className={`topbar-button ${inspectorTab === "changes" ? "active" : ""}`} onClick={() => setInspectorTab(inspectorTab === "changes" ? null : "changes")}>
            <FileDiff size={14} /> 更改
            {git?.files.length ? <span className="count-badge">{git.files.length}</span> : null}
          </button>
          <button className={`topbar-button ${inspectorTab === "terminal" ? "active" : ""}`} onClick={() => setInspectorTab(inspectorTab === "terminal" ? null : "terminal")}>
            <Terminal size={14} /> 终端
          </button>
          {settings?.browserEnabled !== false && <button className={`topbar-button ${inspectorTab === "browser" ? "active" : ""}`} onClick={() => setInspectorTab(inspectorTab === "browser" ? null : "browser")}>
            <Globe2 size={14} /> 浏览器
          </button>}
          <button className="icon-button" onClick={() => setSettingsOpen(true)} title="设置"><Settings size={16} /></button>
          <div className="topbar-menu-wrap">
            <button className="icon-button" title="任务操作" onClick={() => setMoreOpen((value) => !value)}><MoreHorizontal size={17} /></button>
            {moreOpen && (
              <div className="topbar-menu">
                <button onClick={() => { setMoreOpen(false); startNewTask(false); }}>新任务</button>
                <button disabled={!connected || !git?.isRepository} onClick={() => { setMoreOpen(false); void newWorktreeChat(); }}>新建 Worktree 任务</button>
                <button disabled={!connected} onClick={() => { setMoreOpen(false); void store.cloneSession(); }}>克隆当前分支</button>
                <button disabled={!connected || isStreaming} onClick={() => { setMoreOpen(false); void store.forkLatest(); }}>从最新检查点分叉</button>
                <button disabled={!connected || isStreaming} onClick={() => { setMoreOpen(false); void store.compact(); }}>压缩上下文</button>
                <button disabled={!connected} onClick={() => { setMoreOpen(false); void store.exportSession(); }}>导出为 HTML</button>
                <button disabled={!sessionFile || isStreaming} onClick={() => {
                  setMoreOpen(false);
                  if (!sessionFile) return;
                  void pi.archiveSession(sessionFile).then(async () => {
                    await store.disconnect();
                    store.prepareNewTask();
                    await store.refreshSessions();
                  });
                }}>归档任务</button>
                <div className="menu-separator" />
                <button disabled={!connected} onClick={() => { setMoreOpen(false); void store.disconnect(); }}>断开 Pi</button>
              </div>
            )}
          </div>
          <div className="window-controls">
            <button className="window-control" onClick={() => void appWindow?.minimize()} title="最小化" aria-label="最小化窗口">
              <Minus size={15} strokeWidth={1.6} />
            </button>
            <button className="window-control" onClick={() => void appWindow?.toggleMaximize()} title="最大化或还原" aria-label="最大化或还原窗口">
              <Square size={12} strokeWidth={1.5} />
            </button>
            <button className="window-control close" onClick={() => void appWindow?.close()} title="关闭" aria-label="关闭窗口">
              <X size={16} strokeWidth={1.6} />
            </button>
          </div>
        </div>
      </header>

      <div className="workspace-shell">
        {sidebarVisible && (
          <Sidebar
            sessions={sessions}
            currentSessionFile={sessionFile}
            runningSessionFiles={runningSessionFiles}
            approvalSessionFiles={approvalSessionFiles}
            runningCount={Object.values(runtimes).filter((runtime) => runtime.isStreaming).length}
            cwd={cwd}
            connection={connection}
            onNewSession={() => void startNewTask(false)}
            onQuickChat={() => void startNewTask(true)}
            onOpenPullRequests={() => setHubView("pull-requests")}
            onOpenSites={() => setHubView("sites")}
            onOpenScheduled={() => setHubView("scheduled")}
            onOpenPlugins={() => setHubView("plugins")}
            onOpenSession={(session) => void openSession(session)}
            onDeleteSession={(session) => {
              if (!window.confirm(`将“${session.name || session.firstMessage || "未命名任务"}”移到回收站吗？`)) return;
              void pi.deleteSession(session.file).then(store.refreshSessions);
            }}
            onArchiveSession={(session) => {
              void pi.archiveSession(session.file).then(async () => {
                await store.loadSettings();
                await store.refreshSessions();
              });
            }}
            onOpenSettings={() => openSettingsPage("general")}
            onPickFolder={() => void pickFolder()}
            onClose={() => setSidebarVisible(false)}
          />
        )}

        <main className="main-stage">
          {hubView ? (
            <div className="feature-hub">
              <div className="feature-hub-heading">
                <span className="feature-hub-icon">
                  {hubView === "pull-requests" ? <GitPullRequest size={22} /> : hubView === "sites" ? <Globe2 size={22} /> : hubView === "scheduled" ? <Clock3 size={22} /> : <Blocks size={22} />}
                </span>
                <div>
                  <h1>{hubView === "pull-requests" ? "拉取请求" : hubView === "sites" ? "站点" : hubView === "scheduled" ? "已安排" : "插件"}</h1>
                  <p>{hubView === "pull-requests"
                    ? "查看当前项目的更改，让 Pi 在提交前完成代码审查。"
                    : hubView === "sites"
                      ? "让 Pi 识别 Web 项目、启动开发服务器并检查页面。"
                      : hubView === "scheduled"
                        ? "集中查看和创建定时运行的后台任务。"
                        : "管理扩展、技能、提示词和工具包。"}</p>
                </div>
              </div>
              <div className="feature-hub-card">
                {hubView === "pull-requests" && <>
                  <div className="feature-hub-stat"><strong>{git?.branch || "未检测到分支"}</strong><span>{git?.files.length ?? 0} 个本地更改</span></div>
                  <div className="feature-hub-actions">
                    <button className="primary-button" disabled={!git?.isRepository} onClick={() => { setHubView(null); setInspectorTab("changes"); }}>查看更改</button>
                    <button className="secondary-button" disabled={!git?.isRepository || isStreaming} onClick={() => { setHubView(null); void requestReview(); }}>让 Pi 审查</button>
                  </div>
                </>}
                {hubView === "sites" && <>
                  <div className="feature-hub-stat"><strong>{draftWorkspace.split(/[\\/]/).filter(Boolean).pop() || "选择一个项目"}</strong><span>本地预览与页面检查</span></div>
                  <div className="feature-hub-actions">
                    <button className="primary-button" onClick={() => {
                      setHubView(null);
                      void sendFromComposer("识别这个项目中的 Web 应用，启动本地开发服务器，检查首页是否可用，并把预览地址告诉我。若启动失败，请直接修复。", undefined);
                    }}>启动并检查站点</button>
                  </div>
                </>}
                {hubView === "scheduled" && <>
                  <div className="feature-hub-empty"><Clock3 size={20} /><strong>还没有已安排的任务</strong><span>计划任务运行器将在下一轮接入；这里不会把普通聊天伪装成定时执行。</span></div>
                </>}
                {hubView === "plugins" && <>
                  <div className="feature-hub-stat"><strong>Pi 资源</strong><span>扩展、技能、提示词与包</span></div>
                  <div className="feature-hub-actions"><button className="primary-button" onClick={() => openSettingsPage("resources")}>打开插件与资源设置</button></div>
                </>}
              </div>
            </div>
          ) : <>
          <div className={`conversation-scroll ${newTask ? "new-task-scroll" : ""}`}>
            <div className={`conversation ${newTask ? "new-task-conversation" : ""}`}>
              {newTask ? (
                <div className="new-task-screen">
                  <div className="welcome-mark">π</div>
                  <h1>我们应该在 {taskWorkspaceName} 中做些什么？</h1>
                  {store.lastError && <p className="new-task-error">{store.lastError}</p>}
                  {settings?.suggestedPrompts !== false && <div className="starter-grid">
                    {STARTERS.map((starter) => <button key={starter} onClick={() => void sendFromComposer(starter)}>{starter}</button>)}
                  </div>}
                  {renderComposer("task-start")}
                </div>
              ) : messages.map((message) => (
                <Message key={message.id} message={message} showThinking={settings?.showThinking ?? true} />
              ))}
              {Object.values(extensionWidgets).map((lines, index) => (
                <div className="extension-widget" key={index}>{lines.map((line, lineIndex) => <div key={lineIndex}>{line}</div>)}</div>
              ))}
              {extensionRequest && <ExtensionDialog request={extensionRequest} onAnswer={(response) => void store.answerExtension(response)} />}
              <div ref={chatEndRef} />
            </div>
          </div>

          {!newTask && <>
            {git?.files.length ? <div className="task-artifact-row">
              <button onClick={() => setInspectorTab("changes")}><FileDiff size={13} /> {git.files.length} 个文件有更改</button>
              {!isStreaming && <button onClick={() => void requestReview()}>审查代码</button>}
            </div> : null}
            {isStreaming && <div className="active-goal-card">
              <span className="active-goal-status"><Clock3 size={14} /></span>
              <span className="active-goal-copy">
                <strong>进行中的目标</strong>
                <span title={currentGoal}>{currentGoal}</span>
              </span>
              <span className="active-goal-meta">{statusText} · {Math.floor(goalElapsed / 60)}:{String(goalElapsed % 60).padStart(2, "0")}</span>
              <button onClick={() => setGoalEditPrefill(currentGoal)} title="在输入框中调整目标"><Pencil size={13} /></button>
              <button onClick={() => void store.abort()} title="停止当前目标"><Square size={12} fill="currentColor" /></button>
              <button className="danger" onClick={() => void store.abort()} title="结束当前目标"><Trash2 size={13} /></button>
            </div>}
            {!isStreaming && (Object.keys(extensionStatuses).length > 0 || (stats?.contextUsage?.percent ?? 0) > 0) && <div className="task-context-row">
              {Object.values(extensionStatuses).map((status) => <span className="extension-status" key={status}>{status}</span>)}
              {stats?.contextUsage?.percent !== null && stats?.contextUsage?.percent !== undefined && <span className="context-meter">上下文 {Math.round(stats.contextUsage.percent)}%</span>}
            </div>}
            {renderComposer("follow-up")}
          </>}
          </>}
        </main>

        {inspectorTab && (
          <InspectorPanel
            key={inspectorTab}
            initialTab={inspectorTab}
            git={git}
            cwd={cwd}
            terminal={terminal}
            browser={browser}
            logs={piLog}
            onClose={() => setInspectorTab(null)}
            onRefreshGit={() => void store.refreshGit()}
            onReview={() => void requestReview()}
            onRunCommand={(command, exclude) => void store.runBash(command, exclude)}
            onAbortCommand={() => void store.abortBash()}
          />
        )}
      </div>

      {settingsOpen && <SettingsModal initialPage={settingsPage} settings={settings} cwd={cwd} onSave={store.saveSettings} onClose={() => setSettingsOpen(false)} />}

      <div className="toast-stack">
        {toasts.map((toast) => (
          <button key={toast.id} className={`toast ${toast.kind}`} onClick={() => store.dismissToast(toast.id)}>{toast.message}</button>
        ))}
      </div>
    </div>
  );
}
