/** The conversation: the Host's transcript events, sending, queued messages, aborting, compacting. */
import { describeError } from "../lib/errors";
import { buildPromptPayload, harnessRuntimes } from "../lib/harnessRuntime";
import { appendManagedQueue, insertManagedQueueItem, moveManagedQueueItem, removeManagedQueueItem } from "../lib/managedQueue";
import { completionNotification, isSilentUiRequest, uiRequestNotification } from "../lib/eventNotifications";
import { agentBrowserFromResult, computerFromResult, isGrokBrowserTool, isGrokComputerTool } from "../lib/toolPanels";
import { completeAssistant, endToolCall, interruptTurn, replaceOrAppend, startAssistant, startToolCall } from "../lib/transcript";
import type { ManagedQueuedMessage } from "../types";
import type { GetState, SetState, StoreContext } from "./context";
import type { TranscriptSlice } from "./types";

export function createTranscriptSlice(set: SetState, get: GetState, ctx: StoreContext): TranscriptSlice {
  return {
    messages: [],
    isStreaming: false,
    isCompacting: false,
    retryStatus: null,
    steeringQueue: [],
    followUpQueue: [],
    managedFollowUpQueue: [],
    agentBrowser: null,
    computer: null,
    terminal: { running: false, command: "", output: "", history: [] },
    extensionWidgets: {},
    handleEvent: (runtimeId, event) => {
      if (event.type === "turn-start") ctx.updateRuntime(runtimeId, { isStreaming: true });
      if (event.type === "turn-end") {
        ctx.updateRuntime(runtimeId, { isStreaming: false });
        queueMicrotask(() => void ctx.drainManagedFollowUp(runtimeId));
      }
      if (event.type === "ui-request" && !isSilentUiRequest(event.request.method)) {
        ctx.updateRuntime(runtimeId, { extensionRequest: event.request });
      }

      // A task in the background only notifies.
      if (runtimeId !== get().runtimeId) {
        const runtime = get().runtimes[runtimeId];
        const context = { cwd: runtime?.cwd ?? "", sessionFile: runtime?.sessionFile ?? null };
        if (event.type === "turn-end") {
          ctx.raise(completionNotification(runtimeId, context, true));
          void get().refreshSessions();
        }
        if (event.type === "ui-request") ctx.raise(uiRequestNotification(runtimeId, event.request, context, true));
        return;
      }

      switch (event.type) {
        case "turn-start":
          set({ isStreaming: true, retryStatus: null });
          return;
        case "turn-end":
          ctx.settleOptimisticPrompt(runtimeId);
          ctx.activeTurnStartedAt = null;
          set({ isStreaming: false, retryStatus: null });
          if ((ctx.managedFollowUpsByRuntime.get(runtimeId) ?? []).length === 0) {
            ctx.raise(completionNotification(runtimeId, {
              cwd: get().cwd,
              sessionFile: get().sessionFile,
              sessionName: get().sessionName,
            }, false));
          }
          void Promise.all([get().refreshSessions(), get().refreshGit(), ctx.refreshStats()]);
          return;
        case "turn-interrupted":
          ctx.flushAssistantDelta();
          set((state) => ({ messages: interruptTurn(state.messages) }));
          return;
        case "user": {
          // The message the composer showed at once becomes the recorded one.
          const optimistic = ctx.pendingOptimisticPrompt?.runtimeId === runtimeId ? ctx.pendingOptimisticPrompt : null;
          set((state) => ({ messages: replaceOrAppend(state.messages, optimistic?.userMessageId, event.message) }));
          return;
        }
        case "assistant-start": {
          ctx.clearPendingAssistantUpdate(runtimeId);
          // The composer's placeholder reply, if there is one, is the reply being streamed.
          set((state) => ({ messages: startAssistant(state.messages) }));
          if (ctx.pendingOptimisticPrompt?.runtimeId === runtimeId) ctx.pendingOptimisticPrompt = null;
          return;
        }
        case "assistant-delta":
          ctx.queueAssistantDelta(runtimeId, { text: event.text, thinking: event.thinking });
          return;
        case "assistant-tool-calls":
          ctx.queueAssistantDelta(runtimeId, { toolCalls: event.calls });
          return;
        case "assistant": {
          ctx.clearPendingAssistantUpdate(runtimeId);
          const durationMs = ctx.activeTurnStartedAt === null ? undefined : Date.now() - ctx.activeTurnStartedAt;
          set((state) => ({ messages: completeAssistant(state.messages, { ...event.message, durationMs }) }));
          return;
        }
        case "tool-start":
          set((state) => ({ messages: startToolCall(state.messages, event.callId, event.name, event.args) }));
          return;
        case "tool-end":
          set((state) => ({
            messages: endToolCall(state.messages, event.callId, event.name, event.result),
            agentBrowser: isGrokBrowserTool(event.name) ? agentBrowserFromResult(event.result, state.agentBrowser) : state.agentBrowser,
            computer: isGrokComputerTool(event.name) ? computerFromResult(event.result, state.computer) : state.computer,
          }));
          return;
        case "queue":
          set({ steeringQueue: Array(event.steering).fill(""), followUpQueue: Array(event.followUp).fill("") });
          return;
        case "compaction-start":
          set({ isCompacting: true });
          return;
        case "compaction-end":
          set({ isCompacting: false });
          if (event.failed) ctx.toast("上下文压缩失败", "error");
          return;
        case "plan":
          set((state) => {
            const widgets = { ...state.extensionWidgets };
            if (event.lines.length > 0) widgets["pidesktop-plan"] = event.lines;
            else delete widgets["pidesktop-plan"];
            return { extensionWidgets: widgets };
          });
          return;
        case "ui-request": {
          const request = event.request;
          if (request.method === "notify") {
            ctx.toast(request.message, request.notifyType ?? "info");
            return;
          }
          set({ extensionRequest: request });
          ctx.raise(uiRequestNotification(runtimeId, request, {
            cwd: get().cwd,
            sessionFile: get().sessionFile,
          }, false));
          return;
        }
      }
    },

    sendMessage: async (text, attachments = [], behavior) => {
      const payload = buildPromptPayload(text, attachments);
      if (!payload.message && payload.images.length === 0) return false;
      // connect() marks the runtime as running before it has applied the picked model;
      // a prompt sent in that gap would be answered by the runtime's default model.
      if (ctx.pendingConnection && (ctx.queuedModelSelection || ctx.queuedThinkingLevel)) {
        await ctx.pendingConnection.promise.catch(() => undefined);
      }
      const initialRuntimeId = get().runtimeId;
      const modelChange = ctx.pendingModelChange?.runtimeId === initialRuntimeId
        ? ctx.pendingModelChange.promise
        : null;
      if (modelChange) {
        try {
          await modelChange;
        } catch {
          return false;
        }
      }
      const runtimeId = get().runtimeId;
      if (!runtimeId) {
        ctx.toast("当前没有活动的任务", "error");
        return false;
      }
      const wasStreaming = get().isStreaming;
      if (wasStreaming && behavior === "followUp") {
        const item: ManagedQueuedMessage = {
          id: typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          text: payload.message,
          attachments: attachments.map((attachment) => ({ ...attachment })),
          createdAt: Date.now(),
        };
        const queue = ctx.managedFollowUpsByRuntime.get(runtimeId) ?? [];
        ctx.setManagedQueueForRuntime(runtimeId, appendManagedQueue(queue, item));
        return true;
      }
      const optimistic = !wasStreaming && !payload.message.startsWith("/");
      if (!wasStreaming) ctx.activeTurnStartedAt = Date.now();
      if (optimistic) {
        const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        ctx.pendingOptimisticPrompt = {
          runtimeId,
          userMessageId: `optimistic-user-${nonce}`,
          assistantMessageId: `optimistic-assistant-${nonce}`,
        };
        const pending = ctx.pendingOptimisticPrompt;
        set((state) => ({
          messages: [
            ...state.messages,
            {
              id: pending.userMessageId,
              role: "user",
              content: payload.message,
              images: payload.images.length
                ? payload.images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }))
                : undefined,
              timestamp: Date.now(),
            },
            {
              id: pending.assistantMessageId,
              role: "assistant",
              content: "",
              isStreaming: true,
              timestamp: Date.now(),
            },
          ],
          isStreaming: true,
        }));
      }
      try {
        if (wasStreaming) {
          await harnessRuntimes.queue(runtimeId, behavior === "followUp" ? "followUp" : "steer", payload);
        } else {
          await harnessRuntimes.prompt(runtimeId, payload);
          ctx.recordStartedSession(runtimeId);
          // The task has started: its model and thinking level now live in the runtime.
          ctx.queuedModelSelection = null;
          ctx.queuedThinkingLevel = null;
        }
        return true;
      } catch (error) {
        if (optimistic) ctx.rollbackOptimisticPrompt(runtimeId);
        if (!wasStreaming) ctx.activeTurnStartedAt = null;
        ctx.toast(describeError(error), "error");
        return false;
      }
    },

    removeManagedFollowUp: (id) => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) return;
      const current = ctx.managedFollowUpsByRuntime.get(runtimeId) ?? [];
      ctx.setManagedQueueForRuntime(runtimeId, removeManagedQueueItem(current, id).queue);
    },

    moveManagedFollowUp: (id, direction) => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) return;
      const current = ctx.managedFollowUpsByRuntime.get(runtimeId) ?? [];
      ctx.setManagedQueueForRuntime(runtimeId, moveManagedQueueItem(current, id, direction));
    },

    steerManagedFollowUp: async (id) => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) return;
      const current = ctx.managedFollowUpsByRuntime.get(runtimeId) ?? [];
      const removed = removeManagedQueueItem(current, id);
      if (!removed.item) return;
      ctx.setManagedQueueForRuntime(runtimeId, removed.queue);
      const sent = await get().sendMessage(removed.item.text, removed.item.attachments, "steer");
      if (!sent) {
        const latest = ctx.managedFollowUpsByRuntime.get(runtimeId) ?? [];
        ctx.setManagedQueueForRuntime(runtimeId, insertManagedQueueItem(latest, removed.item, removed.index));
      }
    },

    abort: async () => {
      const runtimeId = get().runtimeId;
      if (runtimeId) ctx.suppressManagedDrainFor.add(runtimeId);
      try {
        await harnessRuntimes.abort(ctx.activeRuntime());
      } catch (error) {
        if (runtimeId) ctx.suppressManagedDrainFor.delete(runtimeId);
        throw error;
      } finally {
        if (runtimeId) ctx.settleOptimisticPrompt(runtimeId);
        set({ isStreaming: false });
      }
    },

    compact: async () => {
      set({ isCompacting: true });
      try {
        await harnessRuntimes.compact(ctx.activeRuntime());
        await ctx.refreshStats();
      } finally {
        set({ isCompacting: false });
      }
    },
  };
}
