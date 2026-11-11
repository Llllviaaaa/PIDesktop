import { useCallback, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { agent } from "../../lib/agent";
import { loadAttachmentFiles, mergeAttachments } from "../../lib/attachments";
import { describeError } from "../../lib/errors";
import { useAppStore } from "../../store";
import { useIntelligentUiStore } from "../../stores/intelligentUiStore";
import type { AppSettings, AttachmentPayload, GitSnapshot, ModelInfo } from "../../types";
import type { HubView } from "./shellTypes";
import { useShellGitAndMessageActions } from "./useShellGitAndMessageActions";

export interface UseShellTaskAndGitActionsOptions {
  newTask: boolean;
  quickChat: boolean;
  defaultWorkspaceDir: string;
  draftWorkspace: string;
  workspaceCwd: string;
  cwd: string;
  taskEnvironment: "local" | "worktree";
  attachments: AttachmentPayload[];
  setAttachments: React.Dispatch<React.SetStateAction<AttachmentPayload[]>>;
  draftGit: GitSnapshot | null;
  git: GitSnapshot | null;
  settings: AppSettings | null;
  selectWorkspace: (workspace: string) => void;
  setDraftWorkspace: (next: string) => void;
  setDraftMode: (next: boolean) => void;
  setQuickChat: (next: boolean) => void;
  setTaskEnvironment: (next: "local" | "worktree") => void;
  setHubView: (next: HubView | null) => void;
  refreshDraftGit: () => Promise<void>;
  connect: (cwd: string) => Promise<unknown>;
  appendLog: (text: string) => void;
}

export function useShellTaskAndGitActions({
  newTask,
  quickChat,
  defaultWorkspaceDir,
  draftWorkspace,
  workspaceCwd,
  cwd,
  taskEnvironment,
  attachments,
  setAttachments,
  draftGit,
  git,
  settings,
  selectWorkspace,
  setDraftWorkspace,
  setDraftMode,
  setQuickChat,
  setTaskEnvironment,
  setHubView,
  refreshDraftGit,
  connect,
  appendLog,
}: UseShellTaskAndGitActionsOptions) {
  const gitAndMessage = useShellGitAndMessageActions({
    newTask,
    workspaceCwd,
    cwd,
    draftGit,
    git,
    settings,
    setDraftMode,
    refreshDraftGit,
    connect,
  });

  const attachFiles = useCallback(async (files: string[]) => {
    const loaded = await loadAttachmentFiles(files, (error) => {
      appendLog(`附件读取失败：${describeError(error)}`);
      useAppStore.getState().showToast(`无法添加附件：${describeError(error)}`, "error");
    });
    setAttachments((current) => mergeAttachments(current, loaded));
  }, [appendLog, setAttachments]);

  const attachPayloads = useCallback((added: AttachmentPayload[]) => {
    setAttachments((current) => mergeAttachments(current, added));
  }, [setAttachments]);

  const pickAttachments = useCallback(async () => {
    const selected = await open({
      multiple: true,
      directory: false,
      title: "向任务添加文件",
    });
    await attachFiles(typeof selected === "string" ? [selected] : selected ?? []);
  }, [attachFiles]);

  const addWorkspaceFileToChat = useCallback(async (path: string) => {
    if (!workspaceCwd) return;
    const resolved = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path)
      ? path
      : `${workspaceCwd.replace(/[\\/]+$/, "")}\\${path.replace(/\//g, "\\")}`;
    try {
      const attachment = await agent.readAttachment(resolved);
      setAttachments((current) => current.some((item) => item.path === attachment.path)
        ? current
        : [...current, attachment]);
      useAppStore.getState().showToast(`${attachment.fileName} 已添加到聊天`, "info");
    } catch (error) {
      useAppStore.getState().showToast(describeError(error), "error");
    }
  }, [setAttachments, workspaceCwd]);

  const sendFromComposer = useCallback(async (text: string, behavior?: "steer" | "followUp") => {
    const enteringConversation = newTask;
    const enterConversation = () => {
      if (!enteringConversation) return;
      setDraftMode(false);
      setHubView(null);
    };
    const restoreInitialPrompt = () => {
      if (enteringConversation) useAppStore.setState({ composerPrefill: text });
    };
    let current = useAppStore.getState();
    let workspace = quickChat
      ? (defaultWorkspaceDir || await agent.quickChatDir())
      : (draftWorkspace || current.cwd || defaultWorkspaceDir || await agent.quickChatDir());
    if (!workspace) {
      const selected = await open({ directory: true, multiple: false, title: "选择任务项目" });
      if (typeof selected !== "string") return false;
      workspace = selected;
      selectWorkspace(selected);
    }
    const normalize = (value: string) => value.replace(/[\\/]+$/, "").toLowerCase();
    if (current.connection !== "running" || normalize(current.cwd) !== normalize(workspace)) {
      window.localStorage.setItem("qianji:last-workspace", workspace);
      const pendingConn = current.connect(workspace);
      enterConversation();
      await pendingConn;
      current = useAppStore.getState();
      if (current.connection !== "running") {
        restoreInitialPrompt();
        return false;
      }
    }
    if (taskEnvironment === "worktree" && current.messages.length === 0 && !quickChat) {
      try {
        await current.refreshGit();
        current = useAppStore.getState();
        const worktree = await agent.createWorktree(current.cwd, current.git?.branch);
        window.localStorage.setItem("qianji:last-workspace", worktree.path);
        setDraftWorkspace(worktree.path);
        const pendingConn = current.connect(worktree.path);
        enterConversation();
        await pendingConn;
        current = useAppStore.getState();
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
    if (sent) setAttachments([]);
    else restoreInitialPrompt();
    return sent;
  }, [
    attachments,
    defaultWorkspaceDir,
    draftWorkspace,
    newTask,
    quickChat,
    selectWorkspace,
    setAttachments,
    setDraftMode,
    setDraftWorkspace,
    setHubView,
    taskEnvironment,
  ]);

  useEffect(() => {
    useIntelligentUiStore.getState().setPromptDispatcher((prompt) => sendFromComposer(prompt, "followUp"));
    return () => useIntelligentUiStore.getState().setPromptDispatcher(null);
  }, [sendFromComposer]);

  const stopFromComposer = useCallback(() => {
    void useAppStore.getState().abort();
  }, []);
  const removeComposerAttachment = useCallback((path: string) => {
    setAttachments((items) => items.filter((item) => item.path !== path));
  }, [setAttachments]);
  const changeComposerModel = useCallback((next: ModelInfo) => {
    void useAppStore.getState().setModel(next).catch((error) => {
      useAppStore.getState().appendLog(`切换模型失败：${describeError(error)}`);
    });
  }, []);
  const changeComposerThinking = useCallback((level: string) => {
    void useAppStore.getState().setThinkingLevel(level).catch((error) => {
      useAppStore.getState().showToast(`设置推理等级失败：${describeError(error)}`, "error");
    });
  }, []);
  const startQuickChatFromComposer = useCallback(() => {
    setQuickChat(true);
    setTaskEnvironment("local");
  }, [setQuickChat, setTaskEnvironment]);
  const changeComposerPermission = useCallback(async (mode: AppSettings["permissionMode"]) => {
    const current = useAppStore.getState();
    if (!current.settings || current.settings.permissionMode === mode) return;
    if (current.isStreaming) {
      current.showToast("请等待当前回复完成后再切换权限", "warning");
      return;
    }
    const previous = current.settings.permissionMode;
    try {
      await current.setRuntimePermissionMode(mode);
      await current.saveSettings({ ...current.settings, permissionMode: mode });
      useAppStore.getState().showToast("权限模式已更新", "info");
    } catch (error) {
      await useAppStore.getState().setRuntimePermissionMode(previous).catch(() => undefined);
      useAppStore.getState().showToast(`切换权限失败：${describeError(error)}`, "error");
    }
  }, []);
  const changeComposerAgentMode = useCallback(async (mode: AppSettings["agentMode"]) => {
    const current = useAppStore.getState();
    if (!current.settings || current.settings.agentMode === mode) return;
    if (current.isStreaming) {
      current.showToast("请等待当前回复完成后再切换工作模式", "warning");
      return;
    }
    const previous = current.settings.agentMode;
    try {
      await current.setRuntimeAgentMode(mode);
      await current.saveSettings({ ...current.settings, agentMode: mode });
      useAppStore.getState().showToast(`已切换到${mode === "agent" ? "执行" : mode === "plan" ? "计划" : "问答"}模式`, "info");
    } catch (error) {
      await useAppStore.getState().setRuntimeAgentMode(previous).catch(() => undefined);
      useAppStore.getState().showToast(`切换工作模式失败：${describeError(error)}`, "error");
    }
  }, []);
  const consumeComposerPrefill = useCallback(() => {
    useAppStore.getState().clearComposerPrefill();
  }, []);

  return {
    ...gitAndMessage,
    attachFiles,
    attachPayloads,
    pickAttachments,
    addWorkspaceFileToChat,
    sendFromComposer,
    stopFromComposer,
    removeComposerAttachment,
    changeComposerModel,
    changeComposerThinking,
    startQuickChatFromComposer,
    changeComposerPermission,
    changeComposerAgentMode,
    consumeComposerPrefill,
  };
}
