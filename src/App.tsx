import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Check,
  ChevronDown,
  Code2,
  FileDiff,
  Folder,
  FolderOpen,
  Globe2,
  Hammer,
  Menu,
  Maximize2,
  Minimize2,
  Minus,
  MoreHorizontal,
  PanelBottom,
  PanelLeft,
  PanelRight,
  RefreshCw,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import { pi, subscribeToPi } from "./lib/pi";
import { aggregateDiffStats } from "./lib/gitDiffStats";
import { sessionRecency, sessionTitle } from "./lib/sessionTitle";
import { usePiStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { Message } from "./components/Message";
import { Composer } from "./components/Composer";
import { SettingsModal, type SettingsPage } from "./components/SettingsModal";
import { ExtensionDialog } from "./components/ExtensionDialog";
import { InspectorPanel, type InspectorTab } from "./components/InspectorPanel";
import { ToolRail, type WorkspaceTool } from "./components/ToolRail";
import { FileTreePanel } from "./components/FileTreePanel";
import { DocumentPane } from "./components/DocumentPane";
import { BrowserWorkspacePanel } from "./components/BrowserWorkspacePanel";
import { SideChatPanel } from "./components/SideChatPanel";
import { TerminalWorkspacePanel } from "./components/TerminalWorkspacePanel";
import { PullRequestsPage } from "./components/PullRequestsPage";
import { ScheduledTasksPage } from "./components/ScheduledTasksPage";
import { PluginMarketplacePage } from "./components/PluginMarketplacePage";
import { WorkspaceFileOpenContext } from "./components/Markdown";
import type { AppSettings, AttachmentPayload, GitSnapshot, ModelInfo, ProjectConfig, PullRequestInfo, ScheduledRunRecord, UiMessage, WorkspaceEditorInfo } from "./types";

function TelescopeIcon({ size = 18 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.2 19.2 9 14.4" />
      <path d="M6.2 21h4.2" />
      <path d="M3.8 15.2 6 16.4" />
      <path d="M10.4 13.2 20.2 6.4a2.2 2.2 0 0 0-2.3-3.7L8.2 9.6a2 2 0 0 0-.3 3.1l2.5.5Z" />
      <circle cx="18.6" cy="5.2" r="2.1" />
    </svg>
  );
}

const STARTERS: Array<{ title: string; prompt: string; tone: "blue" | "purple" | "green" | "orange"; Icon: typeof Hammer | typeof TelescopeIcon }> = [
  { title: "探索并理解代码", prompt: "解释这个代码库及其架构，标出关键模块与入口。", tone: "blue", Icon: TelescopeIcon },
  { title: "构建新功能、应用或工具", prompt: "根据当前仓库，提出并实现一项高价值的小功能，说明改动范围。", tone: "purple", Icon: Hammer },
  { title: "审查代码并提出修改建议", prompt: "检查当前改动中的正确性、回归风险与可维护性问题，按严重程度列出建议。", tone: "green", Icon: RefreshCw },
  { title: "修复问题和失败", prompt: "运行测试或复现当前失败项，定位根因并修复。", tone: "orange", Icon: Bug },
];

type HubView = "pull-requests" | "sites" | "scheduled" | "plugins";
type AppMenu = "file" | "edit" | "view" | "help";
type NavigationTarget =
  | { kind: "home"; workspace: string }
  | { kind: "hub"; view: HubView }
  | { kind: "session"; cwd: string; file: string };

function navigationKey(target: NavigationTarget): string {
  return target.kind === "home"
    ? `home:${target.workspace}`
    : target.kind === "hub"
      ? `hub:${target.view}`
      : `session:${target.cwd}:${target.file}`;
}

function WorkspaceCubeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 1.4 14 4.85 8 8.3 2 4.85 8 1.4Z" fill="#f7f7f7" />
      <path d="M2 4.85 8 8.3v6.3l-6-3.45v-6.3Z" fill="#a7a7a7" />
      <path d="M14 4.85 8 8.3v6.3l6-3.45v-6.3Z" fill="#d7d7d7" />
    </svg>
  );
}

