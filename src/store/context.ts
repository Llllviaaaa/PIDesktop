/**
 * What the store's slices share (P6e): the bookkeeping behind their actions
 * that is not state anyone renders (which connection is current, the prompt
 * shown before the Host confirms it, picks queued for a task that has not
 * started, the streaming timer), and the helpers more than one slice calls.
 * One context belongs to one store.
 */
import type { StoreApi } from "zustand";
import { describeError } from "../lib/errors";
import { agent } from "../lib/agent";
import { buildPromptPayload, harnessRuntimes } from "../lib/harnessRuntime";
import { insertManagedQueueItem } from "../lib/managedQueue";
import { persistModelCatalog } from "../lib/modelCatalogCache";
import { sameLocalPath } from "../lib/pathIdentity";
import { agentBrowserFromMessages, computerFromMessages } from "../lib/toolPanels";
import { streamAssistant } from "../lib/transcript";
import { createNotices } from "../notifications";
import type { AppSettings, ManagedQueuedMessage, ModelInfo, UiToolCall } from "../types";
import type { AppState, RuntimeState } from "./types";

export type SetState = StoreApi<AppState>["setState"];
export type GetState = StoreApi<AppState>["getState"];

export class StoreContext {
  /** Streamed text, thinking and tool calls not drawn yet; applied together every 32 ms. */
  pendingAssistantUpdate: { runtimeId: string; text: string; thinking: string; toolCalls: UiToolCall[] } | null = null;
  assistantUpdateTimer: number | null = null;
  /** Bumped by every connect; work started for an older one drops its result. */
  connectionVersion = 0;
  /** The prompt the composer showed before the Host recorded it. */
  pendingOptimisticPrompt: { runtimeId: string; userMessageId: string; assistantMessageId: string } | null = null;
  pendingModelChange: { runtimeId: string; promise: Promise<void> } | null = null;
  // What the user picked for a task that has not started yet. connect() applies them to
  // every runtime that task lands on; the first prompt hands them over to the runtime.
  queuedModelSelection: ModelInfo | null = null;
  queuedThinkingLevel: string | null = null;
  pendingConnection: { key: string; promise: Promise<void> } | null = null;
  readonly intentionalRuntimeStops = new Set<string>();
  readonly workspaceWarmups = new Map<string, Promise<void>>();
  preferredWarmupKey = "";
  activeTurnStartedAt: number | null = null;
  readonly managedFollowUpsByRuntime = new Map<string, ManagedQueuedMessage[]>();
  readonly managedDrainInFlight = new Set<string>();
  readonly suppressManagedDrainFor = new Set<string>();
  viewedSessionFile: string | null = null;
  readonly notices: ReturnType<typeof createNotices>;

  constructor(private readonly set: SetState, private readonly get: GetState) {
    this.notices = createNotices({
      get,
      set,
      dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
      sessionIsBeingViewed: (sessionFile) => Boolean(
        sessionFile
        && this.viewedSessionFile
        && sameLocalPath(sessionFile, this.viewedSessionFile)
        && typeof document !== "undefined"
        && document.visibilityState !== "hidden"
        && document.hasFocus(),
      ),
    });
  }

  toast = (...args: Parameters<ReturnType<typeof createNotices>["showToast"]>) => this.notices.showToast(...args);
  raise = (...args: Parameters<ReturnType<typeof createNotices>["raise"]>) => this.notices.raise(...args);

  persistCurrentModelCatalog = () => {
    const state = this.get();
    persistModelCatalog({ models: state.availableModels, selected: state.model });
  };

  workspaceKey = (cwd: string) => cwd.trim().replace(/[\\/]+$/, "").toLowerCase();

  // Before the first turn a pick belongs to the task, not to the runtime it happens to be on.
  taskNotStarted = () => this.get().messages.length === 0;

