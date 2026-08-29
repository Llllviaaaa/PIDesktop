import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { confirm, open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Check,
  ChevronDown,
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
import { pi } from "./lib/pi";
import {
  BUILTIN_APPEARANCE_CATALOG,
  createCustomAppearanceTheme,
  loadAppearanceCatalog,
  resolveAppearancePet,
  resolveAppearanceTheme,
} from "./lib/appearanceCatalog";
import { aggregateDiffStats } from "./lib/gitDiffStats";
import { activeSessionTitle, sessionRecency, sessionTitle } from "./lib/sessionTitle";
import { navigationKey, withoutArchivedSessions, type NavigationTarget as BaseNavigationTarget } from "./lib/navigationHistory";
import { sameLocalPath } from "./lib/pathIdentity";
import { ACTIVE_RUNTIME_KEY, LAST_TASK_KEY, readPersistedTask, useRuntimeBootstrap } from "./hooks/useRuntimeBootstrap";
import { usePiStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { Composer } from "./components/Composer";
import type { SettingsPage } from "./components/SettingsModal";
import { PetCompanion } from "./components/PetCompanion";
import {
  DESKTOP_PET_EVENT,
  DESKTOP_PET_STATE_KEY,
  type DesktopPetWindowState,
} from "./components/DesktopPetWindow";
import { ExtensionDialog } from "./components/ExtensionDialog";
import type { InspectorTab } from "./components/InspectorPanel";
import { ConnectedInspectorPanel } from "./components/ConnectedInspectorPanel";
import { ConversationMessages } from "./components/ConversationMessages";
import { ActiveGoalBar } from "./components/ActiveGoalBar";
import { ToolRail, type WorkspaceTool } from "./components/ToolRail";
import { FileTreePanel } from "./components/FileTreePanel";
import { DocumentPane } from "./components/DocumentPane";
import { BrowserWorkspacePanel } from "./components/BrowserWorkspacePanel";
import { SideChatPanel, type SideChatMeta } from "./components/SideChatPanel";
import { ReviewPanel, type ReviewTarget } from "./components/ReviewPanel";
import { WorkspaceFileOpenContext } from "./components/Markdown";
import type { AppSettings, AttachmentPayload, GitSnapshot, ModelInfo, ProjectConfig, PullRequestInfo, ScheduledRunRecord, SessionInfo, UiMessage, WorkspaceEditorInfo } from "./types";

const SettingsModal = lazy(() => import("./components/SettingsModal").then((module) => ({ default: module.SettingsModal })));
const PullRequestsPage = lazy(() => import("./components/PullRequestsPage").then((module) => ({ default: module.PullRequestsPage })));
const ScheduledTasksPage = lazy(() => import("./components/ScheduledTasksPage").then((module) => ({ default: module.ScheduledTasksPage })));
const PluginMarketplacePage = lazy(() => import("./components/PluginMarketplacePage").then((module) => ({ default: module.PluginMarketplacePage })));
const TerminalWorkspacePanel = lazy(() => import("./components/TerminalWorkspacePanel").then((module) => ({ default: module.TerminalWorkspacePanel })));

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
type NavigationTarget = BaseNavigationTarget<HubView>;

interface SideChatInstance extends SideChatMeta {
  id: string;
  cwd: string;
  parentSessionFile: string;
  createdAt: number;
}

function selectAppShellState(state: ReturnType<typeof usePiStore.getState>) {
  const { messages, ...shellState } = state;
  void messages;
  return shellState;
}

const ANTIGRAVITY_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAALlSURBVFhH7dbZS1RxGMbxtj8m6q5odNQ0jYLSFipDxDAiqDAvijCihWzDObPokDZaWZGVaEk7XbRDi0EbUUGLF0abZFakjjnOfMOkXzPPzEmjueiiz+X5Pe/7MGc4nDNq1H//KmA0SaK7hwVs0SV/SztsARt1OFm0Kw4wRoeSTTtjABEdsPP25Hi6aibQs2Ey35amQmTEo8e119CkndYbGTw8l86L+kze7cjhS0k2wYJsjdkZ0F5Dk3aars/n1Ll8rjYU8shXyKuyhXQtm0PvrAyNJqS9hgYT8d0qpuLyarxn17P/2GZO12yitXwNL0uX86FoscYT0l5DgyocCbP2Shmrzrsoaalj/ZEGvHUNNLprubZhF09WrCV4/6GOxdFeQ4PKe6+OwjN+FjQ3sujoRYoO3KIk0Mp23xXqy09wYV2Auyu36Vgc7TU0qPLPVjO7qYUZh24wY99TcmvbWbi7nRWVbWxyPaBm6yVayhp1LI72GhpUM5tOknXwNlPrXpJZ3UGW/wszq7qZ5/tEsec9ZRXP8W67o2NxtNfQoMo40Ep6oA2n/yOp3h5SrH6cVogsd4hcdy9LPJ9ZY71my9bHOhpDew0NRpu87ybOQBupVR9xuPtIsQboHxg6m1geYaoVJtfTT1FlN6W+Th2Pob2GBqM5al/g8HcyxR2ktDmsxz9MsyLk+QYo8vcRThz5QXsNDUZzVHfg8PWQ4g7pkbH9PGS7I8ytDFO8xz6nvYYGf0oLvMHp/4rD0z/syyLdFSHHE2Fulf0t0F5Dgz9N2/OZtMo+nG77pdHSXDDdo1d/0V5Dg4Ny67vIqQ6S5rW/pWrSTsiwYLpPT4Zor6HBjq9h8vb2ku0P/cHbdsiUCki3IMcbP6i9hgaXHA6SFwgRjt8xIqkuyPLC0kMxC0Laa0SnBn+xdXFk//nvPOvQKyzS3hiaTjbtS0iHkmicdtnSySQYqx3DApoHv+F00x8YfHYLdO9//5TvWpRbXvydcf8AAAAASUVORK5CYII=";

function WorkspaceEditorIcon({ editorId, size = 16 }: { editorId?: WorkspaceEditorInfo["id"]; size?: number }) {
  if (editorId === "cursor") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect width="24" height="24" rx="5.5" fill="#202124" />
        <path d="M12 5.4 18 8.85 12 12.3 6 8.85 12 5.4Z" fill="#f7f7f7" />
        <path d="M6 8.85 12 12.3v6.3l-6-3.45v-6.3Z" fill="#a7a7a7" />
        <path d="M18 8.85 12 12.3v6.3l6-3.45v-6.3Z" fill="#d7d7d7" />
      </svg>
    );
  }
  if (editorId === "vscode") {
    return (
      <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden>
        <path d="M96.461 10.796 75.857.876c-2.385-1.149-5.235-.664-7.107 1.207L1.299 63.583c-1.815 1.654-1.813 4.511.004 6.162l5.51 5.009c1.485 1.35 3.722 1.45 5.321.237l81.227-61.621c2.725-2.067 6.639-.124 6.639 3.297v-.239c0-2.402-1.375-4.59-3.539-5.632Z" fill="#0065A9" />
        <path d="M96.461 89.204 75.857 99.124c-2.385 1.149-5.235.665-7.107-1.207L1.299 36.417c-1.815-1.654-1.813-4.511.004-6.162l5.51-5.009c1.485-1.35 3.722-1.45 5.321-.236l81.227 61.62c2.725 2.067 6.639.124 6.639-3.297v.24c0 2.401-1.375 4.59-3.539 5.631Z" fill="#007ACC" />
        <path d="M75.858 99.126c-2.386 1.148-5.236.663-7.108-1.209 2.306 2.306 6.25.673 6.25-2.589V4.672c0-3.262-3.944-4.895-6.25-2.589C70.622.211 73.472-.274 75.858.874l20.601 9.907C98.623 11.822 100 14.011 100 16.413v67.174c0 2.402-1.377 4.592-3.541 5.633L75.858 99.126Z" fill="#1F9CF0" />
      </svg>
    );
  }
  if (editorId === "windsurf") {
    return (
      <svg width={size} height={size} viewBox="0 0 1024 1024" fill="none" aria-hidden>
        <path d="M897.246 286.869h-7.427c-39.084-.061-70.802 31.591-70.802 70.67v158.05c0 31.561-26.087 57.127-57.135 57.127-18.446 0-36.862-9.283-47.789-24.866L552.673 317.304c-13.393-19.144-35.187-30.557-58.778-30.557-36.801 0-69.919 31.287-69.919 69.91v158.962c0 31.562-25.873 57.127-57.134 57.127-18.507 0-36.893-9.283-47.821-24.865L138.395 289.882c-4.079-5.844-13.241-2.952-13.241 4.17v137.84c0 6.97 2.131 13.727 6.118 19.448l177.765 253.86c10.502 15.004 25.996 26.144 43.863 30.192 44.716 10.165 85.87-24.257 85.87-68.114V508.406c0-31.561 25.569-57.127 57.134-57.127h.091c19.025 0 36.862 9.283 47.79 24.866l161.45 230.516c13.424 19.174 34.092 30.557 58.748 30.557 37.623 0 69.858-31.318 69.858-69.91V508.376c0-31.561 25.569-57.127 57.134-57.127h6.301c3.957 0 7.154-3.196 7.154-7.152V294.021c0-3.956-3.197-7.152-7.154-7.152h-.03Z" fill="currentColor" />
      </svg>
    );
  }
  if (editorId === "antigravity") {
    return <img src={ANTIGRAVITY_ICON} width={size} height={size} alt="" aria-hidden />;
  }
  return <FolderOpen size={size} strokeWidth={1.8} aria-hidden />;
}

