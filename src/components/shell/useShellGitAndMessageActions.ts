import { useCallback, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { agent } from "../../lib/agent";
import { clientContributions } from "../../lib/clientContributions";
import type { CodeReviewScope } from "../../lib/codeReview";
import { describeError } from "../../lib/errors";
import { rewindController } from "../../lib/rewindController";
import { useAppStore } from "../../store";
import type { CommitOutcome } from "../CommitDialog";
import type { AppSettings, AttachmentPayload, GitSnapshot, UiMessage } from "../../types";

export interface UseShellGitAndMessageActionsOptions {
  newTask: boolean;
  workspaceCwd: string;
  cwd: string;
  draftGit: GitSnapshot | null;
  git: GitSnapshot | null;
  settings: AppSettings | null;
  setDraftMode: (next: boolean) => void;
  refreshDraftGit: () => Promise<void>;
  connect: (cwd: string) => Promise<unknown>;
}

export function useShellGitAndMessageActions({
  newTask,
  workspaceCwd,
  cwd,
  draftGit,
  git,
  settings,
  setDraftMode,
  refreshDraftGit,
  connect,
}: UseShellGitAndMessageActionsOptions) {
  const [editingMessage, setEditingMessage] = useState<{ messageId: string } | null>(null);
  const [commitDialog, setCommitDialog] = useState<{ push: boolean } | null>(null);
  const [gitPushing, setGitPushing] = useState(false);

  const editUserMessage = useCallback((message: UiMessage) => {
    const current = useAppStore.getState();
    if (current.isStreaming) {
      current.showToast("请等待当前回复完成后再编辑消息", "warning");
      return;
    }
    setEditingMessage({ messageId: message.id });
  }, []);

  const submitMessageEdit = useCallback(async (message: UiMessage, text: string) => {
    const current = useAppStore.getState();
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
    const current = useAppStore.getState();
    if (current.isStreaming) {
      current.showToast("请等待当前回复完成后再回退消息", "warning");
      return false;
    }
    if (clientContributions.hasRewindHandler()) {
      const handled = await clientContributions.tryHandleRewind(message);
      if (handled) setEditingMessage(null);
      return handled;
    }
    const inspected = await rewindController.inspectMessage(message.id);
    if (!inspected) {
      current.showToast("无法定位这条消息的会话检查点", "warning");
      return false;
    }
    const detail = inspected.changed
      ? `将回退此消息之后的对话，并将 ${inspected.files.length || 1} 个文件恢复到该消息发送前的快照状态。原消息会自动放回输入框供你修改重发。`
      : "将回退此消息之后的对话，并将原消息放回输入框供你重新编辑发送。已有对话分支仍可从会话树切回。";
    const accepted = await confirm(
      detail,
      { title: "回退消息并重新编辑？", kind: "warning", okLabel: "回退并编辑", cancelLabel: "取消" },
    );
    if (!accepted) return false;
    const outcome = await rewindController.performRewind({
      message,
      entryId: inspected.entryId,
      mode: "both",
      protectDraft: false,
    });
    if (outcome) setEditingMessage(null);
    return Boolean(outcome);
  }, []);

  const cancelMessageEdit = useCallback(() => setEditingMessage(null), []);

  const refreshReviewGit = useCallback(async () => {
    if (newTask) await refreshDraftGit();
    else await useAppStore.getState().refreshGit();
  }, [newTask, refreshDraftGit]);

  const restoreGitFiles = useCallback(async (paths?: string[]) => {
    const snapshot = newTask ? draftGit : useAppStore.getState().git;
    if (!workspaceCwd || !snapshot?.files.length) return;
    const targets = paths?.length ? paths : snapshot.files.map((file) => file.path);
    if (!targets.length) return;
    const label = targets.length === 1 ? targets[0] : `${targets.length} 个文件`;
    if (!window.confirm(`撤销对 ${label} 的本地更改？未提交的改动将丢失。`)) return;
    try {
      await agent.gitRestoreFiles(workspaceCwd, targets);
      await refreshReviewGit();
      useAppStore.getState().showToast("已撤销本地更改", "info");
    } catch (error) {
      useAppStore.getState().showToast(describeError(error), "error");
    }
  }, [draftGit, newTask, refreshReviewGit, workspaceCwd]);

  const requestReview = useCallback(async (target: CodeReviewScope = { mode: "uncommitted" }) => {
    if (settings?.reviewDelivery === "detached") {
      const current = useAppStore.getState();
      const workspace = current.cwd;
      current.prepareNewTask();
      if (workspace) await useAppStore.getState().connect(workspace);
    }
    const scope = target.mode === "base-branch"
      ? `审查当前分支相对于基线分支 ${target.baseBranch} 的代码更改。先运行 git merge-base HEAD ${target.baseBranch}，再检查从合并基点到 HEAD 的差异。`
      : "审查当前未提交的代码更改，包括已暂存、未暂存和未跟踪文件。";
    const sent = await useAppStore.getState().sendMessage([
      scope,
      "只报告由这些更改引入、作者明确会修复的离散问题，重点检查正确性、回归风险、安全性和缺失测试；按严重程度列出发现。没有可操作问题时请直接说明。",
      "需要定位到具体改动行的意见，请另起一行输出 ::code-comment{title=\"[P1] 简短标题\" body=\"问题、触发场景和修复方向\" file=\"相对或绝对文件路径\" start=行号 end=行号 priority=1}。正文保持普通 Markdown，不要输出 JSON。",
    ].join("\n\n"));
    if (sent) setDraftMode(false);
  }, [setDraftMode, settings?.reviewDelivery]);

  const openCommitDialog = useCallback((push: boolean) => {
    if (workspaceCwd) setCommitDialog({ push });
  }, [workspaceCwd]);

  const finishCommit = useCallback((outcome: CommitOutcome) => {
    setCommitDialog(null);
    const committed = `已提交 ${outcome.commit.shortSha}：${outcome.commit.subject}`;
    const push = outcome.push;
    if (push && "error" in push) {
      useAppStore.getState().showToast(`${committed}。推送失败：${push.error}`, "error");
    } else if (push) {
      useAppStore.getState().showToast(`${committed}，已推送到 ${push.result.remote}/${push.result.branch}`, "info");
    } else {
      useAppStore.getState().showToast(committed, "info");
    }
    void refreshReviewGit();
  }, [refreshReviewGit]);

  const pushCurrentBranch = useCallback(async () => {
    if (!workspaceCwd || gitPushing) return;
    setGitPushing(true);
    try {
      const result = await agent.gitPush(workspaceCwd);
      useAppStore.getState().showToast(
        result.setUpstream ? `已发布 ${result.branch} 到 ${result.remote}` : `已推送到 ${result.remote}/${result.branch}`,
        "info",
      );
    } catch (error) {
      useAppStore.getState().showToast(`推送失败：${describeError(error)}`, "error");
    } finally {
      setGitPushing(false);
      void refreshReviewGit();
    }
  }, [gitPushing, refreshReviewGit, workspaceCwd]);

  const newWorktreeChat = useCallback(async () => {
    if (!cwd) return;
    const worktree = await agent.createWorktree(cwd, git?.branch);
    window.localStorage.setItem("qianji:last-workspace", worktree.path);
    await connect(worktree.path);
  }, [connect, cwd, git?.branch]);

  return {
    editingMessage,
    setEditingMessage,
    commitDialog,
    setCommitDialog,
    gitPushing,
    editUserMessage,
    submitMessageEdit,
    rewindUserMessage,
    cancelMessageEdit,
    refreshReviewGit,
    restoreGitFiles,
    requestReview,
    openCommitDialog,
    finishCommit,
    pushCurrentBranch,
    newWorktreeChat,
  };
}
