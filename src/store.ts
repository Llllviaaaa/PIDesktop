import { create } from "zustand";
import { pi, respondToExtension, sendCommand } from "./lib/pi";
import { redactSensitiveText } from "./lib/redact";
import { updateToolCall } from "./lib/piToolCalls";
import type { PiState, RuntimeState } from "./storeTypes";
import {
  appendManagedQueue,
  insertManagedQueueItem,
  moveManagedQueueItem,
  removeManagedQueueItem,
} from "./lib/managedQueue";
import {
  buildForkCommand,
  buildGetTreeCommand,
  flattenSessionTree,
  type SessionTreeNode,
} from "./lib/sessionTree";
import {
  agentBrowserFromMessages,
  agentBrowserFromResult,
  assistantToUi,
  attachForkPointsToUi,
  attachToolResult,
  buildPromptPayload,
  computerFromMessages,
  computerFromResult,
  imagesFromContent,
  messageId,
  mergeAssistantUi,
  messagesToUi,
  resultContent,
  resultDetails,
  stringifyResult,
  textFromContent,
} from "./lib/piMessages";
import type {
  AssistantMessage,
  ConnectionState,
  ExtensionUIRequest,
  ForkPoint,
  ManagedQueuedMessage,
  ModelInfo,
  SessionMessageTiming,
  SessionStats,
  Toast,
  ToolResultMessage,
  UiMessage,
  UiToolCall,
} from "./types";

const PIDESKTOP_REWIND_COMMAND = "pidesktop-rewind";
const PIDESKTOP_MODE_COMMAND = "pidesktop-mode";
const PIDESKTOP_PERMISSION_COMMAND = "pidesktop-permission";

