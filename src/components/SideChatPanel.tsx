/**
 * A side chat: a throwaway fork of the conversation on screen, in its own
 * runtime, shown in the right sidebar's Side Chat tab. Pi forks the session
 * into a scratch directory; the Harness Host forks it into a hidden session.
 * Either way the fork is removed when the runtime stops.
 */
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, MessageSquare, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { buildPromptPayload, harnessRuntimes } from "../lib/harnessRuntime";
import { pi, respondToExtension, subscribeToPi } from "../lib/pi";
import {
  completeAssistant,
  endToolCall,
  replaceOrAppend,
  startAssistant,
  startToolCall,
  streamAssistant,
  type TranscriptEvent,
} from "../lib/transcript";
import { sameLocalPath } from "../lib/pathIdentity";
import type {
  AppSettings,
  AttachmentPayload,
  ExtensionUIRequest,
  ModelInfo,
  SessionStats,
  SlashCommand,
  UiMessage,
} from "../types";
import { groupTranscriptMessages } from "../lib/transcriptTurns";
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
  /** Header actions; a host with its own tab strip leaves them out. */
  onClose?: () => void;
  onDelete?: () => void;
  onNew?: () => void;
  onStateChange?: (chatId: string, meta: SideChatMeta) => void;
  onError?: (message: string) => void;
}


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

