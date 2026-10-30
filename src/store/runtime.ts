/** The task on screen and its runtimes: connecting, model and effort, settings, Git. */
import { describeError } from "../lib/errors";
import { agent } from "../lib/agent";
import { harnessRuntimes } from "../lib/harnessRuntime";
import { redactSensitiveText } from "../lib/redact";
import { readStoredModelCatalog } from "../lib/modelCatalogCache";
import { agentBrowserFromMessages, computerFromMessages } from "../lib/toolPanels";
import type { AppSettings } from "../types";
import type { GetState, SetState, StoreContext } from "./context";
import type { RuntimeSlice } from "./types";

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

export function createRuntimeSlice(set: SetState, get: GetState, ctx: StoreContext): RuntimeSlice {
  return {
    runtimeId: null,
    runtimes: {},
    connection: "disconnected",
    cwd: "",
    piLog: [],
    lastError: null,
    sessionFile: null,
    sessionId: null,
    sessionName: null,
    isSwitchingModel: false,
    thinkingLevel: "medium",
    model: cachedModelCatalog.selected,
    availableModels: cachedModelCatalog.models,
    availableThinkingLevels: [],
    commands: [],
    stats: null,
    settings: null,
    git: null,
    connect: async (cwd, sessionFile) => {
      const requestKey = `${ctx.workspaceKey(cwd)}\u0000${sessionFile ?? ""}`;
      if (ctx.pendingConnection?.key === requestKey) return ctx.pendingConnection.promise;

      const request = (async () => {
        const connectVersion = ++ctx.connectionVersion;
        // A pick made on the new-task page is not meant for a saved session opened afterwards.
        if (sessionFile) {
          ctx.queuedModelSelection = null;
          ctx.queuedThinkingLevel = null;
        }
        ctx.clearPendingAssistantUpdate();
        ctx.pendingOptimisticPrompt = null;
        ctx.activeTurnStartedAt = null;
        const localHistory = sessionFile ? agent.sessionHistory(sessionFile) : null;
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
            if (connectVersion !== ctx.connectionVersion) return;
            set({
              messages: restoredMessages,
              agentBrowser: agentBrowserFromMessages(restoredMessages),
              computer: computerFromMessages(restoredMessages),
            });
          }).catch(() => undefined);
        }
        try {
          const key = ctx.workspaceKey(cwd);
          ctx.preferredWarmupKey = key;
          const warmup = ctx.workspaceWarmups.get(key);
          if (warmup) await warmup;
          if (connectVersion !== ctx.connectionVersion) return;
          const started = await agent.start(cwd, sessionFile);
          if (connectVersion !== ctx.connectionVersion) {
            await agent.stop(started.runtimeId).catch(() => undefined);
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
            managedFollowUpQueue: ctx.managedFollowUpsByRuntime.get(runtimeId) ?? [],
          }));
          await ctx.syncSession(connectVersion, true);
          if (connectVersion !== ctx.connectionVersion) return;
          // A new task without a pick of its own starts from the remembered defaults.
          const queuedModel = ctx.queuedModelSelection ?? (sessionFile ? null : ctx.newTaskDefaultModel());
          const queuedLevel = ctx.queuedThinkingLevel ?? (sessionFile ? null : get().settings?.thinkingLevel || null);
          // A saved session takes a pick once. A task that has not started keeps it, because
          // sending can still move the task to another runtime (worktree, quick chat, project).
          if (sessionFile) {
            ctx.queuedModelSelection = null;
            ctx.queuedThinkingLevel = null;
          }
          const modelChange = ctx.pendingModelChange?.runtimeId === runtimeId
            ? ctx.pendingModelChange.promise
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
          if (connectVersion !== ctx.connectionVersion) return;
          // Pi clamps to what the model supports; only apply a level it actually offers.
          if (queuedLevel && queuedLevel !== get().thinkingLevel && get().availableThinkingLevels.includes(queuedLevel)) {
            try {
              await get().setThinkingLevel(queuedLevel);
            } catch {
              // The composer keeps showing Pi's reported level; a failed preset is not fatal.
            }
            if (connectVersion !== ctx.connectionVersion) return;
          }
          await Promise.all([get().refreshSessions(), get().refreshGit()]);
        } catch (error) {
          if (connectVersion !== ctx.connectionVersion) return;
          const message = describeError(error);
          set({ connection: "exited", lastError: message });
          get().appendLog(message);
          ctx.toast(message, "error");
        }
      })();

      ctx.pendingConnection = { key: requestKey, promise: request };
      try {
        await request;
      } finally {
        if (ctx.pendingConnection?.promise === request) ctx.pendingConnection = null;
      }
    },

    prewarmWorkspace: async (cwd) => {
      const key = ctx.workspaceKey(cwd);
      if (!key) return;
      ctx.preferredWarmupKey = key;
      const pending = ctx.workspaceWarmups.get(key);
      if (pending) return pending;
      // Reuse is decided by the host claim. This map only tracks the in-flight request.

      const warmup = agent.start(cwd)
        .then((started) => {
          if (ctx.preferredWarmupKey !== key && started.runtimeId !== get().runtimeId) {
            return agent.stop(started.runtimeId).finally(() => {
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
          if (ctx.workspaceWarmups.get(key) === warmup) ctx.workspaceWarmups.delete(key);
        });
      ctx.workspaceWarmups.set(key, warmup);
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
      ctx.connectionVersion += 1;
      ctx.pendingConnection = null;
      ctx.queuedModelSelection = null;
      ctx.queuedThinkingLevel = null;
      ctx.clearPendingAssistantUpdate();
      ctx.pendingOptimisticPrompt = null;
      const runtimeId = get().runtimeId;
      if (runtimeId) {
        ctx.intentionalRuntimeStops.add(runtimeId);
        try {
          await agent.stop(runtimeId);
        } catch (error) {
          ctx.intentionalRuntimeStops.delete(runtimeId);
          throw error;
        }
        ctx.intentionalRuntimeStops.delete(runtimeId);
        ctx.managedFollowUpsByRuntime.delete(runtimeId);
        ctx.managedDrainInFlight.delete(runtimeId);
        ctx.suppressManagedDrainFor.delete(runtimeId);
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
      ctx.connectionVersion += 1;
      ctx.pendingConnection = null;
      ctx.clearPendingAssistantUpdate();
      ctx.pendingOptimisticPrompt = null;
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

    handleStatus: (status) => {
      const runtimeId = status.runtimeId;
      const intentionalStop = status.status === "exited" && ctx.intentionalRuntimeStops.delete(runtimeId);
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
        if (status.code && status.code !== 0) ctx.toast(`Pi 已退出，代码 ${status.code}`, "error");
      }
    },

    handleLog: (runtimeId, line) => {
      if (runtimeId === get().runtimeId) get().appendLog(line);
    },

    appendLog: (line) => set((state) => ({ piLog: [...state.piLog.slice(-399), redactSensitiveText(line)] })),

    reloadProviderCatalog: async () => {
      const runtimeId = get().runtimeId;
      if (!runtimeId) return;
      try {
        const models = await harnessRuntimes.models();
        if (get().runtimeId !== runtimeId) return;
        set({ availableModels: models });
        ctx.persistCurrentModelCatalog();
      } catch (error) {
        get().appendLog(`刷新模型目录失败：${describeError(error)}`);
      }
    },

    setModel: async (model) => {
      const runtimeId = get().runtimeId;
      // While connect() is still attaching a runtime there is nothing to send the pick to.
      if (!runtimeId || get().connection === "starting") {
        ctx.queuedModelSelection = model;
        set({ model });
        ctx.persistCurrentModelCatalog();
        return;
      }

      const previous = ctx.pendingModelChange?.runtimeId === runtimeId
        ? ctx.pendingModelChange.promise.catch(() => undefined)
        : Promise.resolve();
      const change = previous.then(async () => {
        if (get().runtimeId !== runtimeId) throw new Error("当前任务已切换，请重新选择模型");
        const confirmed = await harnessRuntimes.setModel(runtimeId, model.provider, model.id);
        if (get().runtimeId !== runtimeId) throw new Error("当前任务已切换，请重新选择模型");
        set({
          model: confirmed,
          availableThinkingLevels: harnessRuntimes.thinkingLevels(),
        });
        ctx.persistCurrentModelCatalog();
        ctx.rememberForNewTasks({ provider: confirmed.provider, model: confirmed.id });
      });

      ctx.pendingModelChange = { runtimeId, promise: change };
      if (ctx.taskNotStarted()) ctx.queuedModelSelection = model;
      // Reflect the click immediately while Pi confirms it in the background.
      // A failed command is rolled back to the runtime's reported model below.
      if (get().runtimeId === runtimeId) set({ model, isSwitchingModel: true });
      try {
        await change;
      } catch (error) {
        if (get().runtimeId === runtimeId) {
          // Pi turned this model down; do not offer it to the next runtime either.
          if (ctx.queuedModelSelection === model) ctx.queuedModelSelection = null;
          try {
            const state = await harnessRuntimes.state(runtimeId);
            if (get().runtimeId === runtimeId) {
              set({ model: state.model ?? null });
              ctx.persistCurrentModelCatalog();
            }
          } catch {
            // Keep the last confirmed UI value when the runtime cannot be queried.
          }
          ctx.toast(`切换模型失败：${describeError(error)}`, "error");
        }
        throw error;
      } finally {
        if (ctx.pendingModelChange?.promise === change) {
          ctx.pendingModelChange = null;
          if (get().runtimeId === runtimeId) set({ isSwitchingModel: false });
        }
      }
    },

    setThinkingLevel: async (level) => {
      const runtimeId = get().runtimeId;
      if (!runtimeId || get().connection === "starting") {
        // New-task page: remember the choice and apply it once the runtime starts.
        ctx.queuedThinkingLevel = level;
        set({ thinkingLevel: level });
        return;
      }
      const modelChange = ctx.pendingModelChange?.runtimeId === runtimeId
        ? ctx.pendingModelChange.promise
        : null;
      if (modelChange) await modelChange;
      if (get().runtimeId !== runtimeId) throw new Error("当前任务已切换，请重新设置推理等级");
      await harnessRuntimes.setThinkingLevel(runtimeId, level);
      set({ thinkingLevel: level });
      ctx.rememberForNewTasks({ thinkingLevel: level });
      if (ctx.taskNotStarted()) ctx.queuedThinkingLevel = level;
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

    refreshGit: async () => {
      const cwd = get().cwd;
      if (!cwd) return;
      try {
        set({ git: await agent.gitSnapshot(cwd) });
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
        set({ settings: await agent.getSettings() });
      } catch (error) {
        ctx.toast(`加载设置失败：${describeError(error)}`, "error");
      }
    },

    saveSettings: async (settings) => {
      if (!isTauriRuntime()) {
        window.localStorage.setItem(WEB_SETTINGS_KEY, JSON.stringify(settings));
        set({ settings });
        return;
      }
      await agent.setSettings(settings);
      set({ settings: await agent.getSettings() });
    },
  };
}
