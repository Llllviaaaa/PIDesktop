import { create } from "zustand";
import { pi, respondToExtension, sendCommand, type PiRuntimeStatus } from "./lib/pi";
import type {
  AgentMessage,
  AppSettings,
  AssistantMessage,
  AttachmentPayload,
  BrowserState,
  ComputerState,
  ConnectionState,
  ExtensionUIRequest,
  GitSnapshot,
  ImageContent,
  ModelInfo,
  PiEvent,
  SessionInfo,
  SessionStats,
  SlashCommand,
  Toast,
  ToolResultMessage,
  UiMessage,
  UiToolCall,
} from "./types";

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => (block as { text?: string }).text ?? "")
    .join("");
}

function imagesFromContent(content: unknown): ImageContent[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const images = content.filter(
    (block): block is ImageContent =>
      Boolean(block) &&
      typeof block === "object" &&
      (block as { type?: string }).type === "image" &&
      typeof (block as { data?: unknown }).data === "string",
  );
  return images.length ? images : undefined;
}

function thinkingFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const value = content
    .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "thinking")
    .map((block) => (block as { thinking?: string }).thinking ?? "")
    .join("");
  return value || undefined;
}

function toolCallsFromContent(content: unknown): UiToolCall[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const calls = content
    .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "toolCall")
    .map((block) => {
      const call = block as { id?: string; name?: string; arguments?: Record<string, unknown> };
      return {
        id: call.id ?? `tool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: call.name ?? "tool",
        args: call.arguments ?? {},
        running: false,
      } satisfies UiToolCall;
    });
  return calls.length ? calls : undefined;
}

function messageId(message: AgentMessage): string {
  if (message.role === "toolResult") return `tool-${message.toolCallId}-${message.timestamp}`;
  return `msg-${message.role}-${message.timestamp}`;
}

function assistantToUi(message: AssistantMessage, streaming = false): UiMessage {
  return {
    id: messageId(message),
    role: "assistant",
    content: textFromContent(message.content) || message.errorMessage || "",
    thinking: thinkingFromContent(message.content),
    model: message.model,
    usage: message.usage,
    toolCalls: toolCallsFromContent(message.content),
    isStreaming: streaming,
    isError: message.stopReason === "error" || message.stopReason === "aborted",
    timestamp: message.timestamp,
  };
}

function messagesToUi(messages: AgentMessage[]): UiMessage[] {
  const result: UiMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      result.push(assistantToUi(message));
    } else if (message.role === "user") {
      result.push({
        id: messageId(message),
        role: "user",
        content: textFromContent(message.content),
        images: imagesFromContent(message.content),
        timestamp: message.timestamp,
      });
    } else if (message.role === "toolResult") {
      attachToolResult(result, message);
    } else if (message.role === "bashExecution") {
      result.push({
        id: messageId(message),
        role: "terminal",
        content: `$ ${message.command}\n${message.output}`,
        isError: Boolean(message.exitCode),
        timestamp: message.timestamp,
      });
    } else if (message.role === "custom" && message.display) {
      result.push({
        id: messageId(message),
        role: "notice",
        content: textFromContent(message.content),
        timestamp: message.timestamp,
      });
    } else if (message.role === "compactionSummary" || message.role === "branchSummary") {
      result.push({
        id: messageId(message),
        role: "notice",
        content: message.role === "compactionSummary"
          ? `Context compacted\n\n${message.summary}`
          : `Branch summary\n\n${message.summary}`,
        timestamp: message.timestamp,
      });
    }
  }
  return result;
}

function attachToolResult(messages: UiMessage[], result: ToolResultMessage) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const call = message.toolCalls?.find((candidate) => candidate.id === result.toolCallId);
    if (call) {
      call.result = stringifyResult(result.content);
      call.images = imagesFromContent(result.content);
      call.details = isRecord(result.details) ? result.details : undefined;
      call.isError = result.isError;
      call.running = false;
      return;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resultContent(result: unknown): unknown[] {
  return isRecord(result) && Array.isArray(result.content) ? result.content : [];
}

function resultDetails(result: unknown): Record<string, unknown> | undefined {
  return isRecord(result) && isRecord(result.details) ? result.details : undefined;
}

function browserFromResult(result: unknown, previous: BrowserState | null): BrowserState | null {
  const details = resultDetails(result);
  const images = imagesFromContent(resultContent(result));
  const url = typeof details?.url === "string" ? details.url : previous?.url;
  const title = typeof details?.title === "string" ? details.title : previous?.title;
  if (!url && !title && !images?.[0]) return previous;
  return {
    url: url || "about:blank",
    title: title || url || "浏览器",
    screenshot: images?.[0] ?? previous?.screenshot,
    updatedAt: Date.now(),
  };
}

function browserFromMessages(messages: UiMessage[]): BrowserState | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const calls = messages[messageIndex].toolCalls ?? [];
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex -= 1) {
      const call = calls[callIndex];
      if (call.name.toLowerCase() !== "browser") continue;
      const url = typeof call.details?.url === "string" ? call.details.url : "about:blank";
      const title = typeof call.details?.title === "string" ? call.details.title : url;
      return { url, title, screenshot: call.images?.[0], updatedAt: call.finishedAt ?? Date.now() };
    }
  }
  return null;
}

function computerFromResult(result: unknown, previous: ComputerState | null): ComputerState | null {
  const details = resultDetails(result);
  const images = imagesFromContent(resultContent(result));
  const hasDesktopFrame = Boolean(images?.[0])
    || typeof details?.width === "number"
    || typeof details?.height === "number";
  if (!hasDesktopFrame && !previous) return null;
  return {
    action: typeof details?.action === "string" ? details.action : previous?.action || "screenshot",
    width: typeof details?.width === "number" ? details.width : previous?.width || 0,
    height: typeof details?.height === "number" ? details.height : previous?.height || 0,
    left: typeof details?.left === "number" ? details.left : previous?.left || 0,
    top: typeof details?.top === "number" ? details.top : previous?.top || 0,
    screenshot: images?.[0] ?? previous?.screenshot,
    updatedAt: Date.now(),
  };
}

function computerFromMessages(messages: UiMessage[]): ComputerState | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const calls = messages[messageIndex].toolCalls ?? [];
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex -= 1) {
      const call = calls[callIndex];
      if (call.name.toLowerCase() !== "computer") continue;
      return computerFromResult({ content: call.images ?? [], details: call.details }, null);
    }
  }
  return null;
}

function stringifyResult(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    const text = textFromContent(result);
    if (text) return text;
  }
  if (typeof result === "object" && result !== null && "content" in result) {
    const text = textFromContent((result as { content: unknown }).content);
    if (text) return text;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

interface TerminalState {
  running: boolean;
  command: string;
  output: string;
  exitCode?: number;
}

interface RuntimeState {
  runtimeId: string;
  cwd: string;
  sessionFile: string | null;
  isStreaming: boolean;
  status: ConnectionState;
  extensionRequest: ExtensionUIRequest | null;
  updatedAt: number;
}

interface PiState {
  runtimeId: string | null;
  runtimes: Record<string, RuntimeState>;
  connection: ConnectionState;
  cwd: string;
  piLog: string[];
  lastError: string | null;
  messages: UiMessage[];
  sessionFile: string | null;
  sessionId: string | null;
  sessionName: string | null;
  isStreaming: boolean;
  isCompacting: boolean;
  retryStatus: string | null;
  thinkingLevel: string;
  model: ModelInfo | null;
  availableModels: ModelInfo[];
  availableThinkingLevels: string[];
  commands: SlashCommand[];
  stats: SessionStats | null;
  steeringQueue: unknown[];
  followUpQueue: unknown[];
  sessions: SessionInfo[];
  settings: AppSettings | null;
  git: GitSnapshot | null;
  browser: BrowserState | null;
  computer: ComputerState | null;
  terminal: TerminalState;
  extensionRequest: ExtensionUIRequest | null;
  extensionStatuses: Record<string, string>;
  extensionWidgets: Record<string, string[]>;
  composerPrefill: string | null;
  toasts: Toast[];

  connect: (cwd: string, sessionFile?: string) => Promise<void>;
  restoreRuntimes: (preferredRuntimeId?: string | null) => Promise<boolean>;
  switchSession: (cwd: string, sessionFile: string) => Promise<void>;
  disconnect: () => Promise<void>;
  handleEvent: (runtimeId: string, event: PiEvent) => void;
  handleStatus: (status: PiRuntimeStatus) => void;
  handleLog: (runtimeId: string, line: string) => void;
  appendLog: (line: string) => void;
  sendMessage: (text: string, attachments?: AttachmentPayload[], behavior?: "steer" | "followUp") => Promise<void>;
  abort: () => Promise<void>;
  prepareNewTask: () => void;
  newSession: () => Promise<void>;
  cloneSession: () => Promise<void>;
  forkLatest: () => Promise<void>;
  compact: () => Promise<void>;
  exportSession: () => Promise<string | null>;
  setModel: (model: ModelInfo) => Promise<void>;
  setThinkingLevel: (level: string) => Promise<void>;
  setSessionName: (name: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshGit: () => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  runBash: (command: string, excludeFromContext?: boolean) => Promise<void>;
  abortBash: () => Promise<void>;
  answerExtension: (response: { value?: string; confirmed?: boolean; cancelled?: true }) => Promise<void>;
  showToast: (message: string, kind?: Toast["kind"]) => void;
  clearComposerPrefill: () => void;
  dismissToast: (id: string) => void;
}

export const usePiStore = create<PiState>((set, get) => {
  const toast = (message: string, kind: Toast["kind"] = "info") => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    set((state) => ({ toasts: [...state.toasts.slice(-3), { id, message, kind }] }));
    window.setTimeout(() => get().dismissToast(id), 5500);
  };

  const notify = (title: string, body: string, approval = false) => {
    const settings = get().settings;
    if (!settings?.notificationsEnabled) return;
    if (approval ? !settings.notifyOnApproval : !settings.notifyOnCompletion) return;
    if (settings.notifyOnlyWhenUnfocused && document.hasFocus()) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    new Notification(title, { body });
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

  const syncSession = async () => {
    const runtimeId = get().runtimeId;
    if (!runtimeId) return;
    const stateResponse = await sendCommand(runtimeId, "get_state");
    const data = stateResponse.data;
    if (get().runtimeId !== runtimeId) return;
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

    const [models, levels, history, commands] = await Promise.all([
      sendCommand(runtimeId, "get_available_models"),
      sendCommand(runtimeId, "get_available_thinking_levels"),
      sendCommand(runtimeId, "get_messages"),
      sendCommand(runtimeId, "get_commands"),
    ]);
    if (get().runtimeId !== runtimeId) return;
    const restoredMessages = messagesToUi(history.data?.messages ?? []);
    set({
      availableModels: models.data?.models ?? [],
      availableThinkingLevels: levels.data?.levels ?? ["off"],
      messages: restoredMessages,
      browser: browserFromMessages(restoredMessages),
      computer: computerFromMessages(restoredMessages),
      commands: commands.data?.commands ?? [],
    });
    const sessionFile = data?.sessionFile;
    if (sessionFile) {
      await pi.bindSession(runtimeId, sessionFile);
      set((state) => ({
        runtimes: {
          ...state.runtimes,
          [runtimeId]: { ...state.runtimes[runtimeId], sessionFile, updatedAt: Date.now() },
        },
      }));
    }
    await refreshStats();
  };

  const refreshStats = async () => {
    const runtimeId = get().runtimeId;
    if (!runtimeId) return;
    try {
      const response = await sendCommand(runtimeId, "get_session_stats");
      if (get().runtimeId !== runtimeId) return;
      set({ stats: (response.data as unknown as SessionStats) ?? null });
    } catch {
      set({ stats: null });
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
    sessions: [],
    settings: null,
    git: null,
    browser: null,
    computer: null,
    terminal: { running: false, command: "", output: "" },
    extensionRequest: null,
    extensionStatuses: {},
    extensionWidgets: {},
    composerPrefill: null,
    toasts: [],

    connect: async (cwd, sessionFile) => {
      set({
        connection: "starting",
        cwd,
        messages: [],
        sessionFile: null,
        sessionId: null,
        sessionName: null,
        isStreaming: false,
        isCompacting: false,
        extensionRequest: null,
        browser: null,
        computer: null,
        lastError: null,
      });
      try {
        const runtimeId = await pi.start(cwd, sessionFile);
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
        }));
        if (sessionFile && existing?.sessionFile !== sessionFile) {
          await sendCommand(runtimeId, "switch_session", { sessionPath: sessionFile }, 60_000);
        }
        await syncSession();
        await Promise.all([get().refreshSessions(), get().refreshGit()]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ connection: "exited", lastError: message });
        get().appendLog(message);
        toast(message, "error");
      }
    },

    restoreRuntimes: async (preferredRuntimeId) => {
      try {
        const discovered = await pi.listRuntimes();
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
          lastError: null,
        });
        await syncSession();
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
      const runtimeId = get().runtimeId;
      if (runtimeId) await pi.stop(runtimeId);
      set((state) => {
        const runtimes = { ...state.runtimes };
        if (runtimeId) delete runtimes[runtimeId];
        return { runtimeId: null, runtimes, connection: "disconnected", isStreaming: false, messages: [] };
      });
    },

    prepareNewTask: () => set({
      runtimeId: null,
      connection: "disconnected",
      cwd: "",
      messages: [],
      sessionFile: null,
      sessionId: null,
      sessionName: null,
      isStreaming: false,
      isCompacting: false,
      retryStatus: null,
      extensionRequest: null,
      browser: null,
      computer: null,
      extensionStatuses: {},
      extensionWidgets: {},
      steeringQueue: [],
      followUpQueue: [],
      terminal: { running: false, command: "", output: "" },
      lastError: null,
    }),

    handleEvent: (runtimeId, event) => {
      if (event.type === "agent_start") updateRuntime(runtimeId, { isStreaming: true });
      if (event.type === "agent_end" && !event.willRetry) updateRuntime(runtimeId, { isStreaming: false });
      if (event.type === "agent_settled") updateRuntime(runtimeId, { isStreaming: false });
      if (event.type === "message_start" && event.message.role === "user") void get().refreshSessions();
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
            notify("Pi 已完成", get().sessionName || "本地编码任务已完成，可以开始检查。" );
          }
          return;
        case "agent_settled":
          set({ isStreaming: false, retryStatus: null });
          void Promise.all([get().refreshSessions(), get().refreshGit(), refreshStats()]);
          return;
        case "message_start": {
          const message = event.message;
          if (message.role === "assistant") {
            set((state) => ({ messages: [...state.messages, assistantToUi(message, true)] }));
          } else if (message.role === "user") {
            set((state) => ({
              messages: [
                ...state.messages,
                {
                  id: messageId(message),
                  role: "user",
                  content: textFromContent(message.content),
                  images: imagesFromContent(message.content),
                  timestamp: message.timestamp,
                },
              ],
            }));
          }
          return;
        }
        case "message_update": {
          if (event.message.role !== "assistant") return;
          const next = assistantToUi(event.message, true);
          set((state) => {
            const messages = [...state.messages];
            let index = messages.length - 1;
            while (index >= 0 && messages[index].role !== "assistant") index -= 1;
            if (index < 0 || !messages[index].isStreaming) {
              messages.push(next);
            } else {
              const previous = messages[index];
              const previousCalls = new Map(previous.toolCalls?.map((call) => [call.id, call]));
              next.toolCalls = next.toolCalls?.map((call) => ({ ...previousCalls.get(call.id), ...call }));
              messages[index] = { ...previous, ...next, id: previous.id };
            }
            return { messages, isStreaming: true };
          });
          return;
        }
        case "message_end": {
          if (event.message.role === "assistant") {
            const completed = assistantToUi(event.message);
            set((state) => {
              const messages = [...state.messages];
              let index = messages.length - 1;
              while (index >= 0 && messages[index].role !== "assistant") index -= 1;
              if (index >= 0 && messages[index].isStreaming) {
                const previous = messages[index];
                const previousCalls = new Map(previous.toolCalls?.map((call) => [call.id, call]));
                completed.toolCalls = completed.toolCalls?.map((call) => ({ ...previousCalls.get(call.id), ...call }));
                messages[index] = { ...previous, ...completed, id: previous.id };
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
              browser: event.toolName.toLowerCase() === "browser"
                ? resultDetails(event.result)?.action === "close"
                  ? null
                  : browserFromResult(event.result, state.browser)
                : state.browser,
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
        set({ connection: "exited", isStreaming: false });
        if (status.code && status.code !== 0) toast(`Pi 已退出，代码 ${status.code}`, "error");
      }
    },

    handleLog: (runtimeId, line) => {
      if (runtimeId === get().runtimeId) get().appendLog(line);
    },

    appendLog: (line) => set((state) => ({ piLog: [...state.piLog.slice(-399), line] })),

    sendMessage: async (text, attachments = [], behavior) => {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      const imageAttachments = attachments.filter((item) => item.kind === "image" && item.data);
      const fileReferences = attachments
        .filter((item) => item.kind !== "image")
        .map((item) => `- ${item.fileName}: ${item.path}`);
      const message = fileReferences.length
        ? `${trimmed}\n\n附加的本地文件：\n${fileReferences.join("\n")}`.trim()
        : trimmed;
      const images = imageAttachments.map((item) => ({
        type: "image" as const,
        data: item.data!,
        mimeType: item.mimeType,
      }));
      try {
        if (get().isStreaming) {
          const commandName = behavior === "followUp" ? "follow_up" : "steer";
          await command(commandName, { message, images });
        } else {
          await command("prompt", { message, images });
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), "error");
      }
    },

    abort: async () => {
      try {
        await command("abort");
      } finally {
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
        toast("已从最新检查点分叉对话", "info");
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
      const response = await command("set_model", { provider: model.provider, modelId: model.id });
      set({ model: (response.data as unknown as ModelInfo) ?? model });
      const levels = await command("get_available_thinking_levels");
      set({ availableThinkingLevels: levels.data?.levels ?? ["off"] });
    },

    setThinkingLevel: async (level) => {
      await command("set_thinking_level", { level });
      set({ thinkingLevel: level });
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
      set({ settings });
      if (settings.notificationsEnabled && "Notification" in window && Notification.permission === "default") {
        void Notification.requestPermission();
      }
      toast("设置已保存。重新连接后将应用进程设置。", "info");
      await get().refreshSessions();
    },

    runBash: async (shellCommand, excludeFromContext = false) => {
      const trimmed = shellCommand.trim();
      if (!trimmed || get().terminal.running) return;
      set({ terminal: { running: true, command: trimmed, output: "" } });
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

function updateToolCall(
  source: UiMessage[],
  id: string,
  update: (call: UiToolCall) => UiToolCall,
  name = "tool",
  args: Record<string, unknown> = {},
): UiMessage[] {
  const messages = source.map((message) => ({
    ...message,
    toolCalls: message.toolCalls?.map((call) => (call.id === id ? update(call) : call)),
  }));
  if (messages.some((message) => message.toolCalls?.some((call) => call.id === id))) return messages;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") {
      const call = update({ id, name, args, running: true });
      messages[index] = { ...messages[index], toolCalls: [...(messages[index].toolCalls ?? []), call] };
      break;
    }
  }
  return messages;
}
