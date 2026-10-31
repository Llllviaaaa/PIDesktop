/** The task list and navigating a session: archive, rewind, fork, the session tree, export. */
import { describeError } from "../lib/errors";
import { agent } from "../lib/agent";
import { buildPromptPayload, harnessRuntimes } from "../lib/harnessRuntime";
import { flattenSessionTree } from "../lib/sessionTree";
import type { GetState, SetState, StoreContext } from "./context";
import type { SessionsSlice } from "./types";

export function createSessionsSlice(set: SetState, get: GetState, ctx: StoreContext): SessionsSlice {
  return {
    sessions: [],
    sessionTree: [],
    sessionTreeLeafId: null,
    sessionTreeError: null,
    sessionTreeLoading: false,

    resolveMessageForkPoint: async (messageId) => {
      const state = get();
      const messageIndex = state.messages.findIndex((message) => message.id === messageId);
      const target = state.messages[messageIndex];
      if (messageIndex < 0 || target?.role !== "user" || !target.content.trim()) return null;
      if (target.entryId) return { entryId: target.entryId, text: target.content };
      try {
        const points = await harnessRuntimes.forkPoints(ctx.activeRuntime());
        const matches = points.filter((point) => point.text === target.content);
        const sameTextAfter = state.messages
          .slice(messageIndex + 1)
          .filter((message) => message.role === "user" && message.content === target.content)
          .length;
        return matches[matches.length - 1 - sameTextAfter] ?? null;
      } catch (error) {
        ctx.toast(describeError(error), "error");
        return null;
      }
    },

    rewindMessage: async (entryId) => {
      if (get().isStreaming) {
        ctx.toast("请等待当前回复完成后再回退消息", "warning");
        return false;
      }
      try {
        // The user can decline restoring the files; nothing changes then.
        if (!await harnessRuntimes.rewind(ctx.activeRuntime(), entryId)) return false;
        await ctx.syncSession();
        await get().refreshSessions();
        return true;
      } catch (error) {
        ctx.toast(describeError(error), "error");
        return false;
      }
    },

    editAndResend: async (entryId, text, attachments = []) => {
      if (get().isStreaming) {
        ctx.toast("请等待当前回复完成后再编辑消息", "warning");
        return false;
      }
      const payload = buildPromptPayload(text, attachments);
      if (!payload.message && payload.images.length === 0) return false;
      try {
        if (!await harnessRuntimes.rewind(ctx.activeRuntime(), entryId)) return false;
        await ctx.syncSession();
        await get().refreshSessions();
        return get().sendMessage(text, attachments);
      } catch (error) {
        ctx.toast(describeError(error), "error");
        return false;
      }
    },

    newSession: async () => {
      harnessRuntimes.newSession(ctx.activeRuntime());
      await ctx.syncSession();
      await get().refreshSessions();
    },

    cloneSession: async () => {
      await harnessRuntimes.clone(ctx.activeRuntime());
      await ctx.syncSession();
      await get().refreshSessions();
      ctx.toast("会话已克隆", "info");
    },

    forkLatest: async () => {
      const runtimeId = ctx.activeRuntime();
      const latest = (await harnessRuntimes.forkPoints(runtimeId)).at(-1);
      if (!latest) {
        ctx.toast("当前对话还没有可分叉的检查点", "warning");
        return;
      }
      await harnessRuntimes.fork(runtimeId, latest.entryId);
      await ctx.syncSession();
      await get().refreshSessions();
      await get().loadSessionTree();
      ctx.toast("已从最新检查点分叉对话", "info");
    },

    loadSessionTree: async () => {
      const runtimeId = get().runtimeId;
      if (!runtimeId || get().connection !== "running") {
        set({ sessionTree: [], sessionTreeLeafId: null, sessionTreeError: "需要已连接的会话才能查看会话树", sessionTreeLoading: false });
        return;
      }
      set({ sessionTreeLoading: true, sessionTreeError: null });
      try {
        const { tree, leafId } = await harnessRuntimes.tree(runtimeId);
        set({
          sessionTree: flattenSessionTree(tree, leafId),
          sessionTreeLeafId: leafId,
          sessionTreeError: null,
          sessionTreeLoading: false,
        });
      } catch (error) {
        const message = describeError(error);
        set({
          sessionTree: [],
          sessionTreeLeafId: null,
          sessionTreeError: message,
          sessionTreeLoading: false,
        });
      }
    },

    continueFromTreeNode: async (entryId: string) => {
      if (!entryId.trim()) {
        ctx.toast("无效的会话树节点", "warning");
        return;
      }
      if (get().isStreaming) {
        ctx.toast("请等待当前任务完成后再从此节点继续", "warning");
        return;
      }
      try {
        await harnessRuntimes.fork(ctx.activeRuntime(), entryId);
        await ctx.syncSession();
        await get().refreshSessions();
        await get().loadSessionTree();
        ctx.toast("已从此节点分叉并继续", "info");
      } catch (error) {
        ctx.toast(describeError(error), "error");
      }
    },

    exportSession: async (destination) => {
      const sessionFile = get().sessionFile;
      if (!sessionFile) throw new Error("当前任务还没有可导出的对话");
      const path = await agent.exportSessionMarkdown(sessionFile, destination);
      ctx.toast(`已导出到 ${path}`, "info");
      return path;
    },

    setSessionName: async (name) => {
      await harnessRuntimes.rename(ctx.activeRuntime(), name.trim());
      set({ sessionName: name.trim() || null });
      await get().refreshSessions();
    },

    refreshSessions: async () => {
      try {
        set({ sessions: await agent.listSessions() });
      } catch (error) {
        get().appendLog(`列出会话失败：${describeError(error)}`);
      }
    },
  };
}