export const usePiStore = create<PiState>((set, get) => {
  let pendingAssistantUpdate: {
    runtimeId: string;
    message?: AssistantMessage;
    textDelta: string;
    thinkingDelta: string;
    thinkingReplace?: string;
    toolCalls: UiToolCall[];
  } | null = null;
  let assistantUpdateTimer: number | null = null;
  let connectionVersion = 0;
  let pendingOptimisticPrompt: {
    runtimeId: string;
    userMessageId: string;
    assistantMessageId: string;
  } | null = null;
  let pendingModelChange: { runtimeId: string; promise: Promise<void> } | null = null;
  let queuedModelSelection: ModelInfo | null = null;
  let pendingConnection: { key: string; promise: Promise<void> } | null = null;
  const intentionalRuntimeStops = new Set<string>();
  const workspaceWarmups = new Map<string, Promise<void>>();
  let preferredWarmupKey = "";
  let activeTurnStartedAt: number | null = null;
  const managedFollowUpsByRuntime = new Map<string, ManagedQueuedMessage[]>();
  const managedDrainInFlight = new Set<string>();
  const suppressManagedDrainFor = new Set<string>();

  const workspaceKey = (cwd: string) => cwd.trim().replace(/[\\/]+$/, "").toLowerCase();

  const rollbackOptimisticPrompt = (runtimeId: string) => {
    const pending = pendingOptimisticPrompt;
    if (!pending || pending.runtimeId !== runtimeId) return;
    pendingOptimisticPrompt = null;
    set((state) => ({
      messages: state.messages.filter(
        (message) => message.id !== pending.userMessageId && message.id !== pending.assistantMessageId,
      ),
      isStreaming: false,
    }));
  };

  const settleOptimisticPrompt = (runtimeId: string) => {
    const pending = pendingOptimisticPrompt;
    if (!pending || pending.runtimeId !== runtimeId) return;
    pendingOptimisticPrompt = null;
    set((state) => ({
      messages: state.messages.filter((message) => message.id !== pending.assistantMessageId),
    }));
  };

  const clearPendingAssistantUpdate = (runtimeId?: string) => {
    if (runtimeId && pendingAssistantUpdate?.runtimeId !== runtimeId) return;
    if (assistantUpdateTimer !== null) window.clearTimeout(assistantUpdateTimer);
    assistantUpdateTimer = null;
    pendingAssistantUpdate = null;
  };

  const applyAssistantUpdate = (runtimeId: string, message: AssistantMessage) => {
    if (runtimeId !== get().runtimeId) return;
    const next = assistantToUi(message, true);
    set((state) => {
      const messages = [...state.messages];
      let index = messages.length - 1;
      while (index >= 0 && messages[index].role !== "assistant") index -= 1;
      if (index < 0 || !messages[index].isStreaming) {
        messages.push(next);
      } else {
        messages[index] = mergeAssistantUi(messages[index], next);
      }
      return { messages, isStreaming: true };
    });
  };

  const applyAssistantDelta = (pending: NonNullable<typeof pendingAssistantUpdate>) => {
    if (pending.runtimeId !== get().runtimeId) return;
    set((state) => {
      const messages = [...state.messages];
      let index = messages.length - 1;
      while (index >= 0 && messages[index].role !== "assistant") index -= 1;
      if (index < 0 || !messages[index].isStreaming) {
        messages.push({
          id: `stream-${Date.now()}`,
          role: "assistant",
          content: pending.textDelta,
          thinking: pending.thinkingReplace || pending.thinkingDelta || undefined,
          toolCalls: pending.toolCalls.length ? pending.toolCalls : undefined,
          isStreaming: true,
          timestamp: Date.now(),
        });
      } else {
        const previous = messages[index];
        const toolCalls = new Map((previous.toolCalls ?? []).map((call) => [call.id, { ...call }]));
        for (const call of pending.toolCalls) {
          toolCalls.set(call.id, { ...toolCalls.get(call.id), ...call });
        }
        messages[index] = {
          ...previous,
          content: previous.content + pending.textDelta,
          thinking: pending.thinkingReplace
            || `${previous.thinking ?? ""}${pending.thinkingDelta}`
            || undefined,
          toolCalls: toolCalls.size ? [...toolCalls.values()] : undefined,
          isStreaming: true,
        };
      }
      return { messages, isStreaming: true };
    });
  };

  const queueAssistantUpdate = (
    runtimeId: string,
    message: AssistantMessage | undefined,
    update: { type: string; delta?: string; content?: string; toolCall?: { id: string; name: string; arguments: Record<string, unknown> } },
  ) => {
    if (!pendingAssistantUpdate || pendingAssistantUpdate.runtimeId !== runtimeId) {
      pendingAssistantUpdate = { runtimeId, textDelta: "", thinkingDelta: "", toolCalls: [] };
    }
    if (message) pendingAssistantUpdate.message = message;
    const chunk = update.delta || (update.type.endsWith("_delta") && update.content) || "";
    if (update.type === "text_delta" && chunk) pendingAssistantUpdate.textDelta += chunk;
    if (update.type === "thinking_delta" && chunk) pendingAssistantUpdate.thinkingDelta += chunk;
    if (update.type === "thinking_end" && typeof update.content === "string" && update.content) {
      pendingAssistantUpdate.thinkingReplace = update.content;
    }
    if (update.type === "toolcall_end" && update.toolCall) {
      pendingAssistantUpdate.toolCalls.push({
        id: update.toolCall.id,
        name: update.toolCall.name,
        args: update.toolCall.arguments,
        running: true,
      });
    }
    if (assistantUpdateTimer !== null) return;
    assistantUpdateTimer = window.setTimeout(() => {
      const pending = pendingAssistantUpdate;
      assistantUpdateTimer = null;
      pendingAssistantUpdate = null;
      if (!pending) return;
      if (pending.message) applyAssistantUpdate(pending.runtimeId, pending.message);
      if (!pending.message) {
        applyAssistantDelta(pending);
        return;
      }
      if (pending.thinkingDelta || pending.thinkingReplace) {
        applyAssistantDelta({ ...pending, textDelta: "", toolCalls: [] });
      }
    }, 32);
  };

  const toast = (message: string, kind: Toast["kind"] = "info") => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const safeMessage = redactSensitiveText(message);
    let added = false;
    set((state) => {
      if (state.toasts.some((item) => item.kind === kind && item.message === safeMessage)) return state;
      added = true;
      return { toasts: [...state.toasts.slice(-3), { id, message: safeMessage, kind }] };
    });
    if (added) window.setTimeout(() => get().dismissToast(id), 5500);
  };

  const notify = (title: string, body: string, approval = false) => {
    const settings = get().settings;
    if (!settings?.notificationsEnabled) return;
    if (approval ? !settings.notifyOnApproval : !settings.notifyOnCompletion) return;
    if (settings.notifyOnlyWhenUnfocused && document.hasFocus()) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    new Notification(redactSensitiveText(title), { body: redactSensitiveText(body) });
  };

  const command = (
    name: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ) => {
    const runtimeId = get().runtimeId;
    if (!runtimeId) return Promise.reject(new Error("当前没有活动的 Pi 任务"));
    return sendCommand(runtimeId, name, payload, timeoutMs);
  };

  const updateRuntime = (runtimeId: string, patch: Partial<RuntimeState>) => {
    set((state) => {
      const current = state.runtimes[runtimeId];
      if (!current) return state;
      return {
        runtimes: {
          ...state.runtimes,
          [runtimeId]: { ...current, ...patch, updatedAt: Date.now() },
        },
      };
    });
  };

  const setManagedQueueForRuntime = (runtimeId: string, queue: ManagedQueuedMessage[]) => {
    if (queue.length > 0) managedFollowUpsByRuntime.set(runtimeId, queue);
    else managedFollowUpsByRuntime.delete(runtimeId);
    if (get().runtimeId === runtimeId) set({ managedFollowUpQueue: queue });
  };

  const drainManagedFollowUp = async (runtimeId: string) => {
    if (suppressManagedDrainFor.delete(runtimeId)) return;
    if (managedDrainInFlight.has(runtimeId)) return;
    const queue = managedFollowUpsByRuntime.get(runtimeId) ?? [];
    const next = queue[0];
    if (!next) return;

    managedDrainInFlight.add(runtimeId);
    setManagedQueueForRuntime(runtimeId, queue.slice(1));
    try {
      await sendCommand(runtimeId, "prompt", buildPromptPayload(next.text, next.attachments));
    } catch (error) {
      const current = managedFollowUpsByRuntime.get(runtimeId) ?? [];
      setManagedQueueForRuntime(runtimeId, insertManagedQueueItem(current, next, 0));
      if (get().runtimeId === runtimeId) {
        toast(`发送待处理消息失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    } finally {
      managedDrainInFlight.delete(runtimeId);
    }
  };

  const hydrateMessageForkPoints = async (runtimeId: string) => {
    try {
      const response = await sendCommand(runtimeId, "get_fork_messages");
      if (get().runtimeId !== runtimeId) return;
      const points = (response.data?.messages as ForkPoint[] | undefined) ?? [];
      set((state) => ({ messages: attachForkPointsToUi(state.messages, points) }));
    } catch {
      // Older Pi runtimes may not expose fork metadata; edit falls back to on-demand lookup.
    }
  };

  const syncSession = async (expectedVersion = connectionVersion) => {
    const runtimeId = get().runtimeId;
    if (!runtimeId) return;
    const stateRequest = sendCommand(runtimeId, "get_state");
    const historyRequest = sendCommand(runtimeId, "get_messages");
    const stateResponse = await stateRequest;
    const data = stateResponse.data;
    if (get().runtimeId !== runtimeId || expectedVersion !== connectionVersion) return;
    if (data) {
      set({
        sessionFile: data.sessionFile ?? null,
        sessionId: data.sessionId ?? null,
        sessionName: data.sessionName ?? null,
        isStreaming: data.isStreaming ?? false,
        isCompacting: data.isCompacting ?? false,
        thinkingLevel: data.thinkingLevel ?? get().thinkingLevel,
        model: data.model ?? null,
      });
    }

    const sessionFile = data?.sessionFile;
    const timingsRequest = sessionFile
      ? pi.sessionMessageTimings(sessionFile).catch(() => [] as SessionMessageTiming[])
      : Promise.resolve([] as SessionMessageTiming[]);
    const forkPointsRequest = sendCommand(runtimeId, "get_fork_messages").catch(() => null);
    if (sessionFile) {
      await pi.bindSession(runtimeId, sessionFile);
      if (get().runtimeId !== runtimeId || expectedVersion !== connectionVersion) return;
      set((state) => ({
        runtimes: {
          ...state.runtimes,
          [runtimeId]: { ...state.runtimes[runtimeId], sessionFile, updatedAt: Date.now() },
        },
      }));
    }

    const [history, timings, forkPointsResponse] = await Promise.all([
      historyRequest,
      timingsRequest,
      forkPointsRequest,
    ]);
    if (get().runtimeId !== runtimeId || expectedVersion !== connectionVersion) return;
    const restoredMessages = attachForkPointsToUi(
      messagesToUi(history.data?.messages ?? [], timings),
      (forkPointsResponse?.data?.messages as ForkPoint[] | undefined) ?? [],
    );
    set({
      messages: restoredMessages,
      agentBrowser: agentBrowserFromMessages(restoredMessages),
      computer: computerFromMessages(restoredMessages),
    });

    const [models, levels, commands] = await Promise.all([
      sendCommand(runtimeId, "get_available_models"),
      sendCommand(runtimeId, "get_available_thinking_levels"),
      sendCommand(runtimeId, "get_commands"),
    ]);
    if (get().runtimeId !== runtimeId || expectedVersion !== connectionVersion) return;
    set({
      availableModels: models.data?.models ?? [],
      availableThinkingLevels: levels.data?.levels ?? ["off"],
      commands: (commands.data?.commands ?? []).filter((item) => item.name !== PIDESKTOP_REWIND_COMMAND),
    });
    await refreshStats(expectedVersion);
  };

  const refreshStats = async (expectedVersion = connectionVersion) => {
    const runtimeId = get().runtimeId;
    if (!runtimeId) return;
    try {
      const response = await sendCommand(runtimeId, "get_session_stats");
      if (get().runtimeId !== runtimeId || expectedVersion !== connectionVersion) return;
      set({ stats: (response.data as unknown as SessionStats) ?? null });
    } catch {
      if (get().runtimeId === runtimeId && expectedVersion === connectionVersion) set({ stats: null });
    }
  };

  return {
    runtimeId: null,
    runtimes: {},
    connection: "disconnected",
    cwd: "",
    piLog: [],
    lastError: null,
    messages: [],
    sessionFile: null,
    sessionId: null,
    sessionName: null,
    isStreaming: false,
    isSwitchingModel: false,
    isCompacting: false,
    retryStatus: null,
    thinkingLevel: "medium",
    model: null,
    availableModels: [],
    availableThinkingLevels: [],
    commands: [],
    stats: null,
    steeringQueue: [],
    followUpQueue: [],
    managedFollowUpQueue: [],
    sessions: [],
    settings: null,
    git: null,
    agentBrowser: null,
    computer: null,
    terminal: { running: false, command: "", output: "", history: [] },
    extensionRequest: null,
    extensionStatuses: {},
    extensionWidgets: {},
    composerPrefill: null,
    toasts: [],
    sessionTree: [],
    sessionTreeLeafId: null,
    sessionTreeError: null,
    sessionTreeLoading: false,

    connect: async (cwd, sessionFile) => {
      if (sessionFile) queuedModelSelection = null;
      const requestKey = `${workspaceKey(cwd)}\u0000${sessionFile ?? ""}`;
      if (pendingConnection?.key === requestKey) return pendingConnection.promise;

      const request = (async () => {
        const connectVersion = ++connectionVersion;
        clearPendingAssistantUpdate();
        pendingOptimisticPrompt = null;
        activeTurnStartedAt = null;
        const localHistory = sessionFile ? pi.sessionHistory(sessionFile) : null;
        set({
          connection: "starting",
          cwd,
          messages: [],
          sessionFile: sessionFile ?? null,
          sessionId: null,
          sessionName: null,
          isStreaming: false,
          isCompacting: false,
          extensionRequest: null,
          agentBrowser: null,
          computer: null,
          git: null,
          lastError: null,
          managedFollowUpQueue: [],
        });
        if (localHistory) {
          void localHistory.then(({ messages: history, timings }) => {
            if (connectVersion !== connectionVersion) return;
            const restoredMessages = messagesToUi(history, timings);
            set({
              messages: restoredMessages,
              agentBrowser: agentBrowserFromMessages(restoredMessages),
              computer: computerFromMessages(restoredMessages),
            });
          }).catch(() => undefined);
        }
        try {
          const key = workspaceKey(cwd);
          preferredWarmupKey = key;
          const warmup = workspaceWarmups.get(key);
          if (warmup) await warmup;
          if (connectVersion !== connectionVersion) return;
          const started = await pi.start(cwd, sessionFile);
          if (connectVersion !== connectionVersion) {
            await pi.stop(started.runtimeId).catch(() => undefined);
            return;
          }
          const runtimeId = started.runtimeId;
          const existing = get().runtimes[runtimeId];
          set((state) => ({
            runtimeId,
            connection: "running",
            isStreaming: existing?.isStreaming ?? false,
            runtimes: {
              ...state.runtimes,
              [runtimeId]: {
                runtimeId,
                cwd,
                sessionFile: sessionFile ?? existing?.sessionFile ?? null,
                isStreaming: existing?.isStreaming ?? false,
                status: "running",
                extensionRequest: existing?.extensionRequest ?? null,
                updatedAt: Date.now(),
              },
            },
            extensionRequest: existing?.extensionRequest ?? null,
            managedFollowUpQueue: managedFollowUpsByRuntime.get(runtimeId) ?? [],
          }));
          if (sessionFile && !started.sessionLoaded) {
            await sendCommand(runtimeId, "switch_session", { sessionPath: sessionFile }, 60_000);
            if (connectVersion !== connectionVersion) return;
          }
          await syncSession(connectVersion);
          if (connectVersion !== connectionVersion) return;
          if (!sessionFile && queuedModelSelection) {
            const queued = queuedModelSelection;
            queuedModelSelection = null;
            try {
              await get().setModel(queued);
            } catch {
              // setModel reports the failure without invalidating an otherwise healthy runtime.
            }
            if (connectVersion !== connectionVersion) return;
          }
          await Promise.all([get().refreshSessions(), get().refreshGit()]);
        } catch (error) {
          if (connectVersion !== connectionVersion) return;
          const message = error instanceof Error ? error.message : String(error);
          set({ connection: "exited", lastError: message });
          get().appendLog(message);
          toast(message, "error");
        }
      })();

      pendingConnection = { key: requestKey, promise: request };
      try {
        await request;
      } finally {
        if (pendingConnection?.promise === request) pendingConnection = null;
      }
    },

    prewarmWorkspace: async (cwd) => {
      const key = workspaceKey(cwd);
      if (!key) return;
      preferredWarmupKey = key;
      const pending = workspaceWarmups.get(key);
      if (pending) return pending;
      const reusable = Object.values(get().runtimes).find((runtime) =>
        workspaceKey(runtime.cwd) === key
        && runtime.sessionFile === null
        && runtime.status === "running"
        && !runtime.isStreaming
        && !runtime.extensionRequest
      );
      if (reusable) return;

      const warmup = pi.start(cwd)
        .then((started) => {
          if (preferredWarmupKey !== key && started.runtimeId !== get().runtimeId) {
            return pi.stop(started.runtimeId).finally(() => {
              set((state) => {
                const runtimes = { ...state.runtimes };
                delete runtimes[started.runtimeId];
                return { runtimes };
              });
            });
          }
          const staleWarmups = Object.values(get().runtimes).filter((runtime) =>
            runtime.runtimeId !== started.runtimeId
            && runtime.runtimeId !== get().runtimeId
            && runtime.sessionFile === null
            && !runtime.isStreaming
            && !runtime.extensionRequest
          );
          set((state) => {
            const current = state.runtimes[started.runtimeId];
            return {
              runtimes: {
                ...state.runtimes,
                [started.runtimeId]: {
                  runtimeId: started.runtimeId,
                  cwd,
                  sessionFile: current?.sessionFile ?? null,
                  isStreaming: current?.isStreaming ?? false,
                  status: "running",
                  extensionRequest: current?.extensionRequest ?? null,
                  updatedAt: Date.now(),
                },
              },
            };
          });
          if (staleWarmups.length > 0) {
            void Promise.allSettled(staleWarmups.map((runtime) => pi.stop(runtime.runtimeId)))
              .then(() => {
                set((state) => {
                  const runtimes = { ...state.runtimes };
                  for (const runtime of staleWarmups) delete runtimes[runtime.runtimeId];
                  return { runtimes };
                });
              });
          }
        })
        .catch((error) => {
          get().appendLog(`Workspace prewarm skipped: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          if (workspaceWarmups.get(key) === warmup) workspaceWarmups.delete(key);
        });
      workspaceWarmups.set(key, warmup);
      return warmup;
    },

    restoreRuntimes: async (preferredRuntimeId) => {
      const restoreVersion = ++connectionVersion;
      try {
        const discovered = await pi.listRuntimes();
        if (restoreVersion !== connectionVersion) return false;
        const runtimes = Object.fromEntries(discovered.map((runtime) => [
          runtime.runtimeId,
          {
            runtimeId: runtime.runtimeId,
            cwd: runtime.cwd,
            sessionFile: runtime.sessionFile ?? null,
            isStreaming: runtime.isStreaming,
            status: "running" as ConnectionState,
            extensionRequest: runtime.pendingExtension ?? null,
            updatedAt: Date.now(),
          } satisfies RuntimeState,
        ]));
        set({ runtimes });

        const active = preferredRuntimeId
          ? discovered.find((runtime) => runtime.runtimeId === preferredRuntimeId)
          : undefined;
        if (!active) return false;

        set({
          runtimeId: active.runtimeId,
          connection: "running",
          cwd: active.cwd,
          sessionFile: active.sessionFile ?? null,
          isStreaming: active.isStreaming,
          extensionRequest: active.pendingExtension ?? null,
          managedFollowUpQueue: managedFollowUpsByRuntime.get(active.runtimeId) ?? [],
          lastError: null,
        });
        await syncSession(restoreVersion);
        if (restoreVersion !== connectionVersion) return false;
        await get().refreshGit();
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        get().appendLog(`恢复 Pi runtime 失败：${message}`);
        return false;
      }
    },

    switchSession: async (cwd, sessionFile) => {
      const current = get();
      if (current.sessionFile === sessionFile && current.connection === "running") return;
      await get().connect(cwd, sessionFile);
    },

    disconnect: async () => {
      connectionVersion += 1;
      pendingConnection = null;
      queuedModelSelection = null;
      clearPendingAssistantUpdate();
      pendingOptimisticPrompt = null;
      const runtimeId = get().runtimeId;
      if (runtimeId) {
        intentionalRuntimeStops.add(runtimeId);
        try {
          await pi.stop(runtimeId);
        } catch (error) {
          intentionalRuntimeStops.delete(runtimeId);
          throw error;
        }
        intentionalRuntimeStops.delete(runtimeId);
        managedFollowUpsByRuntime.delete(runtimeId);
        managedDrainInFlight.delete(runtimeId);
        suppressManagedDrainFor.delete(runtimeId);
      }
      set((state) => {
        const runtimes = { ...state.runtimes };
        if (runtimeId) delete runtimes[runtimeId];
        if (state.runtimeId !== runtimeId) return { runtimes };
        return {
          runtimeId: null,
          runtimes,
          connection: "disconnected",
          isStreaming: false,
          isSwitchingModel: false,
          messages: [],
          managedFollowUpQueue: [],
        };
      });
    },

    prepareNewTask: () => {
      connectionVersion += 1;
      pendingConnection = null;
      clearPendingAssistantUpdate();
      pendingOptimisticPrompt = null;
      set({
        runtimeId: null,
        connection: "disconnected",
        cwd: "",
        messages: [],
        sessionFile: null,
        sessionId: null,
        sessionName: null,
        isStreaming: false,
        isSwitchingModel: false,
        isCompacting: false,
        retryStatus: null,
        extensionRequest: null,
        agentBrowser: null,
        computer: null,
        extensionStatuses: {},
        extensionWidgets: {},
        steeringQueue: [],
        followUpQueue: [],
        managedFollowUpQueue: [],
        terminal: { running: false, command: "", output: "", history: [] },
        lastError: null,
        sessionTree: [],
        sessionTreeLeafId: null,
        sessionTreeError: null,
        sessionTreeLoading: false,
      });
    },

    handleEvent: (runtimeId, event) => {
      if (event.type === "agent_start") updateRuntime(runtimeId, { isStreaming: true });
      if (event.type === "agent_end" && !event.willRetry) updateRuntime(runtimeId, { isStreaming: false });
      if (event.type === "agent_settled") updateRuntime(runtimeId, { isStreaming: false });
      if (event.type === "agent_settled") queueMicrotask(() => void drainManagedFollowUp(runtimeId));
      if (event.type === "extension_ui_request") {
        const request = event as ExtensionUIRequest;
        if (!["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(request.method)) {
          updateRuntime(runtimeId, { extensionRequest: request });
        }
      }

      if (runtimeId !== get().runtimeId) {
        if (event.type === "agent_end" && !event.willRetry) {
          const runtime = get().runtimes[runtimeId];
          const project = runtime?.cwd.split(/[\\/]/).filter(Boolean).pop() || "后台任务";
          notify("Pi 后台任务已完成", project);
        }
        if (event.type === "agent_settled") void get().refreshSessions();
        if (event.type === "extension_ui_request") {
          const request = event as ExtensionUIRequest;
          if (!["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(request.method)) {
            notify("Pi 后台任务等待审批", ("title" in request && request.title) || "打开任务以处理审批。", true);
          }
        }
        return;
      }

      switch (event.type) {
        case "response":
          return;
        case "agent_start":
          set({ isStreaming: true, retryStatus: null });
          return;
        case "agent_end":
          if (!event.willRetry) {
            set({ isStreaming: false });
            if ((managedFollowUpsByRuntime.get(runtimeId) ?? []).length === 0) {
              notify("Pi 已完成", get().sessionName || "本地编码任务已完成，可以开始检查。" );
            }
          }
          return;
        case "agent_settled":
          settleOptimisticPrompt(runtimeId);
          activeTurnStartedAt = null;
          set({ isStreaming: false, retryStatus: null });
          void hydrateMessageForkPoints(runtimeId);
          void Promise.all([get().refreshSessions(), get().refreshGit(), refreshStats()]);
          return;
        case "message_start": {
          const message = event.message;
          if (message.role === "assistant") {
            clearPendingAssistantUpdate(runtimeId);
            const optimistic = pendingOptimisticPrompt?.runtimeId === runtimeId ? pendingOptimisticPrompt : null;
            const incoming = assistantToUi(message, true);
            set((state) => {
              if (!optimistic) return { messages: [...state.messages, incoming] };
              const messages = [...state.messages];
              const index = messages.findIndex((item) => item.id === optimistic.assistantMessageId);
              if (index >= 0) messages[index] = { ...incoming, id: optimistic.assistantMessageId };
              else messages.push(incoming);
              return { messages };
            });
            if (optimistic) pendingOptimisticPrompt = null;
          } else if (message.role === "user") {
            const optimistic = pendingOptimisticPrompt?.runtimeId === runtimeId ? pendingOptimisticPrompt : null;
            const incoming: UiMessage = {
              id: messageId(message),
              role: "user",
              content: textFromContent(message.content),
              images: imagesFromContent(message.content),
              timestamp: message.timestamp,
            };
            set((state) => {
              if (!optimistic) return { messages: [...state.messages, incoming] };
              const messages = [...state.messages];
              const index = messages.findIndex((item) => item.id === optimistic.userMessageId);
              if (index >= 0) messages[index] = { ...incoming, id: optimistic.userMessageId };
              else messages.push(incoming);
              return { messages };
            });
          }
          return;
        }
        case "message_update": {
          const message = event.message?.role === "assistant" ? event.message : undefined;
          queueAssistantUpdate(runtimeId, message, event.assistantMessageEvent);
          return;
        }
        case "message_end": {
          if (event.message.role === "assistant") {
            clearPendingAssistantUpdate(runtimeId);
            const durationMs = activeTurnStartedAt === null ? undefined : Date.now() - activeTurnStartedAt;
            const completed = assistantToUi(event.message, false, durationMs);
            set((state) => {
              const messages = [...state.messages];
              let index = messages.length - 1;
              while (index >= 0 && messages[index].role !== "assistant") index -= 1;
              if (index >= 0 && messages[index].isStreaming) {
                messages[index] = mergeAssistantUi(messages[index], completed);
              }
              return { messages };
            });
          } else if (event.message.role === "toolResult") {
            set((state) => {
              const messages = [...state.messages];
              attachToolResult(messages, event.message as ToolResultMessage);
              return { messages };
            });
          }
          return;
        }
        case "tool_execution_start":
          set((state) => ({
            messages: updateToolCall(state.messages, event.toolCallId, (call) => ({
              ...call,
              name: event.toolName,
              args: event.args,
              running: true,
              startedAt: Date.now(),
            }), event.toolName, event.args),
          }));
          return;
        case "tool_execution_update":
          set((state) => ({
            messages: updateToolCall(state.messages, event.toolCallId, (call) => ({
              ...call,
              running: true,
              result: stringifyResult(event.partialResult),
              images: imagesFromContent(resultContent(event.partialResult)),
              details: resultDetails(event.partialResult),
            }), event.toolName, event.args),
          }));
          return;
        case "tool_execution_end":
          set((state) => {
            const messages = updateToolCall(state.messages, event.toolCallId, (call) => ({
              ...call,
              running: false,
              result: stringifyResult(event.result),
              images: imagesFromContent(resultContent(event.result)),
              details: resultDetails(event.result),
              isError: event.isError,
              finishedAt: Date.now(),
            }), event.toolName);
            return {
              messages,
              agentBrowser: event.toolName.toLowerCase() === "browser"
                ? resultDetails(event.result)?.action === "close"
                  ? null
                  : agentBrowserFromResult(event.result, state.agentBrowser)
                : state.agentBrowser,
              computer: event.toolName.toLowerCase() === "computer"
                ? computerFromResult(event.result, state.computer)
                : state.computer,
            };
          });
          return;
        case "bash_execution_update":
          set((state) => ({
            terminal: {
              ...state.terminal,
              output: event.output ?? state.terminal.output + (event.delta ?? ""),
              running: event.done ? false : state.terminal.running,
              exitCode: event.exitCode ?? state.terminal.exitCode,
            },
          }));
          return;
        case "queue_update":
          set({ steeringQueue: event.steering, followUpQueue: event.followUp });
          return;
        case "compaction_start":
          set({ isCompacting: true });
          return;
        case "compaction_end":
          set({ isCompacting: false });
          if (event.errorMessage) toast(event.errorMessage, "error");
          return;
        case "auto_retry_start":
          set({ retryStatus: `${Math.ceil(event.delayMs / 1000)} 秒后重试 ${event.attempt}/${event.maxAttempts}` });
          return;
        case "auto_retry_end":
          set({ retryStatus: null });
          if (!event.success && event.finalError) toast(event.finalError, "error");
          return;
        case "extension_error":
          toast(event.error, "error");
          return;
        case "extension_ui_request": {
          const request = event as ExtensionUIRequest;
          if (request.method === "notify") {
            toast(request.message, request.notifyType ?? "info");
          } else if (request.method === "setStatus") {
            set((state) => {
              const statuses = { ...state.extensionStatuses };
              if (request.statusText) statuses[request.statusKey] = request.statusText;
              else delete statuses[request.statusKey];
              return { extensionStatuses: statuses };
            });
          } else if (request.method === "setWidget") {
            set((state) => {
              const widgets = { ...state.extensionWidgets };
              if (request.widgetLines) widgets[request.widgetKey] = request.widgetLines;
              else delete widgets[request.widgetKey];
              return { extensionWidgets: widgets };
            });
          } else if (request.method === "setTitle") {
            document.title = request.title;
          } else if (request.method === "set_editor_text") {
            set({ composerPrefill: request.text });
          } else {
            set({ extensionRequest: request });
            notify("Pi 需要审批", request.title || "有一项本地操作正在等待你的决定。", true);
          }
          return;
        }
        default:
          get().appendLog(`event: ${JSON.stringify(event).slice(0, 800)}`);
      }
    },

    handleStatus: (status) => {
      const runtimeId = status.runtimeId;
      const intentionalStop = status.status === "exited" && intentionalRuntimeStops.delete(runtimeId);
      set((state) => {
        if (status.status === "exited") {
          const runtimes = { ...state.runtimes };
          delete runtimes[runtimeId];
          return { runtimes };
        }
        const current = state.runtimes[runtimeId];
        const nextStatus = status.status === "running" ? "running" : "starting";
        return {
          runtimes: {
            ...state.runtimes,
            [runtimeId]: {
              runtimeId,
              cwd: status.cwd || current?.cwd || "",
              sessionFile: current?.sessionFile ?? null,
              isStreaming: current?.isStreaming ?? false,
              status: nextStatus,
              extensionRequest: current?.extensionRequest ?? null,
              updatedAt: Date.now(),
            },
          },
        };
      });
      if (runtimeId !== get().runtimeId) return;
      if (status.status === "running") set({ connection: "running" });
      if (status.status === "exited") {
        if (intentionalStop) return;
        set({ connection: "exited", isStreaming: false });
        if (status.code && status.code !== 0) toast(`Pi 已退出，代码 ${status.code}`, "error");
      }
    },

    handleLog: (runtimeId, line) => {
      if (runtimeId === get().runtimeId) get().appendLog(line);
    },

    appendLog: (line) => set((state) => ({ piLog: [...state.piLog.slice(-399), redactSensitiveText(line)] })),

    resolveMessageForkPoint: async (messageId) => {
      const state = get();
      const messageIndex = state.messages.findIndex((message) => message.id === messageId);
      const target = state.messages[messageIndex];
      if (messageIndex < 0 || target?.role !== "user" || !target.content.trim()) return null;
      if (target.entryId) return { entryId: target.entryId, text: target.content };
      try {
        const response = await command("get_fork_messages");
        const points = (response.data?.messages as ForkPoint[] | undefined) ?? [];
        const matches = points.filter((point) => point.text === target.content);
        const sameTextAfter = state.messages
          .slice(messageIndex + 1)
          .filter((message) => message.role === "user" && message.content === target.content)
          .length;
        return matches[matches.length - 1 - sameTextAfter] ?? null;
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), "error");
        return null;
      }
    },

    editAndResend: async (entryId, text, attachments = []) => {
      if (get().isStreaming) {
        toast("请等待当前回复完成后再编辑消息", "warning");
        return false;
      }
      const payload = buildPromptPayload(text, attachments);
      if (!payload.message && payload.images.length === 0) return false;
      try {
        const commandsResponse = await command("get_commands");
        const rewindAvailable = (commandsResponse.data?.commands ?? [])
          .some((item) => item.name === PIDESKTOP_REWIND_COMMAND);
        if (!rewindAvailable) throw new Error("消息回退组件尚未加载，请重启当前任务后再试");

        await command("prompt", { message: `/${PIDESKTOP_REWIND_COMMAND} ${entryId}` }, 60_000);
        await syncSession();
        await get().refreshSessions();
        return get().sendMessage(text, attachments);
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), "error");
        return false;
      }
    },

    sendMessage: async (text, attachments = [], behavior) => {
      const payload = buildPromptPayload(text, attachments);
      if (!payload.message && payload.images.length === 0) return false;
      const initialRuntimeId = get().runtimeId;
      const modelChange = pendingModelChange?.runtimeId === initialRuntimeId
        ? pendingModelChange.promise
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
        toast("当前没有活动的 Pi 任务", "error");
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
        const queue = managedFollowUpsByRuntime.get(runtimeId) ?? [];
        setManagedQueueForRuntime(runtimeId, appendManagedQueue(queue, item));
        return true;
      }
      const optimistic = !wasStreaming && !payload.message.startsWith("/");
      if (!wasStreaming) activeTurnStartedAt = Date.now();
      if (optimistic) {
        const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        pendingOptimisticPrompt = {
          runtimeId,
          userMessageId: `optimistic-user-${nonce}`,
          assistantMessageId: `optimistic-assistant-${nonce}`,
        };
        const pending = pendingOptimisticPrompt;
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
          const commandName = behavior === "followUp" ? "follow_up" : "steer";
          await command(commandName, payload);
        } else {
          await command("prompt", payload);
        }
        return true;
      } catch (error) {
        if (optimistic) rollbackOptimisticPrompt(runtimeId);
        if (!wasStreaming) activeTurnStartedAt = null;
        toast(error instanceof Error ? error.message : String(error), "error");
        return false;
      }
    },

    removeManagedFollowUp: (id) => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) return;
      const current = managedFollowUpsByRuntime.get(runtimeId) ?? [];
      setManagedQueueForRuntime(runtimeId, removeManagedQueueItem(current, id).queue);
    },

    moveManagedFollowUp: (id, direction) => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) return;
      const current = managedFollowUpsByRuntime.get(runtimeId) ?? [];
      setManagedQueueForRuntime(runtimeId, moveManagedQueueItem(current, id, direction));
    },

    steerManagedFollowUp: async (id) => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) return;
      const current = managedFollowUpsByRuntime.get(runtimeId) ?? [];
      const removed = removeManagedQueueItem(current, id);
      if (!removed.item) return;
      setManagedQueueForRuntime(runtimeId, removed.queue);
      const sent = await get().sendMessage(removed.item.text, removed.item.attachments, "steer");
      if (!sent) {
        const latest = managedFollowUpsByRuntime.get(runtimeId) ?? [];
        setManagedQueueForRuntime(runtimeId, insertManagedQueueItem(latest, removed.item, removed.index));
      }
    },

    abort: async () => {
      const runtimeId = get().runtimeId;
      if (runtimeId) suppressManagedDrainFor.add(runtimeId);
      try {
        await command("abort");
      } catch (error) {
        if (runtimeId) suppressManagedDrainFor.delete(runtimeId);
        throw error;
      } finally {
        if (runtimeId) settleOptimisticPrompt(runtimeId);
        set({ isStreaming: false });
      }
    },

    newSession: async () => {
      const response = await command("new_session");
      if (!response.data?.cancelled) {
        await syncSession();
        await get().refreshSessions();
      }
    },

    cloneSession: async () => {
      const response = await command("clone", {}, 60_000);
      if (!response.data?.cancelled) {
        await syncSession();
        await get().refreshSessions();
        toast("会话已克隆", "info");
      }
    },

    forkLatest: async () => {
      const points = await command("get_fork_messages");
      const messages = points.data?.messages as Array<{ entryId: string; text: string }> | undefined;
      const latest = messages?.[messages.length - 1];
      if (!latest) {
        toast("当前对话还没有可分叉的检查点", "warning");
        return;
      }
      const response = await command("fork", { entryId: latest.entryId }, 60_000);
      if (!response.data?.cancelled) {
        await syncSession();
        await get().refreshSessions();
        await get().loadSessionTree();
        toast("已从最新检查点分叉对话", "info");
      }
    },

    loadSessionTree: async () => {
      const runtimeId = get().runtimeId;
      if (!runtimeId || get().connection !== "running") {
        set({ sessionTree: [], sessionTreeLeafId: null, sessionTreeError: "需要已连接的 Pi 会话才能查看会话树", sessionTreeLoading: false });
        return;
      }
      set({ sessionTreeLoading: true, sessionTreeError: null });
      try {
        const treeCommand = buildGetTreeCommand();
        const response = await command(treeCommand.type, {}, 60_000);
        const tree = (response.data?.tree as SessionTreeNode[] | undefined) ?? [];
        const leafId = typeof response.data?.leafId === "string" ? response.data.leafId : null;
        set({
          sessionTree: flattenSessionTree(tree, leafId),
          sessionTreeLeafId: leafId,
          sessionTreeError: null,
          sessionTreeLoading: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({
          sessionTree: [],
          sessionTreeLeafId: null,
          sessionTreeError: message.includes("get_tree") || message.toLowerCase().includes("unknown")
            ? "当前 Pi 运行时未暴露 get_tree；请升级 Pi 或使用检查点分叉。"
            : message,
          sessionTreeLoading: false,
        });
      }
    },

    continueFromTreeNode: async (entryId: string) => {
      if (!entryId.trim()) {
        toast("无效的会话树节点", "warning");
        return;
      }
      if (get().isStreaming) {
        toast("请等待当前任务完成后再从此节点继续", "warning");
        return;
      }
      try {
        const forkCommand = buildForkCommand(entryId);
        const response = await command(forkCommand.type, { entryId: forkCommand.entryId }, 60_000);
        if (response.data?.cancelled) {
          toast("分叉已被取消", "warning");
          return;
        }
        await syncSession();
        await get().refreshSessions();
        await get().loadSessionTree();
        toast("已从此节点分叉并继续", "info");
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), "error");
      }
    },

    compact: async () => {
      set({ isCompacting: true });
      try {
        await command("compact", {}, 10 * 60_000);
        await refreshStats();
      } finally {
        set({ isCompacting: false });
      }
    },

    exportSession: async () => {
      const response = await command("export_html", {}, 60_000);
      const path = typeof response.data?.path === "string" ? response.data.path : null;
      if (path) toast(`已导出到 ${path}`, "info");
      return path;
    },

    setModel: async (model) => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) {
        queuedModelSelection = model;
        set({ model });
        return;
      }

      const previous = pendingModelChange?.runtimeId === runtimeId
        ? pendingModelChange.promise.catch(() => undefined)
        : Promise.resolve();
      const change = previous.then(async () => {
        if (get().runtimeId !== runtimeId) throw new Error("当前任务已切换，请重新选择模型");
        const response = await sendCommand(runtimeId, "set_model", {
          provider: model.provider,
          modelId: model.id,
        });
        const returned = response.data as unknown as ModelInfo | undefined;
        if (returned && (returned.provider !== model.provider || returned.id !== model.id)) {
          throw new Error(`Pi 返回了不同的模型：${returned.provider}/${returned.id}`);
        }

        const stateResponse = await sendCommand(runtimeId, "get_state");
        const confirmed = stateResponse.data?.model;
        if (!confirmed || confirmed.provider !== model.provider || confirmed.id !== model.id) {
          const actual = confirmed ? `${confirmed.provider}/${confirmed.id}` : "未知";
          throw new Error(`Pi 未应用所选模型，当前仍为 ${actual}`);
        }
        if (get().runtimeId !== runtimeId) throw new Error("当前任务已切换，请重新选择模型");

        const levels = await sendCommand(runtimeId, "get_available_thinking_levels");
        if (get().runtimeId !== runtimeId) throw new Error("当前任务已切换，请重新选择模型");
        set({
          model: confirmed,
          availableThinkingLevels: levels.data?.levels ?? ["off"],
        });
      });

      pendingModelChange = { runtimeId, promise: change };
      // Reflect the click immediately while Pi confirms it in the background.
      // A failed command is rolled back to the runtime's reported model below.
      if (get().runtimeId === runtimeId) set({ model, isSwitchingModel: true });
      try {
        await change;
      } catch (error) {
        if (get().runtimeId === runtimeId) {
          try {
            const stateResponse = await sendCommand(runtimeId, "get_state");
            if (get().runtimeId === runtimeId) set({ model: stateResponse.data?.model ?? null });
          } catch {
            // Keep the last confirmed UI value when the runtime cannot be queried.
          }
          toast(`切换模型失败：${error instanceof Error ? error.message : String(error)}`, "error");
        }
        throw error;
      } finally {
        if (pendingModelChange?.promise === change) {
          pendingModelChange = null;
          if (get().runtimeId === runtimeId) set({ isSwitchingModel: false });
        }
      }
    },

    setThinkingLevel: async (level) => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) throw new Error("当前没有活动的 Pi 任务");
      const modelChange = pendingModelChange?.runtimeId === runtimeId
        ? pendingModelChange.promise
        : null;
      if (modelChange) await modelChange;
      if (get().runtimeId !== runtimeId) throw new Error("当前任务已切换，请重新设置推理等级");
      await sendCommand(runtimeId, "set_thinking_level", { level });
      set({ thinkingLevel: level });
    },

    setRuntimeAgentMode: async (mode) => {
      if (!get().runtimeId) return;
      await command("prompt", { message: `/${PIDESKTOP_MODE_COMMAND} ${mode}` }, 30_000);
    },

    setRuntimePermissionMode: async (mode) => {
      if (!get().runtimeId) return;
      await command("prompt", { message: `/${PIDESKTOP_PERMISSION_COMMAND} ${mode}` }, 30_000);
    },

    setSessionName: async (name) => {
      await command("set_session_name", { name: name.trim() });
      set({ sessionName: name.trim() || null });
      await get().refreshSessions();
    },

    refreshSessions: async () => {
      try {
        set({ sessions: await pi.listSessions() });
      } catch (error) {
        get().appendLog(`列出会话失败：${String(error)}`);
      }
    },

    refreshGit: async () => {
      const cwd = get().cwd;
      if (!cwd) return;
      try {
        set({ git: await pi.gitSnapshot(cwd) });
      } catch (error) {
        get().appendLog(`读取 Git 更改失败：${String(error)}`);
      }
    },

    loadSettings: async () => {
      try {
        set({ settings: await pi.getSettings() });
      } catch (error) {
        toast(`加载设置失败：${String(error)}`, "error");
      }
    },

    saveSettings: async (settings) => {
      await pi.setSettings(settings);
      set({ settings: await pi.getSettings() });
    },

    runBash: async (shellCommand, excludeFromContext = false) => {
      const trimmed = shellCommand.trim();
      if (!trimmed || get().terminal.running) return;
      set((state) => ({
        terminal: {
          running: true,
          command: trimmed,
          output: "",
          history: state.terminal.command
            ? [...state.terminal.history, {
                command: state.terminal.command,
                output: state.terminal.output,
                exitCode: state.terminal.exitCode,
              }].slice(-100)
            : state.terminal.history,
        },
      }));
      try {
        const response = await command("bash", { command: trimmed, excludeFromContext }, 60 * 60_000);
        set((state) => ({
          terminal: {
            ...state.terminal,
            running: false,
            output: typeof response.data?.output === "string" ? response.data.output : state.terminal.output,
            exitCode: typeof response.data?.exitCode === "number" ? response.data.exitCode : undefined,
          },
        }));
      } catch (error) {
        set((state) => ({
          terminal: { ...state.terminal, running: false, output: `${state.terminal.output}\n${String(error)}` },
        }));
      }
    },

    abortBash: async () => {
      await command("abort_bash");
      set((state) => ({ terminal: { ...state.terminal, running: false } }));
    },

    resetTerminal: () => {
      if (get().terminal.running) return;
      set({ terminal: { running: false, command: "", output: "", history: [] } });
    },

    answerExtension: async (response) => {
      const request = get().extensionRequest;
      const runtimeId = get().runtimeId;
      if (!request || !runtimeId) return;
      set({ extensionRequest: null });
      updateRuntime(runtimeId, { extensionRequest: null });
      await respondToExtension(runtimeId, request, response);
    },

    showToast: toast,
    clearComposerPrefill: () => set({ composerPrefill: null }),
    dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
  };
});
