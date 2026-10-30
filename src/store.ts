import { create } from "zustand";
import { describeError } from "./lib/errors";
import { pi, respondToExtension } from "./lib/pi";
import { buildPromptPayload, harnessRuntimes } from "./lib/harnessRuntime";
import { redactSensitiveText } from "./lib/redact";
import { readStoredNotifications } from "./lib/notificationCenter";
import { createNotices } from "./notifications";
import type { PiState, RuntimeState } from "./storeTypes";
import {
  appendManagedQueue,
  insertManagedQueueItem,
  moveManagedQueueItem,
  removeManagedQueueItem,
} from "./lib/managedQueue";
import { persistModelCatalog, readStoredModelCatalog } from "./lib/modelCatalogCache";
import { sameLocalPath } from "./lib/pathIdentity";
import {
  completionNotification,
  isSilentUiRequest,
  uiRequestNotification,
} from "./lib/eventNotifications";
import { flattenSessionTree } from "./lib/sessionTree";
import {
  agentBrowserFromMessages,
  agentBrowserFromResult,
  computerFromMessages,
  computerFromResult,
  isGrokBrowserTool,
  isGrokComputerTool,
} from "./lib/toolPanels";
import {
  completeAssistant,
  endToolCall,
  replaceOrAppend,
  startAssistant,
  startToolCall,
  streamAssistant,
} from "./lib/transcript";
import type {
  AppSettings,
  ManagedQueuedMessage,
  ModelInfo,
  UiToolCall,
} from "./types";

const WEB_SETTINGS_KEY = "pid-desktop:settings:v1";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function readWebSettings(): AppSettings | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(WEB_SETTINGS_KEY) || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as AppSettings : null;
  } catch {
    return null;
  }
}

const cachedModelCatalog = readStoredModelCatalog();

