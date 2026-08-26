import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, MessageSquare, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { pi, respondToExtension, sendCommand, subscribeToPi } from "../lib/pi";
import {
  assistantToUi,
  attachToolResult,
  buildPromptPayload,
  imagesFromContent,
  mergeAssistantUi,
  messageId,
  textFromContent,
} from "../lib/piMessages";
import { updateToolCall } from "../lib/piToolCalls";
import { sameLocalPath } from "../lib/pathIdentity";
import type {
  AppSettings,
  AttachmentPayload,
  ExtensionUIRequest,
  ModelInfo,
  PiEvent,
  SessionStats,
  SlashCommand,
  ToolResultMessage,
  UiMessage,
  UiToolCall,
} from "../types";
import { Composer } from "./Composer";
import { ExtensionDialog } from "./ExtensionDialog";
import { Message } from "./Message";

export type SideChatPhase = "starting" | "ready" | "error" | "expired";

export interface SideChatMeta {
  title: string;
  phase: SideChatPhase;
  isStreaming: boolean;
}

interface SideChatPanelProps {
  chatId: string;
  cwd: string;
  parentSessionFile: string;
  hidden?: boolean;
  showThinking: boolean;
  settings: AppSettings | null;
  onClose: () => void;
  onDelete: () => void;
  onNew: () => void;
  onStateChange: (chatId: string, meta: SideChatMeta) => void;
  onError?: (message: string) => void;
}

const SIDE_CHAT_MODE_COMMAND = "pidesktop-mode";
const SIDE_CHAT_PERMISSION_COMMAND = "pidesktop-permission";

function permissionLabel(mode: AppSettings["permissionMode"]): string {
  if (mode === "read-only") return "只读";
  if (mode === "workspace-write") return "工作区写入";
  if (mode === "full-access") return "完全访问";
  return "先询问";
}

function promptTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.startsWith("/")) return "侧边聊天";
  return normalized.length > 28 ? `${normalized.slice(0, 28)}…` : normalized;
}

function upsertToolCall(calls: UiToolCall[] | undefined, call: UiToolCall): UiToolCall[] {
  const next = [...(calls ?? [])];
  const index = next.findIndex((item) => item.id === call.id);
  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...call,
      args: Object.keys(call.args).length ? call.args : next[index].args,
    };
  } else {
    next.push(call);
  }
  return next;
}

