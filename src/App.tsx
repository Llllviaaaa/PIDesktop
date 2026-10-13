import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useSyncOnChange } from "./hooks/useSyncOnChange";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "./lib/queries";
import { useShallow } from "zustand/react/shallow";
import { usePanelResize } from "./hooks/usePanelResize";
import {
  BOTTOM_PANEL_BOUNDS,
  BOTTOM_PANEL_HEIGHT_KEY,
  BOTTOM_PANEL_KEYS,
  bottomPanelMaxHeight as panelMaxHeight,
  SIDEBAR_BOUNDS,
  SIDEBAR_KEYS,
  SIDEBAR_WIDTH_KEY,
  WORKSPACE_PANEL_BOUNDS,
  WORKSPACE_PANEL_KEYS,
  WORKSPACE_PANEL_WIDTH_KEY,
  workspacePanelMaxWidth as panelMaxWidth,
} from "./lib/panelLayout";
import { describeError } from "./lib/errors";
import { confirm, open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  ArrowRight,
  FileDiff,
  Folder,
  Globe2,
  Menu,
  Minus,
  MoreHorizontal,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Square,
  X,
} from "lucide-react";
import { pi } from "./lib/pi";
import {
  BUILTIN_APPEARANCE_CATALOG,
  createCustomAppearanceTheme,
  loadAppearanceCatalog,
  resolveAppearancePet,
  resolveAppearanceTheme,
  type PetAnimationState,
} from "./lib/appearanceCatalog";
import { aggregateDiffStats } from "./lib/gitDiffStats";
import { backgroundTerminalsFor, subscribeTerminalTabs, terminalTabsSnapshot } from "./lib/terminalTabs";
import {
  nextTranscriptDensity,
  normalizeTranscriptDensity,
  TRANSCRIPT_DENSITY_LABELS,
  TRANSCRIPT_DENSITY_ORDER,
} from "./lib/transcriptDensity";
import { activeSessionTitle } from "./lib/sessionTitle";
import { navigationKey, withoutArchivedSessions, type NavigationTarget as BaseNavigationTarget } from "./lib/navigationHistory";
import { sameLocalPath } from "./lib/pathIdentity";
import { filterHiddenModels } from "./lib/modelProviders";
import { buildPetActivities, petStatusToAnimation, type PetActivityItem, type PetActivityStatus } from "./lib/petActivity";
import { ACTIVE_RUNTIME_KEY, LAST_TASK_KEY, readPersistedTask, useRuntimeBootstrap } from "./hooks/useRuntimeBootstrap";
import { usePiStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { Composer } from "./components/Composer";
import type { SettingsPage } from "./components/SettingsModal";
import { PetAvatar, PetCompanion } from "./components/PetCompanion";
import {
  DESKTOP_PET_EVENT,
  DESKTOP_PET_DISABLE_EVENT,
  DESKTOP_PET_NAVIGATE_EVENT,
  DESKTOP_PET_STATE_KEY,
  type DesktopPetNavigationRequest,
  type DesktopPetWindowState,
} from "./components/DesktopPetWindow";
import { ExtensionDialog, extensionRequestHeadline } from "./components/ExtensionDialog";
import type { InspectorTab } from "./components/InspectorPanel";
import { ConnectedInspectorPanel } from "./components/ConnectedInspectorPanel";
import { ConversationMessages } from "./components/ConversationMessages";
import { ClaudeHomeDashboard } from "./components/ClaudeHomeDashboard";
import { ActiveGoalBar } from "./components/ActiveGoalBar";
import { LivePlanBar } from "./components/LivePlanBar";
import { isWorkspaceTool, ToolRail, type WorkspaceTool } from "./components/ToolRail";
import { FileTreePanel } from "./components/FileTreePanel";
import { DocumentPane } from "./components/DocumentPane";
import { BROWSER_AUTO_VERIFY_KEY, BrowserWorkspacePanel, readBrowserToggle } from "./components/BrowserWorkspacePanel";
import { SideChatPanel, type SideChatMeta } from "./components/SideChatPanel";
import { ReviewPanel, type PendingReviewComment, type ReviewFilter, type ReviewTarget } from "./components/ReviewPanel";
import { WorkspaceFileOpenContext } from "./components/Markdown";
import { FileActionsProvider, OpenInMenu } from "./components/WorkspaceOpeners";
import { GitActionButton } from "./components/GitActionButton";
import { CommitDialog, type CommitOutcome } from "./components/CommitDialog";
import { preferredEditorFor, rememberProjectEditor } from "./lib/workspaceEditors";
import { isLocalWebAddress } from "./lib/webAccess";
import type { AppSettings, AttachmentPayload, GitSnapshot, ModelInfo, ProjectConfig, PullRequestInfo, ScheduledRunRecord, SessionInfo, TerminalAppInfo, UiMessage, WorkspaceEditorInfo } from "./types";

const SettingsModal = lazy(() => import("./components/SettingsModal").then((module) => ({ default: module.SettingsModal })));
const PullRequestsPage = lazy(() => import("./components/PullRequestsPage").then((module) => ({ default: module.PullRequestsPage })));
const ScheduledTasksPage = lazy(() => import("./components/ScheduledTasksPage").then((module) => ({ default: module.ScheduledTasksPage })));
const PluginMarketplacePage = lazy(() => import("./components/PluginMarketplacePage").then((module) => ({ default: module.PluginMarketplacePage })));
const TerminalWorkspacePanel = lazy(() => import("./components/TerminalWorkspacePanel").then((module) => ({ default: module.TerminalWorkspacePanel })));

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

const WORKSPACE_TOOL_KEY = "pid-desktop:workspace-tool";

/** The dock reopens on the tool it last showed. */
function readStoredWorkspaceTool(): WorkspaceTool {
  try {
    const value = window.localStorage.getItem(WORKSPACE_TOOL_KEY);
    return isWorkspaceTool(value) ? value : "summary";
  } catch {
    return "summary";
  }
}

export default function App() {
  const store = usePiStore(useShallow(selectAppShellState));
  // Store actions are stable references. Calling them unbound keeps hooks from
  // having to list the whole `store` object, which changes on every update.
  const { prepareNewTask, setViewedSession, connect, appendLog, switchSession } = store;
  const queryClient = useQueryClient();
  const isTauri = "__TAURI_INTERNALS__" in window;
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
  const pickerModels = useMemo(
    () => filterHiddenModels(availableModels, settings?.hiddenModels, model),
    [availableModels, settings?.hiddenModels, model],
  );
  const [draftMode, setDraftMode] = useState(() => {
    if (!import.meta.env.DEV) return true;
    const fixture = new URLSearchParams(window.location.search).get("fixture");
    return fixture !== "thread" && fixture !== "performance" && fixture !== "stream" && fixture !== "queue" && fixture !== "title" && fixture !== "diagrams" && fixture !== "goal";
  });
  const newTask = draftMode;
  const [localTranscriptDensity, setLocalTranscriptDensity] = useState<ReturnType<typeof normalizeTranscriptDensity>>("normal");
  const transcriptDensity = settings
    ? normalizeTranscriptDensity(settings.transcriptDensity)
    : localTranscriptDensity;
  const setTranscriptDensity = useCallback((density: typeof transcriptDensity) => {
    const current = usePiStore.getState();
    if (current.settings) {
      void current.saveSettings({ ...current.settings, transcriptDensity: density });
      return;
    }
    setLocalTranscriptDensity(density);
  }, []);
  const cycleTranscriptDensity = useCallback(() => {
    setTranscriptDensity(nextTranscriptDensity(transcriptDensity));
  }, [setTranscriptDensity, transcriptDensity]);
  const [sidebarVisible, setSidebarVisible] = useState(() => window.innerWidth > 900);
  const [sidebarHoverPreview, setSidebarHoverPreview] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("general");
  const [hubView, setHubView] = useState<HubView | null>(null);
  // The summary opens on its home unless a sub-view (plan, logs) is asked for.
  const [summaryView, setSummaryView] = useState<{ view: InspectorTab | null; nonce: number }>({ view: null, nonce: 0 });
  const [bottomPanel, setBottomPanel] = useState(false);
  const [workspaceSidebarOpen, setWorkspaceSidebarOpen] = useState(false);
  const [workspaceFocusMode, setWorkspaceFocusMode] = useState(false);
  const [commitDialog, setCommitDialog] = useState<{ push: boolean } | null>(null);
  const [gitPushing, setGitPushing] = useState(false);
  const [workspaceTool, setWorkspaceTool] = useState<WorkspaceTool>(readStoredWorkspaceTool);
  // Tools stay mounted once opened, so switching tabs keeps their state (review drafts, the page).
  const [mountedTools, setMountedTools] = useState<ReadonlySet<WorkspaceTool>>(() => new Set());
  const [reviewRequest, setReviewRequest] = useState<{ filter: ReviewFilter; nonce: number } | null>(null);
  const [browserNavigate, setBrowserNavigate] = useState<{ url: string; nonce: number } | null>(null);
  const [composerInsert, setComposerInsert] = useState<{ text: string; nonce: number } | null>(null);
  const [editorChoiceOverride, setEditorChoiceOverride] = useState<{ workspace: string; id: string } | null>(null);
  const [sideChats, setSideChats] = useState<SideChatInstance[]>([]);
  const [activeSideChatId, setActiveSideChatId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<{ path: string; line?: number } | null>(null);
  const [openFileTabs, setOpenFileTabs] = useState<Array<{ path: string; line?: number }>>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [appMenu, setAppMenu] = useState<AppMenu | null>(null);
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  // Codex home defaults to Local; Worktree only when settings or user toggle says so.
  const [taskEnvironment, setTaskEnvironment] = useState<"local" | "worktree">("local");
  const [draftWorkspace, setDraftWorkspace] = useState(() => window.localStorage.getItem("pid-desktop:last-workspace") || "");
  // The home composer shows the chosen workspace's branch and uncommitted changes.
  const draftGitQuery = useQuery({
    queryKey: queryKeys.gitSnapshot(draftWorkspace),
    queryFn: () => pi.gitSnapshot(draftWorkspace),
    enabled: isTauri && Boolean(draftWorkspace),
  });
  const draftGit: GitSnapshot | null = isTauri && draftWorkspace && !draftGitQuery.isError ? draftGitQuery.data ?? null : null;
  const draftBranch = draftGit?.isRepository ? draftGit.branch || "" : "";
  const [registeredProjects, setRegisteredProjects] = useState<ProjectConfig[]>([]);
  const [quickChat, setQuickChat] = useState(false);
  const [homeLayout, setHomeLayout] = useState<"studio" | "classic">(() => {
    const saved = window.localStorage.getItem("pid-desktop:claude-home-layout");
    return saved === "classic" ? "classic" : "studio";
  });
  const toggleHomeLayout = useCallback((next: "studio" | "classic") => {
    setHomeLayout(next);
    try {
      window.localStorage.setItem("pid-desktop:claude-home-layout", next);
    } catch {
      // ignore storage failure
    }
  }, []);
  const heroGreeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return "早上好，今天想构建什么？";
    if (hour >= 12 && hour < 18) return "下午好，接下来做什么？";
    if (hour >= 18 && hour < 23) return "晚上好，要开始新任务吗？";
    return "夜深了，还在攻克难题吗？";
  }, []);
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
  const [navigationAvailability, setNavigationAvailability] = useState({ back: false, forward: false });
  const layoutScale = Math.min(150, Math.max(75, settings?.uiScale ?? 100)) / 100;

  const sidebarResize = usePanelResize({
    storageKey: SIDEBAR_WIDTH_KEY,
    bounds: SIDEBAR_BOUNDS,
    keys: SIDEBAR_KEYS,
    axis: "x",
    growsWithPointer: true,
    resizingClass: "sidebar-is-resizing",
    scale: layoutScale,
    maxSize: useCallback(() => SIDEBAR_BOUNDS.max, []),
  });
  const sidebarWidth = sidebarResize.size;

  // The workspace panel and the conversation share the space the sidebar leaves.
  const workspacePanelMaxWidth = useCallback(
    () => panelMaxWidth(window.innerWidth, layoutScale, sidebarVisible ? sidebarWidth : 0),
    [layoutScale, sidebarVisible, sidebarWidth],
  );
  const workspaceResize = usePanelResize({
    storageKey: WORKSPACE_PANEL_WIDTH_KEY,
    bounds: WORKSPACE_PANEL_BOUNDS,
    keys: WORKSPACE_PANEL_KEYS,
    axis: "x",
    growsWithPointer: false,
    resizingClass: "workspace-is-resizing",
    scale: layoutScale,
    maxSize: workspacePanelMaxWidth,
  });
  const workspacePanelWidth = workspaceResize.size;

  const bottomPanelMaxHeight = useCallback(
    () => panelMaxHeight(window.innerHeight, layoutScale),
    [layoutScale],
  );
  const bottomResize = usePanelResize({
    storageKey: BOTTOM_PANEL_HEIGHT_KEY,
    bounds: BOTTOM_PANEL_BOUNDS,
    keys: BOTTOM_PANEL_KEYS,
    axis: "y",
    growsWithPointer: false,
    resizingClass: "bottom-panel-is-resizing",
    scale: layoutScale,
    maxSize: bottomPanelMaxHeight,
  });
  const bottomPanelHeight = bottomResize.size;
  const petFixture = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("pet") : null;
  const petActivityFixture = import.meta.env.DEV ? new URLSearchParams(window.location.search).get("pet-activity") : null;
  const appearanceQuery = useQuery({
    queryKey: queryKeys.appearance(cwd),
    queryFn: () => loadAppearanceCatalog(cwd),
    enabled: isTauri,
  });
  // A catalog that fails to load falls back to the built-in themes and pets.
  const appearanceCatalog = (!appearanceQuery.isError && appearanceQuery.data) || BUILTIN_APPEARANCE_CATALOG;
  const previewPet = petFixture && appearanceCatalog.pets.some((pet) => pet.id === petFixture) ? petFixture : null;
  const activePet = useMemo(
    () => resolveAppearancePet(appearanceCatalog, previewPet ?? settings?.petCharacter ?? "cat"),
    [appearanceCatalog, previewPet, settings?.petCharacter],
  );
  const currentRuntime = runtimeId ? runtimes[runtimeId] : undefined;
  const currentPetBusy = isStreaming || isCompacting || connection === "starting";
  const extensionRequestTitle = extensionRequest ? extensionRequestHeadline(extensionRequest) : undefined;
  const currentPetStatus: PetActivityStatus | null = extensionRequest
    ? "needs-input"
    : connection === "exited" || Boolean(retryStatus)
      ? "blocked"
      : currentPetBusy
        ? "running"
        : null;
  const currentPetActivity = useMemo<PetActivityItem | null>(() => currentPetStatus ? {
    id: `current:${runtimeId || sessionFile || cwd || "task"}`,
    status: currentPetStatus,
    title: resolvedThreadTitle || "当前任务",
    body: currentPetStatus === "needs-input"
      ? extensionRequestTitle || "正在等待你的决定"
      : currentPetStatus === "blocked"
        ? retryStatus || "任务已停止"
        : isCompacting ? "正在压缩上下文" : connection === "starting" ? "正在启动" : "正在工作",
    cwd,
    sessionFile,
    updatedAt: currentRuntime?.updatedAt ?? 0,
  } : null, [connection, currentPetStatus, currentRuntime?.updatedAt, cwd, extensionRequestTitle, isCompacting, resolvedThreadTitle, retryStatus, runtimeId, sessionFile]);
  const petActivities = useMemo(() => buildPetActivities({
    runtimes,
    notifications,
    sessions,
    current: currentPetActivity,
  }), [currentPetActivity, notifications, runtimes, sessions]);
  const displayedPetActivities = useMemo<PetActivityItem[]>(() => petActivityFixture === "1" ? [
    { id: "fixture-input", status: "needs-input", title: "等待权限确认", body: "需要批准命令", cwd: cwd || "D:\\Workspace", sessionFile: null, updatedAt: 4 },
    { id: "fixture-blocked", status: "blocked", title: "构建桌面应用", body: "构建进程已退出", cwd: cwd || "D:\\Workspace", sessionFile: null, updatedAt: 3 },
    { id: "fixture-ready", status: "ready", title: "审查设置页面", body: "任务已完成", cwd: cwd || "D:\\Workspace", sessionFile: null, updatedAt: 2 },
    { id: "fixture-running", status: "running", title: "运行界面测试", body: "正在工作", cwd: cwd || "D:\\Workspace", sessionFile: null, updatedAt: 1 },
  ] : petActivities, [cwd, petActivities, petActivityFixture]);
  const petActivity: PetAnimationState = displayedPetActivities[0]
    ? petStatusToAnimation(displayedPetActivities[0].status)
    : workspaceSidebarOpen && workspaceTool === "review" ? "review" : "idle";
  const petBusy = petActivity === "running";
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
  const workspaceSidebarVisible = workspaceSidebarOpen;
  const reviewActive = workspaceSidebarOpen && workspaceTool === "review";
  const sidebarRendered = sidebarVisible || sidebarHoverPreview;
  const currentSideChats = useMemo(
    () => sessionFile ? sideChats.filter((chat) => sameLocalPath(chat.parentSessionFile, sessionFile)) : [],
    [sessionFile, sideChats],
  );

  useEffect(() => {
    if (isTauri) return;
    void usePiStore.getState().loadSettings();
  }, [isTauri]);

  const showWorkspaceTool = useCallback((tool: WorkspaceTool) => {
    setWorkspaceTool(tool);
    setWorkspaceSidebarOpen(true);
    setMountedTools((current) => (current.has(tool) ? current : new Set(current).add(tool)));
    try {
      window.localStorage.setItem(WORKSPACE_TOOL_KEY, tool);
    } catch {
      // Blocked storage only forgets the last tool.
    }
  }, []);

  const closeWorkspaceSidebar = useCallback(() => {
    setWorkspaceSidebarOpen(false);
    setWorkspaceFocusMode(false);
  }, []);

  const reloadAppearanceCatalog = useCallback(async () => {
    if (!isTauri) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.appearance(cwd) });
    const failure = queryClient.getQueryState(queryKeys.appearance(cwd))?.error;
    if (failure) throw failure;
  }, [cwd, isTauri, queryClient]);
  // Opening or closing Settings picks up themes and pets installed meanwhile.
  const settingsOpenSeenRef = useRef(settingsOpen);
  useEffect(() => {
    if (settingsOpenSeenRef.current === settingsOpen) return;
    settingsOpenSeenRef.current = settingsOpen;
    void reloadAppearanceCatalog().catch(() => undefined);
  }, [reloadAppearanceCatalog, settingsOpen]);

  useEffect(() => {
    if (!isTauri || !settings) return;
    let cancelled = false;
    const payload: DesktopPetWindowState = {
      enabled: settings.petEnabled,
      pet: activePet,
      petSize: settings.petSize,
      busy: petBusy,
      activity: petActivity,
      activities: displayedPetActivities,
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
  }, [activePet, displayedPetActivities, isTauri, petActivity, petBusy, settings]);

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
    showWorkspaceTool("side-chat");
    return id;
  }, [newTask, sessionFile, showWorkspaceTool, workspaceCwd]);

  const openSideChat = useCallback((id: string) => {
    const target = sideChats.find((chat) => chat.id === id);
    if (!target || !sessionFile || !sameLocalPath(target.parentSessionFile, sessionFile)) return;
    setActiveSideChatId(id);
    showWorkspaceTool("side-chat");
  }, [sessionFile, showWorkspaceTool, sideChats]);

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
    if (!replacement && workspaceTool === "side-chat") closeWorkspaceSidebar();
  }, [activeSideChatId, closeWorkspaceSidebar, sessionFile, sideChats, workspaceTool]);

  /** Shows a dock tool. Side chat needs a started task, and reuses the chat already open. */
  const selectWorkspaceTool = useCallback((tool: WorkspaceTool) => {
    if (tool === "side-chat") {
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
    if (tool === "files") setPreviewFile((current) => current ?? openFileTabs[openFileTabs.length - 1] ?? null);
    showWorkspaceTool(tool);
  }, [activeSideChatId, createSideChat, currentSideChats, newTask, openFileTabs, openSideChat, sessionFile, showWorkspaceTool, workspaceCwd]);

  const toggleWorkspaceTool = useCallback((tool: WorkspaceTool) => {
    if (workspaceSidebarOpen && workspaceTool === tool) {
      closeWorkspaceSidebar();
      return;
    }
    selectWorkspaceTool(tool);
  }, [closeWorkspaceSidebar, selectWorkspaceTool, workspaceSidebarOpen, workspaceTool]);

  const toggleWorkspaceSidebar = useCallback(() => {
    if (workspaceSidebarOpen) {
      closeWorkspaceSidebar();
      return;
    }
    // Reopen on the last tool; a side chat without a task falls back to the summary.
    selectWorkspaceTool(workspaceTool === "side-chat" && (newTask || !sessionFile) ? "summary" : workspaceTool);
  }, [closeWorkspaceSidebar, newTask, selectWorkspaceTool, sessionFile, workspaceSidebarOpen, workspaceTool]);

  const openSummary = useCallback((view: InspectorTab | null = null) => {
    setSummaryView((current) => ({ view, nonce: current.nonce + 1 }));
    showWorkspaceTool("summary");
  }, [showWorkspaceTool]);

  /** Opens the review tool, optionally on a scope (last turn, branch comparison). */
  const openReview = useCallback((filter?: ReviewFilter) => {
    if (filter) setReviewRequest((current) => ({ filter, nonce: (current?.nonce ?? 0) + 1 }));
    showWorkspaceTool("review");
  }, [showWorkspaceTool]);

  const openBrowserAt = useCallback((url?: string) => {
    if (url) setBrowserNavigate((current) => ({ url, nonce: (current?.nonce ?? 0) + 1 }));
    showWorkspaceTool("browser");
  }, [showWorkspaceTool]);

  // localhost links from the terminal open next to the conversation; others in the system browser.
  const openTerminalLink = useCallback((url: string) => {
    if (isLocalWebAddress(url)) openBrowserAt(url);
    else void openUrl(url).catch(() => undefined);
  }, [openBrowserAt]);

  const sendTerminalToChat = useCallback((text: string, source: string) => {
    const block = `终端输出（${source}）：\n\`\`\`text\n${text}\n\`\`\``;
    setComposerInsert((current) => ({ text: block, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  const workspaceEditorsQuery = useQuery({
    queryKey: queryKeys.workspaceEditors(),
    queryFn: () => pi.listWorkspaceEditors(),
    enabled: isTauri,
    staleTime: Infinity,
  });
  const workspaceEditors: WorkspaceEditorInfo[] = useMemo(() => workspaceEditorsQuery.data ?? [], [workspaceEditorsQuery.data]);
  const terminalAppsQuery = useQuery({
    queryKey: queryKeys.terminalApps(),
    queryFn: () => pi.listTerminalApps(),
    enabled: isTauri,
    staleTime: Infinity,
  });
  const terminalApps: TerminalAppInfo[] = useMemo(() => terminalAppsQuery.data ?? [], [terminalAppsQuery.data]);
  // Project choice (just made, or remembered) → Settings default → first installed editor.
  const preferredWorkspaceEditor = useMemo(() => {
    const override = editorChoiceOverride && sameLocalPath(editorChoiceOverride.workspace, workspaceCwd)
      ? workspaceEditors.find((editor) => editor.id === editorChoiceOverride.id) ?? null
      : null;
    return override ?? preferredEditorFor(workspaceCwd, workspaceEditors, settings?.defaultFileOpener);
  }, [editorChoiceOverride, settings?.defaultFileOpener, workspaceCwd, workspaceEditors]);

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

  // Showing the sidebar ends any hover preview; the pending close timer goes with it.
  useSyncOnChange([sidebarVisible], () => {
    if (sidebarVisible) setSidebarHoverPreview(false);
  });
  useEffect(() => {
    if (sidebarVisible) cancelSidebarHoverClose();
  }, [cancelSidebarHoverClose, sidebarVisible]);

  useEffect(() => () => cancelSidebarHoverClose(), [cancelSidebarHoverClose]);

  useSyncOnChange([workspaceSidebarVisible], () => {
    if (!workspaceSidebarVisible) setWorkspaceFocusMode(false);
  });

  useEffect(() => {
    if (!moreOpen && !appMenu && !workspaceFocusMode) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (moreOpen && !target.closest(".title-actions")) setMoreOpen(false);
      if (appMenu && !target.closest(".app-menu-bar, .app-menu-dropdown")) setAppMenu(null);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || settingsOpen) return;
      if (moreOpen) setMoreOpen(false);
      else if (appMenu) setAppMenu(null);
      else if (workspaceFocusMode) setWorkspaceFocusMode(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [appMenu, moreOpen, settingsOpen, workspaceFocusMode]);

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

  // Apply the product default when settings arrive or the default changes; the
  // user can still toggle the chips afterwards.
  const defaultTaskEnvironment = settings?.defaultTaskEnvironment;
  const settingsLoaded = Boolean(settings);
  useSyncOnChange([settingsLoaded, defaultTaskEnvironment], () => {
    if (!settingsLoaded) return;
    setTaskEnvironment(defaultTaskEnvironment === "worktree" ? "worktree" : "local");
  });

  useEffect(() => {
    window.localStorage.setItem("pid-desktop:task-environment", taskEnvironment);
  }, [taskEnvironment]);

  useEffect(() => {
    const root = document.documentElement;
    const syncWindowBlur = () => {
      root.toggleAttribute("data-window-blur", !document.hasFocus());
    };
    document.body.setAttribute("data-dsh-claude-style", "");
    syncWindowBlur();
    window.addEventListener("focus", syncWindowBlur);
    window.addEventListener("blur", syncWindowBlur);
    return () => {
      window.removeEventListener("focus", syncWindowBlur);
      window.removeEventListener("blur", syncWindowBlur);
    };
  }, []);

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
            settings?.backgroundColor ?? "#fcfcfb",
            settings?.foregroundColor ?? "#141413",
            settings?.accentColor ?? "#d97757",
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
      root.style.setProperty(
        "--code-font",
        settings?.codeFont || '"JetBrains Mono", "Cascadia Code", "SF Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, monospace',
      );
      root.style.fontFamily = settings?.uiFont || 'var(--font-ui)';
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
      // Inside a terminal, shells own Ctrl+O/P/T/B (readline history, search, …).
      const inTerminal = Boolean((event.target as Element | null)?.closest?.(".xterm"));
      if (shortcut === normalize(shortcuts.settings) || (event.ctrlKey && event.key === ",")) {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (settingsOpen && event.key === "Escape") {
        // Menus and dialogs inside Settings mark themselves so Escape closes them first.
        if (document.querySelector("[data-escape-layer]")) return;
        event.preventDefault();
        setSettingsOpen(false);
        return;
      }
      if (ctrl && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "o" && !inTerminal) {
        event.preventDefault();
        cycleTranscriptDensity();
        return;
      }
      if (ctrl && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setBottomPanel((value) => !value);
        return;
      }
      if (ctrl && !event.altKey && !event.shiftKey && (event.code === "Backquote" || event.key === "`")) {
        event.preventDefault();
        setBottomPanel((value) => !value);
        return;
      }
      if (ctrl && event.altKey && !event.shiftKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleWorkspaceSidebar();
        return;
      }
      if (ctrl && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "t" && !inTerminal) {
        event.preventDefault();
        toggleWorkspaceTool("browser");
        return;
      }
      if (ctrl && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "p" && !inTerminal) {
        event.preventDefault();
        toggleWorkspaceTool("files");
        return;
      }
      if (ctrl && event.shiftKey && !event.altKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        toggleWorkspaceTool("review");
        return;
      }
      if (ctrl && event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        toggleWorkspaceTool("side-chat");
        return;
      }
      if (shortcut === normalize(shortcuts.newChat) && connection === "running") {
        event.preventDefault();
        prepareNewTask();
        setDraftMode(true);
        setQuickChat(false);
        setHubView(null);
      } else if (shortcut === normalize(shortcuts.terminal) || shortcut === "ctrl+j") {
        event.preventDefault();
        setBottomPanel((value) => !value);
      } else if (shortcut === normalize(shortcuts.changes)) {
        event.preventDefault();
        toggleWorkspaceTool("review");
      } else if (shortcut === normalize(shortcuts.toggleSidebar) && !inTerminal) {
        event.preventDefault();
        togglePrimarySidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [connection, cycleTranscriptDensity, settings, settingsOpen, prepareNewTask, togglePrimarySidebar, toggleWorkspaceSidebar, toggleWorkspaceTool]);

  useSyncOnChange([editingTitle, resolvedThreadTitle], () => {
    if (!editingTitle) setTitleDraft(resolvedThreadTitle);
  });

  // A different conversation drops any message being edited and follows new output.
  useSyncOnChange([runtimeId, sessionFile], () => setEditingMessage(null));
  useEffect(() => {
    autoFollowConversationRef.current = true;
  }, [runtimeId, sessionFile]);

  useEffect(() => {
    const viewedSession = !newTask && !hubView && !settingsOpen ? sessionFile : null;
    setViewedSession(viewedSession);
    const markVisibleSessionViewed = () => setViewedSession(viewedSession);
    window.addEventListener("focus", markVisibleSessionViewed);
    return () => {
      window.removeEventListener("focus", markVisibleSessionViewed);
      setViewedSession(null);
    };
  }, [hubView, newTask, sessionFile, settingsOpen, setViewedSession]);

  // Keep the side-chat panel pointed at a chat that belongs to this session.
  useSyncOnChange([activeSideChatId, currentSideChats, newTask, sessionFile, workspaceTool], () => {
    if (workspaceTool !== "side-chat") return;
    if (!sessionFile || newTask) {
      setWorkspaceTool("summary");
      return;
    }
    const activeMatches = currentSideChats.some((chat) => chat.id === activeSideChatId);
    if (activeMatches) return;
    const replacement = currentSideChats[currentSideChats.length - 1];
    if (replacement) setActiveSideChatId(replacement.id);
    else setWorkspaceTool("summary");
  });

  useSyncOnChange([draftWorkspace, sessions], () => {
    if (draftWorkspace || sessions.length === 0) return;
    const firstProject = sessions.find((session) => !session.cwd.toLowerCase().endsWith("quick-chat"))?.cwd;
    if (firstProject) setDraftWorkspace(firstProject);
  });

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
    if (!isTauri || !draftWorkspace) return;
    if (!runtimeRecoveryDone || !newTask || hubView !== null || connection !== "disconnected" || startupAutoConnectRef.current) return;
    // A home composer needs an active blank runtime: the model catalog and
    // model/thinking commands are runtime RPCs, not static settings data.
    void connect(draftWorkspace).catch(() => undefined);
  }, [connection, draftWorkspace, hubView, isTauri, newTask, runtimeRecoveryDone, startupAutoConnectRef, connect]);

  const refreshDraftGit = useCallback(async () => {
    if (!isTauri || !draftWorkspace) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.gitSnapshot(draftWorkspace) });
  }, [draftWorkspace, isTauri, queryClient]);

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
        appendLog(`附件读取失败：${describeError(error)}`);
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
  }, [appendLog]);

  const openPreviewFile = useCallback((path: string, line?: number) => {
    setHubView(null);
    setPreviewFile({ path, line });
    setOpenFileTabs((current) => current.some((item) => item.path === path)
      ? current.map((item) => item.path === path ? { path, line } : item)
      : [...current, { path, line }]);
    showWorkspaceTool("files");
  }, [showWorkspaceTool]);

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
    await connect(worktree.path);
  }, [cwd, git?.branch, connect]);

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
      usePiStore.getState().showToast(describeError(error), "error");
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
  const changedFiles = git?.files ?? [];
  // The checkout the review tab shows: the chosen project on a new task, else the thread's.
  const reviewGit = newTask ? draftGit : git;
  const gitDiffStats = useMemo(() => {
    const { add, del } = aggregateDiffStats(reviewGit?.diff);
    return { additions: add, deletions: del };
  }, [reviewGit?.diff]);
  const reviewFileCount = reviewGit?.files.length ?? 0;
  const terminalTabs = useSyncExternalStore(subscribeTerminalTabs, terminalTabsSnapshot);
  const backgroundTerminals = useMemo(() => backgroundTerminalsFor(terminalTabs, workspaceCwd), [terminalTabs, workspaceCwd]);
  const showBackgroundTerminals = !bottomPanel && (backgroundTerminals.count > 0 || backgroundTerminals.unseenOutput);
  const terminalToggleTitle = bottomPanel
    ? "隐藏终端 (Ctrl+J)：终端继续运行"
    : showBackgroundTerminals
      ? `终端 (Ctrl+J)：后台有 ${backgroundTerminals.count} 个终端${backgroundTerminals.unseenOutput ? "，有新输出" : ""}`
      : "终端 (Ctrl+J)";
  const taskWorkspaceName = quickChat
    ? "快速对话"
    : draftWorkspace.split(/[\\/]/).filter(Boolean).pop() || "一个项目";
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
        current.appendLog(`创建 Worktree 失败：${describeError(error)}`);
        current.showToast(`创建 Worktree 失败：${describeError(error)}`, "error");
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
    setHubView(null);
    closeWorkspaceSidebar();
    setPreviewFile(null);
  }, [closeWorkspaceSidebar]);

  const openProjectHome = useCallback((workspace: string) => {
    if (!workspace) return;
    selectWorkspace(workspace);
    usePiStore.getState().prepareNewTask();
    setDraftMode(true);
    setQuickChat(false);
    setHubView(null);
    closeWorkspaceSidebar();
    setPreviewFile(null);
  }, [closeWorkspaceSidebar, selectWorkspace]);

  const revealWorkspaceInExplorer = useCallback((workspace: string) => {
    if (!workspace) return;
    void pi.openWorkspaceInFileManager(workspace).catch((error) => {
      usePiStore.getState().showToast(`无法在资源管理器中打开项目：${describeError(error)}`, "error");
    });
  }, []);

  const revealWorkspaceInEditor = useCallback((workspace: string, editor: WorkspaceEditorInfo) => {
    if (!workspace) return;
    void pi.openWorkspaceInEditor(workspace, editor.id).catch((error) => {
      usePiStore.getState().showToast(`无法在 ${editor.name} 中打开项目：${describeError(error)}`, "error");
    });
  }, []);

  /** Opens the project in `editor` and makes it this project's editor from now on. */
  const chooseWorkspaceEditor = useCallback((editor: WorkspaceEditorInfo) => {
    if (!workspaceCwd) return;
    revealWorkspaceInEditor(workspaceCwd, editor);
    rememberProjectEditor(workspaceCwd, editor.id);
    setEditorChoiceOverride({ workspace: workspaceCwd, id: editor.id });
  }, [revealWorkspaceInEditor, workspaceCwd]);

  const openWorkspaceTerminalApp = useCallback((app: TerminalAppInfo) => {
    if (!workspaceCwd) return;
    void pi.openWorkspaceInTerminalApp(workspaceCwd, app.id).catch((error) => {
      usePiStore.getState().showToast(`无法打开 ${app.name}：${describeError(error)}`, "error");
    });
  }, [workspaceCwd]);

  /** The "open in" button's main action: the project's editor, or Explorer when none is installed. */
  const openWorkspaceInPreferredApp = useCallback(() => {
    if (!workspaceCwd) return;
    if (preferredWorkspaceEditor) chooseWorkspaceEditor(preferredWorkspaceEditor);
    else revealWorkspaceInExplorer(workspaceCwd);
  }, [chooseWorkspaceEditor, preferredWorkspaceEditor, revealWorkspaceInExplorer, workspaceCwd]);
  const canOpenWorkspace = Boolean(workspaceCwd) && !quickChat && !hubView;

  // Ctrl+O already cycles transcript density, so opening the project takes Ctrl+Shift+O.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== "o") return;
      if ((event.target as Element | null)?.closest?.(".xterm") || !canOpenWorkspace) return;
      event.preventDefault();
      openWorkspaceInPreferredApp();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [canOpenWorkspace, openWorkspaceInPreferredApp]);

  const notify = useCallback((message: string, tone: "info" | "error") => {
    usePiStore.getState().showToast(message, tone);
  }, []);

  const currentNavigationTarget = useCallback((): NavigationTarget => {
    if (hubView) return { kind: "hub", view: hubView };
    if (!newTask && sessionFile) return { kind: "session", cwd, file: sessionFile };
    return { kind: "home", workspace: draftWorkspace || cwd };
  }, [cwd, draftWorkspace, hubView, newTask, sessionFile]);

  const applyNavigationTarget = useCallback(async (target: NavigationTarget) => {
    setMoreOpen(false);
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
    await switchSession(target.cwd, target.file);
  }, [openProjectHome, startNewTask, switchSession]);

  // The history stacks are refs so navigation never re-renders mid-update; this
  // copies what the back and forward buttons need into state after each change.
  const syncNavigationAvailability = useCallback(() => {
    setNavigationAvailability({
      back: navigationBackRef.current.length > 0,
      forward: navigationForwardRef.current.length > 0,
    });
  }, []);

  const navigateTo = useCallback((target: NavigationTarget) => {
    const current = currentNavigationTarget();
    if (navigationKey(current) === navigationKey(target)) return;
    navigationBackRef.current.push(current);
    navigationForwardRef.current = [];
    syncNavigationAvailability();
    void applyNavigationTarget(target);
  }, [applyNavigationTarget, currentNavigationTarget, syncNavigationAvailability]);

  const openPetActivity = useCallback((activity: DesktopPetNavigationRequest) => {
    if (activity.notificationId) usePiStore.getState().markNotificationRead(activity.notificationId);
    if (activity.sessionFile) {
      navigateTo({ kind: "session", cwd: activity.cwd, file: activity.sessionFile });
    } else if (activity.cwd) {
      navigateTo({ kind: "home", workspace: activity.cwd });
    }
  }, [navigateTo]);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    const stops: UnlistenFn[] = [];
    void Promise.all([
      listen<DesktopPetNavigationRequest>(DESKTOP_PET_NAVIGATE_EVENT, (event) => openPetActivity(event.payload)),
      listen(DESKTOP_PET_DISABLE_EVENT, () => {
        const current = usePiStore.getState();
        if (!current.settings?.petEnabled) return;
        void current.saveSettings({ ...current.settings, petEnabled: false }).catch((error) => {
          current.showToast(`关闭宠物失败：${describeError(error)}`, "error");
        });
      }),
    ]).then((unlisteners) => {
      if (disposed) unlisteners.forEach((stop) => stop());
      else stops.push(...unlisteners);
    });
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
    };
  }, [isTauri, openPetActivity]);

  const navigateBack = useCallback(() => {
    const target = navigationBackRef.current.pop();
    if (!target) return;
    navigationForwardRef.current.push(currentNavigationTarget());
    syncNavigationAvailability();
    void applyNavigationTarget(target);
  }, [applyNavigationTarget, currentNavigationTarget, syncNavigationAvailability]);

  const navigateForward = useCallback(() => {
    const target = navigationForwardRef.current.pop();
    if (!target) return;
    navigationBackRef.current.push(currentNavigationTarget());
    syncNavigationAvailability();
    void applyNavigationTarget(target);
  }, [applyNavigationTarget, currentNavigationTarget, syncNavigationAvailability]);

  const forgetArchivedSessions = useCallback((archivedFiles: string[]) => {
    navigationBackRef.current = withoutArchivedSessions(navigationBackRef.current, archivedFiles);
    navigationForwardRef.current = withoutArchivedSessions(navigationForwardRef.current, archivedFiles);
    const persistedTask = readPersistedTask();
    if (persistedTask && archivedFiles.some((file) => sameLocalPath(file, persistedTask.sessionFile))) {
      window.localStorage.removeItem(LAST_TASK_KEY);
    }
    syncNavigationAvailability();
  }, [syncNavigationAvailability]);

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
      usePiStore.getState().showToast(`归档失败：${describeError(error)}`, "error");
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
        closeWarning = describeError(error);
        usePiStore.getState().appendLog(`归档后关闭旧任务失败：${closeWarning}`);
      }
      await applyNavigationTarget({ kind: "home", workspace: activeTarget.cwd || fallbackWorkspace });
    }

    try {
      await usePiStore.getState().refreshSessions();
    } catch (error) {
      usePiStore.getState().appendLog(`归档后刷新会话失败：${describeError(error)}`);
    }
    usePiStore.getState().showToast(
      closeWarning ? `${successMessage}；旧任务进程关闭失败，但已返回项目首页` : successMessage,
      closeWarning ? "warning" : "info",
    );
  }, [applyNavigationTarget, forgetArchivedSessions]);

  const canNavigateBack = navigationAvailability.back;
  const canNavigateForward = navigationAvailability.forward;


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
      usePiStore.getState().showToast(describeError(error), "error");
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
      const message = describeError(error);
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
      usePiStore.getState().appendLog(`切换模型失败：${describeError(error)}`);
    });
  }, []);
  const changeComposerThinking = useCallback((level: string) => {
    void usePiStore.getState().setThinkingLevel(level).catch((error) => {
      usePiStore.getState().showToast(`设置推理等级失败：${describeError(error)}`, "error");
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
      usePiStore.getState().showToast(`切换权限失败：${describeError(error)}`, "error");
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
      usePiStore.getState().showToast(`切换工作模式失败：${describeError(error)}`, "error");
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
    if (sent) setDraftMode(false);
  }, [settings?.reviewDelivery]);

  const refreshReviewGit = useCallback(async () => {
    if (newTask) await refreshDraftGit();
    else await usePiStore.getState().refreshGit();
  }, [newTask, refreshDraftGit]);

  /** Commits run in the app, not through the agent; the dialog can push right after. */
  const openCommitDialog = useCallback((push: boolean) => {
    if (workspaceCwd) setCommitDialog({ push });
  }, [workspaceCwd]);

  const finishCommit = useCallback((outcome: CommitOutcome) => {
    setCommitDialog(null);
    const committed = `已提交 ${outcome.commit.shortSha}：${outcome.commit.subject}`;
    const push = outcome.push;
    if (push && "error" in push) {
      usePiStore.getState().showToast(`${committed}。推送失败：${push.error}`, "error");
    } else if (push) {
      usePiStore.getState().showToast(`${committed}，已推送到 ${push.result.remote}/${push.result.branch}`, "info");
    } else {
      usePiStore.getState().showToast(committed, "info");
    }
    void refreshReviewGit();
  }, [refreshReviewGit]);

  const pushCurrentBranch = useCallback(async () => {
    if (!workspaceCwd || gitPushing) return;
    setGitPushing(true);
    try {
      const result = await pi.gitPush(workspaceCwd);
      usePiStore.getState().showToast(
        result.setUpstream ? `已发布 ${result.branch} 到 ${result.remote}` : `已推送到 ${result.remote}/${result.branch}`,
        "info",
      );
    } catch (error) {
      usePiStore.getState().showToast(`推送失败：${describeError(error)}`, "error");
    } finally {
      setGitPushing(false);
      void refreshReviewGit();
    }
  }, [gitPushing, refreshReviewGit, workspaceCwd]);

  /** Stage, unstage or discard one hunk (or a whole file's turn changes). */
  const applyGitPatch = useCallback(async (patch: string, options: { cached: boolean; reverse: boolean }, done: string) => {
    if (!workspaceCwd) return false;
    try {
      await pi.gitApplyPatch(workspaceCwd, patch, options);
      if (newTask) await refreshDraftGit();
      else await usePiStore.getState().refreshGit();
      usePiStore.getState().showToast(done, "info");
      return true;
    } catch (error) {
      usePiStore.getState().showToast(`Git 未能应用这块改动：${describeError(error)}`, "error");
      return false;
    }
  }, [newTask, refreshDraftGit, workspaceCwd]);

  const submitReviewComments = useCallback(async (comments: PendingReviewComment[]) => {
    if (!comments.length) return false;
    const items = comments.map((comment, index) => [
      `${index + 1}. 文件：${comment.path}${comment.line ? `（第 ${comment.line} 行）` : ""}`,
      `   意见：${comment.body.replace(/\n/g, "\n   ")}`,
    ].join("\n"));
    return sendFromComposer([
      `请处理以下 ${comments.length} 条代码审阅意见。逐条修改；如果某条意见不成立，说明理由。`,
      items.join("\n"),
    ].join("\n\n"));
  }, [sendFromComposer]);

  const verifyBrowserPage = useCallback((url: string, automatic = false) => sendFromComposer([
    automatic ? `（自动验证）刚才的改动影响了页面 ${url}。` : `请验证页面 ${url}。`,
    "用浏览器工具打开它，检查页面是否正常渲染、控制台有没有报错、主要交互能否使用；发现问题直接修复，修复后再验证一次，最后简要说明结果。",
  ].join("\n")), [sendFromComposer]);

  // A turn ends when the current runtime stops streaming (switching threads is not a turn end).
  const [turnCompletedAt, setTurnCompletedAt] = useState(0);
  const [streamSeen, setStreamSeen] = useState({ runtimeId, isStreaming });
  if (streamSeen.runtimeId !== runtimeId || streamSeen.isStreaming !== isStreaming) {
    if (streamSeen.runtimeId === runtimeId && streamSeen.isStreaming && !isStreaming) setTurnCompletedAt((value) => value + 1);
    setStreamSeen({ runtimeId, isStreaming });
  }

  // Opt-in (browser ⋯ menu): after a turn that changed files, ask Pi once to verify the open local page.
  const browserUrlRef = useRef("");
  const rememberBrowserUrl = useCallback((url: string) => {
    browserUrlRef.current = url;
  }, []);
  const handledTurnRef = useRef(0);
  const verificationTurnRef = useRef(false);
  useEffect(() => {
    if (turnCompletedAt === 0 || handledTurnRef.current === turnCompletedAt) return;
    handledTurnRef.current = turnCompletedAt;
    if (verificationTurnRef.current) {
      // This was the verification turn itself; do not verify the verification.
      verificationTurnRef.current = false;
      return;
    }
    const url = browserUrlRef.current;
    if (!isTauri || !workspaceCwd || !url || !isLocalWebAddress(url) || !readBrowserToggle(BROWSER_AUTO_VERIFY_KEY, false)) return;
    void pi.gitLastTurnSnapshot(workspaceCwd).then(async (turn) => {
      if (!turn || turn.files.length === 0) return;
      verificationTurnRef.current = await verifyBrowserPage(url, true);
    }).catch(() => undefined);
  }, [isTauri, turnCompletedAt, verifyBrowserPage, workspaceCwd]);

  const exportConversationMarkdown = useCallback(async () => {
    const current = usePiStore.getState();
    if (!current.sessionFile) return;
    const baseName = (current.sessionName || "pidesktop-conversation")
      // eslint-disable-next-line no-control-regex -- stripping control characters is what this sanitiser is for
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
      current.showToast(`导出失败：${describeError(error)}`, "error");
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
      models={pickerModels}
      model={model}
      thinkingLevel={thinkingLevel}
      thinkingLevels={availableThinkingLevels}
      prefill={goalEditPrefill ?? composerPrefill}
      insertRequest={composerInsert}
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
      transcriptDensity={transcriptDensity}
      onTranscriptDensityChange={variant === "follow-up" ? setTranscriptDensity : undefined}
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
                <button disabled={!canOpenWorkspace} onClick={() => { setAppMenu(null); openWorkspaceInPreferredApp(); }}>{preferredWorkspaceEditor ? `在 ${preferredWorkspaceEditor.name} 中打开` : "在文件资源管理器中打开"}  Ctrl+Shift+O</button>
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
                {TRANSCRIPT_DENSITY_ORDER.map((value) => (
                  <button key={value} onClick={() => { setAppMenu(null); setTranscriptDensity(value); }}>
                    对话{TRANSCRIPT_DENSITY_LABELS[value]}{transcriptDensity === value ? " ✓" : ""}
                    {value === "normal" ? "  Ctrl+O" : ""}
                  </button>
                ))}
                <div className="menu-separator" />
                <button onClick={() => { setAppMenu(null); openSummary(); }}>任务摘要</button>
                <button onClick={() => { setAppMenu(null); toggleWorkspaceTool("review"); }}>审查</button>
                <button onClick={() => { setAppMenu(null); setBottomPanel((value) => !value); }}>{bottomPanel ? "隐藏终端" : "打开终端"}  Ctrl+J</button>
                <button onClick={() => { setAppMenu(null); toggleWorkspaceTool("browser"); }}>浏览器</button>
                <button onClick={() => { setAppMenu(null); toggleWorkspaceTool("files"); }}>文件</button>
                <button onClick={() => { setAppMenu(null); openSettingsPage("appearance"); }}>外观设置</button>
              </>}
              {appMenu === "help" && <>
                <button onClick={() => { setAppMenu(null); void openUrl("https://pi.dev"); }}>Pi 文档</button>
                <button onClick={() => { setAppMenu(null); openSummary("logs"); }}>诊断日志</button>
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
                store.showToast(`创建工作树失败：${describeError(error)}`, "error");
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
            onPointerDown={sidebarResize.beginResize}
            onKeyDown={sidebarResize.resizeWithKeyboard}
          />
        )}

        <FileActionsProvider
          workspace={workspaceCwd}
          editors={workspaceEditors}
          preferredEditor={preferredWorkspaceEditor}
          onOpenPreview={openPreviewFile}
          onAddToChat={(path) => void addWorkspaceFileToChat(path)}
          onNotify={notify}
        >
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
          {!newTask && !hubView && (
            <div className="dsh-claude-topbar-center" data-tauri-drag-region>
              <div className="dsh-claude-view-tabs" data-dsh-view-tabs="" role="tablist" aria-label="对话详细程度">
                {TRANSCRIPT_DENSITY_ORDER.map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={transcriptDensity === value}
                    className={`dsh-claude-view-tab ${transcriptDensity === value ? "active" : ""}`}
                    onClick={() => setTranscriptDensity(value)}
                  >
                    {TRANSCRIPT_DENSITY_LABELS[value]}
                  </button>
                ))}
              </div>
            </div>
          )}
          {newTask && !hubView && (
            <div className="dsh-claude-topbar-center" data-tauri-drag-region>
              <div className="dsh-claude-view-tabs is-always-visible" data-dsh-view-tabs="" role="tablist" aria-label="首页版面">
                <button
                  type="button"
                  role="tab"
                  aria-selected={homeLayout === "studio"}
                  className={`dsh-claude-view-tab ${homeLayout === "studio" ? "active" : ""}`}
                  onClick={() => toggleHomeLayout("studio")}
                >
                  工作室
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={homeLayout === "classic"}
                  className={`dsh-claude-view-tab ${homeLayout === "classic" ? "active" : ""}`}
                  onClick={() => toggleHomeLayout("classic")}
                >
                  经典
                </button>
              </div>
            </div>
          )}
          <div className="topbar-right" data-tauri-drag-region>
            {!hubView && (
              <div className="panel-toggles codex-layout-chrome">
                <div className="main-pane-controls">
                  {reviewFileCount > 0 && (
                    <button
                      type="button"
                      className={`title-diff-chip topbar-diff-chip ${reviewActive ? "active" : ""}`}
                      title={`${reviewFileCount} 个文件有未提交的变更 · 审查 (Ctrl+Shift+G)`}
                      aria-label={`审查 ${reviewFileCount} 个文件的变更`}
                      aria-pressed={reviewActive}
                      onClick={() => (reviewActive ? closeWorkspaceSidebar() : openReview("uncommitted"))}
                    >
                      {gitDiffStats.additions > 0 && <em>+{gitDiffStats.additions.toLocaleString()}</em>}
                      {gitDiffStats.deletions > 0 && <b>−{gitDiffStats.deletions.toLocaleString()}</b>}
                      {gitDiffStats.additions === 0 && gitDiffStats.deletions === 0 && <span>{reviewFileCount} 个文件</span>}
                    </button>
                  )}
                  {canOpenWorkspace && (
                    <GitActionButton
                      git={reviewGit}
                      pushing={gitPushing}
                      onCommit={openCommitDialog}
                      onPush={() => void pushCurrentBranch()}
                    />
                  )}
                  {canOpenWorkspace && (
                    <OpenInMenu
                      workspace={workspaceCwd}
                      editors={workspaceEditors}
                      preferredEditor={preferredWorkspaceEditor}
                      terminalApps={terminalApps}
                      onOpenPreferred={openWorkspaceInPreferredApp}
                      onChooseEditor={chooseWorkspaceEditor}
                      onOpenTerminalApp={openWorkspaceTerminalApp}
                      onReveal={() => revealWorkspaceInExplorer(workspaceCwd)}
                      onOpenIntegratedTerminal={() => setBottomPanel(true)}
                    />
                  )}
                </div>
                <div className="workspace-pane-controls">
                  <button
                    type="button"
                    className={`panel-toggle terminal-toggle ${bottomPanel ? "active" : ""}`}
                    title={terminalToggleTitle}
                    aria-label={terminalToggleTitle}
                    aria-pressed={bottomPanel}
                    onClick={() => setBottomPanel((value) => !value)}
                  >
                    <PanelBottom size={15} strokeWidth={1.75} />
                    {showBackgroundTerminals && (
                      <i className={`panel-toggle-dot ${backgroundTerminals.unseenOutput ? "unseen" : ""}`} aria-hidden />
                    )}
                  </button>
                  <button
                    type="button"
                    className={`panel-toggle ${workspaceSidebarVisible ? "active" : ""}`}
                    title="侧边栏：摘要、审查、浏览器、文件 (Ctrl+Alt+B)"
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
                  store.showToast(`检出失败：${describeError(error)}`, "error");
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
            <div className={`conversation ${newTask ? "new-task-conversation" : ""} ${!newTask ? `density-${transcriptDensity}` : ""}`}>
              {newTask ? (
                <div
                  className={`new-task-screen codex-home vetta-home dsh-claude-home is-${homeLayout}`}
                  data-dsh-claude-home-layout={homeLayout}
                >
                  <div className="vetta-home-intro dsh-claude-hero-headline">
                    <span className="dsh-claude-hero-pet" aria-hidden="true">
                      <PetAvatar pet={activePet} busy={petBusy} state={petActivity} />
                    </span>
                    <h1 className="new-task-heading">
                      {homeLayout === "studio"
                        ? (quickChat ? "接下来聊些什么？" : `接下来在 ${taskWorkspaceName} 做什么？`)
                        : heroGreeting}
                    </h1>
                  </div>
                  {store.lastError && <p className="new-task-error">{store.lastError}</p>}

                  {homeLayout === "studio" && (
                    <ClaudeHomeDashboard
                      sessions={sessions}
                      currentModelId={model?.id}
                    />
                  )}

                  <div className="dsh-claude-home-composer-wrap">
                    {renderComposer("task-start")}
                  </div>
                </div>
              ) : (
                <>
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
                    density={transcriptDensity}
                    onOpenPlan={() => openSummary("plan")}
                  />
                  {(git?.files.length ?? 0) > 0 && (
                    <section className="conversation-change-card" aria-label="当前工作区变更">
                      <div className="conversation-change-heading">
                        <button
                          type="button"
                          className="conversation-change-open"
                          onClick={() => openReview("uncommitted")}
                          title="查看变更"
                        >
                          <span className="conversation-change-icon"><FileDiff size={15} strokeWidth={1.7} /></span>
                          <div>
                            <strong>
                              {changedFiles.length === 1
                                ? `已编辑 ${changedFiles[0].path.split(/[\\/]/).pop()}`
                                : `已编辑 ${changedFiles.length} 个文件`}
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
                  {/* ConversationPlan already renders update_plan; skip the plan extension's text copy. */}
                  {Object.entries(extensionWidgets).filter(([key]) => key !== "pidesktop-plan").map(([key, lines]) => (
                    <div className="extension-widget" key={key}>{lines.map((line, lineIndex) => <div key={lineIndex}>{line}</div>)}</div>
                  ))}
                  {extensionRequest && <ExtensionDialog request={extensionRequest} onAnswer={(response) => void store.answerExtension(response)} />}
                </>
              )}
              <div />
            </div>
          </div>

          {!newTask && !hubView && (
            <div className="composer-dock">
              <LivePlanBar />
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
            aria-valuemin={WORKSPACE_PANEL_BOUNDS.min}
            aria-valuemax={workspacePanelMaxWidth()}
            aria-valuenow={Math.round(workspacePanelWidth)}
            tabIndex={0}
            onPointerDown={workspaceResize.beginResize}
            onKeyDown={workspaceResize.resizeWithKeyboard}
          />
        )}
        <div className="workspace-dock" hidden={!workspaceSidebarVisible}>
          <ToolRail
            active={workspaceTool}
            onSelect={selectWorkspaceTool}
            onClose={closeWorkspaceSidebar}
            focused={workspaceFocusMode}
            onToggleFocus={() => setWorkspaceFocusMode((value) => !value)}
            badges={{ review: reviewFileCount || undefined, "side-chat": currentSideChats.length || undefined }}
            busy={{ "side-chat": currentSideChats.some((chat) => chat.isStreaming) }}
          />
          <div className="workspace-dock-body">
            {workspaceSidebarVisible && workspaceTool === "summary" && (
              <ConnectedInspectorPanel
                key={`summary-${summaryView.nonce}`}
                openView={summaryView.view}
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
                onCommitOrPush={() => openCommitDialog(false)}
                onEnvironmentChange={setTaskEnvironment}
                onSwitchWorkspace={(path) => void switchWorkspacePath(path)}
                onAbortCommand={() => void store.abortBash()}
                onRefreshTree={refreshSessionTree}
                onContinueFromNode={continueFromTreeNode}
                onOpenReview={openReview}
                onOpenTerminal={() => setBottomPanel(true)}
                onOpenBrowser={openBrowserAt}
                sideChats={currentSideChats}
                onOpenSideChat={openSideChat}
                onOpenFile={(path) => openPreviewFile(path)}
              />
            )}
            {mountedTools.has("review") && (
              <div className="workspace-dock-slot" hidden={workspaceTool !== "review"}>
                <ReviewPanel
                  git={newTask ? draftGit : git}
                  cwd={workspaceCwd}
                  isStreaming={isStreaming}
                  request={reviewRequest}
                  onRefreshGit={() => void (newTask ? refreshDraftGit() : store.refreshGit())}
                  onReview={(target) => void requestReview(target)}
                  onSubmitComments={submitReviewComments}
                  onCommitOrPush={openCommitDialog}
                  onRestoreFiles={(paths) => void restoreGitFiles(paths)}
                  onStageFiles={(paths) => updateGitIndex("stage", paths)}
                  onUnstageFiles={(paths) => updateGitIndex("unstage", paths)}
                  onApplyPatch={applyGitPatch}
                  onOpenFile={(path, line) => openPreviewFile(path, line)}
                  onError={showErrorToast}
                />
              </div>
            )}
            {mountedTools.has("browser") && (
              <div className="workspace-dock-slot" hidden={workspaceTool !== "browser"}>
                <BrowserWorkspacePanel
                  recentAgentPage={agentBrowser}
                  active={workspaceSidebarVisible && workspaceTool === "browser"}
                  navigateRequest={browserNavigate}
                  turnCompletedAt={turnCompletedAt}
                  onComment={(url, comment) => void sendFromComposer(`请根据这条页面反馈检查并修改页面：\n\n页面：${url}\n反馈：${comment}`)}
                  onVerify={(url) => void verifyBrowserPage(url)}
                  onUrlChange={rememberBrowserUrl}
                />
              </div>
            )}
            {mountedTools.has("files") && (
              <div className="workspace-dock-slot" hidden={workspaceTool !== "files"}>
                {previewFile && workspaceCwd && (
                  <DocumentPane
                    cwd={workspaceCwd}
                    path={previewFile.path}
                    line={previewFile.line}
                    tabs={openFileTabs}
                    onSelectTab={(path, line) => setPreviewFile({ path, line })}
                    onCloseTab={closePreviewTab}
                    onBack={() => setPreviewFile(null)}
                    onClose={() => { setPreviewFile(null); setOpenFileTabs([]); }}
                  />
                )}
                {/* The tree stays mounted under an open file, so its expanded folders survive. */}
                <div className="workspace-dock-slot" hidden={Boolean(previewFile && workspaceCwd)}>
                  <FileTreePanel
                    cwd={workspaceCwd}
                    activePath={previewFile?.path ?? null}
                    onOpenFile={(path) => openPreviewFile(path)}
                    onAddToChat={(path) => void addWorkspaceFileToChat(path)}
                  />
                </div>
              </div>
            )}
            {sideChats.map((chat) => (
              <SideChatPanel
                key={chat.id}
                chatId={chat.id}
                cwd={chat.cwd}
                parentSessionFile={chat.parentSessionFile}
                hidden={!workspaceSidebarVisible || workspaceTool !== "side-chat" || activeSideChatId !== chat.id}
                showThinking={settings?.showThinking ?? true}
                settings={settings}
                onClose={closeWorkspaceSidebar}
                onDelete={() => deleteSideChat(chat.id)}
                onNew={() => { createSideChat(); }}
                onStateChange={updateSideChatMeta}
                onError={showErrorToast}
              />
            ))}
          </div>
        </div>
        </div>

        {bottomPanel && <>
          <div
            className="bottom-panel-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整终端高度"
            aria-valuemin={BOTTOM_PANEL_BOUNDS.min}
            aria-valuemax={bottomPanelMaxHeight()}
            aria-valuenow={Math.round(bottomPanelHeight)}
            tabIndex={0}
            onPointerDown={bottomResize.beginResize}
            onKeyDown={bottomResize.resizeWithKeyboard}
          />
          <Suspense fallback={<div className="bottom-terminal page-loading">正在加载终端…</div>}>
            <TerminalWorkspacePanel
              key="bottom-terminal"
              cwd={workspaceCwd}
              defaultShell={settings?.terminalShell || "PowerShell"}
              onHide={() => setBottomPanel(false)}
              onSendToChat={sendTerminalToChat}
              onOpenLink={openTerminalLink}
            />
          </Suspense>
        </>}
        </div>
        </div>
        </div>
        </FileActionsProvider>
      </div>

      {commitDialog && workspaceCwd && reviewGit?.isRepository && (
        <CommitDialog
          cwd={workspaceCwd}
          git={reviewGit}
          initialPush={commitDialog.push}
          model={model ? { provider: model.provider, id: model.id } : null}
          agentRunning={isStreaming}
          onClose={() => setCommitDialog(null)}
          onDone={finishCommit}
        />
      )}
      {settingsOpen && <Suspense fallback={<div className="settings-center settings-loading">正在加载设置…</div>}><SettingsModal initialPage={settingsPage} settings={settings} cwd={cwd} appearanceCatalog={appearanceCatalog} onReloadAppearance={reloadAppearanceCatalog} onSave={store.saveSettings} onClose={() => setSettingsOpen(false)} /></Suspense>}

      {!isTauri && (settings?.petEnabled || previewPet) && !settingsOpen && (
        <PetCompanion
          pet={activePet}
          busy={petBusy}
          activity={petActivity}
          size={settings?.petSize ?? 96}
          activities={displayedPetActivities}
          onOpenActivity={openPetActivity}
          onHide={() => {
            const current = usePiStore.getState();
            if (current.settings) void current.saveSettings({ ...current.settings, petEnabled: false });
          }}
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