const SIDEBAR_WIDTH_KEY = "pid-desktop:sidebar-width:v2";
const WORKSPACE_PANEL_WIDTH_KEY = "pid-desktop:workspace-panel-width:v5";
const BOTTOM_PANEL_HEIGHT_KEY = "pid-desktop:bottom-panel-height:v1";
const WORKSPACE_PANEL_MIN_WIDTH = 320;
const WORKSPACE_PANEL_MAX_WIDTH = 900;
const BOTTOM_PANEL_MIN_HEIGHT = 180;
const BOTTOM_PANEL_MAX_HEIGHT = 520;

export default function App() {
  const store = usePiStore(useShallow(selectAppShellState));
  const {
    connection,
    cwd,
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
    agentBrowser,
    computer,
    terminal,
    piLog,
    extensionRequest,
    extensionWidgets,
    composerPrefill,
    runtimeId,
    runtimes,
    toasts,
    notifications,
  } = store;
  const [draftMode, setDraftMode] = useState(() => {
    if (!import.meta.env.DEV) return true;
    const fixture = new URLSearchParams(window.location.search).get("fixture");
    return fixture !== "thread" && fixture !== "performance" && fixture !== "stream" && fixture !== "queue" && fixture !== "title" && fixture !== "diagrams" && fixture !== "goal";
  });
  const newTask = draftMode;
  const [sidebarVisible, setSidebarVisible] = useState(() => window.innerWidth > 900);
  const [sidebarHoverPreview, setSidebarHoverPreview] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(stored) && stored >= 200 && stored <= 380 ? stored : 240;
  });
  const [workspacePanelWidth, setWorkspacePanelWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem(WORKSPACE_PANEL_WIDTH_KEY));
    return Number.isFinite(stored) && stored >= WORKSPACE_PANEL_MIN_WIDTH && stored <= WORKSPACE_PANEL_MAX_WIDTH ? stored : 420;
  });
  const [bottomPanelHeight, setBottomPanelHeight] = useState(() => {
    const stored = Number(window.localStorage.getItem(BOTTOM_PANEL_HEIGHT_KEY));
    return Number.isFinite(stored) && stored >= BOTTOM_PANEL_MIN_HEIGHT && stored <= BOTTOM_PANEL_MAX_HEIGHT ? stored : 280;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("general");
  const [appearanceCatalog, setAppearanceCatalog] = useState(BUILTIN_APPEARANCE_CATALOG);
  const [hubView, setHubView] = useState<HubView | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab | null>(null);
  const [inspectorOpenView, setInspectorOpenView] = useState<InspectorTab | null>(null);
  const [bottomPanel, setBottomPanel] = useState(false);
  const [workspaceSidebarOpen, setWorkspaceSidebarOpen] = useState(false);
  const [workspaceFocusMode, setWorkspaceFocusMode] = useState(false);
  const [workspaceTool, setWorkspaceTool] = useState<WorkspaceTool | null>(null);
  const [sideChats, setSideChats] = useState<SideChatInstance[]>([]);
  const [activeSideChatId, setActiveSideChatId] = useState<string | null>(null);
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
  const [editingMessage, setEditingMessage] = useState<{ messageId: string } | null>(null);

  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const autoFollowConversationRef = useRef(true);
  const lastAutoScrollAtRef = useRef(0);
  const firstUserMessage = usePiStore((state) => state.messages.find((message) => message.role === "user")?.content);
  const resolvedThreadTitle = useMemo(() => activeSessionTitle({
    sessions,
    sessionFile,
    sessionId,
    sessionName,
    firstMessage: firstUserMessage,
  }), [firstUserMessage, sessionFile, sessionId, sessionName, sessions]);
  const navigationBackRef = useRef<NavigationTarget[]>([]);
  const navigationForwardRef = useRef<NavigationTarget[]>([]);
  const sidebarHoverCloseTimerRef = useRef<number | null>(null);
  const [navigationVersion, setNavigationVersion] = useState(0);
  const isTauri = "__TAURI_INTERNALS__" in window;
  const layoutScale = Math.min(150, Math.max(75, settings?.uiScale ?? 100)) / 100;
  const petFixture = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("pet") : null;
  const previewPet = petFixture && appearanceCatalog.pets.some((pet) => pet.id === petFixture) ? petFixture : null;
  const activePet = useMemo(
    () => resolveAppearancePet(appearanceCatalog, previewPet ?? settings?.petCharacter ?? "cat"),
    [appearanceCatalog, previewPet, settings?.petCharacter],
  );
  const petBusy = isStreaming || isCompacting || connection === "starting";
  const { runtimeRecoveryDone, startupAutoConnectRef } = useRuntimeBootstrap({
    isTauri,
    connection,
    sessions,
    autoConnect: settings?.autoConnect ?? false,
    runtimeId,
    cwd,
    sessionFile,
    draftMode,
    onDraftModeChange: setDraftMode,
    onDraftWorkspaceChange: setDraftWorkspace,
  });
  const appWindow = isTauri ? getCurrentWindow() : null;
  const workspaceCwd = newTask ? draftWorkspace : cwd;
  const workspaceSidebarVisible = workspaceSidebarOpen || Boolean(workspaceTool || previewFile);
  const sidebarRendered = sidebarVisible || sidebarHoverPreview;
  const currentSideChats = useMemo(
    () => sessionFile ? sideChats.filter((chat) => sameLocalPath(chat.parentSessionFile, sessionFile)) : [],
    [sessionFile, sideChats],
  );

  useEffect(() => {
    if (isTauri) return;
    void usePiStore.getState().loadSettings();
  }, [isTauri]);

  const reloadAppearanceCatalog = useCallback(async () => {
    if (!isTauri) {
      setAppearanceCatalog(BUILTIN_APPEARANCE_CATALOG);
      return;
    }
    try {
      setAppearanceCatalog(await loadAppearanceCatalog(cwd));
    } catch (error) {
      setAppearanceCatalog(BUILTIN_APPEARANCE_CATALOG);
      throw error;
    }
  }, [cwd, isTauri]);

  useEffect(() => {
    void reloadAppearanceCatalog().catch(() => undefined);
  }, [reloadAppearanceCatalog, settingsOpen]);

  useEffect(() => {
    if (!isTauri || !settings) return;
    let cancelled = false;
    const payload: DesktopPetWindowState = {
      enabled: settings.petEnabled,
      pet: activePet,
      busy: petBusy,
    };
    window.localStorage.setItem(DESKTOP_PET_STATE_KEY, JSON.stringify(payload));
    void getAllWindows()
      .then(async (windows) => {
        const petWindow = windows.find((windowHandle) => windowHandle.label === "desktop-pet");
        if (!petWindow || cancelled) return;
        await emitTo("desktop-pet", DESKTOP_PET_EVENT, payload);
        if (cancelled) return;
        if (payload.enabled) await petWindow.show();
        else await petWindow.hide();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activePet, isTauri, petBusy, settings]);

  const createSideChat = useCallback(() => {
    if (newTask || !sessionFile || !workspaceCwd) {
      usePiStore.getState().showToast("请先开始当前任务，再创建侧边聊天", "warning");
      return null;
    }
    const id = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `side-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const next: SideChatInstance = {
      id,
      cwd: workspaceCwd,
      parentSessionFile: sessionFile,
      createdAt: Date.now(),
      title: "侧边聊天",
      phase: "starting",
      isStreaming: false,
    };
    setSideChats((current) => [...current, next]);
    setActiveSideChatId(id);
    setInspectorTab(null);
    setInspectorOpenView(null);
    setPreviewFile(null);
    setWorkspaceSidebarOpen(true);
    setWorkspaceTool("side-chat");
    return id;
  }, [newTask, sessionFile, workspaceCwd]);

  const openSideChat = useCallback((id: string) => {
    const target = sideChats.find((chat) => chat.id === id);
    if (!target || !sessionFile || !sameLocalPath(target.parentSessionFile, sessionFile)) return;
    setActiveSideChatId(id);
    setInspectorTab(null);
    setInspectorOpenView(null);
    setPreviewFile(null);
    setWorkspaceSidebarOpen(true);
    setWorkspaceTool("side-chat");
  }, [sessionFile, sideChats]);

  const updateSideChatMeta = useCallback((id: string, meta: SideChatMeta) => {
    setSideChats((current) => {
      let changed = false;
      const next = current.map((chat) => {
        if (chat.id !== id) return chat;
        if (chat.title === meta.title && chat.phase === meta.phase && chat.isStreaming === meta.isStreaming) return chat;
        changed = true;
        return { ...chat, ...meta };
      });
      return changed ? next : current;
    });
  }, []);

  const showErrorToast = useCallback((message: string) => {
    usePiStore.getState().showToast(message, "error");
  }, []);

  const deleteSideChat = useCallback((id: string) => {
    const remaining = sideChats.filter((chat) => chat.id !== id);
    setSideChats(remaining);
    if (activeSideChatId !== id) return;
    const replacement = sessionFile
      ? [...remaining].reverse().find((chat) => sameLocalPath(chat.parentSessionFile, sessionFile))
      : undefined;
    setActiveSideChatId(replacement?.id ?? null);
    if (!replacement) setWorkspaceTool(null);
  }, [activeSideChatId, sessionFile, sideChats]);

  const toggleWorkspaceTool = useCallback((tool: WorkspaceTool) => {
    if (tool === "side-chat") {
      if (workspaceTool === "side-chat") {
        setWorkspaceTool(null);
        return;
      }
      if (newTask || !sessionFile || !workspaceCwd) {
        usePiStore.getState().showToast("请先开始当前任务，再创建侧边聊天", "warning");
        return;
      }
      const active = currentSideChats.find((chat) => chat.id === activeSideChatId)
        ?? currentSideChats[currentSideChats.length - 1];
      if (!active) {
        createSideChat();
        return;
      }
      openSideChat(active.id);
      return;
    }
    setInspectorTab(null);
    setInspectorOpenView(null);
    setPreviewFile(tool === "files" ? (openFileTabs[openFileTabs.length - 1] ?? null) : null);
    setWorkspaceSidebarOpen(true);
    setWorkspaceTool((current) => (current === tool ? null : tool));
  }, [activeSideChatId, createSideChat, currentSideChats, newTask, openFileTabs, openSideChat, sessionFile, workspaceCwd, workspaceTool]);
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
      setInspectorTab(null);
      setInspectorOpenView(null);
      return;
    }
    setInspectorTab(null);
    setInspectorOpenView(null);
    setWorkspaceTool(null);
    setPreviewFile(null);
    setWorkspaceSidebarOpen(true);
  }, [workspaceSidebarVisible]);

  const cancelSidebarHoverClose = useCallback(() => {
    if (sidebarHoverCloseTimerRef.current === null) return;
    window.clearTimeout(sidebarHoverCloseTimerRef.current);
    sidebarHoverCloseTimerRef.current = null;
  }, []);

  const showSidebarHoverPreview = useCallback(() => {
    if (sidebarVisible) return;
    cancelSidebarHoverClose();
    setSidebarHoverPreview(true);
  }, [cancelSidebarHoverClose, sidebarVisible]);

  const scheduleSidebarHoverClose = useCallback(() => {
    if (sidebarVisible) return;
    cancelSidebarHoverClose();
    sidebarHoverCloseTimerRef.current = window.setTimeout(() => {
      setSidebarHoverPreview(false);
      sidebarHoverCloseTimerRef.current = null;
    }, 160);
  }, [cancelSidebarHoverClose, sidebarVisible]);

  const togglePrimarySidebar = useCallback(() => {
    cancelSidebarHoverClose();
    setSidebarHoverPreview(false);
    setSidebarVisible((value) => !value);
  }, [cancelSidebarHoverClose]);

  const pinPrimarySidebar = useCallback(() => {
    cancelSidebarHoverClose();
    setSidebarHoverPreview(false);
    setSidebarVisible(true);
  }, [cancelSidebarHoverClose]);

  useEffect(() => {
    if (!sidebarVisible) return;
    cancelSidebarHoverClose();
    setSidebarHoverPreview(false);
  }, [cancelSidebarHoverClose, sidebarVisible]);

  useEffect(() => () => cancelSidebarHoverClose(), [cancelSidebarHoverClose]);

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
      usePiStore.getState().addNotification({
        id: `scheduled:${event.payload.id}:${event.payload.status}`,
        kind: "completion",
        title: event.payload.status === "success" ? "计划任务已完成" : "计划任务未完成",
        body: event.payload.taskName,
        cwd: event.payload.cwd,
        sessionFile: event.payload.sessionFile ?? null,
      });
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
    if (!settings) return;
    // Apply product default once settings arrive; user can still toggle chips afterward.
    setTaskEnvironment(settings.defaultTaskEnvironment === "worktree" ? "worktree" : "local");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only sync when settings object first becomes available / default changes
  }, [settings?.defaultTaskEnvironment]);

  useEffect(() => {
    window.localStorage.setItem("pid-desktop:task-environment", taskEnvironment);
  }, [taskEnvironment]);

  useEffect(() => {
    const root = document.documentElement;
    const systemTheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const fixtureTheme = import.meta.env.DEV && !isTauri
        ? new URLSearchParams(window.location.search).get("theme")
        : null;
      const requestedTheme = fixtureTheme && appearanceCatalog.themes.some((theme) => theme.id === fixtureTheme)
        ? fixtureTheme
        : settings?.theme ?? "system";
      const theme = requestedTheme === "custom"
        ? createCustomAppearanceTheme(
            settings?.backgroundColor ?? "#ffffff",
            settings?.foregroundColor ?? "#1a1a1a",
            settings?.accentColor ?? "#18181b",
          )
        : resolveAppearanceTheme(appearanceCatalog, requestedTheme, systemTheme?.matches ?? false);
      const palette = theme.palette;
      if (!palette) return;
      root.dataset.theme = theme.mode;
      const variables: Record<string, string> = {
        "--app": palette.app,
        "--panel": palette.panel,
        "--panel-strong": palette.panelStrong,
        "--panel-soft": palette.panelSoft,
        "--hover": palette.hover,
        "--active": palette.active,
        "--border": palette.border,
        "--border-strong": palette.borderStrong,
        "--text": palette.text,
        "--text-2": palette.text2,
        "--text-3": palette.text3,
        "--accent": palette.accent,
        "--accent-custom": palette.accent,
        "--accent-text": palette.accentText,
        "--sidebar-bg": palette.sidebar,
        "--sidebar-text": palette.text2,
        "--thread-muted": palette.text3,
      };
      for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
      root.style.setProperty("--code-font", settings?.codeFont || 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace');
      root.style.fontFamily = settings?.uiFont || '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      root.style.color = palette.text;
      root.style.background = palette.app;
      const appRoot = document.getElementById("root");
      if (appRoot) {
        const scale = Math.min(150, Math.max(75, settings?.uiScale ?? 100)) / 100;
        appRoot.style.zoom = String(scale);
        appRoot.style.width = `${100 / scale}%`;
        appRoot.style.height = `${100 / scale}%`;
      }
    };
    applyTheme();
    systemTheme?.addEventListener("change", applyTheme);
    return () => systemTheme?.removeEventListener("change", applyTheme);
  }, [appearanceCatalog, isTauri, settings]);

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
      if (ctrl && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setBottomPanel((value) => !value);
        return;
      }
      if (ctrl && !event.altKey && !event.shiftKey && (event.code === "Backquote" || event.key === "`")) {
        event.preventDefault();
        setInspectorTab(null);
        setInspectorOpenView(null);
        setPreviewFile(null);
        setWorkspaceSidebarOpen(true);
        setWorkspaceTool((current) => (current === "terminal" ? null : "terminal"));
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
        toggleWorkspaceTool("side-chat");
        return;
      }
      if (shortcut === normalize(shortcuts.newChat) && connection === "running") {
        event.preventDefault();
        store.prepareNewTask();
        setDraftMode(true);
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
        togglePrimarySidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [connection, settings, settingsOpen, store.prepareNewTask, togglePrimarySidebar, toggleWorkspaceSidebar, toggleWorkspaceTool]);

  useEffect(() => {
    if (!editingTitle) setTitleDraft(resolvedThreadTitle);
  }, [editingTitle, resolvedThreadTitle]);

  useEffect(() => {
    setEditingMessage(null);
    autoFollowConversationRef.current = true;
  }, [runtimeId, sessionFile]);

  useEffect(() => {
    const viewedSession = !newTask && !hubView && !settingsOpen ? sessionFile : null;
    store.setViewedSession(viewedSession);
    const markVisibleSessionViewed = () => store.setViewedSession(viewedSession);
    window.addEventListener("focus", markVisibleSessionViewed);
    return () => {
      window.removeEventListener("focus", markVisibleSessionViewed);
      store.setViewedSession(null);
    };
  }, [hubView, newTask, sessionFile, settingsOpen, store.setViewedSession]);

  useEffect(() => {
    if (workspaceTool !== "side-chat") return;
    if (!sessionFile || newTask) {
      setWorkspaceTool(null);
      return;
    }
    const activeMatches = currentSideChats.some((chat) => chat.id === activeSideChatId);
    if (activeMatches) return;
    const replacement = currentSideChats[currentSideChats.length - 1];
    if (replacement) setActiveSideChatId(replacement.id);
    else setWorkspaceTool(null);
  }, [activeSideChatId, currentSideChats, newTask, sessionFile, workspaceTool]);

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
    if (!runtimeRecoveryDone || !newTask || hubView !== null || connection !== "disconnected" || startupAutoConnectRef.current) return;
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
  }, [connection, draftWorkspace, hubView, isTauri, newTask, runtimeRecoveryDone, store.connect]);

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
    const enteringConversation = newTask;
    const enterConversation = () => {
      if (!enteringConversation) return;
      setDraftMode(false);
      setHubView(null);
    };
    const restoreInitialPrompt = () => {
      if (enteringConversation) usePiStore.setState({ composerPrefill: text });
    };
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
      const connection = current.connect(workspace);
      enterConversation();
      await connection;
      current = usePiStore.getState();
      if (current.connection !== "running") {
        restoreInitialPrompt();
        return false;
      }
    }
    if (taskEnvironment === "worktree" && current.messages.length === 0 && !quickChat) {
      try {
        // Ensure git snapshot is available for base branch when possible.
        await current.refreshGit();
        current = usePiStore.getState();
        const worktree = await pi.createWorktree(current.cwd, current.git?.branch);
        window.localStorage.setItem("pid-desktop:last-workspace", worktree.path);
        setDraftWorkspace(worktree.path);
        const connection = current.connect(worktree.path);
        enterConversation();
        await connection;
        current = usePiStore.getState();
        if (current.connection !== "running") {
          restoreInitialPrompt();
          return false;
        }
      } catch (error) {
        current.appendLog(`创建 Worktree 失败：${String(error)}`);
        current.showToast(`创建 Worktree 失败：${String(error)}`, "error");
        restoreInitialPrompt();
        return false;
      }
    }
    enterConversation();
    const sent = await current.sendMessage(text, attachments, behavior);
    if (sent) {
      setAttachments([]);
    } else restoreInitialPrompt();
    return sent;
  }, [attachments, draftWorkspace, newTask, quickChat, selectWorkspace, taskEnvironment]);

  const startNewTask = useCallback((asQuickChat = false) => {
    const current = usePiStore.getState();
    if (current.cwd && !current.cwd.toLowerCase().endsWith("quick-chat")) setDraftWorkspace(current.cwd);
    current.prepareNewTask();
    setDraftMode(true);
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
    setDraftMode(true);
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

  const selectWorkspaceEditor = useCallback((workspace: string, editor: WorkspaceEditorInfo) => {
    if (!workspace) return;
    revealWorkspaceInEditor(workspace, editor);
    const current = usePiStore.getState();
    if (!current.settings || current.settings.defaultFileOpener === editor.id) return;
    void current.saveSettings({ ...current.settings, defaultFileOpener: editor.id }).catch((error) => {
      current.showToast(`无法保存默认打开应用：${String(error)}`, "error");
    });
  }, [revealWorkspaceInEditor]);

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
    setDraftMode(false);
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

  const forgetArchivedSessions = useCallback((archivedFiles: string[]) => {
    navigationBackRef.current = withoutArchivedSessions(navigationBackRef.current, archivedFiles);
    navigationForwardRef.current = withoutArchivedSessions(navigationForwardRef.current, archivedFiles);
    const persistedTask = readPersistedTask();
    if (persistedTask && archivedFiles.some((file) => sameLocalPath(file, persistedTask.sessionFile))) {
      window.localStorage.removeItem(LAST_TASK_KEY);
    }
    setNavigationVersion((value) => value + 1);
  }, []);

  const archiveConversations = useCallback(async (
    targets: Array<Pick<SessionInfo, "cwd" | "file">>,
    fallbackWorkspace: string,
    successMessage: string,
  ) => {
    if (targets.length === 0) return;
    const archivedFiles = targets.map((target) => target.file);
    try {
      await Promise.all(archivedFiles.map((file) => pi.archiveSession(file)));
    } catch (error) {
      usePiStore.getState().showToast(`归档失败：${String(error)}`, "error");
      return;
    }

    const activeFile = usePiStore.getState().sessionFile;
    const activeTarget = activeFile
      ? targets.find((target) => sameLocalPath(target.file, activeFile))
      : undefined;
    forgetArchivedSessions(archivedFiles);

    let closeWarning: string | null = null;
    if (activeTarget) {
      window.localStorage.removeItem(ACTIVE_RUNTIME_KEY);
      window.localStorage.removeItem(LAST_TASK_KEY);
      try {
        await usePiStore.getState().disconnect();
      } catch (error) {
        closeWarning = error instanceof Error ? error.message : String(error);
        usePiStore.getState().appendLog(`归档后关闭旧任务失败：${closeWarning}`);
      }
      await applyNavigationTarget({ kind: "home", workspace: activeTarget.cwd || fallbackWorkspace });
    }

    try {
      await usePiStore.getState().refreshSessions();
    } catch (error) {
      usePiStore.getState().appendLog(`归档后刷新会话失败：${error instanceof Error ? error.message : String(error)}`);
    }
    usePiStore.getState().showToast(
      closeWarning ? `${successMessage}；旧任务进程关闭失败，但已返回项目首页` : successMessage,
      closeWarning ? "warning" : "info",
    );
  }, [applyNavigationTarget, forgetArchivedSessions]);

  const canNavigateBack = navigationVersion >= 0 && navigationBackRef.current.length > 0;
  const canNavigateForward = navigationVersion >= 0 && navigationForwardRef.current.length > 0;

  const beginSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    const scale = Math.min(150, Math.max(75, settings?.uiScale ?? 100)) / 100;
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const next = Math.min(380, Math.max(200, startWidth + (move.clientX - startX) / scale));
      setSidebarWidth(next);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.body.classList.remove("sidebar-is-resizing");
      setSidebarWidth((current) => {
        window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(current));
        return current;
      });
    };
    target.setPointerCapture(pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.body.classList.add("sidebar-is-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [settings?.uiScale, sidebarWidth]);

  const resizeSidebarWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const increment = event.shiftKey ? 24 : 8;
    const next = event.key === "ArrowLeft"
      ? Math.max(200, sidebarWidth - increment)
      : event.key === "ArrowRight"
        ? Math.min(380, sidebarWidth + increment)
        : event.key === "Home"
          ? 200
          : event.key === "End"
            ? 380
            : null;
    if (next === null) return;
    event.preventDefault();
    setSidebarWidth(next);
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
  }, [sidebarWidth]);

  const workspacePanelMaxWidth = useCallback(() => {
    const mainStageMinWidth = 360;
    const available = window.innerWidth / layoutScale - (sidebarVisible ? sidebarWidth : 0) - mainStageMinWidth;
    return Math.max(WORKSPACE_PANEL_MIN_WIDTH, Math.min(WORKSPACE_PANEL_MAX_WIDTH, available));
  }, [layoutScale, sidebarVisible, sidebarWidth]);

  const beginWorkspaceResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = workspacePanelWidth;
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const next = Math.min(workspacePanelMaxWidth(), Math.max(WORKSPACE_PANEL_MIN_WIDTH, startWidth + (startX - move.clientX) / layoutScale));
      setWorkspacePanelWidth(next);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.body.classList.remove("workspace-is-resizing");
      setWorkspacePanelWidth((current) => {
        window.localStorage.setItem(WORKSPACE_PANEL_WIDTH_KEY, String(current));
        return current;
      });
    };
    target.setPointerCapture(pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.body.classList.add("workspace-is-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [layoutScale, workspacePanelMaxWidth, workspacePanelWidth]);

  const resizeWorkspaceWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const increment = event.shiftKey ? 32 : 10;
    const maxWidth = workspacePanelMaxWidth();
    const next = event.key === "ArrowLeft"
      ? Math.min(maxWidth, workspacePanelWidth + increment)
      : event.key === "ArrowRight"
        ? Math.max(WORKSPACE_PANEL_MIN_WIDTH, workspacePanelWidth - increment)
        : event.key === "Home"
          ? WORKSPACE_PANEL_MIN_WIDTH
          : event.key === "End"
            ? maxWidth
            : null;
    if (next === null) return;
    event.preventDefault();
    setWorkspacePanelWidth(next);
    window.localStorage.setItem(WORKSPACE_PANEL_WIDTH_KEY, String(next));
  }, [workspacePanelMaxWidth, workspacePanelWidth]);

  const bottomPanelMaxHeight = useCallback(
    () => Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.min(BOTTOM_PANEL_MAX_HEIGHT, window.innerHeight / layoutScale - 240)),
    [layoutScale],
  );

  const beginBottomPanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startY = event.clientY;
    const startHeight = bottomPanelHeight;
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const next = Math.min(bottomPanelMaxHeight(), Math.max(BOTTOM_PANEL_MIN_HEIGHT, startHeight + (startY - move.clientY) / layoutScale));
      setBottomPanelHeight(next);
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.body.classList.remove("bottom-panel-is-resizing");
      setBottomPanelHeight((current) => {
        window.localStorage.setItem(BOTTOM_PANEL_HEIGHT_KEY, String(current));
        return current;
      });
    };
    target.setPointerCapture(pointerId);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.body.classList.add("bottom-panel-is-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [bottomPanelHeight, bottomPanelMaxHeight, layoutScale]);

  const resizeBottomPanelWithKeyboard = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const increment = event.shiftKey ? 32 : 10;
    const maxHeight = bottomPanelMaxHeight();
    const next = event.key === "ArrowUp"
      ? Math.min(maxHeight, bottomPanelHeight + increment)
      : event.key === "ArrowDown"
        ? Math.max(BOTTOM_PANEL_MIN_HEIGHT, bottomPanelHeight - increment)
        : event.key === "Home"
          ? BOTTOM_PANEL_MIN_HEIGHT
          : event.key === "End"
            ? maxHeight
            : null;
    if (next === null) return;
    event.preventDefault();
    setBottomPanelHeight(next);
    window.localStorage.setItem(BOTTOM_PANEL_HEIGHT_KEY, String(next));
  }, [bottomPanelHeight, bottomPanelMaxHeight]);

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
    const previous = current.settings.permissionMode;
    try {
      await current.setRuntimePermissionMode(mode);
      await current.saveSettings({ ...current.settings, permissionMode: mode });
      usePiStore.getState().showToast("权限模式已更新", "info");
    } catch (error) {
      await usePiStore.getState().setRuntimePermissionMode(previous).catch(() => undefined);
      usePiStore.getState().showToast(`切换权限失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }, []);
  const changeComposerAgentMode = useCallback(async (mode: AppSettings["agentMode"]) => {
    const current = usePiStore.getState();
    if (!current.settings || current.settings.agentMode === mode) return;
    if (current.isStreaming) {
      current.showToast("请等待当前回复完成后再切换工作模式", "warning");
      return;
    }
    const previous = current.settings.agentMode;
    try {
      await current.setRuntimeAgentMode(mode);
      await current.saveSettings({ ...current.settings, agentMode: mode });
      usePiStore.getState().showToast(`已切换到${mode === "agent" ? "执行" : mode === "plan" ? "计划" : "问答"}模式`, "info");
    } catch (error) {
      await usePiStore.getState().setRuntimeAgentMode(previous).catch(() => undefined);
      usePiStore.getState().showToast(`切换工作模式失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }, []);
  const consumeComposerPrefill = useCallback(() => {
    setGoalEditPrefill(null);
    usePiStore.getState().clearComposerPrefill();
  }, []);

  const editUserMessage = useCallback((message: UiMessage) => {
    const current = usePiStore.getState();
    if (current.isStreaming) {
      current.showToast("请等待当前回复完成后再编辑消息", "warning");
      return;
    }
    setEditingMessage({ messageId: message.id });
  }, []);

  const submitMessageEdit = useCallback(async (message: UiMessage, text: string) => {
    const current = usePiStore.getState();
    if (current.isStreaming) {
      current.showToast("请等待当前回复完成后再编辑消息", "warning");
      return false;
    }
    const point = await current.resolveMessageForkPoint(message.id);
    if (!point) {
      current.showToast("无法定位这条消息的会话检查点", "warning");
      return false;
    }
    const originalImages: AttachmentPayload[] = (message.images ?? []).map((image, index) => ({
      path: `message-image-${message.id}-${index}`,
      fileName: `image-${index + 1}.${image.mimeType.split("/")[1] || "png"}`,
      mimeType: image.mimeType,
      size: Math.floor(image.data.length * 0.75),
      kind: "image",
      data: image.data,
    }));
    const sent = await current.editAndResend(point.entryId, text, originalImages);
    if (sent) setEditingMessage(null);
    return sent;
  }, []);

  const rewindUserMessage = useCallback(async (message: UiMessage) => {
    const current = usePiStore.getState();
    if (current.isStreaming) {
      current.showToast("请等待当前回复完成后再回退消息", "warning");
      return false;
    }
    const point = await current.resolveMessageForkPoint(message.id);
    if (!point) {
      current.showToast("无法定位这条消息的会话检查点", "warning");
      return false;
    }
    const accepted = await confirm(
      "将回退此消息之后的对话，并恢复到该消息发送时的工作区状态。已有对话分支仍可从会话树切回。",
      { title: "回退消息和改动？", kind: "warning", okLabel: "回退", cancelLabel: "取消" },
    );
    if (!accepted) return false;
    const rewound = await current.rewindMessage(point.entryId);
    if (rewound) setEditingMessage(null);
    return rewound;
  }, []);

  const cancelMessageEdit = useCallback(() => {
    setEditingMessage(null);
  }, []);

  const refreshSessionTree = useCallback(() => {
    void usePiStore.getState().loadSessionTree();
  }, []);

  const continueFromTreeNode = useCallback((entryId: string) => {
    void usePiStore.getState().continueFromTreeNode(entryId);
  }, []);

  const requestReview = useCallback(async (target: ReviewTarget = { mode: "uncommitted" }) => {
    if (settings?.reviewDelivery === "detached") {
      const current = usePiStore.getState();
      const workspace = current.cwd;
      current.prepareNewTask();
      if (workspace) await usePiStore.getState().connect(workspace);
    }
    const scope = target.mode === "base-branch"
      ? `审查当前分支相对于基线分支 ${target.baseBranch} 的代码更改。先运行 git merge-base HEAD ${target.baseBranch}，再检查从合并基点到 HEAD 的差异。`
      : "审查当前未提交的代码更改，包括已暂存、未暂存和未跟踪文件。";
    const sent = await usePiStore.getState().sendMessage([
      scope,
      "只报告由这些更改引入、作者明确会修复的离散问题，重点检查正确性、回归风险、安全性和缺失测试；按严重程度列出发现。没有可操作问题时请直接说明。",
      "需要定位到具体改动行的意见，请另起一行输出 ::code-comment{title=\"[P1] 简短标题\" body=\"问题、触发场景和修复方向\" file=\"相对或绝对文件路径\" start=行号 end=行号 priority=1}。正文保持普通 Markdown，不要输出 JSON。",
    ].join("\n\n"));
    if (sent) {
      setDraftMode(false);
      setWorkspaceTool(null);
    }
  }, [settings?.reviewDelivery]);

  const requestCommitOrPush = useCallback(async () => {
    await usePiStore.getState().sendMessage(
      "请审查当前工作区未提交更改，撰写简洁的提交说明并创建提交；若已配置可用远程且适合推送，再推送到远程并回报结果。",
    );
  }, []);

  const exportConversationMarkdown = useCallback(async () => {
    const current = usePiStore.getState();
    if (!current.sessionFile) return;
    const baseName = (current.sessionName || "pidesktop-conversation")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
      .trim() || "pidesktop-conversation";
    const destination = await saveDialog({
      title: "导出当前对话",
      defaultPath: `${baseName}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (typeof destination !== "string") return;
    try {
      const path = await pi.exportSessionMarkdown(current.sessionFile, destination);
      current.showToast(`已导出到 ${path}`, "info");
    } catch (error) {
      current.showToast(`导出失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
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
      pendingCount={store.steeringQueue.length + store.followUpQueue.length + store.managedFollowUpQueue.length}
      queuedMessages={store.managedFollowUpQueue}
      requireCtrlEnter={settings?.requireCtrlEnter}
      defaultFollowUpBehavior={settings?.followUpBehavior}
      workspace={quickChat ? "" : draftWorkspace}
      workspaceOptions={workspaceOptions}
      environment={taskEnvironment}
      branchLabel={!quickChat ? (variant === "task-start" ? draftBranch : (git?.isRepository ? (git.branch || "") : "")) : ""}
      quickChat={quickChat}
      permissionMode={settings?.permissionMode ?? "ask"}
      permissionLabel={permissionLabel}
      agentMode={settings?.agentMode ?? "agent"}
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
      onAgentModeChange={changeComposerAgentMode}
      onPrefillConsumed={consumeComposerPrefill}
      onRemoveQueuedMessage={store.removeManagedFollowUp}
      onMoveQueuedMessage={store.moveManagedFollowUp}
      onSteerQueuedMessage={store.steerManagedFollowUp}
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
            onClick={togglePrimarySidebar}
            onMouseEnter={showSidebarHoverPreview}
            onMouseLeave={scheduleSidebarHoverClose}
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
                <button disabled={!connected || !sessionFile} onClick={() => { setAppMenu(null); void exportConversationMarkdown(); }}>导出为 Markdown...</button>
                <button disabled={!connected} onClick={() => { setAppMenu(null); void store.exportSession(); }}>导出为 HTML</button>
                <div className="menu-separator" />
                <button onClick={() => { setAppMenu(null); void invoke("quit_app"); }}>退出</button>
              </>}
              {appMenu === "edit" && <>
                <button onClick={() => { setAppMenu(null); document.execCommand("undo"); }}>撤销</button>
                <button onClick={() => { setAppMenu(null); document.execCommand("redo"); }}>重做</button>
                <div className="menu-separator" />
                <button onClick={() => { setAppMenu(null); document.execCommand("selectAll"); }}>全选</button>
              </>}
              {appMenu === "view" && <>
                <button onClick={() => { setAppMenu(null); togglePrimarySidebar(); }}>{sidebarVisible ? "隐藏侧栏" : "显示侧栏"}</button>
                <button onClick={() => { setAppMenu(null); setWorkspaceSidebarOpen(false); setWorkspaceTool(null); setPreviewFile(null); setInspectorTab("changes"); setInspectorOpenView(null); }}>显示环境信息</button>
                <button onClick={() => { setAppMenu(null); toggleWorkspaceTool("review"); }}>审查</button>
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
        ["--workspace-panel-width" as string]: `${workspacePanelWidth}px`,
        ["--bottom-panel-height" as string]: `${bottomPanelHeight}px`,
      }}>
        {!sidebarVisible && (
          <div
            aria-hidden="true"
            className="sidebar-hover-zone"
            onMouseEnter={showSidebarHoverPreview}
            onMouseLeave={scheduleSidebarHoverClose}
          />
        )}
        <div
          className={`primary-sidebar-panel${sidebarRendered ? " open" : ""}${sidebarHoverPreview ? " hover-preview" : ""}`}
          data-panel
          data-sidebar-panel-state={sidebarVisible ? "pinned" : sidebarHoverPreview ? "preview" : "closed"}
        >
          {sidebarRendered && (
            <Sidebar
            sessions={sessions}
            currentSessionFile={sessionFile}
            runningSessionFiles={runningSessionFiles}
            approvalSessionFiles={approvalSessionFiles}
            notifications={notifications}
            cwd={newTask ? draftWorkspace : cwd}
            newTaskActive={newTask && hubView === null}
            activeHub={hubView === "pull-requests" || hubView === "scheduled" || hubView === "plugins" ? hubView : null}
            onNewSession={() => navigateTo({ kind: "home", workspace: draftWorkspace || cwd })}
            onOpenPullRequests={() => navigateTo({ kind: "hub", view: "pull-requests" })}
            onOpenScheduled={() => navigateTo({ kind: "hub", view: "scheduled" })}
            onOpenPlugins={() => navigateTo({ kind: "hub", view: "plugins" })}
            onOpenSession={(session) => navigateTo({ kind: "session", cwd: session.cwd, file: session.file })}
            onOpenNotification={(notification) => {
              store.markNotificationRead(notification.id);
              const targetSession = notification.sessionFile
                ? sessions.find((session) => sameLocalPath(session.file, notification.sessionFile as string))
                : null;
              if (targetSession) {
                navigateTo({ kind: "session", cwd: targetSession.cwd, file: targetSession.file });
              } else if (notification.cwd) {
                navigateTo({ kind: "home", workspace: notification.cwd });
                if (notification.sessionFile) store.showToast("原任务记录已不可用，已打开对应项目", "warning");
              }
            }}
            onMarkAllNotificationsRead={store.markAllNotificationsRead}
            onDismissNotification={store.dismissNotification}
            onOpenProject={(workspace) => navigateTo({ kind: "home", workspace })}
            onNewProjectSession={(workspace) => navigateTo({ kind: "home", workspace })}
            onArchiveSession={(session) => archiveConversations([session], session.cwd, "已归档对话")}
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
            onArchiveProject={(workspace, projectSessions) => archiveConversations(
              projectSessions,
              workspace,
              `已归档 ${projectSessions.length} 个对话`,
            )}
            onOpenSettings={() => openSettingsPage("general")}
            onPickFolder={() => void pickFolder()}
            hoverPreview={!sidebarVisible}
            onHoverEnter={cancelSidebarHoverClose}
            onHoverLeave={scheduleSidebarHoverClose}
            />
          )}
        </div>
        {sidebarVisible && (
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧栏宽度"
            aria-valuemin={200}
            aria-valuemax={380}
            aria-valuenow={Math.round(sidebarWidth)}
            tabIndex={0}
            onPointerDown={beginSidebarResize}
            onKeyDown={resizeSidebarWithKeyboard}
          />
        )}

        <div className="work-surface">
        <div className="stage-canvas">
        <header className="topbar" data-tauri-drag-region>
          <div className="topbar-left" data-tauri-drag-region>
            {!sidebarVisible && (
              <button
                className="icon-button"
                onClick={pinPrimarySidebar}
                onMouseEnter={showSidebarHoverPreview}
                onMouseLeave={scheduleSidebarHoverClose}
                title="显示侧栏"
              ><Menu size={17} /></button>
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
                        if (titleDraft.trim() !== resolvedThreadTitle) void store.setSessionName(titleDraft);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setTitleDraft(resolvedThreadTitle);
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
                        <button disabled={!sessionFile} onClick={() => { setMoreOpen(false); void exportConversationMarkdown(); }}>导出为 Markdown...</button>
                        <button disabled={!sessionFile || isStreaming} onClick={() => {
                          setMoreOpen(false);
                          if (!sessionFile) return;
                          void archiveConversations([{ cwd, file: sessionFile }], cwd, "已归档对话");
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
                      <span className={`workspace-tools-mark workspace-editor-${preferredWorkspaceEditor?.id ?? "explorer"}`} aria-hidden>
                        <WorkspaceEditorIcon editorId={preferredWorkspaceEditor?.id} size={18} />
                      </span>
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
                          selectWorkspaceEditor(workspaceCwd, editor);
                        }}>
                          <WorkspaceEditorIcon editorId={editor.id} size={16} /><span>在 {editor.name} 中打开</span>
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
          <Suspense fallback={<div className="page-loading">正在加载…</div>}>
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
              onError={showErrorToast}
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
                  {(gitDiffStats.additions > 0 || gitDiffStats.deletions > 0) && (
                    <div className="thread-meta-row">
                      {(gitDiffStats.additions > 0 || gitDiffStats.deletions > 0) && (
                        <button
                          type="button"
                          className="title-diff-chip"
                          title="查看变更"
                          onClick={() => {
                            setWorkspaceSidebarOpen(false);
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
                  <ConversationMessages
                    showThinking={settings?.showThinking ?? true}
                    expectVisibleThinking={thinkingLevel !== "off" && model?.reasoning === true}
                    isStreaming={isStreaming}
                    statusText={statusText}
                    editingMessageId={editingMessage?.messageId}
                    onEdit={editUserMessage}
                    onRewind={rewindUserMessage}
                    onCancelEdit={cancelMessageEdit}
                    onSubmitEdit={submitMessageEdit}
                    scrollerRef={conversationScrollRef}
                    autoFollowRef={autoFollowConversationRef}
                    lastAutoScrollAtRef={lastAutoScrollAtRef}
                    conversationKey={`${runtimeId ?? "none"}:${sessionFile ?? "new"}`}
                  />
                  {(git?.files.length ?? 0) > 0 && (
                    <section className="conversation-change-card" aria-label="当前工作区变更">
                      <div className="conversation-change-heading">
                        <button
                          type="button"
                          className="conversation-change-open"
                          onClick={() => setWorkspaceTool("review")}
                          title="查看变更"
                        >
                          <span className="conversation-change-icon"><FileDiff size={15} strokeWidth={1.7} /></span>
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
                        <button type="button" onClick={() => void requestReview({ mode: "uncommitted" })}>审核</button>
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
              <ActiveGoalBar />
              {renderComposer("follow-up")}
            </div>
          )}
          </>}
          </Suspense>
        </main>
        </WorkspaceFileOpenContext.Provider>
        {workspaceSidebarVisible && !workspaceFocusMode && (
          <div
            className="workspace-split-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整对话与工作区宽度"
            aria-valuemin={WORKSPACE_PANEL_MIN_WIDTH}
            aria-valuemax={workspacePanelMaxWidth()}
            aria-valuenow={Math.round(workspacePanelWidth)}
            tabIndex={0}
            onPointerDown={beginWorkspaceResize}
            onKeyDown={resizeWorkspaceWithKeyboard}
          />
        )}
        {workspaceTool === "review" && (
          <ReviewPanel
            key={`dock-${workspaceTool}`}
            onClose={() => setWorkspaceTool(null)}
            git={newTask ? draftGit : git}
            cwd={workspaceCwd}
            isStreaming={isStreaming}
            onRefreshGit={() => void (newTask ? refreshDraftGit() : store.refreshGit())}
            onReview={(target) => void requestReview(target)}
            onReviewComment={(path, line, comment) => void sendFromComposer(
              `请处理这条代码审阅意见：\n\n文件：${path}${line ? `\n行号：${line}` : ""}\n意见：${comment}`,
            )}
            onCommitOrPush={() => void requestCommitOrPush()}
            onOpenTool={(tool) => setWorkspaceTool(tool)}
            onRestoreFiles={(paths) => void restoreGitFiles(paths)}
            onStageFiles={(paths) => updateGitIndex("stage", paths)}
            onUnstageFiles={(paths) => updateGitIndex("unstage", paths)}
            onOpenFile={(path, line) => openPreviewFile(path, line)}
            onError={showErrorToast}
          />
        )}
        {workspaceTool === "browser" && (
          <BrowserWorkspacePanel
            recentAgentPage={agentBrowser}
            onComment={(url, comment) => void sendFromComposer(`请根据这条页面反馈检查并修改页面：\n\n页面：${url}\n反馈：${comment}`)}
            onClose={() => setWorkspaceTool(null)}
          />
        )}
        {workspaceTool === "terminal" && (
          <Suspense fallback={<div className="workspace-panel page-loading">正在加载终端…</div>}>
            <TerminalWorkspacePanel
              cwd={workspaceCwd}
              shellLabel={settings?.terminalShell || "PowerShell"}
              onClose={() => setWorkspaceTool(null)}
            />
          </Suspense>
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
        {sideChats.map((chat) => (
          <SideChatPanel
            key={chat.id}
            chatId={chat.id}
            cwd={chat.cwd}
            parentSessionFile={chat.parentSessionFile}
            hidden={workspaceTool !== "side-chat" || activeSideChatId !== chat.id}
            showThinking={settings?.showThinking ?? true}
            settings={settings}
            onClose={() => setWorkspaceTool(null)}
            onDelete={() => deleteSideChat(chat.id)}
            onNew={() => { createSideChat(); }}
            onStateChange={updateSideChatMeta}
            onError={showErrorToast}
          />
        ))}
        {workspaceSidebarVisible && !workspaceTool && !previewFile && !inspectorTab && (
          <ToolRail onSelect={toggleWorkspaceTool} />
        )}
        </div>

        {bottomPanel && <>
          <div
            className="bottom-panel-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整终端高度"
            aria-valuemin={BOTTOM_PANEL_MIN_HEIGHT}
            aria-valuemax={bottomPanelMaxHeight()}
            aria-valuenow={Math.round(bottomPanelHeight)}
            tabIndex={0}
            onPointerDown={beginBottomPanelResize}
            onKeyDown={resizeBottomPanelWithKeyboard}
          />
          <Suspense fallback={<div className="bottom-terminal page-loading">正在加载终端…</div>}>
            <TerminalWorkspacePanel
              key="bottom-terminal"
              cwd={workspaceCwd}
              shellLabel={settings?.terminalShell || "PowerShell"}
              placement="bottom"
              onClose={() => setBottomPanel(false)}
            />
          </Suspense>
        </>}

        <div className="environment-flyout-layer" aria-hidden={!inspectorTab}>
          {inspectorTab && (
            <ConnectedInspectorPanel
              key={`flyout-inspector-${inspectorTab}-${inspectorOpenView ?? "home"}`}
              initialTab={inspectorTab}
              openView={inspectorOpenView}
              onClose={() => { setInspectorTab(null); setInspectorOpenView(null); }}
              onError={showErrorToast}
              git={newTask ? draftGit : git}
              cwd={workspaceCwd}
              environment={taskEnvironment}
              terminal={terminal}
              agentBrowser={agentBrowser}
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
              onOpenWorkspaceTool={(tool) => toggleWorkspaceTool(tool)}
              sideChats={currentSideChats}
              onOpenSideChat={openSideChat}
              onOpenFile={(path) => openPreviewFile(path)}
            />
          )}
        </div>

        </div>
        </div>
        </div>
      </div>

      {settingsOpen && <Suspense fallback={<div className="settings-center settings-loading">正在加载设置…</div>}><SettingsModal initialPage={settingsPage} settings={settings} cwd={cwd} appearanceCatalog={appearanceCatalog} onReloadAppearance={reloadAppearanceCatalog} onSave={store.saveSettings} onClose={() => setSettingsOpen(false)} /></Suspense>}

      {!isTauri && (settings?.petEnabled || previewPet) && !settingsOpen && (
        <PetCompanion
          pet={activePet}
          busy={petBusy}
        />
      )}

      <div className="toast-stack">
        {toasts.map((toast) => (
          <button key={toast.id} className={`toast ${toast.kind}`} onClick={() => store.dismissToast(toast.id)}>{toast.message}</button>
        ))}
      </div>
    </div>
  );
}
