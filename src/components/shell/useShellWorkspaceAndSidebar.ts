import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { agent } from "../../lib/agent";
import { describeError } from "../../lib/errors";
import { sameLocalPath } from "../../lib/pathIdentity";
import { queryKeys } from "../../lib/queries";
import { preferredEditorFor, rememberProjectEditor } from "../../lib/workspaceEditors";
import { useAppStore } from "../../store";
import { useWorkbenchStore } from "../../stores/workbenchStore";
import type {
  AppSettings,
  ConnectionState,
  GitSnapshot,
  ProjectConfig,
  SessionInfo,
  TerminalAppInfo,
  WorkspaceEditorInfo,
} from "../../types";
import type { HubView } from "./shellTypes";

export interface UseShellWorkspaceAndSidebarOptions {
  isTauri: boolean;
  newTask: boolean;
  cwd: string;
  settings: AppSettings | null;
  sessions: SessionInfo[];
  connection: ConnectionState;
  hubView: HubView | null;
  setHubView: (next: HubView | null) => void;
  runtimeRecoveryDone: boolean;
  startupAutoConnectRef: React.RefObject<boolean>;
  connect: (cwd: string) => Promise<unknown>;
  draftWorkspace: string;
  setDraftWorkspace: (next: string) => void;
}

export function useShellWorkspaceAndSidebar({
  isTauri,
  newTask,
  cwd,
  settings,
  sessions,
  connection,
  hubView,
  setHubView,
  runtimeRecoveryDone,
  startupAutoConnectRef,
  connect,
  draftWorkspace,
  setDraftWorkspace,
}: UseShellWorkspaceAndSidebarOptions) {
  const queryClient = useQueryClient();
  const [sidebarVisible, setSidebarVisible] = useState(() => window.innerWidth > 900);
  const [sidebarHoverPreview, setSidebarHoverPreview] = useState(false);
  const sidebarHoverCloseTimerRef = useRef<number | null>(null);
  const [editorChoiceOverride, setEditorChoiceOverride] = useState<{ workspace: string; id: string } | null>(null);
  const [registeredProjects, setRegisteredProjects] = useState<ProjectConfig[]>([]);
  const [quickChat, setQuickChat] = useState(false);
  const [taskEnvironment, setTaskEnvironment] = useState<"local" | "worktree">("local");

  const workspaceCwd = newTask ? draftWorkspace : cwd;
  const sidebarRendered = sidebarVisible || sidebarHoverPreview;

  const draftGitQuery = useQuery({
    queryKey: queryKeys.gitSnapshot(draftWorkspace),
    queryFn: () => agent.gitSnapshot(draftWorkspace),
    enabled: isTauri && Boolean(draftWorkspace),
  });
  const draftGit: GitSnapshot | null = isTauri && draftWorkspace && !draftGitQuery.isError ? draftGitQuery.data ?? null : null;
  const draftBranch = draftGit?.isRepository ? draftGit.branch || "" : "";

  const customDefaultWorkspace = settings?.defaultWorkspace?.trim() || "";
  const defaultWorkspaceQuery = useQuery({
    queryKey: ["default-workspace-dir", customDefaultWorkspace],
    queryFn: () => agent.quickChatDir(),
    enabled: isTauri,
    staleTime: Infinity,
  });
  const defaultWorkspaceDir = (customDefaultWorkspace || defaultWorkspaceQuery.data || "").trim();

  const isDefaultWorkspace = useCallback((path: string) => {
    const trimmed = path.trim().replace(/[\\/]+$/, "");
    if (!trimmed) return false;
    if (trimmed.toLowerCase().endsWith("quick-chat")) return true;
    if (customDefaultWorkspace) return sameLocalPath(trimmed, customDefaultWorkspace);
    return false;
  }, [customDefaultWorkspace]);

  const workspaceEditorsQuery = useQuery({
    queryKey: queryKeys.workspaceEditors(),
    queryFn: () => agent.listWorkspaceEditors(),
    enabled: isTauri,
    staleTime: Infinity,
  });
  const workspaceEditors: WorkspaceEditorInfo[] = useMemo(() => workspaceEditorsQuery.data ?? [], [workspaceEditorsQuery.data]);

  const terminalAppsQuery = useQuery({
    queryKey: queryKeys.terminalApps(),
    queryFn: () => agent.listTerminalApps(),
    enabled: isTauri,
    staleTime: Infinity,
  });
  const terminalApps: TerminalAppInfo[] = useMemo(() => terminalAppsQuery.data ?? [], [terminalAppsQuery.data]);

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

  useSyncOnChange([sidebarVisible], () => {
    if (sidebarVisible) setSidebarHoverPreview(false);
  });
  useEffect(() => {
    if (sidebarVisible) cancelSidebarHoverClose();
  }, [cancelSidebarHoverClose, sidebarVisible]);
  useEffect(() => () => cancelSidebarHoverClose(), [cancelSidebarHoverClose]);

  const defaultTaskEnvironment = settings?.defaultTaskEnvironment;
  const settingsLoaded = Boolean(settings);
  useSyncOnChange([settingsLoaded, defaultTaskEnvironment], () => {
    if (!settingsLoaded) return;
    setTaskEnvironment(defaultTaskEnvironment === "worktree" ? "worktree" : "local");
  });

  useEffect(() => {
    window.localStorage.setItem("qianji:task-environment", taskEnvironment);
  }, [taskEnvironment]);

  useSyncOnChange([draftWorkspace, sessions], () => {
    if (draftWorkspace || sessions.length === 0) return;
    const firstProject = sessions.find((session) => !isDefaultWorkspace(session.cwd))?.cwd;
    if (firstProject) setDraftWorkspace(firstProject);
  });

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    const loadProjects = async () => {
      try {
        const projects = await agent.listProjects();
        if (!disposed) setRegisteredProjects(projects.filter((project) => !project.hidden));
      } catch {
        if (!disposed) setRegisteredProjects([]);
      }
    };
    void loadProjects();
    const reload = () => void loadProjects();
    window.addEventListener("qianji:projects-changed", reload);
    return () => {
      disposed = true;
      window.removeEventListener("qianji:projects-changed", reload);
    };
  }, [isTauri]);

  useEffect(() => {
    const targetWorkspace = quickChat ? defaultWorkspaceDir : (draftWorkspace || defaultWorkspaceDir);
    if (!isTauri || !targetWorkspace) return;
    if (!runtimeRecoveryDone || !newTask || hubView !== null || connection !== "disconnected" || startupAutoConnectRef.current) return;
    void connect(targetWorkspace).catch(() => undefined);
  }, [connection, defaultWorkspaceDir, draftWorkspace, hubView, isTauri, newTask, quickChat, runtimeRecoveryDone, startupAutoConnectRef, connect]);

  const refreshDraftGit = useCallback(async () => {
    if (!isTauri || !draftWorkspace) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.gitSnapshot(draftWorkspace) });
  }, [draftWorkspace, isTauri, queryClient]);

  const selectWorkspace = useCallback((workspace: string) => {
    const isDefault = isDefaultWorkspace(workspace);
    window.localStorage.setItem("qianji:last-workspace", workspace);
    if (!isDefault) setDraftWorkspace(workspace);
    setQuickChat(isDefault);
    if (isTauri && workspace && !isDefault) {
      void agent.registerProject(workspace)
        .then(() => window.dispatchEvent(new Event("qianji:projects-changed")))
        .catch(() => undefined);
    }
  }, [isDefaultWorkspace, isTauri, setDraftWorkspace]);

  const pickFolder = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: "打开工作区" });
    if (typeof selected !== "string") return;
    selectWorkspace(selected);
  }, [selectWorkspace]);

  const openPreviewFile = useCallback((path: string, line?: number) => {
    if (!workspaceCwd) return;
    setHubView(null);
    void useWorkbenchStore.getState().openFile(workspaceCwd, path, line ? { line } : undefined);
  }, [setHubView, workspaceCwd]);

  const revealWorkspaceInExplorer = useCallback((workspace: string) => {
    if (!workspace) return;
    void agent.openWorkspaceInFileManager(workspace).catch((error) => {
      useAppStore.getState().showToast(`无法在资源管理器中打开项目：${describeError(error)}`, "error");
    });
  }, []);

  const chooseWorkspaceEditor = useCallback((editor: WorkspaceEditorInfo) => {
    if (!workspaceCwd) return;
    void agent.openWorkspaceInEditor(workspaceCwd, editor.id).catch((error) => {
      useAppStore.getState().showToast(`无法在 ${editor.name} 中打开项目：${describeError(error)}`, "error");
    });
    rememberProjectEditor(workspaceCwd, editor.id);
    setEditorChoiceOverride({ workspace: workspaceCwd, id: editor.id });
  }, [workspaceCwd]);

  const openWorkspaceTerminalApp = useCallback((app: TerminalAppInfo) => {
    if (!workspaceCwd) return;
    void agent.openWorkspaceInTerminalApp(workspaceCwd, app.id).catch((error) => {
      useAppStore.getState().showToast(`无法打开 ${app.name}：${describeError(error)}`, "error");
    });
  }, [workspaceCwd]);

  const openWorkspaceInPreferredApp = useCallback(() => {
    if (!workspaceCwd) return;
    if (preferredWorkspaceEditor) chooseWorkspaceEditor(preferredWorkspaceEditor);
    else revealWorkspaceInExplorer(workspaceCwd);
  }, [chooseWorkspaceEditor, preferredWorkspaceEditor, revealWorkspaceInExplorer, workspaceCwd]);

  const canOpenWorkspace = Boolean(workspaceCwd) && !quickChat && !hubView;

  const workspaceOptions = useMemo(
    () => [draftWorkspace, cwd, ...registeredProjects.map((project) => project.path), ...sessions.map((session) => session.cwd)]
      .filter((item): item is string => Boolean(item) && !isDefaultWorkspace(item)),
    [cwd, draftWorkspace, isDefaultWorkspace, registeredProjects, sessions],
  );

  return {
    sidebarVisible,
    setSidebarVisible,
    sidebarHoverPreview,
    sidebarRendered,
    cancelSidebarHoverClose,
    showSidebarHoverPreview,
    scheduleSidebarHoverClose,
    togglePrimarySidebar,
    pinPrimarySidebar,
    workspaceCwd,
    draftGit,
    draftBranch,
    defaultWorkspaceDir,
    isDefaultWorkspace,
    quickChat,
    setQuickChat,
    taskEnvironment,
    setTaskEnvironment,
    workspaceEditors,
    terminalApps,
    preferredWorkspaceEditor,
    refreshDraftGit,
    selectWorkspace,
    pickFolder,
    openPreviewFile,
    revealWorkspaceInExplorer,
    chooseWorkspaceEditor,
    openWorkspaceTerminalApp,
    openWorkspaceInPreferredApp,
    canOpenWorkspace,
    workspaceOptions,
  };
}