  // The last model and thinking level the user picked become the defaults new tasks start with.
  rememberForNewTasks = (patch: Partial<Pick<AppSettings, "provider" | "model" | "thinkingLevel">>) => {
    const settings = this.get().settings;
    if (!settings) return;
    const next = { ...settings, ...patch };
    if (
      next.provider === settings.provider
      && next.model === settings.model
      && next.thinkingLevel === settings.thinkingLevel
    ) return;
    void this.get().saveSettings(next).catch((error) => {
      this.get().appendLog(`保存默认模型失败：${describeError(error)}`);
    });
  };

  // A runtime warmed before the default changed still runs the old one. Only a model
  // the catalog lists is applied, so a disconnected provider does not fail every new task.
  newTaskDefaultModel = (): ModelInfo | null => {
    const { settings, model, availableModels } = this.get();
    if (!settings?.provider || !settings.model) return null;
    if (model?.provider === settings.provider && model.id === settings.model) return null;
    return availableModels.find((item) => item.provider === settings.provider && item.id === settings.model) ?? null;
  };

  rollbackOptimisticPrompt = (runtimeId: string) => {
    const pending = this.pendingOptimisticPrompt;
    if (!pending || pending.runtimeId !== runtimeId) return;
    this.pendingOptimisticPrompt = null;
    this.set((state) => ({
      messages: state.messages.filter(
        (message) => message.id !== pending.userMessageId && message.id !== pending.assistantMessageId,
      ),
      isStreaming: false,
    }));
  };

  settleOptimisticPrompt = (runtimeId: string) => {
    const pending = this.pendingOptimisticPrompt;
    if (!pending || pending.runtimeId !== runtimeId) return;
    this.pendingOptimisticPrompt = null;
    this.set((state) => ({
      messages: state.messages.filter((message) => message.id !== pending.assistantMessageId),
    }));
  };

  clearPendingAssistantUpdate = (runtimeId?: string) => {
    if (runtimeId && this.pendingAssistantUpdate?.runtimeId !== runtimeId) return;
    if (this.assistantUpdateTimer !== null) window.clearTimeout(this.assistantUpdateTimer);
    this.assistantUpdateTimer = null;
    this.pendingAssistantUpdate = null;
  };

  queueAssistantDelta = (runtimeId: string, delta: { text?: string; thinking?: string; toolCalls?: UiToolCall[] }) => {
    if (!this.pendingAssistantUpdate || this.pendingAssistantUpdate.runtimeId !== runtimeId) {
      this.pendingAssistantUpdate = { runtimeId, text: "", thinking: "", toolCalls: [] };
    }
    this.pendingAssistantUpdate.text += delta.text ?? "";
    this.pendingAssistantUpdate.thinking += delta.thinking ?? "";
    this.pendingAssistantUpdate.toolCalls.push(...(delta.toolCalls ?? []));
    if (this.assistantUpdateTimer !== null) return;
    this.assistantUpdateTimer = window.setTimeout(() => this.flushAssistantDelta(), 32);
  };

  /** Apply the queued streamed text now, to the task on screen. */
  flushAssistantDelta = () => {
    const pending = this.pendingAssistantUpdate;
    if (this.assistantUpdateTimer !== null) window.clearTimeout(this.assistantUpdateTimer);
    this.assistantUpdateTimer = null;
    this.pendingAssistantUpdate = null;
    if (!pending || pending.runtimeId !== this.get().runtimeId) return;
    this.set((state) => ({ messages: streamAssistant(state.messages, pending), isStreaming: true }));
  };

  /** The task on screen, which the actions act on. */
  activeRuntime = (): string => {
    const runtimeId = this.get().runtimeId;
    if (!runtimeId) throw new Error("当前没有活动的任务");
    return runtimeId;
  };