export const usePiStore = create<PiState>((set, get) => {
  /** Streamed text, thinking and tool calls not drawn yet; applied together every 32 ms. */
  let pendingAssistantUpdate: { runtimeId: string; text: string; thinking: string; toolCalls: UiToolCall[] } | null = null;
  let assistantUpdateTimer: number | null = null;
  let connectionVersion = 0;
  let pendingOptimisticPrompt: {
    runtimeId: string;
    userMessageId: string;
    assistantMessageId: string;
  } | null = null;
  let pendingModelChange: { runtimeId: string; promise: Promise<void> } | null = null;
  // What the user picked for a task that has not started yet. connect() applies them to
  // every runtime that task lands on; the first prompt hands them over to the runtime.
  let queuedModelSelection: ModelInfo | null = null;
  let queuedThinkingLevel: string | null = null;
  let pendingConnection: { key: string; promise: Promise<void> } | null = null;
  const intentionalRuntimeStops = new Set<string>();
  const workspaceWarmups = new Map<string, Promise<void>>();
  let preferredWarmupKey = "";
  let activeTurnStartedAt: number | null = null;
  const managedFollowUpsByRuntime = new Map<string, ManagedQueuedMessage[]>();
  const managedDrainInFlight = new Set<string>();
  const suppressManagedDrainFor = new Set<string>();
  const notices = createNotices({
    get,
    set,
    dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
    sessionIsBeingViewed: (sessionFile) => Boolean(
      sessionFile
      && viewedSessionFile
      && sameLocalPath(sessionFile, viewedSessionFile)
      && typeof document !== "undefined"
      && document.visibilityState !== "hidden"
      && document.hasFocus(),
    ),
  });
  const toast = notices.showToast;
  const pushNotification = notices.addNotification;
  const raise = notices.raise;
  const removeNotifications = notices.removeNotifications;
  let viewedSessionFile: string | null = null;

  const persistCurrentModelCatalog = () => {
    const state = get();
    persistModelCatalog({ models: state.availableModels, selected: state.model });
  };

  const workspaceKey = (cwd: string) => cwd.trim().replace(/[\\/]+$/, "").toLowerCase();

  // Before the first turn a pick belongs to the task, not to the runtime it happens to be on.
  const taskNotStarted = () => get().messages.length === 0;

  // The last model and thinking level the user picked become the defaults new tasks start with.
  const rememberForNewTasks = (patch: Partial<Pick<AppSettings, "provider" | "model" | "thinkingLevel">>) => {
    const settings = get().settings;
    if (!settings) return;
    const next = { ...settings, ...patch };
    if (
      next.provider === settings.provider
      && next.model === settings.model
      && next.thinkingLevel === settings.thinkingLevel
    ) return;
    void get().saveSettings(next).catch((error) => {
      get().appendLog(`保存默认模型失败：${describeError(error)}`);
    });
  };

  // A runtime warmed before the default changed still runs the old one. Only a model
  // the catalog lists is applied, so a disconnected provider does not fail every new task.
  const newTaskDefaultModel = (): ModelInfo | null => {
    const { settings, model, availableModels } = get();
    if (!settings?.provider || !settings.model) return null;
    if (model?.provider === settings.provider && model.id === settings.model) return null;
    return availableModels.find((item) => item.provider === settings.provider && item.id === settings.model) ?? null;
  };

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

  const queueAssistantDelta = (runtimeId: string, delta: { text?: string; thinking?: string; toolCalls?: UiToolCall[] }) => {
    if (!pendingAssistantUpdate || pendingAssistantUpdate.runtimeId !== runtimeId) {
      pendingAssistantUpdate = { runtimeId, text: "", thinking: "", toolCalls: [] };
    }
    pendingAssistantUpdate.text += delta.text ?? "";
    pendingAssistantUpdate.thinking += delta.thinking ?? "";
    pendingAssistantUpdate.toolCalls.push(...(delta.toolCalls ?? []));
    if (assistantUpdateTimer !== null) return;
    assistantUpdateTimer = window.setTimeout(() => {
      const pending = pendingAssistantUpdate;
      assistantUpdateTimer = null;
      pendingAssistantUpdate = null;
      if (!pending || pending.runtimeId !== get().runtimeId) return;
      set((state) => ({ messages: streamAssistant(state.messages, pending), isStreaming: true }));
    }, 32);
  };

  /** The task on screen, which the actions below act on. */
  const activeRuntime = (): string => {
    const runtimeId = get().runtimeId;
    if (!runtimeId) throw new Error("当前没有活动的任务");
    return runtimeId;
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
      await harnessRuntimes.prompt(runtimeId, buildPromptPayload(next.text, next.attachments));
    } catch (error) {
      const current = managedFollowUpsByRuntime.get(runtimeId) ?? [];
      setManagedQueueForRuntime(runtimeId, insertManagedQueueItem(current, next, 0));
      if (get().runtimeId === runtimeId) {
        toast(`发送待处理消息失败：${describeError(error)}`, "error");
      }
    } finally {
      managedDrainInFlight.delete(runtimeId);
    }
  };

  const syncSession = async (expectedVersion = connectionVersion, keepQueuedModel = false) => {
    const runtimeId = get().runtimeId;
    if (!runtimeId) return;
    const stateRequest = harnessRuntimes.state(runtimeId);
    const historyRequest = harnessRuntimes.messages(runtimeId);
    const modelCatalogRequest = harnessRuntimes.models().then((models) => {
      if (get().runtimeId !== runtimeId || expectedVersion !== connectionVersion) return;
      set({
        availableModels: models,
        availableThinkingLevels: harnessRuntimes.thinkingLevels(),
        // The Host has no slash commands of its own.
        commands: [],
      });
      persistCurrentModelCatalog();
    }).catch((error) => {
      if (get().runtimeId === runtimeId && expectedVersion === connectionVersion) {
        get().appendLog(`刷新模型目录失败：${describeError(error)}`);
      }
    });
    const data = await stateRequest;
    if (get().runtimeId !== runtimeId || expectedVersion !== connectionVersion) return;
    {
      set({
        sessionFile: data.sessionFile ?? null,
        sessionId: data.sessionId ?? null,
        sessionName: data.sessionName ?? null,
        isStreaming: data.isStreaming ?? false,
        isCompacting: data.isCompacting ?? false,
        thinkingLevel: data.thinkingLevel ?? get().thinkingLevel,
        // A fresh runtime reports its default; keep showing the pick connect() is about to apply.
        model: (keepQueuedModel ? queuedModelSelection : null) ?? data.model ?? null,
      });
      persistCurrentModelCatalog();
    }

    const sessionFile = data?.sessionFile;
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

    const restoredMessages = await historyRequest;
    if (get().runtimeId !== runtimeId || expectedVersion !== connectionVersion) return;
    set({
      messages: restoredMessages,
      agentBrowser: agentBrowserFromMessages(restoredMessages),
      computer: computerFromMessages(restoredMessages),
    });

    await modelCatalogRequest;
    await refreshStats(expectedVersion);
  };

  const refreshStats = async (expectedVersion = connectionVersion) => {
    const runtimeId = get().runtimeId;
    if (!runtimeId) return;
    try {
      const stats = await harnessRuntimes.stats(runtimeId);
      if (get().runtimeId !== runtimeId || expectedVersion !== connectionVersion) return;
      set({ stats });
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
    model: cachedModelCatalog.selected,
    availableModels: cachedModelCatalog.models,
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
    notifications: readStoredNotifications(),
    sessionTree: [],
    sessionTreeLeafId: null,
    sessionTreeError: null,
    sessionTreeLoading: false,

    connect: async (cwd, sessionFile) => {
      const requestKey = `${workspaceKey(cwd)}\u0000${sessionFile ?? ""}`;
      if (pendingConnection?.key === requestKey) return pendingConnection.promise;

      const request = (async () => {
        const connectVersion = ++connectionVersion;
        // A pick made on the new-task page is not meant for a saved session opened afterwards.
        if (sessionFile) {
          queuedModelSelection = null;
          queuedThinkingLevel = null;
        }
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
          void localHistory.then((restoredMessages) => {
            if (connectVersion !== connectionVersion) return;
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
          await syncSession(connectVersion, true);
          if (connectVersion !== connectionVersion) return;
          // A new task without a pick of its own starts from the remembered defaults.
          const queuedModel = queuedModelSelection ?? (sessionFile ? null : newTaskDefaultModel());
          const queuedLevel = queuedThinkingLevel ?? (sessionFile ? null : get().settings?.thinkingLevel || null);
          // A saved session takes a pick once. A task that has not started keeps it, because
          // sending can still move the task to another runtime (worktree, quick chat, project).
          if (sessionFile) {
            queuedModelSelection = null;
            queuedThinkingLevel = null;
          }
          const modelChange = pendingModelChange?.runtimeId === runtimeId
            ? pendingModelChange.promise
            : null;
          if (modelChange) {
            // Picked again while Pi was booting: that command is already on its way here.
            await modelChange.catch(() => undefined);
          } else if (queuedModel) {
            try {
              await get().setModel(queuedModel);
            } catch {
              // setModel reports the failure without invalidating an otherwise healthy runtime.
            }
          }
          if (connectVersion !== connectionVersion) return;
          // Pi clamps to what the model supports; only apply a level it actually offers.
          if (queuedLevel && queuedLevel !== get().thinkingLevel && get().availableThinkingLevels.includes(queuedLevel)) {
            try {
              await get().setThinkingLevel(queuedLevel);
            } catch {
              // The composer keeps showing Pi's reported level; a failed preset is not fatal.
            }
            if (connectVersion !== connectionVersion) return;
          }
          await Promise.all([get().refreshSessions(), get().refreshGit()]);
        } catch (error) {
          if (connectVersion !== connectionVersion) return;
          const message = describeError(error);
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
      // Reuse is decided by the host claim. This map only tracks the in-flight request.

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
        })
        .catch((error) => {
          get().appendLog(`Workspace prewarm skipped: ${describeError(error)}`);
        })
        .finally(() => {
          if (workspaceWarmups.get(key) === warmup) workspaceWarmups.delete(key);
        });
      workspaceWarmups.set(key, warmup);
      return warmup;
    },

    // Host runtimes live in this page (src/lib/harnessRuntime.ts); after a reload
    // there are none to take back, and the session reopens from its file instead.
    restoreRuntimes: async () => false,

    switchSession: async (cwd, sessionFile) => {
      const current = get();
      if (current.sessionFile === sessionFile && current.connection === "running") return;
      await get().connect(cwd, sessionFile);
    },

    disconnect: async () => {
      connectionVersion += 1;
      pendingConnection = null;
      queuedModelSelection = null;
      queuedThinkingLevel = null;
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
      if (event.type === "turn-start") updateRuntime(runtimeId, { isStreaming: true });
      if (event.type === "turn-end") {
        updateRuntime(runtimeId, { isStreaming: false });
        queueMicrotask(() => void drainManagedFollowUp(runtimeId));
      }
      if (event.type === "ui-request" && !isSilentUiRequest(event.request.method)) {
        updateRuntime(runtimeId, { extensionRequest: event.request });
      }

      // A task in the background only notifies.
      if (runtimeId !== get().runtimeId) {
        const runtime = get().runtimes[runtimeId];
        const context = { cwd: runtime?.cwd ?? "", sessionFile: runtime?.sessionFile ?? null };
        if (event.type === "turn-end") {
          raise(completionNotification(runtimeId, context, true));
          void get().refreshSessions();
        }
        if (event.type === "ui-request") raise(uiRequestNotification(runtimeId, event.request, context, true));
        return;
      }

      switch (event.type) {
        case "turn-start":
          set({ isStreaming: true, retryStatus: null });
          return;
        case "turn-end":
          settleOptimisticPrompt(runtimeId);
          activeTurnStartedAt = null;
          set({ isStreaming: false, retryStatus: null });
          if ((managedFollowUpsByRuntime.get(runtimeId) ?? []).length === 0) {
            raise(completionNotification(runtimeId, {
              cwd: get().cwd,
              sessionFile: get().sessionFile,
              sessionName: get().sessionName,
            }, false));
          }
          void Promise.all([get().refreshSessions(), get().refreshGit(), refreshStats()]);
          return;
        case "user": {
          // The message the composer showed at once becomes the recorded one.
          const optimistic = pendingOptimisticPrompt?.runtimeId === runtimeId ? pendingOptimisticPrompt : null;
          set((state) => ({ messages: replaceOrAppend(state.messages, optimistic?.userMessageId, event.message) }));
          return;
        }
        case "assistant-start": {
          clearPendingAssistantUpdate(runtimeId);
          // The composer's placeholder reply, if there is one, is the reply being streamed.
          set((state) => ({ messages: startAssistant(state.messages) }));
          if (pendingOptimisticPrompt?.runtimeId === runtimeId) pendingOptimisticPrompt = null;
          return;
        }
        case "assistant-delta":
          queueAssistantDelta(runtimeId, { text: event.text, thinking: event.thinking });
          return;
        case "assistant-tool-calls":
          queueAssistantDelta(runtimeId, { toolCalls: event.calls });
          return;
        case "assistant": {
          clearPendingAssistantUpdate(runtimeId);
          const durationMs = activeTurnStartedAt === null ? undefined : Date.now() - activeTurnStartedAt;
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
          if (event.failed) toast("上下文压缩失败", "error");
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
            toast(request.message, request.notifyType ?? "info");
            return;
          }
          set({ extensionRequest: request });
          raise(uiRequestNotification(runtimeId, request, {
            cwd: get().cwd,
            sessionFile: get().sessionFile,
          }, false));
          return;
        }
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
        const points = await harnessRuntimes.forkPoints(activeRuntime());
        const matches = points.filter((point) => point.text === target.content);
        const sameTextAfter = state.messages
          .slice(messageIndex + 1)
          .filter((message) => message.role === "user" && message.content === target.content)
          .length;
        return matches[matches.length - 1 - sameTextAfter] ?? null;
      } catch (error) {
        toast(describeError(error), "error");
        return null;
      }
    },

    rewindMessage: async (entryId) => {
      if (get().isStreaming) {
        toast("请等待当前回复完成后再回退消息", "warning");
        return false;
      }
      try {
        // The user can decline restoring the files; nothing changes then.
        if (!await harnessRuntimes.rewind(activeRuntime(), entryId)) return false;
        await syncSession();
        await get().refreshSessions();
        return true;
      } catch (error) {
        toast(describeError(error), "error");
        return false;
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
        if (!await harnessRuntimes.rewind(activeRuntime(), entryId)) return false;
        await syncSession();
        await get().refreshSessions();
        return get().sendMessage(text, attachments);
      } catch (error) {
        toast(describeError(error), "error");
        return false;
      }
    },

    sendMessage: async (text, attachments = [], behavior) => {
      const payload = buildPromptPayload(text, attachments);
      if (!payload.message && payload.images.length === 0) return false;
      // connect() marks the runtime as running before it has applied the picked model;
      // a prompt sent in that gap would be answered by the runtime's default model.
      if (pendingConnection && (queuedModelSelection || queuedThinkingLevel)) {
        await pendingConnection.promise.catch(() => undefined);
      }
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
          await harnessRuntimes.queue(runtimeId, behavior === "followUp" ? "followUp" : "steer", payload);
        } else {
          await harnessRuntimes.prompt(runtimeId, payload);
          // The task has started: its model and thinking level now live in the runtime.
          queuedModelSelection = null;
          queuedThinkingLevel = null;
        }
        return true;
      } catch (error) {
        if (optimistic) rollbackOptimisticPrompt(runtimeId);
        if (!wasStreaming) activeTurnStartedAt = null;
        toast(describeError(error), "error");
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
        await harnessRuntimes.abort(activeRuntime());
      } catch (error) {
        if (runtimeId) suppressManagedDrainFor.delete(runtimeId);
        throw error;
      } finally {
        if (runtimeId) settleOptimisticPrompt(runtimeId);
        set({ isStreaming: false });
      }
    },

    newSession: async () => {
      harnessRuntimes.newSession(activeRuntime());
      await syncSession();
      await get().refreshSessions();
    },

    cloneSession: async () => {
      await harnessRuntimes.clone(activeRuntime());
      await syncSession();
      await get().refreshSessions();
      toast("会话已克隆", "info");
    },

    forkLatest: async () => {
      const runtimeId = activeRuntime();
      const latest = (await harnessRuntimes.forkPoints(runtimeId)).at(-1);
      if (!latest) {
        toast("当前对话还没有可分叉的检查点", "warning");
        return;
      }
      await harnessRuntimes.fork(runtimeId, latest.entryId);
      await syncSession();
      await get().refreshSessions();
      await get().loadSessionTree();
      toast("已从最新检查点分叉对话", "info");
    },

    loadSessionTree: async () => {
      const runtimeId = get().runtimeId;
      if (!runtimeId || get().connection !== "running") {
        set({ sessionTree: [], sessionTreeLeafId: null, sessionTreeError: "需要已连接的 Pi 会话才能查看会话树", sessionTreeLoading: false });
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
        toast("无效的会话树节点", "warning");
        return;
      }
      if (get().isStreaming) {
        toast("请等待当前任务完成后再从此节点继续", "warning");
        return;
      }
      try {
        await harnessRuntimes.fork(activeRuntime(), entryId);
        await syncSession();
        await get().refreshSessions();
        await get().loadSessionTree();
        toast("已从此节点分叉并继续", "info");
      } catch (error) {
        toast(describeError(error), "error");
      }
    },

    compact: async () => {
      set({ isCompacting: true });
      try {
        await harnessRuntimes.compact(activeRuntime());
        await refreshStats();
      } finally {
        set({ isCompacting: false });
      }
    },

    exportSession: async (destination) => {
      const sessionFile = get().sessionFile;
      if (!sessionFile) throw new Error("当前任务还没有可导出的对话");
      const path = await pi.exportSessionMarkdown(sessionFile, destination);
      toast(`已导出到 ${path}`, "info");
      return path;
    },

    reloadProviderCatalog: async () => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) return;
      try {
        const models = await harnessRuntimes.models();
        if (get().runtimeId !== runtimeId) return;
        set({ availableModels: models });
        persistCurrentModelCatalog();
      } catch (error) {
        get().appendLog(`刷新模型目录失败：${describeError(error)}`);
      }
    },

    setModel: async (model) => {
      const runtimeId = get().runtimeId;
      // While connect() is still attaching a runtime there is nothing to send the pick to.
      if (!runtimeId || get().connection === "starting") {
        queuedModelSelection = model;
        set({ model });
        persistCurrentModelCatalog();
        return;
      }

      const previous = pendingModelChange?.runtimeId === runtimeId
        ? pendingModelChange.promise.catch(() => undefined)
        : Promise.resolve();
      const change = previous.then(async () => {
        if (get().runtimeId !== runtimeId) throw new Error("当前任务已切换，请重新选择模型");
        const confirmed = await harnessRuntimes.setModel(runtimeId, model.provider, model.id);
        if (get().runtimeId !== runtimeId) throw new Error("当前任务已切换，请重新选择模型");
        set({
          model: confirmed,
          availableThinkingLevels: harnessRuntimes.thinkingLevels(),
        });
        persistCurrentModelCatalog();
        rememberForNewTasks({ provider: confirmed.provider, model: confirmed.id });
      });

      pendingModelChange = { runtimeId, promise: change };
      if (taskNotStarted()) queuedModelSelection = model;
      // Reflect the click immediately while Pi confirms it in the background.
      // A failed command is rolled back to the runtime's reported model below.
      if (get().runtimeId === runtimeId) set({ model, isSwitchingModel: true });
      try {
        await change;
      } catch (error) {
        if (get().runtimeId === runtimeId) {
          // Pi turned this model down; do not offer it to the next runtime either.
          if (queuedModelSelection === model) queuedModelSelection = null;
          try {
            const state = await harnessRuntimes.state(runtimeId);
            if (get().runtimeId === runtimeId) {
              set({ model: state.model ?? null });
              persistCurrentModelCatalog();
            }
          } catch {
            // Keep the last confirmed UI value when the runtime cannot be queried.
          }
          toast(`切换模型失败：${describeError(error)}`, "error");
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
      if (!runtimeId || get().connection === "starting") {
        // New-task page: remember the choice and apply it once the runtime starts.
        queuedThinkingLevel = level;
        set({ thinkingLevel: level });
        return;
      }
      const modelChange = pendingModelChange?.runtimeId === runtimeId
        ? pendingModelChange.promise
        : null;
      if (modelChange) await modelChange;
      if (get().runtimeId !== runtimeId) throw new Error("当前任务已切换，请重新设置推理等级");
      await harnessRuntimes.setThinkingLevel(runtimeId, level);
      set({ thinkingLevel: level });
      rememberForNewTasks({ thinkingLevel: level });
      if (taskNotStarted()) queuedThinkingLevel = level;
    },

    setRuntimeAgentMode: async (mode) => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) return;
      await harnessRuntimes.setPermission(runtimeId, { agentMode: mode });
    },

    setRuntimePermissionMode: async (mode) => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) return;
      await harnessRuntimes.setPermission(runtimeId, { permission: mode });
    },

    setSessionName: async (name) => {
      await harnessRuntimes.rename(activeRuntime(), name.trim());
      set({ sessionName: name.trim() || null });
      await get().refreshSessions();
    },

    refreshSessions: async () => {
      try {
        set({ sessions: await pi.listSessions() });
      } catch (error) {
        get().appendLog(`列出会话失败：${describeError(error)}`);
      }
    },

    refreshGit: async () => {
      const cwd = get().cwd;
      if (!cwd) return;
      try {
        set({ git: await pi.gitSnapshot(cwd) });
      } catch (error) {
        get().appendLog(`读取 Git 更改失败：${describeError(error)}`);
      }
    },

    loadSettings: async () => {
      if (!isTauriRuntime()) {
        const settings = readWebSettings();
        if (settings) set({ settings });
        return;
      }
      try {
        set({ settings: await pi.getSettings() });
      } catch (error) {
        toast(`加载设置失败：${describeError(error)}`, "error");
      }
    },

    saveSettings: async (settings) => {
      if (!isTauriRuntime()) {
        window.localStorage.setItem(WEB_SETTINGS_KEY, JSON.stringify(settings));
        set({ settings });
        return;
      }
      await pi.setSettings(settings);
      set({ settings: await pi.getSettings() });
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

    addNotification: pushNotification,

    setViewedSession: (sessionFile) => {
      viewedSessionFile = sessionFile;
      if (!sessionFile || typeof document === "undefined" || !document.hasFocus()) return;
      removeNotifications((notification) => sameLocalPath(notification.sessionFile, sessionFile));
    },

    markNotificationRead: (id) => {
      removeNotifications((notification) => notification.id === id);
    },

    markAllNotificationsRead: () => {
      removeNotifications(() => true);
    },

    dismissNotification: (id) => {
      removeNotifications((notification) => notification.id === id);
    },
    clearComposerPrefill: () => set({ composerPrefill: null }),
    dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
  };
});
