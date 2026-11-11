import { useCallback, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ACTIVE_RUNTIME_KEY, LAST_TASK_KEY, readPersistedTask } from "../../hooks/useRuntimeBootstrap";
import { agent } from "../../lib/agent";
import { describeError } from "../../lib/errors";
import { navigationKey, withoutArchivedSessions } from "../../lib/navigationHistory";
import { sameLocalPath } from "../../lib/pathIdentity";
import { useAppStore } from "../../store";
import type { SessionInfo } from "../../types";
import type { HubView, NavigationTarget } from "./shellTypes";

export interface UseShellNavigationOptions {
  cwd: string;
  draftWorkspace: string;
  hubView: HubView | null;
  newTask: boolean;
  sessionFile: string | null;
  isDefaultWorkspace: (path: string) => boolean;
  selectWorkspace: (workspace: string) => void;
  setDraftWorkspace: (next: string) => void;
  setDraftMode: (next: boolean) => void;
  setQuickChat: (next: boolean) => void;
  setTaskEnvironment: (next: "local" | "worktree") => void;
  setHubView: (next: HubView | null) => void;
  setMoreOpen: (next: boolean) => void;
  switchSession: (cwd: string, file: string) => Promise<unknown>;
}

export function useShellNavigation({
  cwd,
  draftWorkspace,
  hubView,
  newTask,
  sessionFile,
  isDefaultWorkspace,
  selectWorkspace,
  setDraftWorkspace,
  setDraftMode,
  setQuickChat,
  setTaskEnvironment,
  setHubView,
  setMoreOpen,
  switchSession,
}: UseShellNavigationOptions) {
  const navigationBackRef = useRef<NavigationTarget[]>([]);
  const navigationForwardRef = useRef<NavigationTarget[]>([]);
  const [navigationAvailability, setNavigationAvailability] = useState({ back: false, forward: false });

  const startNewTask = useCallback((asQuickChat = false) => {
    const current = useAppStore.getState();
    if (current.cwd && !isDefaultWorkspace(current.cwd)) setDraftWorkspace(current.cwd);
    current.prepareNewTask();
    setDraftMode(true);
    setQuickChat(asQuickChat);
    const preferred = current.settings?.defaultTaskEnvironment === "worktree" ? "worktree" : "local";
    setTaskEnvironment(asQuickChat ? "local" : preferred);
    window.localStorage.setItem("qianji:task-environment", asQuickChat ? "local" : preferred);
    setHubView(null);
  }, [isDefaultWorkspace, setDraftMode, setDraftWorkspace, setHubView, setQuickChat, setTaskEnvironment]);

  const openProjectHome = useCallback((workspace: string) => {
    if (!workspace) return;
    const isDefault = isDefaultWorkspace(workspace);
    selectWorkspace(workspace);
    useAppStore.getState().prepareNewTask();
    setDraftMode(true);
    setQuickChat(isDefault);
    setHubView(null);
  }, [isDefaultWorkspace, selectWorkspace, setDraftMode, setHubView, setQuickChat]);

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
    window.localStorage.setItem("qianji:last-workspace", target.cwd);
    if (!isDefaultWorkspace(target.cwd)) setDraftWorkspace(target.cwd);
    setDraftMode(false);
    setQuickChat(isDefaultWorkspace(target.cwd));
    setHubView(null);
    await switchSession(target.cwd, target.file);
  }, [
    isDefaultWorkspace,
    openProjectHome,
    setDraftMode,
    setDraftWorkspace,
    setHubView,
    setMoreOpen,
    setQuickChat,
    startNewTask,
    switchSession,
  ]);

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
      await Promise.all(archivedFiles.map((file) => agent.archiveSession(file)));
    } catch (error) {
      useAppStore.getState().showToast(`归档失败：${describeError(error)}`, "error");
      return;
    }

    const activeFile = useAppStore.getState().sessionFile;
    const activeTarget = activeFile
      ? targets.find((target) => sameLocalPath(target.file, activeFile))
      : undefined;
    forgetArchivedSessions(archivedFiles);

    let closeWarning: string | null = null;
    if (activeTarget) {
      window.localStorage.removeItem(ACTIVE_RUNTIME_KEY);
      window.localStorage.removeItem(LAST_TASK_KEY);
      try {
        await useAppStore.getState().disconnect();
      } catch (error) {
        closeWarning = describeError(error);
        useAppStore.getState().appendLog(`归档后关闭旧任务失败：${closeWarning}`);
      }
      await applyNavigationTarget({ kind: "home", workspace: activeTarget.cwd || fallbackWorkspace });
    }

    try {
      await useAppStore.getState().refreshSessions();
    } catch (error) {
      useAppStore.getState().appendLog(`归档后刷新会话失败：${describeError(error)}`);
    }
    useAppStore.getState().showToast(
      closeWarning ? `${successMessage}；旧任务进程关闭失败，但已返回项目首页` : successMessage,
      closeWarning ? "warning" : "info",
    );
  }, [applyNavigationTarget, forgetArchivedSessions]);

  // Canonical deduplicated Markdown session exporter (used by both File menu and Thread menu).
  const exportConversationMarkdown = useCallback(async () => {
    const current = useAppStore.getState();
    if (!current.sessionFile) return;
    const baseName = (current.sessionName || "qianji-conversation")
      // eslint-disable-next-line no-control-regex -- stripping control characters is what this sanitiser is for
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
      .slice(0, 60)
      .trim() || "qianji-conversation";
    const destination = await saveDialog({
      title: "导出当前对话",
      defaultPath: `${baseName}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (typeof destination !== "string" || !destination) return;
    try {
      await current.exportSession(destination);
    } catch (error) {
      current.showToast(`导出失败：${describeError(error)}`, "error");
    }
  }, []);

  return {
    canNavigateBack: navigationAvailability.back,
    canNavigateForward: navigationAvailability.forward,
    navigateTo,
    navigateBack,
    navigateForward,
    archiveConversations,
    exportConversationMarkdown,
  };
}