  updateRuntime = (runtimeId: string, patch: Partial<RuntimeState>) => {
    this.set((state) => {
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

  setManagedQueueForRuntime = (runtimeId: string, queue: ManagedQueuedMessage[]) => {
    if (queue.length > 0) this.managedFollowUpsByRuntime.set(runtimeId, queue);
    else this.managedFollowUpsByRuntime.delete(runtimeId);
    if (this.get().runtimeId === runtimeId) this.set({ managedFollowUpQueue: queue });
  };

  drainManagedFollowUp = async (runtimeId: string) => {
    if (this.suppressManagedDrainFor.delete(runtimeId)) return;
    if (this.managedDrainInFlight.has(runtimeId)) return;
    const queue = this.managedFollowUpsByRuntime.get(runtimeId) ?? [];
    const next = queue[0];
    if (!next) return;

    this.managedDrainInFlight.add(runtimeId);
    this.setManagedQueueForRuntime(runtimeId, queue.slice(1));
    try {
      await harnessRuntimes.prompt(runtimeId, buildPromptPayload(next.text, next.attachments));
    } catch (error) {
      const current = this.managedFollowUpsByRuntime.get(runtimeId) ?? [];
      this.setManagedQueueForRuntime(runtimeId, insertManagedQueueItem(current, next, 0));
      if (this.get().runtimeId === runtimeId) {
        this.toast(`发送待处理消息失败：${describeError(error)}`, "error");
      }
    } finally {
      this.managedDrainInFlight.delete(runtimeId);
    }
  };

  syncSession = async (expectedVersion = this.connectionVersion, keepQueuedModel = false) => {
    const { get, set } = this;
    const runtimeId = get().runtimeId;
    if (!runtimeId) return;
    const stateRequest = harnessRuntimes.state(runtimeId);
    const historyRequest = harnessRuntimes.messages(runtimeId);
    const modelCatalogRequest = harnessRuntimes.models().then((models) => {
      if (get().runtimeId !== runtimeId || expectedVersion !== this.connectionVersion) return;
      set({
        availableModels: models,
        availableThinkingLevels: harnessRuntimes.thinkingLevels(),
        // The Host has no slash commands of its own.
        commands: [],
      });
      this.persistCurrentModelCatalog();
    }).catch((error) => {
      if (get().runtimeId === runtimeId && expectedVersion === this.connectionVersion) {
        get().appendLog(`刷新模型目录失败：${describeError(error)}`);
      }
    });
    const data = await stateRequest;
    if (get().runtimeId !== runtimeId || expectedVersion !== this.connectionVersion) return;
    set({
      sessionFile: data.sessionFile ?? null,
      sessionId: data.sessionId ?? null,
      sessionName: data.sessionName ?? null,
      isStreaming: data.isStreaming ?? false,
      isCompacting: data.isCompacting ?? false,
      thinkingLevel: data.thinkingLevel ?? get().thinkingLevel,
      // A fresh runtime reports its default; keep showing the pick connect() is about to apply.
      model: (keepQueuedModel ? this.queuedModelSelection : null) ?? data.model ?? null,
    });
    this.persistCurrentModelCatalog();

    const sessionFile = data?.sessionFile;
    if (sessionFile) {
      await agent.bindSession(runtimeId, sessionFile);
      if (get().runtimeId !== runtimeId || expectedVersion !== this.connectionVersion) return;
      set((state) => ({
        runtimes: {
          ...state.runtimes,
          [runtimeId]: { ...state.runtimes[runtimeId], sessionFile, updatedAt: Date.now() },
        },
      }));
    }

    const restoredMessages = await historyRequest;
    if (get().runtimeId !== runtimeId || expectedVersion !== this.connectionVersion) return;
    set({
      messages: restoredMessages,
      agentBrowser: agentBrowserFromMessages(restoredMessages),
      computer: computerFromMessages(restoredMessages),
    });

    await modelCatalogRequest;
    await this.refreshStats(expectedVersion);
  };

  refreshStats = async (expectedVersion = this.connectionVersion) => {
    const runtimeId = this.get().runtimeId;
    if (!runtimeId) return;
    try {
      const stats = await harnessRuntimes.stats(runtimeId);
      if (this.get().runtimeId !== runtimeId || expectedVersion !== this.connectionVersion) return;
      this.set({ stats });
    } catch {
      if (this.get().runtimeId === runtimeId && expectedVersion === this.connectionVersion) this.set({ stats: null });
    }
  };
}