/** The Harness Host has no slash commands of its own. */
const NO_COMMANDS: SlashCommand[] = [];

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
  const [isSwitchingModel, setIsSwitchingModel] = useState(false);
  const [permissionMode, setPermissionMode] = useState<AppSettings["permissionMode"]>(settings?.permissionMode ?? "ask");
  const [agentMode, setAgentMode] = useState<AppSettings["agentMode"]>(settings?.agentMode ?? "agent");
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [title, setTitle] = useState("侧边聊天");
  const [restartToken, setRestartToken] = useState(0);
  const runtimeRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeTurnStartedAtRef = useRef<number | null>(null);
  const displayMessages = useMemo(() => groupTranscriptMessages(messages), [messages]);

  const reportError = useCallback((reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    onError?.(message);
    return message;
  }, [onError]);

  useEffect(() => {
    onStateChange?.(chatId, { title, phase, isStreaming });
  }, [chatId, isStreaming, onStateChange, phase, title]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    const refreshStats = async (runtimeId: string) => {
      try {
        const next = await harnessRuntimes.stats(runtimeId);
        if (!disposed && runtimeRef.current === runtimeId) setStats(next);
      } catch {
        if (!disposed && runtimeRef.current === runtimeId) setStats(null);
      }
    };

    const handleEvent = (runtimeId: string, event: TranscriptEvent) => {
      if (runtimeId !== runtimeRef.current) return;
      switch (event.type) {
        case "turn-start":
          activeTurnStartedAtRef.current = Date.now();
          setIsStreaming(true);
          return;
        case "turn-end":
          setIsStreaming(false);
          void refreshStats(runtimeId);
          return;
        case "user":
          // The message shown when it was sent becomes the recorded one.
          setMessages((current) => {
            const last = [...current].reverse().find((message) => message.role === "user");
            const pending = last && !last.entryId && last.content === event.message.content ? last.id : undefined;
            return replaceOrAppend(current, pending, event.message);
          });
          return;
        case "assistant-start":
          setMessages((current) => startAssistant(current));
          return;
        case "assistant-delta":
          setMessages((current) => streamAssistant(current, event));
          return;
        case "assistant-tool-calls":
          setMessages((current) => streamAssistant(current, { toolCalls: event.calls }));
          return;
        case "assistant": {
          const startedAt = activeTurnStartedAtRef.current;
          const durationMs = startedAt === null ? undefined : Date.now() - startedAt;
          setMessages((current) => completeAssistant(current, { ...event.message, durationMs }));
          return;
        }
        case "tool-start":
          setMessages((current) => startToolCall(current, event.callId, event.name, event.args));
          return;
        case "tool-end":
          setMessages((current) => endToolCall(current, event.callId, event.name, event.result));
          return;
        case "ui-request":
          if (event.request.method !== "notify") setExtensionRequest(event.request);
          return;
        default:
          return;
      }
    };

    // Stopping a side runtime also removes its forked session, which lives outside the session list.
    const stopAndDeleteSideRuntime = (runtimeId: string) => pi.stop(runtimeId).catch(() => undefined);

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
        const [state, availableModels] = await Promise.all([
          harnessRuntimes.state(started.runtimeId),
          harnessRuntimes.models(),
        ]);
        const sideFile = state.sessionFile ?? null;
        if (!sideFile || sameLocalPath(sideFile, parentSessionFile)) {
          throw new Error("无法创建独立的侧边聊天会话");
        }
        await pi.bindSession(started.runtimeId, sideFile);
        if (!disposed) {
          setModel(state.model ?? null);
          setThinkingLevel(state.thinkingLevel ?? "off");
          setModels(availableModels);
          setThinkingLevels(harnessRuntimes.thinkingLevels());
          setPhase("ready");
          void refreshStats(started.runtimeId);
        }
      } catch (reason) {
        const runtimeId = runtimeRef.current;
        runtimeRef.current = null;
        if (runtimeId) await stopAndDeleteSideRuntime(runtimeId);
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
      runtimeRef.current = null;
      if (runtimeId) void stopAndDeleteSideRuntime(runtimeId);
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
      if (wasStreaming) await harnessRuntimes.queue(runtimeId, behavior === "followUp" ? "followUp" : "steer", payload);
      else await harnessRuntimes.prompt(runtimeId, payload);
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
    if (runtimeId) void harnessRuntimes.abort(runtimeId).finally(() => setIsStreaming(false));
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
      setModel(await harnessRuntimes.setModel(runtimeId, next.provider, next.id));
      setThinkingLevels(harnessRuntimes.thinkingLevels());
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
      await harnessRuntimes.setThinkingLevel(runtimeId, level);
      setThinkingLevel(level);
    } catch (reason) {
      reportError(reason);
    }
  };

  const changePermission = async (mode: AppSettings["permissionMode"]) => {
    const runtimeId = runtimeRef.current;
    if (!runtimeId || isStreaming) return;
    try {
      await harnessRuntimes.setPermission(runtimeId, { permission: mode });
      setPermissionMode(mode);
    } catch (reason) {
      reportError(reason);
    }
  };

  const changeAgentMode = async (mode: AppSettings["agentMode"]) => {
    const runtimeId = runtimeRef.current;
    if (!runtimeId || isStreaming) return;
    try {
      await harnessRuntimes.setPermission(runtimeId, { agentMode: mode });
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
    if (confirmed) onDelete?.();
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
          {onNew && (
            <button type="button" className="icon-button" title="新建侧边聊天" onClick={onNew}>
              <Plus size={14} strokeWidth={1.75} />
            </button>
          )}
          {onClose && (
            <button type="button" className="icon-button" title="隐藏侧边聊天" onClick={onClose}>
              <X size={14} strokeWidth={1.75} />
            </button>
          )}
          {onDelete && (
            <button type="button" className="icon-button side-chat-delete-action" title="删除侧边聊天" onClick={requestDelete}>
              <Trash2 size={14} strokeWidth={1.75} />
            </button>
          )}
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
            <span>侧边聊天是临时的，关闭标签页后会消失。</span>
            <small>它继承当前任务的上下文，但不会改变主对话。</small>
          </div>
        )}
        {displayMessages.map((message, index) => (
          <Message
            key={message.id}
            message={message}
            showThinking={showThinking}
            expectVisibleThinking={thinkingLevel !== "off"}
            isLastAssistant={message.role === "assistant" && index === displayMessages.length - 1}
            globalStreaming={isStreaming}
            allowRichContent
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
          commands={NO_COMMANDS}
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