const ACTIVE_RUNTIME_KEY = "pid-desktop:active-runtime";
const LAST_TASK_KEY = "pid-desktop:last-task";
const WORKSPACE_CHAT_WIDTH_KEY = "pid-desktop:workspace-chat-width:v2";
const INITIAL_RENDERED_MESSAGES = 16;
const MESSAGE_RENDER_BATCH = 40;

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
    isSwitchingModel,
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
    computer,
    terminal,
    piLog,
    extensionRequest,
    extensionWidgets,
    composerPrefill,
    runtimeId,
    runtimes,
    toasts,
  } = store;
  const [sidebarVisible, setSidebarVisible] = useState(() => window.innerWidth > 900);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem("pid-desktop:sidebar-width"));
    return Number.isFinite(stored) && stored >= 200 && stored <= 380 ? stored : 250;
  });
  const [workspaceChatWidth, setWorkspaceChatWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem(WORKSPACE_CHAT_WIDTH_KEY));
    return Number.isFinite(stored) && stored >= 360 && stored <= 520 ? stored : 462;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("general");
  const [hubView, setHubView] = useState<HubView | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab | null>(null);
  const [inspectorOpenView, setInspectorOpenView] = useState<InspectorTab | null>(null);
  const [bottomPanel, setBottomPanel] = useState(false);
  const [workspaceSidebarOpen, setWorkspaceSidebarOpen] = useState(false);
  const [workspaceFocusMode, setWorkspaceFocusMode] = useState(false);
  const [workspaceTool, setWorkspaceTool] = useState<WorkspaceTool | null>(null);
  const [previewFile, setPreviewFile] = useState<{ path: string; line?: number } | null>(null);
  const [openFileTabs, setOpenFileTabs] = useState<Array<{ path: string; line?: number }>>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [workspaceEditors, setWorkspaceEditors] = useState<WorkspaceEditorInfo[]>([]);
  const [appMenu, setAppMenu] = useState<AppMenu | null>(null);
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  // Codex home defaults to Local; Worktree only when settings or user toggle says so.
  const [taskEnvironment, setTaskEnvironment] = useState<"local" | "worktree">("local");
  const [draftWorkspace, setDraftWorkspace] = useState(() => window.localStorage.getItem("pid-desktop:last-workspace") || "");
  const [draftBranch, setDraftBranch] = useState("");
  const [draftGit, setDraftGit] = useState<GitSnapshot | null>(null);
  const [registeredProjects, setRegisteredProjects] = useState<ProjectConfig[]>([]);
  const [quickChat, setQuickChat] = useState(false);
  const [goalEditPrefill, setGoalEditPrefill] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState<{ messageId: string; entryId: string } | null>(null);
  const [renderedMessageLimit, setRenderedMessageLimit] = useState(INITIAL_RENDERED_MESSAGES);
  const [runtimeRecoveryDone, setRuntimeRecoveryDone] = useState(false);
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const autoFollowConversationRef = useRef(true);
  const lastAutoScrollAtRef = useRef(0);
  const navigationBackRef = useRef<NavigationTarget[]>([]);
  const navigationForwardRef = useRef<NavigationTarget[]>([]);
  const [navigationVersion, setNavigationVersion] = useState(0);
  const autoConnectedRef = useRef(false);
  const isTauri = "__TAURI_INTERNALS__" in window;
  const appWindow = isTauri ? getCurrentWindow() : null;
  const workspaceSidebarVisible = workspaceSidebarOpen || Boolean(workspaceTool || previewFile);
  const preferredWorkspaceEditor = useMemo(() => {
    const preferredId = settings?.defaultFileOpener;
    const configured = workspaceEditors.find((editor) => editor.id === preferredId);
    if (configured) return configured;
    return workspaceEditors[0] ?? null;
  }, [settings?.defaultFileOpener, workspaceEditors]);

  const toggleWorkspaceSidebar = useCallback(() => {
    if (workspaceSidebarVisible) {
      setWorkspaceFocusMode(false);
      setWorkspaceSidebarOpen(false);
      setWorkspaceTool(null);
      setPreviewFile(null);
      return;
    }
    setInspectorTab(null);
    setInspectorOpenView(null);
    setWorkspaceTool(null);
    setPreviewFile(null);
    setWorkspaceSidebarOpen(true);
  }, [workspaceSidebarVisible]);

  useEffect(() => {
    if (!workspaceSidebarVisible) setWorkspaceFocusMode(false);
  }, [workspaceSidebarVisible]);

  useEffect(() => {
    if (!inspectorTab && !toolsMenuOpen && !moreOpen && !appMenu && !workspaceFocusMode) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (toolsMenuOpen && !target.closest(".workspace-tools-menu, .workspace-tools-trigger")) {
        setToolsMenuOpen(false);
      }
      if (moreOpen && !target.closest(".title-actions")) setMoreOpen(false);
      if (appMenu && !target.closest(".app-menu-bar, .app-menu-dropdown")) setAppMenu(null);
      if (inspectorTab && !target.closest(".env-panel, .codex-layout-chrome, .title-diff-chip")) {
        setInspectorTab(null);
        setInspectorOpenView(null);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || settingsOpen) return;
      if (toolsMenuOpen) setToolsMenuOpen(false);
      else if (moreOpen) setMoreOpen(false);
      else if (appMenu) setAppMenu(null);
      else if (workspaceFocusMode) setWorkspaceFocusMode(false);
      else if (inspectorTab) {
        setInspectorTab(null);
        setInspectorOpenView(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [appMenu, inspectorTab, moreOpen, settingsOpen, toolsMenuOpen, workspaceFocusMode]);

  useEffect(() => {
    const narrowWindow = window.matchMedia("(max-width: 900px)");
    const collapseSidebar = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setSidebarVisible(false);
    };

    collapseSidebar(narrowWindow);
    narrowWindow.addEventListener("change", collapseSidebar);
    return () => narrowWindow.removeEventListener("change", collapseSidebar);
  }, []);

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
    if (!isTauri) return;
    let cancelled = false;
    void pi.listWorkspaceEditors()
      .then((editors) => {
        if (!cancelled) setWorkspaceEditors(editors);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceEditors([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isTauri]);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<ScheduledRunRecord>("scheduled-run-updated", (event) => {
      if (event.payload.status === "running") return;
      void usePiStore.getState().refreshSessions();
      usePiStore.getState().showToast(
        event.payload.status === "success"
          ? `计划任务“${event.payload.taskName}”已完成`
          : `计划任务“${event.payload.taskName}”${event.payload.status === "interrupted" ? "已中断" : "失败"}`,
        event.payload.status === "success" ? "info" : "error",
      );
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isTauri]);

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
    // Apply product default once settings arrive; user can still toggle chips afterward.
    setTaskEnvironment(settings.defaultTaskEnvironment === "worktree" ? "worktree" : "local");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only sync when settings object first becomes available / default changes
  }, [settings?.defaultTaskEnvironment]);

  useEffect(() => {
    window.localStorage.setItem("pid-desktop:task-environment", taskEnvironment);
  }, [taskEnvironment]);

  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    // Prefer light shell to match Codex desktop screenshot unless user forces dark.
    const resolved = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
    root.dataset.theme = resolved;
    const dark = resolved === "dark";
    root.style.setProperty("--accent-custom", dark ? "#ffffff" : "#111111");
    root.style.setProperty("--code-font", settings.codeFont);
    root.style.fontFamily = settings.uiFont || '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    root.style.setProperty("--app", dark ? "#0a0a0b" : "#ffffff");
    root.style.setProperty("--text", dark ? "#f5f5f5" : "#1a1a1a");
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
    const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, "").replace("control", "ctrl");
    const shortcuts = {
      newChat: settings?.shortcutNewChat ?? "Ctrl+Shift+N",
      settings: settings?.shortcutSettings ?? "Ctrl+,",
      terminal: settings?.shortcutTerminal ?? "Ctrl+Shift+T",
      changes: settings?.shortcutChanges ?? "Ctrl+Shift+G",
      toggleSidebar: settings?.shortcutToggleSidebar ?? "Ctrl+B",
    };
    const shortcutFor = (event: KeyboardEvent) => [
      event.ctrlKey ? "Ctrl" : "",
      event.altKey ? "Alt" : "",
      event.shiftKey ? "Shift" : "",
      event.metaKey ? "Meta" : "",
      event.key.length === 1 ? event.key.toUpperCase() : event.key,
    ].filter(Boolean).join("+");
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = normalize(shortcutFor(event));
      const ctrl = event.ctrlKey || event.metaKey;
      if (shortcut === normalize(shortcuts.settings) || (event.ctrlKey && event.key === ",")) {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (settingsOpen && event.key === "Escape") {
        event.preventDefault();
        setSettingsOpen(false);
        return;
      }
      if (ctrl && !event.altKey && !event.shiftKey && (event.key.toLowerCase() === "j" || event.code === "Backquote" || event.key === "`")) {
        event.preventDefault();
        setBottomPanel((value) => !value);
        return;
      }
      if (ctrl && event.altKey && !event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleWorkspaceSidebar();
        return;
      }
      if (ctrl && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        setInspectorTab(null);
        setInspectorOpenView(null);
        setPreviewFile(null);
        setWorkspaceSidebarOpen(true);
        setWorkspaceTool((current) => (current === "browser" ? null : "browser"));
        return;
      }
      if (ctrl && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setInspectorTab(null);
        setInspectorOpenView(null);
        setWorkspaceSidebarOpen(true);
        setWorkspaceTool((current) => (current === "files" ? null : "files"));
        return;
      }
      if (ctrl && event.shiftKey && !event.altKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        setInspectorTab(null);
        setInspectorOpenView(null);
        setPreviewFile(null);
        setWorkspaceSidebarOpen(true);
        setWorkspaceTool((current) => (current === "review" ? null : "review"));
        return;
      }
      if (ctrl && event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        setInspectorTab(null);
        setInspectorOpenView(null);
        setWorkspaceSidebarOpen(true);
        setWorkspaceTool((current) => (current === "side-chat" ? null : "side-chat"));
        setPreviewFile(null);
        return;
      }
      if (shortcut === normalize(shortcuts.newChat) && connection === "running") {
        event.preventDefault();
        store.prepareNewTask();
        setQuickChat(false);
        setHubView(null);
      } else if (shortcut === normalize(shortcuts.terminal) || shortcut === "ctrl+j") {
        event.preventDefault();
        setBottomPanel((value) => !value);
      } else if (shortcut === normalize(shortcuts.changes)) {
        event.preventDefault();
        setInspectorTab(null);
        setInspectorOpenView(null);
        setPreviewFile(null);
        setWorkspaceSidebarOpen(true);
        setWorkspaceTool((value) => (value === "review" ? null : "review"));
      } else if (shortcut === normalize(shortcuts.toggleSidebar)) {
        event.preventDefault();
        setSidebarVisible((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [connection, settings, settingsOpen, store.prepareNewTask, toggleWorkspaceSidebar]);

  useEffect(() => {
    setTitleDraft(sessionName || (sessionId ? `任务 ${sessionId.slice(0, 8)}` : "新任务"));
  }, [sessionId, sessionName]);

  useEffect(() => {
    setRenderedMessageLimit(INITIAL_RENDERED_MESSAGES);
    setEditingMessage(null);
    autoFollowConversationRef.current = true;
  }, [runtimeId, sessionFile]);

  useEffect(() => {
    if (!autoFollowConversationRef.current) return;
    const now = performance.now();
    if (isStreaming && now - lastAutoScrollAtRef.current < 80) return;
    lastAutoScrollAtRef.current = now;
    const frame = window.requestAnimationFrame(() => {
      const scroller = conversationScrollRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isStreaming, messages.length, messages[messages.length - 1]?.content]);

  useEffect(() => {
    if (draftWorkspace || sessions.length === 0) return;
    const firstProject = sessions.find((session) => !session.cwd.toLowerCase().endsWith("quick-chat"))?.cwd;
    if (firstProject) setDraftWorkspace(firstProject);
  }, [draftWorkspace, sessions]);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    const loadProjects = async () => {
      try {
        const projects = await pi.listProjects();
        if (!disposed) setRegisteredProjects(projects.filter((project) => !project.hidden));
      } catch {
        if (!disposed) setRegisteredProjects([]);
      }
    };
    void loadProjects();
    const reload = () => void loadProjects();
    window.addEventListener("pid-desktop:projects-changed", reload);
    return () => {
      disposed = true;
      window.removeEventListener("pid-desktop:projects-changed", reload);
    };
  }, [isTauri]);

  useEffect(() => {
    let disposed = false;
    if (!isTauri || !draftWorkspace) {
      setDraftBranch("");
      setDraftGit(null);
      return;
    }
    if (!runtimeRecoveryDone || connection !== "disconnected" || settings?.autoConnect) return;
    // A home composer needs an active blank runtime: the model catalog and
    // model/thinking commands are runtime RPCs, not static settings data.
    void Promise.all([
      store.connect(draftWorkspace),
      pi.gitSnapshot(draftWorkspace),
    ])
      .then(([, snapshot]) => {
        if (!disposed) {
          setDraftGit(snapshot);
          setDraftBranch(snapshot.isRepository ? (snapshot.branch || "") : "");
        }
      })
      .catch(() => {
        if (!disposed) {
          setDraftGit(null);
          setDraftBranch("");
        }
      });
    return () => {
      disposed = true;
    };
  }, [connection, draftWorkspace, isTauri, runtimeRecoveryDone, settings?.autoConnect, store.connect]);

  const refreshDraftGit = useCallback(async () => {
    if (!isTauri || !draftWorkspace) return;
    try {
      const snapshot = await pi.gitSnapshot(draftWorkspace);
      setDraftGit(snapshot);
      setDraftBranch(snapshot.isRepository ? (snapshot.branch || "") : "");
    } catch {
      setDraftGit(null);
      setDraftBranch("");
    }
  }, [draftWorkspace, isTauri]);

  const selectWorkspace = useCallback((workspace: string) => {
    window.localStorage.setItem("pid-desktop:last-workspace", workspace);
    setDraftWorkspace(workspace);
    setQuickChat(false);
    if (isTauri && workspace && !workspace.toLowerCase().endsWith("quick-chat")) {
      void pi.registerProject(workspace)
        .then(() => window.dispatchEvent(new Event("pid-desktop:projects-changed")))
        .catch(() => undefined);
    }
  }, [isTauri]);

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

  const toggleWorkspaceTool = useCallback((tool: WorkspaceTool) => {
    setInspectorTab(null);
    setInspectorOpenView(null);
    setPreviewFile(tool === "files" ? (openFileTabs[openFileTabs.length - 1] ?? null) : null);
    setWorkspaceSidebarOpen(true);
    setWorkspaceTool((current) => (current === tool ? null : tool));
  }, [openFileTabs]);

  const openPreviewFile = useCallback((path: string, line?: number) => {
    setHubView(null);
    setInspectorTab(null);
    setInspectorOpenView(null);
    setPreviewFile({ path, line });
    setOpenFileTabs((current) => current.some((item) => item.path === path)
      ? current.map((item) => item.path === path ? { path, line } : item)
      : [...current, { path, line }]);
    setWorkspaceTool("files");
    setWorkspaceSidebarOpen(true);
  }, []);

  const closePreviewTab = useCallback((path: string) => {
    setOpenFileTabs((current) => {
      const index = current.findIndex((item) => item.path === path);
      const next = current.filter((item) => item.path !== path);
      setPreviewFile((active) => {
        if (active?.path !== path) return active;
        return next[Math.min(Math.max(index, 0), next.length - 1)] ?? null;
      });
      return next;
    });
  }, []);

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
  const newTask = messages.length === 0 && !sessionFile;
  const workspaceCwd = newTask ? draftWorkspace : cwd;
  const workspaceFilePath = useCallback((path: string) => (
    /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)
      ? path
      : `${workspaceCwd.replace(/[\\/]+$/, "")}\\${path.replace(/\//g, "\\")}`
  ), [workspaceCwd]);
  const addWorkspaceFileToChat = useCallback(async (path: string) => {
    if (!workspaceCwd) return;
    try {
      const attachment = await pi.readAttachment(workspaceFilePath(path));
      setAttachments((current) => current.some((item) => item.path === attachment.path)
        ? current
        : [...current, attachment]);
      usePiStore.getState().showToast(`${attachment.fileName} 已添加到聊天`, "info");
    } catch (error) {
      usePiStore.getState().showToast(error instanceof Error ? error.message : String(error), "error");
    }
  }, [workspaceCwd, workspaceFilePath]);
  const workspaceOptions = useMemo(
    () => [draftWorkspace, cwd, ...registeredProjects.map((project) => project.path), ...sessions.map((session) => session.cwd)]
      .filter((item): item is string => Boolean(item) && !item.toLowerCase().endsWith("quick-chat")),
    [cwd, draftWorkspace, registeredProjects, sessions],
  );
  const runningSessionFiles = useMemo(
    () => Object.values(runtimes).filter((runtime) => runtime.isStreaming && runtime.sessionFile).map((runtime) => runtime.sessionFile as string),
    [runtimes],
  );
  const approvalSessionFiles = useMemo(
    () => Object.values(runtimes).filter((runtime) => runtime.extensionRequest && runtime.sessionFile).map((runtime) => runtime.sessionFile as string),
    [runtimes],
  );
  const gitDiffStats = useMemo(() => {
    const { add, del } = aggregateDiffStats(git?.diff);
    return { additions: add, deletions: del };
  }, [git?.diff]);
  // Last assistant reply of the current turn: gets Codex's persistent action row + streaming fold label.
  const lastAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const role = messages[index].role;
      if (role === "assistant") return messages[index].id;
      if (role === "user") return null;
    }
    return null;
  }, [messages]);
  const hiddenMessageCount = Math.max(0, messages.length - renderedMessageLimit);
  const visibleMessages = hiddenMessageCount > 0 ? messages.slice(hiddenMessageCount) : messages;
  const threadElapsedLabel = useMemo(() => {
    if (!messages.length) return null;
    const stamps = messages.map((message) => message.timestamp).filter((value): value is number => typeof value === "number" && value > 0);
    if (!stamps.length) return null;
    const start = Math.min(...stamps);
    const end = isStreaming ? Date.now() : Math.max(...stamps);
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    if (seconds < 60) return isStreaming ? `已进行 ${seconds}s` : `耗时 ${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rem = seconds % 60;
    return isStreaming
      ? `已进行 ${minutes}m ${rem}s`
      : `耗时 ${minutes}m ${rem}s`;
  }, [isStreaming, messages]);
  const taskWorkspaceName = quickChat
    ? "快速对话"
    : draftWorkspace.split(/[\\/]/).filter(Boolean).pop() || "一个项目";
  const recentWorkspaceSessions = useMemo(() => {
    const workspace = draftWorkspace || cwd;
    if (!workspace) return [];
    return sessions
      .filter((session) => session.cwd.replace(/[\\/]+$/, "").toLowerCase() === workspace.replace(/[\\/]+$/, "").toLowerCase())
      .sort((a, b) => sessionRecency(b) - sessionRecency(a))
      .slice(0, 5);
  }, [cwd, draftWorkspace, sessions]);
  const statusText = isCompacting
    ? "正在压缩上下文…"
    : retryStatus || (isStreaming ? "Pi 正在工作…" : connected ? "就绪" : connection === "starting" ? "正在启动 Pi…" : "未连接");
  const sendFromComposer = useCallback(async (text: string, behavior?: "steer" | "followUp") => {
    let current = usePiStore.getState();
    let workspace = quickChat ? await pi.quickChatDir() : draftWorkspace || current.cwd;
    if (!workspace) {
        const selected = await open({ directory: true, multiple: false, title: "选择任务项目" });
        if (typeof selected !== "string") return false;
        workspace = selected;
        selectWorkspace(selected);
    }
    const normalize = (value: string) => value.replace(/[\\/]+$/, "").toLowerCase();
    if (current.connection !== "running" || normalize(current.cwd) !== normalize(workspace)) {
      window.localStorage.setItem("pid-desktop:last-workspace", workspace);
      await current.connect(workspace);
      current = usePiStore.getState();
      if (current.connection !== "running") return false;
    }
    if (editingMessage) {
      const sent = await current.editAndResend(editingMessage.entryId, text, attachments);
      if (sent) {
        setEditingMessage(null);
        setAttachments([]);
      }
      return sent;
    }
    if (taskEnvironment === "worktree" && current.messages.length === 0 && !quickChat) {
      try {
        // Ensure git snapshot is available for base branch when possible.
        await current.refreshGit();
        current = usePiStore.getState();
        const worktree = await pi.createWorktree(current.cwd, current.git?.branch);
        window.localStorage.setItem("pid-desktop:last-workspace", worktree.path);
        setDraftWorkspace(worktree.path);
        await current.connect(worktree.path);
        current = usePiStore.getState();
        if (current.connection !== "running") return false;
      } catch (error) {
        current.appendLog(`创建 Worktree 失败：${String(error)}`);
        current.showToast(`创建 Worktree 失败：${String(error)}`, "error");
        return false;
      }
    }
    const sent = await current.sendMessage(text, attachments, behavior);
    if (sent) setAttachments([]);
    return sent;
  }, [attachments, draftWorkspace, editingMessage, quickChat, selectWorkspace, taskEnvironment]);

  const startNewTask = useCallback((asQuickChat = false) => {
    const current = usePiStore.getState();
    if (current.cwd && !current.cwd.toLowerCase().endsWith("quick-chat")) setDraftWorkspace(current.cwd);
    current.prepareNewTask();
    setQuickChat(asQuickChat);
    // Codex home defaults to Local; only keep Worktree when settings ask for it.
    const preferred = current.settings?.defaultTaskEnvironment === "worktree" ? "worktree" : "local";
    setTaskEnvironment(asQuickChat ? "local" : preferred);
    window.localStorage.setItem("pid-desktop:task-environment", asQuickChat ? "local" : preferred);
    setInspectorTab(null);
    setHubView(null);
    setWorkspaceSidebarOpen(false);
    setWorkspaceTool(null);
    setPreviewFile(null);
  }, []);

  const openProjectHome = useCallback((workspace: string) => {
    if (!workspace) return;
    selectWorkspace(workspace);
    usePiStore.getState().prepareNewTask();
    setQuickChat(false);
    setHubView(null);
    setInspectorTab(null);
    setWorkspaceSidebarOpen(false);
    setWorkspaceTool(null);
    setPreviewFile(null);
  }, [selectWorkspace]);

  const revealWorkspaceInExplorer = useCallback((workspace: string) => {
    if (!workspace) return;
    void pi.openWorkspaceInFileManager(workspace).catch((error) => {
      usePiStore.getState().showToast(`无法在资源管理器中打开项目：${String(error)}`, "error");
    });
  }, []);

  const revealWorkspaceInEditor = useCallback((workspace: string, editor: WorkspaceEditorInfo) => {
    if (!workspace) return;
    void pi.openWorkspaceInEditor(workspace, editor.id).catch((error) => {
      usePiStore.getState().showToast(`无法在 ${editor.name} 中打开项目：${String(error)}`, "error");
    });
  }, []);

  const openWorkspaceWithPreferredApp = useCallback((workspace: string) => {
    if (preferredWorkspaceEditor) {
      revealWorkspaceInEditor(workspace, preferredWorkspaceEditor);
      return;
    }
    revealWorkspaceInExplorer(workspace);
  }, [preferredWorkspaceEditor, revealWorkspaceInEditor, revealWorkspaceInExplorer]);

  const currentNavigationTarget = useCallback((): NavigationTarget => {
    if (hubView) return { kind: "hub", view: hubView };
    if (!newTask && sessionFile) return { kind: "session", cwd, file: sessionFile };
    return { kind: "home", workspace: draftWorkspace || cwd };
  }, [cwd, draftWorkspace, hubView, newTask, sessionFile]);

  const applyNavigationTarget = useCallback(async (target: NavigationTarget) => {
    setInspectorTab(null);
    setInspectorOpenView(null);
    setMoreOpen(false);
    setToolsMenuOpen(false);
    if (target.kind === "hub") {
      setHubView(target.view);
      return;
    }
    if (target.kind === "home") {
      if (target.workspace) openProjectHome(target.workspace);
      else startNewTask(false);
      return;
    }
    window.localStorage.setItem("pid-desktop:last-workspace", target.cwd);
    setDraftWorkspace(target.cwd);
    setQuickChat(target.cwd.toLowerCase().endsWith("quick-chat"));
    setHubView(null);
    await store.switchSession(target.cwd, target.file);
  }, [openProjectHome, startNewTask, store.switchSession]);

  const navigateTo = useCallback((target: NavigationTarget) => {
    const current = currentNavigationTarget();
    if (navigationKey(current) === navigationKey(target)) return;
    navigationBackRef.current.push(current);
    navigationForwardRef.current = [];
    setNavigationVersion((value) => value + 1);
    void applyNavigationTarget(target);
  }, [applyNavigationTarget, currentNavigationTarget]);

  const navigateBack = useCallback(() => {
    const target = navigationBackRef.current.pop();
    if (!target) return;
    navigationForwardRef.current.push(currentNavigationTarget());
    setNavigationVersion((value) => value + 1);
    void applyNavigationTarget(target);
  }, [applyNavigationTarget, currentNavigationTarget]);

  const navigateForward = useCallback(() => {
    const target = navigationForwardRef.current.pop();
    if (!target) return;
    navigationBackRef.current.push(currentNavigationTarget());
    setNavigationVersion((value) => value + 1);
    void applyNavigationTarget(target);
  }, [applyNavigationTarget, currentNavigationTarget]);

  const canNavigateBack = navigationVersion >= 0 && navigationBackRef.current.length > 0;
  const canNavigateForward = navigationVersion >= 0 && navigationForwardRef.current.length > 0;

  const beginSidebarResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const onMove = (move: MouseEvent) => {
      const next = Math.min(380, Math.max(200, startWidth + (move.clientX - startX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setSidebarWidth((current) => {
        window.localStorage.setItem("pid-desktop:sidebar-width", String(current));
        return current;
      });
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  const beginWorkspaceResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = workspaceChatWidth;
    const onMove = (move: MouseEvent) => {
      const available = window.innerWidth - (sidebarVisible ? sidebarWidth : 0) - 440;
      const next = Math.min(520, Math.min(Math.max(360, available), Math.max(360, startWidth + move.clientX - startX)));
      setWorkspaceChatWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setWorkspaceChatWidth((current) => {
        window.localStorage.setItem(WORKSPACE_CHAT_WIDTH_KEY, String(current));
        return current;
      });
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [sidebarVisible, sidebarWidth, workspaceChatWidth]);

  const restoreGitFiles = useCallback(async (paths?: string[]) => {
    const workspace = workspaceCwd;
    const snapshot = newTask ? draftGit : usePiStore.getState().git;
    if (!workspace || !snapshot?.files.length) return;
    const targets = paths?.length ? paths : snapshot.files.map((file) => file.path);
    if (!targets.length) return;
    const label = targets.length === 1 ? targets[0] : `${targets.length} 个文件`;
    if (!window.confirm(`撤销对 ${label} 的本地更改？未提交的改动将丢失。`)) return;
    try {
      await pi.gitRestoreFiles(workspace, targets);
      if (newTask) await refreshDraftGit();
      else await usePiStore.getState().refreshGit();
      usePiStore.getState().showToast("已撤销本地更改", "info");
    } catch (error) {
      usePiStore.getState().showToast(error instanceof Error ? error.message : String(error), "error");
    }
  }, [draftGit, newTask, refreshDraftGit, workspaceCwd]);

  const openSettingsPage = useCallback((page: SettingsPage) => {
    setSettingsPage(page);
    setSettingsOpen(true);
  }, []);

  const updateGitIndex = useCallback(async (mode: "stage" | "unstage", paths: string[]) => {
    if (!workspaceCwd || !paths.length) return;
    try {
      if (mode === "stage") await pi.gitStageFiles(workspaceCwd, paths);
      else await pi.gitUnstageFiles(workspaceCwd, paths);
      if (newTask) await refreshDraftGit();
      else await usePiStore.getState().refreshGit();
      usePiStore.getState().showToast(
        mode === "stage" ? `已暂存 ${paths.length} 个文件` : `已取消暂存 ${paths.length} 个文件`,
        "info",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      usePiStore.getState().showToast(message, "error");
    }
  }, [newTask, refreshDraftGit, workspaceCwd]);

  const stopFromComposer = useCallback(() => {
    void usePiStore.getState().abort();
  }, []);
  const removeComposerAttachment = useCallback((path: string) => {
    setAttachments((items) => items.filter((item) => item.path !== path));
  }, []);
  const changeComposerModel = useCallback((next: ModelInfo) => {
    void usePiStore.getState().setModel(next).catch((error) => {
      usePiStore.getState().appendLog(`切换模型失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, []);
  const changeComposerThinking = useCallback((level: string) => {
    void usePiStore.getState().setThinkingLevel(level).catch((error) => {
      usePiStore.getState().showToast(`设置推理等级失败：${error instanceof Error ? error.message : String(error)}`, "error");
    });
  }, []);
  const startQuickChatFromComposer = useCallback(() => {
    setQuickChat(true);
    setTaskEnvironment("local");
  }, []);
  const changeComposerPermission = useCallback(async (mode: AppSettings["permissionMode"]) => {
    const current = usePiStore.getState();
    if (!current.settings || current.settings.permissionMode === mode) return;
    if (current.isStreaming) {
      current.showToast("请等待当前回复完成后再切换权限", "warning");
      return;
    }
    try {
      await current.saveSettings({ ...current.settings, permissionMode: mode });
      const latest = usePiStore.getState();
      if (latest.connection === "running" && latest.cwd) {
        await latest.connect(latest.cwd, latest.sessionFile ?? undefined);
      }
      usePiStore.getState().showToast("权限模式已更新", "info");
    } catch (error) {
      usePiStore.getState().showToast(`切换权限失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }, []);
  const consumeComposerPrefill = useCallback(() => {
    setGoalEditPrefill(null);
    usePiStore.getState().clearComposerPrefill();
  }, []);

  const editUserMessage = useCallback(async (message: UiMessage) => {
    const current = usePiStore.getState();
    if (current.isStreaming) {
      current.showToast("请等待当前回复完成后再编辑消息", "warning");
      return;
    }
    const point = await current.resolveMessageForkPoint(message.id);
    if (!point) {
      current.showToast("无法定位这条消息的会话检查点", "warning");
      return;
    }
    setEditingMessage({ messageId: message.id, entryId: point.entryId });
    setGoalEditPrefill(message.content);
  }, []);

  const cancelMessageEdit = useCallback(() => {
    setEditingMessage(null);
    setGoalEditPrefill(null);
  }, []);

  const refreshSessionTree = useCallback(() => {
    void usePiStore.getState().loadSessionTree();
  }, []);

  const continueFromTreeNode = useCallback((entryId: string) => {
    void usePiStore.getState().continueFromTreeNode(entryId);
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

  const requestCommitOrPush = useCallback(async () => {
    await usePiStore.getState().sendMessage(
      "请审查当前工作区未提交更改，撰写简洁的提交说明并创建提交；若已配置可用远程且适合推送，再推送到远程并回报结果。",
    );
  }, []);

  const switchWorkspacePath = useCallback(async (path: string) => {
    if (!path) return;
    window.localStorage.setItem("pid-desktop:last-workspace", path);
    setDraftWorkspace(path);
    setQuickChat(path.toLowerCase().endsWith("quick-chat"));
    await usePiStore.getState().connect(path);
  }, []);

  const renderComposer = (variant: "task-start" | "follow-up") => (
    <Composer
      variant={variant}
      isStreaming={isStreaming}
      isSwitchingModel={isSwitchingModel}
      disabled={false}
      attachments={attachments}
      commands={commands}
      models={availableModels}
      model={model}
      thinkingLevel={thinkingLevel}
      thinkingLevels={availableThinkingLevels}
      prefill={goalEditPrefill ?? composerPrefill}
      editing={Boolean(editingMessage)}
      pendingCount={store.steeringQueue.length + store.followUpQueue.length}
      requireCtrlEnter={settings?.requireCtrlEnter}
      defaultFollowUpBehavior={settings?.followUpBehavior}
      workspace={quickChat ? "" : draftWorkspace}
      workspaceOptions={workspaceOptions}
      environment={taskEnvironment}
      branchLabel={!quickChat ? (variant === "task-start" ? draftBranch : (git?.isRepository ? (git.branch || "") : "")) : ""}
      quickChat={quickChat}
      permissionMode={settings?.permissionMode ?? "ask"}
      permissionLabel={permissionLabel}
      contextUsage={variant === "follow-up" ? stats?.contextUsage : undefined}
      onSend={sendFromComposer}
      onStop={stopFromComposer}
      onPickAttachments={pickAttachments}
      onRemoveAttachment={removeComposerAttachment}
      onModelChange={changeComposerModel}
      onThinkingChange={changeComposerThinking}
      onWorkspaceSelect={selectWorkspace}
      onPickWorkspace={pickFolder}
      onQuickChat={startQuickChatFromComposer}
      onEnvironmentChange={setTaskEnvironment}
      onPermissionChange={changeComposerPermission}
      onPrefillConsumed={consumeComposerPrefill}
      onCancelEdit={cancelMessageEdit}
    />
  );

  // Codex layout: native-style menubar above the sidebar and rounded work surface.
  return (
    <div className="app-shell codex-shot">
      <div className="window-menubar" data-tauri-drag-region>
        <div className="window-menubar-left" data-tauri-drag-region>
          <button
            type="button"
            className="window-nav-button"
            onClick={() => setSidebarVisible((value) => !value)}
            title={sidebarVisible ? "隐藏侧栏" : "显示侧栏"}
          >
            <PanelLeft size={17} strokeWidth={1.65} />
          </button>
          <button type="button" className="window-nav-button" disabled={!canNavigateBack} onClick={navigateBack} title="后退">
            <ArrowLeft size={18} strokeWidth={1.55} />
          </button>
          <button type="button" className="window-nav-button" disabled={!canNavigateForward} onClick={navigateForward} title="前进">
            <ArrowRight size={18} strokeWidth={1.55} />
          </button>
          <div className="app-menu-bar">
            {(["file", "edit", "view", "help"] as AppMenu[]).map((menu) => (
              <button
                type="button"
                key={menu}
                className={`app-menu-trigger ${appMenu === menu ? "active" : ""}`}
                onClick={() => setAppMenu((current) => current === menu ? null : menu)}
              >
                {menu === "file" ? "文件" : menu === "edit" ? "编辑" : menu === "view" ? "视图" : "帮助"}
              </button>
            ))}
          </div>
          {appMenu && (
            <div className={`app-menu-dropdown menu-${appMenu}`}>
              {appMenu === "file" && <>
                <button onClick={() => { setAppMenu(null); navigateTo({ kind: "home", workspace: draftWorkspace || cwd }); }}>新对话</button>
                <button onClick={() => { setAppMenu(null); void pickFolder(); }}>打开项目...</button>
                <button disabled={!connected} onClick={() => { setAppMenu(null); void store.exportSession(); }}>导出当前对话</button>
                <div className="menu-separator" />
                <button onClick={() => { setAppMenu(null); void appWindow?.close(); }}>退出</button>
              </>}
              {appMenu === "edit" && <>
                <button onClick={() => { setAppMenu(null); document.execCommand("undo"); }}>撤销</button>
                <button onClick={() => { setAppMenu(null); document.execCommand("redo"); }}>重做</button>
                <div className="menu-separator" />
                <button onClick={() => { setAppMenu(null); document.execCommand("selectAll"); }}>全选</button>
              </>}
              {appMenu === "view" && <>
                <button onClick={() => { setAppMenu(null); setSidebarVisible((value) => !value); }}>{sidebarVisible ? "隐藏侧栏" : "显示侧栏"}</button>
                <button onClick={() => { setAppMenu(null); setWorkspaceSidebarOpen(false); setWorkspaceTool(null); setPreviewFile(null); setInspectorTab("changes"); setInspectorOpenView(null); }}>显示环境信息</button>
                <button onClick={() => { setAppMenu(null); toggleWorkspaceTool("review"); }}>审阅</button>
                <button onClick={() => { setAppMenu(null); setBottomPanel((value) => !value); }}>{bottomPanel ? "隐藏终端" : "打开终端"}</button>
                <button onClick={() => { setAppMenu(null); toggleWorkspaceTool("browser"); }}>浏览器</button>
                <button onClick={() => { setAppMenu(null); toggleWorkspaceTool("files"); }}>文件</button>
                <button onClick={() => { setAppMenu(null); openSettingsPage("appearance"); }}>外观设置</button>
              </>}
              {appMenu === "help" && <>
                <button onClick={() => { setAppMenu(null); void openUrl("https://pi.dev"); }}>Pi 文档</button>
                <button onClick={() => { setAppMenu(null); setWorkspaceSidebarOpen(false); setWorkspaceTool(null); setPreviewFile(null); setInspectorTab("logs"); }}>诊断日志</button>
              </>}
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
      <div className="workspace-shell" style={{
        ["--sidebar-width" as string]: `${sidebarWidth}px`,
        ["--workspace-chat-width" as string]: `${workspaceChatWidth}px`,
      }}>
        {sidebarVisible && (
          <Sidebar
            sessions={sessions}
            currentSessionFile={sessionFile}
            runningSessionFiles={runningSessionFiles}
            approvalSessionFiles={approvalSessionFiles}
            cwd={newTask ? draftWorkspace : cwd}
            newTaskActive={newTask && hubView === null}
            activeHub={hubView === "pull-requests" || hubView === "scheduled" || hubView === "plugins" ? hubView : null}
            onNewSession={() => navigateTo({ kind: "home", workspace: draftWorkspace || cwd })}
            onOpenPullRequests={() => navigateTo({ kind: "hub", view: "pull-requests" })}
            onOpenScheduled={() => navigateTo({ kind: "hub", view: "scheduled" })}
            onOpenPlugins={() => navigateTo({ kind: "hub", view: "plugins" })}
            onOpenSession={(session) => navigateTo({ kind: "session", cwd: session.cwd, file: session.file })}
            onOpenProject={(workspace) => navigateTo({ kind: "home", workspace })}
            onNewProjectSession={(workspace) => navigateTo({ kind: "home", workspace })}
            onArchiveSession={async (session) => {
              try {
                await pi.archiveSession(session.file);
                if (session.file === sessionFile) {
                  await store.disconnect();
                  store.prepareNewTask();
                }
                await store.refreshSessions();
                store.showToast("已归档对话", "info");
              } catch (error) {
                store.showToast(`归档失败：${String(error)}`, "error");
              }
            }}
            onOpenProjectFolder={(workspace) => {
              revealWorkspaceInExplorer(workspace);
            }}
            onCreateWorktree={async (workspace) => {
              try {
                const snapshot = await pi.gitSnapshot(workspace);
                const worktree = await pi.createWorktree(workspace, snapshot.branch);
                navigateTo({ kind: "home", workspace: worktree.path });
                store.showToast(`已创建工作树：${worktree.branch || worktree.path}`, "info");
              } catch (error) {
                store.showToast(`创建工作树失败：${String(error)}`, "error");
              }
            }}
            onArchiveProject={async (_workspace, projectSessions) => {
              try {
                await Promise.all(projectSessions.map((session) => pi.archiveSession(session.file)));
                if (projectSessions.some((session) => session.file === sessionFile)) {
                  await store.disconnect();
                  store.prepareNewTask();
                }
                await store.refreshSessions();
                store.showToast(`已归档 ${projectSessions.length} 个对话`, "info");
              } catch (error) {
                store.showToast(`归档失败：${String(error)}`, "error");
              }
            }}
            onOpenSettings={() => openSettingsPage("general")}
            onOpenHelp={() => void openUrl("https://pi.dev")}
            onPickFolder={() => void pickFolder()}
          />
        )}
        {sidebarVisible && (
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧栏宽度"
            onMouseDown={beginSidebarResize}
          />
        )}

        <div className="work-surface">
        <div className={`stage-canvas ${inspectorTab ? "env-visible" : ""}`}>
        <header className="topbar" data-tauri-drag-region>
          <div className="topbar-left" data-tauri-drag-region>
            {!sidebarVisible && (
              <button className="icon-button" onClick={() => setSidebarVisible(true)} title="显示侧栏"><Menu size={17} /></button>
            )}
            {/* Codex: thread title + … live on the left; not a window-chrome ⋯ on the right */}
            {!newTask && !hubView && (
              <>
                <div className="thread-title-cluster">
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
                          event.preventDefault();
                          event.stopPropagation();
                          setTitleDraft(sessionName || "新对话");
                          setEditingTitle(false);
                        }
                      }}
                    />
                  ) : (
                    <button className="chat-title" onClick={() => connected && setEditingTitle(true)} title="重命名线程">
                      <Folder size={14} strokeWidth={1.75} className="title-doc-icon" />
                      <span>{titleDraft || "新对话"}</span>
                    </button>
                  )}
                  <div className="topbar-menu-wrap title-actions">
                    <button
                      type="button"
                      className="icon-button title-more"
                      title="线程操作"
                      onClick={() => setMoreOpen((value) => !value)}
                    >
                      <MoreHorizontal size={16} strokeWidth={1.75} />
                    </button>
                    {moreOpen && (
                      <div className="topbar-menu title-menu">
                        <button onClick={() => { setMoreOpen(false); navigateTo({ kind: "home", workspace: draftWorkspace || cwd }); }}>新对话</button>
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
                        <button onClick={() => { setMoreOpen(false); setSettingsOpen(true); }}>设置</button>
                        <button disabled={!connected} onClick={() => { setMoreOpen(false); void store.disconnect(); }}>断开 Pi</button>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
          <div className="topbar-right" data-tauri-drag-region>
            {!hubView && (
              <div className="panel-toggles codex-layout-chrome">
                <div className="main-pane-controls">
                  {!newTask && (
                    <>
                <div className="topbar-menu-wrap workspace-tools-menu">
                  <div className={`topbar-branch-control workspace-launch-control ${toolsMenuOpen ? "active" : ""}`}>
                    <button
                      type="button"
                      className="workspace-open-trigger"
                      title={preferredWorkspaceEditor ? `在 ${preferredWorkspaceEditor.name} 中打开` : "在文件资源管理器中打开"}
                      aria-label={preferredWorkspaceEditor ? `在 ${preferredWorkspaceEditor.name} 中打开` : "在文件资源管理器中打开"}
                      disabled={!workspaceCwd}
                      onClick={() => {
                        if (!workspaceCwd) return;
                        openWorkspaceWithPreferredApp(workspaceCwd);
                      }}
                    >
                      <span className="workspace-tools-mark" aria-hidden><WorkspaceCubeIcon /></span>
                    </button>
                    <button
                      type="button"
                      className="workspace-tools-trigger"
                      title="选择打开方式"
                      aria-label="选择打开方式"
                      aria-haspopup="menu"
                      aria-expanded={toolsMenuOpen}
                      onClick={() => setToolsMenuOpen((value) => !value)}
                    >
                      <ChevronDown size={13} strokeWidth={1.75} />
                    </button>
                  </div>
                  {toolsMenuOpen && (
                    <div className="topbar-menu workspace-tools-popover" role="menu">
                      {workspaceEditors.map((editor) => (
                        <button role="menuitem" key={editor.id} disabled={!workspaceCwd} onClick={() => {
                          setToolsMenuOpen(false);
                          if (!workspaceCwd) return;
                          revealWorkspaceInEditor(workspaceCwd, editor);
                        }}>
                          <Code2 size={15} /><span>在 {editor.name} 中打开</span>
                          {preferredWorkspaceEditor?.id === editor.id && <Check className="workspace-editor-selected" size={14} />}
                        </button>
                      ))}
                      {workspaceEditors.length > 0 && <div className="workspace-tools-separator" role="separator" />}
                      <button role="menuitem" disabled={!workspaceCwd} onClick={() => {
                        setToolsMenuOpen(false);
                        if (!workspaceCwd) return;
                        revealWorkspaceInExplorer(workspaceCwd);
                      }}>
                        <FolderOpen size={15} /><span>文件资源管理器</span>
                      </button>
                      <button role="menuitem" onClick={() => { setToolsMenuOpen(false); setBottomPanel(true); }}>
                        <SquareTerminal size={15} /><span>终端</span>
                      </button>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className={`panel-toggle ${inspectorTab ? "active" : ""}`}
                  title="切换置顶摘要"
                  aria-label="切换置顶摘要"
                  aria-pressed={Boolean(inspectorTab)}
                  onClick={() => {
                    if (inspectorTab) {
                      setInspectorTab(null);
                      setInspectorOpenView(null);
                    } else {
                      setWorkspaceSidebarOpen(false);
                      setWorkspaceTool(null);
                      setPreviewFile(null);
                      setInspectorTab("changes");
                      setInspectorOpenView(null);
                    }
                  }}
                >
                  <SlidersHorizontal size={15} strokeWidth={1.75} />
                </button>
                    </>
                  )}
                </div>
                <div className="workspace-pane-controls">
                  {workspaceSidebarVisible && (
                  <button
                    type="button"
                    className={`panel-toggle ${workspaceFocusMode ? "active" : ""}`}
                    title={workspaceFocusMode ? "退出侧边栏聚焦" : "聚焦侧边栏"}
                    aria-label={workspaceFocusMode ? "退出侧边栏聚焦" : "聚焦侧边栏"}
                    aria-pressed={workspaceFocusMode}
                    onClick={() => setWorkspaceFocusMode((value) => !value)}
                  >
                    {workspaceFocusMode
                      ? <Minimize2 size={14} strokeWidth={1.75} />
                      : <Maximize2 size={14} strokeWidth={1.75} />}
                  </button>
                  )}
                  <button
                  type="button"
                  className={`panel-toggle ${bottomPanel ? "active" : ""}`}
                  title="切换底部面板 (Ctrl+J)"
                  aria-label="切换底部面板"
                  aria-pressed={bottomPanel}
                  onClick={() => setBottomPanel((value) => !value)}
                >
                  <PanelBottom size={15} strokeWidth={1.75} />
                </button>
                  <button
                  type="button"
                  className={`panel-toggle ${workspaceSidebarVisible ? "active" : ""}`}
                  title="切换侧边栏 (Ctrl+Alt+B)"
                  aria-label="切换侧边栏"
                  aria-pressed={workspaceSidebarVisible}
                  onClick={toggleWorkspaceSidebar}
                >
                  <PanelRight size={15} strokeWidth={1.75} />
                </button>
                </div>
              </div>
            )}
          </div>
        </header>

        <div className="work-body">
        <div className={`work-split ${workspaceSidebarVisible ? "workspace-sidebar-open" : ""}${workspaceFocusMode ? " workspace-focus" : ""}`}>
        <WorkspaceFileOpenContext.Provider value={openPreviewFile}>
        <main className="main-stage">
          {hubView === "pull-requests" ? (
            <PullRequestsPage
              cwd={draftWorkspace || cwd}
              workspaceOptions={workspaceOptions}
              onOpenUrl={(url) => void openUrl(url)}
              onCheckout={async (pullRequest, repositoryRoot) => {
                try {
                  await pi.checkoutPullRequest(repositoryRoot, pullRequest.number);
                  navigateTo({ kind: "home", workspace: repositoryRoot });
                  store.showToast(`已检出 PR #${pullRequest.number}`, "info");
                } catch (error) {
                  store.showToast(`检出失败：${String(error)}`, "error");
                  throw error;
                }
              }}
              onReview={(pullRequest: PullRequestInfo, repositoryRoot) => {
                setGoalEditPrefill(`审查 GitHub 拉取请求 #${pullRequest.number}：${pullRequest.title}\n${pullRequest.url}\n检查正确性、回归风险、安全问题和缺失测试，并按严重程度给出文件引用。`);
                navigateTo({ kind: "home", workspace: repositoryRoot });
              }}
            />
          ) : hubView === "scheduled" ? (
            <ScheduledTasksPage
              workspaces={workspaceOptions}
              onTasksChanged={() => void store.refreshSessions()}
              onOpenSession={(workspace, file) => navigateTo({ kind: "session", cwd: workspace, file })}
              onError={(message) => store.showToast(message, "error")}
            />
          ) : hubView === "plugins" ? (
            <PluginMarketplacePage cwd={draftWorkspace || cwd} />
          ) : hubView === "sites" ? (
            <div className="feature-hub">
              <div className="feature-hub-heading"><span className="feature-hub-icon"><Globe2 size={22} /></span><div><h1>站点快捷方式</h1><p>识别当前项目中的 Web 应用并在本地启动检查。</p></div></div>
              <div className="feature-hub-card"><div className="feature-hub-stat"><strong>{draftWorkspace.split(/[\\/]/).filter(Boolean).pop() || "选择一个项目"}</strong><span>本地 Web 工作区</span></div><div className="feature-hub-actions"><button className="primary-button" onClick={() => { setHubView(null); void sendFromComposer("识别这个项目中的 Web 应用，启动本地开发服务器，检查首页是否可用，并把预览地址告诉我。若启动失败，请直接修复。", undefined); }}>启动并检查</button></div></div>
            </div>
          ) : <>
          <div
            ref={conversationScrollRef}
            className={`conversation-scroll ${newTask ? "new-task-scroll" : ""}`}
            onScroll={(event) => {
              const scroller = event.currentTarget;
              autoFollowConversationRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
            }}
          >
            <div className={`conversation ${newTask ? "new-task-conversation" : ""}`}>
              {newTask ? (
                <div className="new-task-screen codex-home">
                  <div className="home-mark cloud-mark" aria-hidden>
                    {/* Match Codex cloud + prompt glyph */}
                    <svg width="42" height="42" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M36 35.5H15.5c-4.3 0-7.8-3.3-7.8-7.4 0-3.5 2.4-6.5 5.7-7.3A10.2 10.2 0 0 1 33 14.2c.5 0 1 .05 1.5.12A7.1 7.1 0 0 1 43 21.3c0 3.9-3.1 7.1-7 7.2" />
                      <path d="m18.2 24.8 3.2 3.2-3.2 3.2" />
                      <path d="M24 31.2h5.2" />
                    </svg>
                  </div>
                  <h1 className="new-task-heading">
                    {quickChat ? (
                      "要聊些什么？"
                    ) : (
                      <>
                        要在 <span className="project-underline">{taskWorkspaceName}</span> 内开发什么？
                      </>
                    )}
                  </h1>
                  {store.lastError && <p className="new-task-error">{store.lastError}</p>}
                  <div className="starter-cards">
                    {STARTERS.map((starter) => {
                      const Icon = starter.Icon;
                      return (
                        <button
                          key={starter.title}
                          type="button"
                          className={`starter-card tone-${starter.tone}`}
                          onClick={() => void sendFromComposer(starter.prompt)}
                        >
                          <span className="starter-icon" aria-hidden><Icon size={18} strokeWidth={1.6} /></span>
                          <span>{starter.title}</span>
                        </button>
                      );
                    })}
                  </div>
                  {renderComposer("task-start")}
                  {recentWorkspaceSessions.length > 0 && (
                    <section className="home-recent" aria-label="最近对话">
                      <div className="home-recent-label">最近对话</div>
                      <div className="home-recent-list">
                        {recentWorkspaceSessions.map((session) => (
                          <button
                            key={session.file}
                            type="button"
                            className="home-recent-item"
                            onClick={() => navigateTo({ kind: "session", cwd: session.cwd, file: session.file })}
                          >
                            <span>{sessionTitle(session)}</span>
                            {session.messageCount > 0 && <small>{session.messageCount}</small>}
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              ) : (
                <>
                  {(threadElapsedLabel || isStreaming || gitDiffStats.additions > 0 || gitDiffStats.deletions > 0) && (
                    <div className="thread-meta-row">
                      {(threadElapsedLabel || isStreaming) && (
                        <span className="thread-status-chip" title={statusText}>
                          {isStreaming ? statusText : threadElapsedLabel}
                        </span>
                      )}
                      {(gitDiffStats.additions > 0 || gitDiffStats.deletions > 0) && (
                        <button
                          type="button"
                          className="title-diff-chip"
                          title="查看变更"
                          onClick={() => {
                            setWorkspaceTool(null);
                            setPreviewFile(null);
                            setInspectorOpenView(null);
                            setInspectorTab(inspectorTab === "changes" ? null : "changes");
                          }}
                        >
                          {gitDiffStats.additions > 0 && <em>+{gitDiffStats.additions}</em>}
                          {gitDiffStats.deletions > 0 && <b>-{gitDiffStats.deletions}</b>}
                        </button>
                      )}
                    </div>
                  )}
                  {hiddenMessageCount > 0 && (
                    <button
                      type="button"
                      className="load-earlier-messages"
                      onClick={() => setRenderedMessageLimit((value) => value + MESSAGE_RENDER_BATCH)}
                    >
                      加载更早消息（剩余 {hiddenMessageCount} 条）
                    </button>
                  )}
                  {visibleMessages.map((message) => (
                    <Message
                      key={message.id}
                      message={message}
                      showThinking={settings?.showThinking ?? true}
                      isLastAssistant={message.id === lastAssistantId}
                      globalStreaming={isStreaming}
                      onEdit={message.role === "user" ? editUserMessage : undefined}
                    />
                  ))}
                  {(git?.files.length ?? 0) > 0 && (
                    <section className="conversation-change-card" aria-label="当前工作区变更">
                      <div className="conversation-change-heading">
                        <button
                          type="button"
                          className="conversation-change-open"
                          onClick={() => setWorkspaceTool("review")}
                          title="查看变更"
                        >
                          <span className="conversation-change-icon"><FileDiff size={17} strokeWidth={1.7} /></span>
                          <div>
                            <strong>
                              {git!.files.length === 1
                                ? `已编辑 ${git!.files[0].path.split(/[\\/]/).pop()}`
                                : `已编辑 ${git!.files.length} 个文件`}
                            </strong>
                            <span>
                              {gitDiffStats.additions > 0 && <em>+{gitDiffStats.additions}</em>}
                              {" "}
                              {gitDiffStats.deletions > 0 && <b>-{gitDiffStats.deletions}</b>}
                            </span>
                          </div>
                        </button>
                        <button type="button" className="change-card-secondary" onClick={() => void restoreGitFiles()}>撤销</button>
                        <button type="button" onClick={() => void requestReview()}>审核</button>
                      </div>
                    </section>
                  )}
                  {Object.values(extensionWidgets).map((lines, index) => (
                    <div className="extension-widget" key={index}>{lines.map((line, lineIndex) => <div key={lineIndex}>{line}</div>)}</div>
                  ))}
                  {extensionRequest && <ExtensionDialog request={extensionRequest} onAnswer={(response) => void store.answerExtension(response)} />}
                </>
              )}
              <div />
            </div>
          </div>

          {!newTask && !hubView && (
            <div className="composer-dock">
              {renderComposer("follow-up")}
            </div>
          )}
          </>}
        </main>
        </WorkspaceFileOpenContext.Provider>
        {workspaceSidebarVisible && !workspaceFocusMode && (
          <div
            className="workspace-split-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整对话与工作区宽度"
            onMouseDown={beginWorkspaceResize}
          />
        )}
        {workspaceTool === "review" && (
          <InspectorPanel
            key={`dock-${workspaceTool}`}
            docked
            initialTab="changes"
            openView="changes"
            onClose={() => setWorkspaceTool(null)}
            git={newTask ? draftGit : git}
            cwd={workspaceCwd}
            messages={messages}
            environment={taskEnvironment}
            terminal={terminal}
            browser={browser}
            computer={computer}
            logs={piLog}
            sessionTree={store.sessionTree}
            sessionTreeLoading={store.sessionTreeLoading}
            sessionTreeError={store.sessionTreeError}
            sessionTreeLeafId={store.sessionTreeLeafId}
            isStreaming={isStreaming}
            onRefreshGit={() => void (newTask ? refreshDraftGit() : store.refreshGit())}
            onReview={() => void requestReview()}
            onReviewComment={(path, line, comment) => void sendFromComposer(
              `请处理这条代码审阅意见：\n\n文件：${path}${line ? `\n行号：${line}` : ""}\n意见：${comment}`,
            )}
            onCommitOrPush={() => void requestCommitOrPush()}
            onRestoreFiles={(paths) => void restoreGitFiles(paths)}
            onStageFiles={(paths) => updateGitIndex("stage", paths)}
            onUnstageFiles={(paths) => updateGitIndex("unstage", paths)}
            onEnvironmentChange={setTaskEnvironment}
            onSwitchWorkspace={(path) => void switchWorkspacePath(path)}
            onRunCommand={(command, exclude) => void store.runBash(command, exclude)}
            onAbortCommand={() => void store.abortBash()}
            onRefreshTree={refreshSessionTree}
            onContinueFromNode={continueFromTreeNode}
          />
        )}
        {workspaceTool === "browser" && (
          <BrowserWorkspacePanel
            recentBrowser={browser}
            onComment={(url, comment) => void sendFromComposer(`请根据这条页面反馈检查并修改页面：\n\n页面：${url}\n反馈：${comment}`)}
            onClose={() => setWorkspaceTool(null)}
          />
        )}
        {workspaceTool === "terminal" && (
          <TerminalWorkspacePanel
            cwd={workspaceCwd}
            shellLabel={settings?.terminalShell || "PowerShell"}
            onClose={() => setWorkspaceTool(null)}
          />
        )}
        {workspaceTool === "files" && (
          previewFile && workspaceCwd ? (
            <DocumentPane
              cwd={workspaceCwd}
              path={previewFile.path}
              line={previewFile.line}
              tabs={openFileTabs}
              onSelectTab={(path, line) => setPreviewFile({ path, line })}
              onCloseTab={closePreviewTab}
              onBack={() => setPreviewFile(null)}
              onClose={() => { setPreviewFile(null); setOpenFileTabs([]); setWorkspaceTool(null); }}
            />
          ) : (
            <FileTreePanel
              cwd={workspaceCwd}
              activePath={previewFile?.path ?? null}
              onOpenFile={(path) => openPreviewFile(path)}
              onAddToChat={(path) => void addWorkspaceFileToChat(path)}
              onOpenExternal={(path) => void openPath(workspaceFilePath(path))}
              onClose={() => { setPreviewFile(null); setWorkspaceTool(null); }}
            />
          )
        )}
        {workspaceTool === "side-chat" && (
          <SideChatPanel
            cwd={workspaceCwd}
            parentSessionFile={sessionFile}
            showThinking={settings?.showThinking ?? true}
            onClose={() => setWorkspaceTool(null)}
          />
        )}
        {workspaceSidebarVisible && !workspaceTool && !previewFile && (
          <ToolRail onSelect={toggleWorkspaceTool} />
        )}
        </div>

        {bottomPanel && (
          <TerminalWorkspacePanel
            key="bottom-terminal"
            cwd={workspaceCwd}
            shellLabel={settings?.terminalShell || "PowerShell"}
            placement="bottom"
            onClose={() => setBottomPanel(false)}
          />
        )}

        <div className="environment-flyout-layer" aria-hidden={!inspectorTab}>
          {inspectorTab && (
            <InspectorPanel
              initialTab={inspectorTab}
              openView={inspectorOpenView}
              onClose={() => { setInspectorTab(null); setInspectorOpenView(null); }}
              onError={(message) => store.showToast(message, "error")}
              git={newTask ? draftGit : git}
              cwd={newTask ? draftWorkspace : cwd}
              messages={messages}
              environment={taskEnvironment}
              terminal={terminal}
              browser={browser}
              computer={computer}
              logs={piLog}
              sessionTree={store.sessionTree}
              sessionTreeLoading={store.sessionTreeLoading}
              sessionTreeError={store.sessionTreeError}
              sessionTreeLeafId={store.sessionTreeLeafId}
              isStreaming={isStreaming}
              onRefreshGit={() => void (newTask ? refreshDraftGit() : store.refreshGit())}
              onReview={() => void requestReview()}
              onReviewComment={(path, line, comment) => void sendFromComposer(
                `请处理这条代码审阅意见：\n\n文件：${path}${line ? `\n行号：${line}` : ""}\n意见：${comment}`,
              )}
              onCommitOrPush={() => void requestCommitOrPush()}
              onRestoreFiles={(paths) => void restoreGitFiles(paths)}
              onStageFiles={(paths) => updateGitIndex("stage", paths)}
              onUnstageFiles={(paths) => updateGitIndex("unstage", paths)}
              onEnvironmentChange={setTaskEnvironment}
              onSwitchWorkspace={(path) => void switchWorkspacePath(path)}
              onRunCommand={(command, exclude) => void store.runBash(command, exclude)}
              onAbortCommand={() => void store.abortBash()}
              onRefreshTree={refreshSessionTree}
              onContinueFromNode={continueFromTreeNode}
            />
          )}
        </div>
        </div>
        </div>
        </div>
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