export function SideChatPanel({
  chatId,
  cwd,
  parentSessionFile,
  hidden = false,
  showThinking,
  settings,
  onClose,
  onDelete,
  onNew,
  onStateChange,
  onError,
}: SideChatPanelProps) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [phase, setPhase] = useState<SideChatPhase>("starting");
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [extensionRequest, setExtensionRequest] = useState<ExtensionUIRequest | null>(null);
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState("off");
  const [thinkingLevels, setThinkingLevels] = useState<string[]>(["off"]);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [isSwitchingModel, setIsSwitchingModel] = useState(false);
  const [permissionMode, setPermissionMode] = useState<AppSettings["permissionMode"]>(settings?.permissionMode ?? "ask");
  const [agentMode, setAgentMode] = useState<AppSettings["agentMode"]>(settings?.agentMode ?? "agent");
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [title, setTitle] = useState("侧边聊天");
  const [restartToken, setRestartToken] = useState(0);
  const runtimeRef = useRef<string | null>(null);
  const sideSessionFileRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeTurnStartedAtRef = useRef<number | null>(null);

  const reportError = useCallback((reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    onError?.(message);
    return message;
  }, [onError]);

  useEffect(() => {
    onStateChange(chatId, { title, phase, isStreaming });
  }, [chatId, isStreaming, onStateChange, phase, title]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    const updateAssistant = (updater: (message: UiMessage) => UiMessage) => {
      setMessages((current) => {
        const next = [...current];
        let index = next.length - 1;
        while (index >= 0 && next[index].role !== "assistant") index -= 1;
        if (index < 0 || !next[index].isStreaming) {
          next.push(updater({
            id: `side-stream-${Date.now()}`,
            role: "assistant",
            content: "",
            isStreaming: true,
            timestamp: Date.now(),
          }));
        } else {
          next[index] = updater(next[index]);
        }
        return next;
      });
    };

    const refreshStats = async (runtimeId: string) => {
      try {
        const response = await sendCommand(runtimeId, "get_session_stats");
        if (!disposed && runtimeRef.current === runtimeId) {
          setStats((response.data as unknown as SessionStats) ?? null);
        }
      } catch {
        if (!disposed && runtimeRef.current === runtimeId) setStats(null);
      }
    };

    const handleEvent = (runtimeId: string, event: PiEvent) => {
      if (runtimeId !== runtimeRef.current) return;
      if (event.type === "agent_start") {
        activeTurnStartedAtRef.current = Date.now();
        setIsStreaming(true);
        return;
      }
      if (event.type === "agent_end" && !event.willRetry) {
        setIsStreaming(false);
        return;
      }
      if (event.type === "agent_settled") {
        setIsStreaming(false);
        void refreshStats(runtimeId);
        return;
      }
      if (event.type === "message_start") {
        if (event.message.role === "assistant") {
          const incoming = assistantToUi(event.message, true);
          setMessages((current) => {
            const last = current[current.length - 1];
            return last?.role === "assistant" && last.isStreaming
              ? [...current.slice(0, -1), mergeAssistantUi(last, incoming)]
              : [...current, incoming];
          });
        } else if (event.message.role === "user") {
          const userMessage = event.message;
          const content = textFromContent(userMessage.content);
          if (content.startsWith("/pidesktop-")) return;
          setMessages((current) => {
            const lastUser = [...current].reverse().find((message) => message.role === "user");
            if (lastUser?.content === content) return current;
            return [...current, {
              id: messageId(userMessage),
              role: "user",
              content,
              images: imagesFromContent(userMessage.content),
              timestamp: userMessage.timestamp,
            }];
          });
        }
        return;
      }
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta" && update.delta) {
          updateAssistant((message) => ({ ...message, content: message.content + update.delta, isStreaming: true }));
        } else if (update.type === "thinking_delta" && update.delta) {
          updateAssistant((message) => ({ ...message, thinking: `${message.thinking ?? ""}${update.delta}`, isStreaming: true }));
        } else if (update.type === "toolcall_end" && update.toolCall) {
          const call = update.toolCall;
          updateAssistant((message) => ({
            ...message,
            toolCalls: upsertToolCall(message.toolCalls, {
              id: call.id,
              name: call.name,
              args: call.arguments,
              running: true,
            }),
            isStreaming: true,
          }));
        }
        return;
      }
      if (event.type === "message_end") {
        if (event.message.role === "assistant") {
          const durationMs = activeTurnStartedAtRef.current === null
            ? undefined
            : Date.now() - activeTurnStartedAtRef.current;
          const completed = assistantToUi(event.message, false, durationMs);
          setMessages((current) => {
            const next = [...current];
            let index = next.length - 1;
            while (index >= 0 && next[index].role !== "assistant") index -= 1;
            if (index >= 0 && next[index].isStreaming) next[index] = mergeAssistantUi(next[index], completed);
            else next.push(completed);
            return next;
          });
        } else if (event.message.role === "toolResult") {
          setMessages((current) => {
            const next = [...current];
            attachToolResult(next, event.message as ToolResultMessage);
            return next;
          });
        }
        return;
      }
      if (event.type === "tool_execution_start") {
        setMessages((current) => updateToolCall(current, event.toolCallId, (call) => ({
          ...call,
          name: event.toolName,
          args: event.args,
          running: true,
          startedAt: Date.now(),
        }), event.toolName, event.args));
        return;
      }
      if (event.type === "tool_execution_update") {
        setMessages((current) => updateToolCall(current, event.toolCallId, (call) => ({
          ...call,
          running: true,
        }), event.toolName, event.args));
        return;
      }
      if (event.type === "tool_execution_end") {
        setMessages((current) => updateToolCall(current, event.toolCallId, (call) => ({
          ...call,
          name: event.toolName,
          args: call.args,
          running: false,
          isError: event.isError,
          result: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
          finishedAt: Date.now(),
        }), event.toolName, {}));
        return;
      }
      if (event.type === "extension_ui_request") {
        if (event.method === "setTitle" && event.title?.trim()) setTitle(event.title.trim());
        if (!["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(event.method)) {
          setExtensionRequest(event);
        }
      }
    };

    const stopAndDeleteSideRuntime = async (runtimeId: string, knownSideFile?: string | null) => {
      let sideFile = knownSideFile ?? null;
      if (!sideFile) {
        try {
          const state = await sendCommand(runtimeId, "get_state");
          sideFile = typeof state.data?.sessionFile === "string" ? state.data.sessionFile : null;
        } catch {
          // The runtime may already have exited before its session path can be queried.
        }
      }
      await pi.stop(runtimeId).catch(() => undefined);
      if (sideFile && !sameLocalPath(sideFile, parentSessionFile)) {
        await pi.deleteSession(sideFile).catch(() => undefined);
      }
    };

    setPhase("starting");
    setError(null);
    void (async () => {
      try {
        unsubscribe = await subscribeToPi({
          onEvent: handleEvent,
          onStatus: (status) => {
            if (!disposed && status.runtimeId === runtimeRef.current && status.status === "exited") {
              setIsStreaming(false);
              setPhase("expired");
            }
          },
          onLog: () => undefined,
        });
        if (disposed) return;
        const started = await pi.start(cwd, parentSessionFile, true);
        if (disposed) {
          void stopAndDeleteSideRuntime(started.runtimeId);
          return;
        }
        runtimeRef.current = started.runtimeId;
        const [state, availableModelResponse, thinkingResponse, commandResponse] = await Promise.all([
          sendCommand(started.runtimeId, "get_state"),
          sendCommand(started.runtimeId, "get_available_models"),
          sendCommand(started.runtimeId, "get_available_thinking_levels"),
          sendCommand(started.runtimeId, "get_commands"),
        ]);
        const sideFile = typeof state.data?.sessionFile === "string" ? state.data.sessionFile : null;
        if (!sideFile || sameLocalPath(sideFile, parentSessionFile)) {
          throw new Error("无法创建独立的侧边聊天会话");
        }
        sideSessionFileRef.current = sideFile;
        await pi.bindSession(started.runtimeId, sideFile);
        if (!disposed) {
          setModel(state.data?.model ?? null);
          setThinkingLevel(state.data?.thinkingLevel ?? "off");
          setModels(availableModelResponse.data?.models ?? []);
          setThinkingLevels(thinkingResponse.data?.levels ?? ["off"]);
          setCommands((commandResponse.data?.commands ?? []).filter((command) => !command.name.startsWith("pidesktop-")));
          setPhase("ready");
          void refreshStats(started.runtimeId);
        }
      } catch (reason) {
        const runtimeId = runtimeRef.current;
        const sideFile = sideSessionFileRef.current;
        runtimeRef.current = null;
        sideSessionFileRef.current = null;
        if (runtimeId) await stopAndDeleteSideRuntime(runtimeId, sideFile);
        if (!disposed) {
          setPhase("error");
          setError(reportError(reason));
        }
      }
    })();

    return () => {
      disposed = true;
      unsubscribe?.();
      const runtimeId = runtimeRef.current;
      const sideFile = sideSessionFileRef.current;
      runtimeRef.current = null;
      sideSessionFileRef.current = null;
      if (runtimeId) void stopAndDeleteSideRuntime(runtimeId, sideFile);
    };
  }, [cwd, parentSessionFile, reportError, restartToken]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isStreaming, messages]);

  const submit = async (text: string, behavior?: "steer" | "followUp") => {
    const runtimeId = runtimeRef.current;
    const payload = buildPromptPayload(text, attachments);
    if (!runtimeId || phase !== "ready" || (!payload.message && payload.images.length === 0)) return false;
    const wasStreaming = isStreaming;
    const optimistic = !payload.message.startsWith("/");
    if (optimistic) {
      setMessages((current) => [...current, {
        id: `side-user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "user",
        content: payload.message,
        images: payload.images.length
          ? payload.images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }))
          : undefined,
        timestamp: Date.now(),
      }]);
      if (title === "侧边聊天") setTitle(promptTitle(payload.message));
    }
    setAttachments([]);
    setIsStreaming(true);
    if (!wasStreaming) activeTurnStartedAtRef.current = Date.now();
    try {
      const command = wasStreaming ? (behavior === "followUp" ? "follow_up" : "steer") : "prompt";
      await sendCommand(runtimeId, command, payload, 60_000);
      return true;
    } catch (reason) {
      setIsStreaming(wasStreaming);
      setMessages((current) => [...current, {
        id: `side-error-${Date.now()}`,
        role: "notice",
        content: reportError(reason),
        isError: true,
        timestamp: Date.now(),
      }]);
      return false;
    }
  };

  const stop = () => {
    const runtimeId = runtimeRef.current;
    if (runtimeId) void sendCommand(runtimeId, "abort").finally(() => setIsStreaming(false));
  };

  const pickAttachments = async () => {
    const selected = await open({ multiple: true, directory: false, title: "向侧边聊天添加文件" });
    const files = typeof selected === "string" ? [selected] : selected ?? [];
    const loaded = await Promise.all(files.map(async (file) => {
      try {
        return await pi.readAttachment(file);
      } catch (reason) {
        reportError(reason);
        return null;
      }
    }));
    setAttachments((current) => {
      const next = [...current];
      for (const item of loaded) {
        if (item && !next.some((existing) => existing.path === item.path)) next.push(item);
      }
      return next;
    });
  };

  const changeModel = async (next: ModelInfo) => {
    const runtimeId = runtimeRef.current;
    if (!runtimeId || isSwitchingModel) return;
    const previous = model;
    setModel(next);
    setIsSwitchingModel(true);
    try {
      await sendCommand(runtimeId, "set_model", { provider: next.provider, modelId: next.id });
      const [state, levels] = await Promise.all([
        sendCommand(runtimeId, "get_state"),
        sendCommand(runtimeId, "get_available_thinking_levels"),
      ]);
      setModel(state.data?.model ?? next);
      setThinkingLevels(levels.data?.levels ?? ["off"]);
    } catch (reason) {
      setModel(previous);
      reportError(reason);
    } finally {
      setIsSwitchingModel(false);
    }
  };

  const changeThinking = async (level: string) => {
    const runtimeId = runtimeRef.current;
    if (!runtimeId) return;
    try {
      await sendCommand(runtimeId, "set_thinking_level", { level });
      setThinkingLevel(level);
    } catch (reason) {
      reportError(reason);
    }
  };

  const changePermission = async (mode: AppSettings["permissionMode"]) => {
    const runtimeId = runtimeRef.current;
    if (!runtimeId || isStreaming) return;
    try {
      await sendCommand(runtimeId, "prompt", { message: `/${SIDE_CHAT_PERMISSION_COMMAND} ${mode}` }, 30_000);
      setPermissionMode(mode);
    } catch (reason) {
      reportError(reason);
    }
  };

  const changeAgentMode = async (mode: AppSettings["agentMode"]) => {
    const runtimeId = runtimeRef.current;
    if (!runtimeId || isStreaming) return;
    try {
      await sendCommand(runtimeId, "prompt", { message: `/${SIDE_CHAT_MODE_COMMAND} ${mode}` }, 30_000);
      setAgentMode(mode);
    } catch (reason) {
      reportError(reason);
    }
  };

  const restart = () => {
    setMessages([]);
    setAttachments([]);
    setStats(null);
    setTitle("侧边聊天");
    setRestartToken((value) => value + 1);
  };

  const requestDelete = () => {
    const confirmed = window.confirm("这个侧边聊天将被删除，且无法恢复。你确定吗？");
    if (confirmed) onDelete();
  };

  return (
    <section className="side-chat-pane" aria-label="侧边聊天" hidden={hidden}>
      <header className="workspace-pane-header side-chat-header">
        <span className="workspace-pane-title">
          <MessageSquare size={15} strokeWidth={1.75} />
          <strong title={title}>{title}</strong>
          {isStreaming && <LoaderCircle className="spin side-chat-running" size={13} aria-label="运行中" />}
        </span>
        <span className="workspace-pane-actions">
          <button type="button" className="icon-button" title="新建侧边聊天" onClick={onNew}>
            <Plus size={14} strokeWidth={1.75} />
          </button>
          <button type="button" className="icon-button" title="隐藏侧边聊天" onClick={onClose}>
            <X size={14} strokeWidth={1.75} />
          </button>
          <button type="button" className="icon-button side-chat-delete-action" title="删除侧边聊天" onClick={requestDelete}>
            <Trash2 size={14} strokeWidth={1.75} />
          </button>
        </span>
      </header>

      <div ref={scrollRef} className="side-chat-messages">
        {phase === "starting" && (
          <div className="side-chat-state">
            <LoaderCircle className="spin" size={19} />
            <strong>正在创建侧边聊天</strong>
          </div>
        )}
        {phase === "error" && (
          <div className="side-chat-state error">
            <strong>无法创建侧边聊天</strong>
            <span>{error}</span>
            <button type="button" onClick={restart}><RotateCcw size={14} />重试</button>
          </div>
        )}
        {phase === "expired" && (
          <div className="side-chat-state">
            <strong>侧边聊天已过期</strong>
            <span>这个临时侧边聊天已不可用，请新建侧边聊天后继续。</span>
            <button type="button" onClick={restart}><RotateCcw size={14} />新建侧边聊天</button>
          </div>
        )}
        {phase === "ready" && messages.length === 0 && (
          <div className="side-chat-state side-chat-empty-state">
            <MessageSquare size={22} strokeWidth={1.45} />
            <strong>侧边聊天</strong>
            <span>侧边聊天是临时的，关闭应用后会消失。</span>
            <small>它继承当前任务的上下文，但不会改变主对话。</small>
          </div>
        )}
        {messages.map((message, index) => (
          <Message
            key={message.id}
            message={message}
            showThinking={showThinking}
            expectVisibleThinking={thinkingLevel !== "off"}
            isLastAssistant={message.role === "assistant" && index === messages.length - 1}
            globalStreaming={isStreaming}
          />
        ))}
      </div>

      <div className="side-chat-composer-dock">
        <Composer
          variant="follow-up"
          isStreaming={isStreaming}
          isSwitchingModel={isSwitchingModel}
          disabled={phase !== "ready"}
          attachments={attachments}
          commands={commands}
          models={models}
          model={model}
          thinkingLevel={thinkingLevel}
          thinkingLevels={thinkingLevels}
          pendingCount={0}
          requireCtrlEnter={settings?.requireCtrlEnter}
          defaultFollowUpBehavior={settings?.followUpBehavior}
          permissionMode={permissionMode}
          permissionLabel={permissionLabel(permissionMode)}
          agentMode={agentMode}
          contextUsage={stats?.contextUsage}
          onSend={submit}
          onStop={stop}
          onPickAttachments={() => void pickAttachments()}
          onRemoveAttachment={(path) => setAttachments((current) => current.filter((item) => item.path !== path))}
          onModelChange={(next) => void changeModel(next)}
          onThinkingChange={(level) => void changeThinking(level)}
          onPermissionChange={changePermission}
          onAgentModeChange={changeAgentMode}
        />
      </div>

      {extensionRequest && runtimeRef.current && (
        <ExtensionDialog
          request={extensionRequest}
          onAnswer={(response) => {
            const runtimeId = runtimeRef.current;
            setExtensionRequest(null);
            if (runtimeId) void respondToExtension(runtimeId, extensionRequest, response);
          }}
        />
      )}
    </section>
  );
}
