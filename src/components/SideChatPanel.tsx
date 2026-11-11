/**
 * A side chat: a throwaway fork of the conversation on screen, in its own
 * runtime, shown in the right sidebar's Side Chat tab. Pi forks the session
 * into a scratch directory; the Harness Host forks it into a hidden session.
 * Either way the fork is removed when the runtime stops.
 */
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, LoaderCircle, MessageSquare, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useSyncOnChange } from "../hooks/useSyncOnChange";
import {
  buildPromptPayload,
  harnessRuntimes,
  parseLeadingSlashCommand,
} from "../lib/harnessRuntime";
import { agent, respondToExtension, subscribeToRuntimes } from "../lib/agent";
import {
  completeAssistant,
  endToolCall,
  interruptTurn,
  replaceOrAppend,
  resetStreamingAssistant,
  startAssistant,
  startToolCall,
  streamAssistant,
  type TranscriptEvent,
} from "../lib/transcript";
import { sameLocalPath } from "../lib/pathIdentity";
import { loadAttachmentFiles, mergeAttachments } from "../lib/attachments";
import { filterHiddenModels } from "../lib/modelProviders";
import { fallbackThinkingLevel, mergeThinkingLevels } from "../lib/thinkingLevels";
import { findMentionCandidates } from "../lib/workspaceSearch";
import { useAppStore } from "../store";
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
  parentModel?: ModelInfo | null;
  parentThinkingLevel?: string;
  parentCommands?: SlashCommand[];
  parentMessageCount?: number;
  parentIsStreaming?: boolean;
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
  if (!normalized || normalized.startsWith("/")) return "侧边对话";
  return normalized.length > 28 ? `${normalized.slice(0, 28)}…` : normalized;
}

const EMPTY_COMMANDS: SlashCommand[] = [];

export function SideChatPanel({
  chatId,
  cwd,
  parentSessionFile,
  parentModel = null,
  parentThinkingLevel,
  parentCommands = EMPTY_COMMANDS,
  parentMessageCount = 0,
  parentIsStreaming = false,
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
  const [isCompacting, setIsCompacting] = useState(false);
  const [retryStatus, setRetryStatus] = useState<string | null>(null);
  const [extensionRequest, setExtensionRequest] = useState<ExtensionUIRequest | null>(null);
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<ModelInfo | null>(parentModel);
  const [thinkingLevel, setThinkingLevel] = useState(parentThinkingLevel ?? "off");
  const [thinkingLevels, setThinkingLevels] = useState<string[]>(["off"]);
  const [fetchedCommands, setFetchedCommands] = useState<SlashCommand[] | null>(null);
  const [isSwitchingModel, setIsSwitchingModel] = useState(false);
  const [permissionOverride, setPermissionOverride] = useState<AppSettings["permissionMode"] | null>(null);
  const [agentModeOverride, setAgentModeOverride] = useState<AppSettings["agentMode"] | null>(null);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [title, setTitle] = useState("侧边对话");
  const [restartToken, setRestartToken] = useState(0);
  const [forkedParentCount, setForkedParentCount] = useState(parentMessageCount);

  // Side Chat defaults to read-only `ask` mode (like `/btw` with read-only codebase lookup)
  // so side questions never mutate the shared workspace unless the user explicitly switches modes.
  const agentMode: AppSettings["agentMode"] = agentModeOverride ?? "ask";
  const permissionMode: AppSettings["permissionMode"] =
    permissionOverride ?? (agentMode === "agent" ? (settings?.permissionMode ?? "ask") : "read-only");

  const runtimeRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeTurnStartedAtRef = useRef<number | null>(null);
  const parentSyncInputsRef = useRef({
    parentModel,
    parentThinkingLevel,
    permissionMode,
    agentMode,
  });

  useEffect(() => {
    parentSyncInputsRef.current = {
      parentModel,
      parentThinkingLevel,
      permissionMode,
      agentMode,
    };
  }, [agentMode, parentModel, parentThinkingLevel, permissionMode]);

  const displayMessages = useMemo(() => groupTranscriptMessages(messages), [messages]);
  const visibleModels = useMemo(
    () => filterHiddenModels(models, settings?.hiddenModels, model),
    [model, models, settings?.hiddenModels],
  );
  const commands = fetchedCommands ?? parentCommands;

  // Keep an untouched side chat synced to the latest settled main conversation turn.
  useSyncOnChange([parentMessageCount, parentIsStreaming], () => {
    if (parentIsStreaming || parentMessageCount <= forkedParentCount) return;
    if (messages.length === 0 && !isStreaming && phase === "ready") {
      setForkedParentCount(parentMessageCount);
      setPhase("starting");
      setError(null);
      setRestartToken((value) => value + 1);
    }
  });

  useSyncOnChange([cwd, parentSessionFile], () => {
    setPhase("starting");
    setError(null);
    setForkedParentCount(parentMessageCount);
  });

  const hasNewerParentContext = !parentIsStreaming && parentMessageCount > forkedParentCount && messages.length > 0;

  const reportError = useCallback((reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (onError) onError(message);
    else useAppStore.getState().showToast(message, "error");
    return message;
  }, [onError]);

  useEffect(() => {
    onStateChange?.(chatId, { title, phase, isStreaming });
  }, [chatId, isStreaming, onStateChange, phase, title]);

  // Keep the Host side session's permission & agentMode aligned with UI state.
  useEffect(() => {
    const runtimeId = runtimeRef.current;
    if (!runtimeId || phase !== "ready") return;
    void harnessRuntimes.setPermission(runtimeId, {
      permission: permissionMode,
      agentMode,
    }).catch(() => undefined);
  }, [agentMode, permissionMode, phase]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let pendingTextDelta = "";
    let pendingThinkingDelta = "";
    let deltaFlushTimer: number | null = null;

    const flushPendingDeltas = () => {
      if (deltaFlushTimer !== null) {
        window.clearTimeout(deltaFlushTimer);
        deltaFlushTimer = null;
      }
      if (!pendingTextDelta && !pendingThinkingDelta) return;
      const text = pendingTextDelta;
      const thinking = pendingThinkingDelta;
      pendingTextDelta = "";
      pendingThinkingDelta = "";
      if (disposed) return;
      setMessages((current) => streamAssistant(current, {
        ...(text ? { text } : {}),
        ...(thinking ? { thinking } : {}),
      }));
    };

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
          flushPendingDeltas();
          activeTurnStartedAtRef.current = Date.now();
          setRetryStatus(null);
          setIsStreaming(true);
          return;
        case "turn-end":
          flushPendingDeltas();
          activeTurnStartedAtRef.current = null;
          setRetryStatus(null);
          setIsStreaming(false);
          void refreshStats(runtimeId);
          return;
        case "turn-interrupted":
          flushPendingDeltas();
          setRetryStatus(null);
          setIsStreaming(false);
          setMessages((current) => interruptTurn(current));
          return;
        case "user":
          flushPendingDeltas();
          setMessages((current) => {
            const last = [...current].reverse().find((message) => message.role === "user");
            const pending = last && !last.entryId && last.content === event.message.content ? last.id : undefined;
            return replaceOrAppend(current, pending, event.message);
          });
          return;
        case "assistant-start":
          flushPendingDeltas();
          setRetryStatus(null);
          setMessages((current) => startAssistant(current));
          return;
        case "assistant-delta":
          setRetryStatus(null);
          if (event.text) pendingTextDelta += event.text;
          if (event.thinking) pendingThinkingDelta += event.thinking;
          if (deltaFlushTimer === null) {
            deltaFlushTimer = window.setTimeout(flushPendingDeltas, 32);
          }
          return;
        case "assistant-tool-calls":
          flushPendingDeltas();
          setRetryStatus(null);
          setMessages((current) => streamAssistant(current, { toolCalls: event.calls }));
          return;
        case "assistant": {
          flushPendingDeltas();
          const startedAt = activeTurnStartedAtRef.current;
          const durationMs = startedAt === null ? undefined : Date.now() - startedAt;
          setRetryStatus(null);
          setMessages((current) => completeAssistant(current, { ...event.message, durationMs }));
          return;
        }
        case "retry-status":
          flushPendingDeltas();
          setRetryStatus(event.text);
          setMessages((current) => resetStreamingAssistant(current));
          return;
        case "tool-start":
          flushPendingDeltas();
          setMessages((current) => startToolCall(current, event.callId, event.name, event.args));
          return;
        case "tool-end":
          flushPendingDeltas();
          setMessages((current) => endToolCall(current, event.callId, event.name, event.result));
          return;
        case "compaction-start":
          setIsCompacting(true);
          return;
        case "compaction-end":
          setIsCompacting(false);
          return;
        case "ui-request":
          if (event.request.method === "notify") {
            useAppStore.getState().showToast(event.request.message, event.request.notifyType ?? "info");
          } else {
            setExtensionRequest(event.request);
          }
          return;
        default:
          return;
      }
    };

    // Stopping a side runtime also removes its forked session, which lives outside the session list.
    const stopAndDeleteSideRuntime = (runtimeId: string) => agent.stop(runtimeId).catch(() => undefined);

    void (async () => {
      try {
        unsubscribe = await subscribeToRuntimes({
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
        const started = await agent.start(cwd, parentSessionFile, true);
        if (disposed) {
          void stopAndDeleteSideRuntime(started.runtimeId);
          return;
        }
        runtimeRef.current = started.runtimeId;
        const [state, availableModels, availableCommands] = await Promise.all([
          harnessRuntimes.state(started.runtimeId),
          harnessRuntimes.models(),
          harnessRuntimes.commands(cwd).catch((): SlashCommand[] | null => null),
        ]);
        const sideFile = state.sessionFile ?? null;
        if (!sideFile || sameLocalPath(sideFile, parentSessionFile)) {
          throw new Error("无法创建独立的侧边聊天会话");
        }
        await agent.bindSession(started.runtimeId, sideFile);

        const initial = parentSyncInputsRef.current;
        await harnessRuntimes.setPermission(started.runtimeId, {
          permission: initial.permissionMode,
          agentMode: initial.agentMode,
        }).catch(() => undefined);

        let resolvedModel = state.model ?? initial.parentModel ?? null;
        if (
          initial.parentModel
          && (!state.model
            || state.model.provider !== initial.parentModel.provider
            || state.model.id !== initial.parentModel.id)
        ) {
          resolvedModel = await harnessRuntimes
            .setModel(started.runtimeId, initial.parentModel.provider, initial.parentModel.id)
            .catch(() => resolvedModel);
        }

        let resolvedLevel = state.thinkingLevel ?? initial.parentThinkingLevel ?? "off";
        if (
          initial.parentThinkingLevel
          && initial.parentThinkingLevel !== resolvedLevel
        ) {
          await harnessRuntimes
            .setThinkingLevel(started.runtimeId, initial.parentThinkingLevel)
            .then(() => {
              resolvedLevel = initial.parentThinkingLevel ?? resolvedLevel;
            })
            .catch(() => undefined);
        }

        if (!disposed) {
          setModel(resolvedModel);
          setThinkingLevel(resolvedLevel);
          setModels(availableModels);
          setThinkingLevels(harnessRuntimes.thinkingLevels(resolvedModel));
          if (availableCommands !== null) setFetchedCommands(availableCommands);
          setError(null);
          setPhase("ready");
          void refreshStats(started.runtimeId);
        }
      } catch (reason) {
        const runtimeId = runtimeRef.current;
        runtimeRef.current = null;
        if (runtimeId) await stopAndDeleteSideRuntime(runtimeId);
        if (!disposed) {
          setPhase("error");
          const message = reason instanceof Error ? reason.message : String(reason);
          setError(message);
          onError?.(message);
        }
      }
    })();

    return () => {
      disposed = true;
      if (deltaFlushTimer !== null) {
        window.clearTimeout(deltaFlushTimer);
        deltaFlushTimer = null;
      }
      unsubscribe?.();
      const runtimeId = runtimeRef.current;
      runtimeRef.current = null;
      if (runtimeId) void stopAndDeleteSideRuntime(runtimeId);
    };
  }, [cwd, onError, parentSessionFile, restartToken]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isStreaming, messages]);

  const restart = useCallback(() => {
    setMessages([]);
    setAttachments([]);
    setStats(null);
    setRetryStatus(null);
    setIsCompacting(false);
    setPermissionOverride(null);
    setAgentModeOverride(null);
    setTitle("侧边对话");
    setError(null);
    setPhase("starting");
    setForkedParentCount(parentMessageCount);
    setRestartToken((value) => value + 1);
  }, [parentMessageCount]);

  const submit = async (text: string, behavior?: "steer" | "followUp") => {
    const runtimeId = runtimeRef.current;
    const payload = buildPromptPayload(text, attachments);
    if (!runtimeId || phase !== "ready" || (!payload.message && payload.images.length === 0)) return false;
    const wasStreaming = isStreaming;

    let effectivePayload = payload;
    if (!wasStreaming && payload.images.length === 0) {
      const slash = parseLeadingSlashCommand(payload.message);
      if (slash !== null) {
        try {
          const commandResult = await harnessRuntimes.runCommand(runtimeId, slash.name, slash.rawArgs);
          if (commandResult.handled) {
            if (commandResult.clientAction === "clear") {
              restart();
              return true;
            }
            if (commandResult.clientAction === "compact") {
              setIsCompacting(true);
              try {
                await harnessRuntimes.compact(runtimeId);
                const nextStats = await harnessRuntimes.stats(runtimeId).catch(() => null);
                if (runtimeRef.current === runtimeId) setStats(nextStats);
                setMessages((current) => [
                  ...current,
                  {
                    id: `side-compact-${Date.now()}`,
                    role: "notice",
                    content: "已压缩侧边对话上下文。",
                    timestamp: Date.now(),
                  },
                ]);
              } finally {
                setIsCompacting(false);
              }
              return true;
            }
            if (commandResult.prompt !== undefined && commandResult.prompt.trim() !== "") {
              effectivePayload = { message: commandResult.prompt, images: [] };
            } else {
              const now = Date.now();
              const nonce = `${now}-${Math.random().toString(36).slice(2, 7)}`;
              const outputText = commandResult.output ?? `已执行 \`/${slash.name}\`。`;
              setMessages((current) => [
                ...current,
                {
                  id: `side-slash-user-${nonce}`,
                  role: "user",
                  content: payload.message,
                  timestamp: now,
                },
                {
                  id: `side-slash-assistant-${nonce}`,
                  role: "assistant",
                  content: outputText,
                  ...(commandResult.isError ? { isError: true } : {}),
                  timestamp: now,
                },
              ]);
              return true;
            }
          }
        } catch (reason) {
          reportError(reason);
          return false;
        }
      }
    }

    if (!wasStreaming) {
      setMessages((current) => [...current, {
        id: `side-user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "user",
        content: effectivePayload.message,
        images: effectivePayload.images.length
          ? effectivePayload.images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }))
          : undefined,
        timestamp: Date.now(),
      }]);
      if (title === "侧边对话") setTitle(promptTitle(payload.message));
    }
    setAttachments([]);
    setIsStreaming(true);
    if (!wasStreaming) activeTurnStartedAtRef.current = Date.now();
    try {
      if (wasStreaming) {
        await harnessRuntimes.queue(runtimeId, behavior === "followUp" ? "followUp" : "steer", effectivePayload);
      } else {
        await harnessRuntimes.prompt(runtimeId, effectivePayload);
      }
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

  const attachFiles = async (files: string[]) => {
    const loaded = await loadAttachmentFiles(files, reportError);
    setAttachments((current) => mergeAttachments(current, loaded));
  };

  const pickAttachments = async () => {
    const selected = await open({ multiple: true, directory: false, title: "向侧边对话添加文件" });
    await attachFiles(typeof selected === "string" ? [selected] : selected ?? []);
  };

  const changeModel = async (next: ModelInfo) => {
    const runtimeId = runtimeRef.current;
    if (!runtimeId || isSwitchingModel) return;
    const previous = model;
    setModel(next);
    setIsSwitchingModel(true);
    try {
      const confirmed = await harnessRuntimes.setModel(runtimeId, next.provider, next.id);
      const nextLevels = mergeThinkingLevels(
        harnessRuntimes.thinkingLevels(confirmed),
        settings?.customThinkingLevels,
      );
      setModel(confirmed);
      setThinkingLevels(nextLevels);
      const targetLevel = confirmed.reasoning === false
        ? "off"
        : (confirmed.thinkingLevel ?? next.thinkingLevel ?? (nextLevels.length > 0 && !nextLevels.includes(thinkingLevel)
          ? (fallbackThinkingLevel(thinkingLevel, nextLevels) ?? undefined)
          : undefined));
      if (targetLevel && targetLevel !== thinkingLevel) {
        await harnessRuntimes.setThinkingLevel(runtimeId, targetLevel).catch(() => undefined);
        setThinkingLevel(targetLevel);
      }
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
    const nextAgentMode: AppSettings["agentMode"] =
      mode !== "read-only" && agentMode !== "agent" ? "agent" : agentMode;
    try {
      await harnessRuntimes.setPermission(runtimeId, {
        permission: mode,
        agentMode: nextAgentMode,
      });
      setPermissionOverride(mode);
      if (nextAgentMode !== agentMode) {
        setAgentModeOverride(nextAgentMode);
      }
    } catch (reason) {
      reportError(reason);
    }
  };

  const changeAgentMode = async (mode: AppSettings["agentMode"]) => {
    const runtimeId = runtimeRef.current;
    if (!runtimeId || isStreaming) return;
    const nextPermission: AppSettings["permissionMode"] =
      mode === "agent" && permissionOverride === null
        ? (settings?.permissionMode ?? "ask")
        : mode !== "agent" && permissionOverride === null
          ? "read-only"
          : permissionMode;
    try {
      await harnessRuntimes.setPermission(runtimeId, {
        agentMode: mode,
        permission: nextPermission,
      });
      setAgentModeOverride(mode);
    } catch (reason) {
      reportError(reason);
    }
  };

  const requestDelete = () => {
    const confirmed = window.confirm("这个侧边对话将被删除，且无法恢复。你确定吗？");
    if (confirmed) onDelete?.();
  };

  const statusBadge = isCompacting
    ? "正在压缩…"
    : retryStatus || (hasNewerParentContext ? "主对话已有新进展" : "独立分叉 · 不修改主对话");

  return (
    <section className="side-chat-pane" aria-label="侧边聊天" hidden={hidden}>
      <header className="pid-wb-subbar side-chat-header">
        <span className="side-chat-title-group">
          <GitBranch size={12.5} strokeWidth={1.8} className="side-chat-fork-icon" />
          <strong className="side-chat-topic" title={title}>{title}</strong>
          <span className={`side-chat-context-pill${hasNewerParentContext ? " is-stale" : ""}`}>
            {statusBadge}
          </span>
          {(isStreaming || isCompacting) && (
            <LoaderCircle className="spin side-chat-running" size={13} aria-label="运行中" />
          )}
        </span>
        <span className="pid-wb-subbar-actions">
          <button
            type="button"
            className="pid-wb-btn small side-chat-reset-btn"
            disabled={phase === "starting" || isStreaming}
            title={hasNewerParentContext ? "清空当前侧边对话并同步主对话最新上下文" : "清空并重新分叉侧边对话"}
            onClick={restart}
          >
            <RotateCcw size={12} strokeWidth={1.8} />
            <span>{hasNewerParentContext ? "同步最新" : "重新开始"}</span>
          </button>
          {onNew && (
            <button type="button" className="pid-wb-icon-btn" title="新建侧边聊天" onClick={onNew}>
              <Plus size={13} strokeWidth={1.75} />
            </button>
          )}
          {onClose && (
            <button type="button" className="pid-wb-icon-btn" title="隐藏侧边聊天" onClick={onClose}>
              <X size={13} strokeWidth={1.75} />
            </button>
          )}
          {onDelete && (
            <button type="button" className="pid-wb-icon-btn side-chat-delete-action" title="删除侧边聊天" onClick={requestDelete}>
              <Trash2 size={13} strokeWidth={1.75} />
            </button>
          )}
        </span>
      </header>

      <div ref={scrollRef} className="side-chat-messages">
        {phase === "starting" && (
          <div className="side-chat-state">
            <LoaderCircle className="spin" size={19} />
            <strong>正在创建侧边对话</strong>
            <span>正在从当前主对话创建独立临时分支…</span>
          </div>
        )}
        {phase === "error" && (
          <div className="side-chat-state error">
            <strong>无法创建侧边对话</strong>
            <span>{error}</span>
            <button type="button" onClick={restart}><RotateCcw size={14} />重试</button>
          </div>
        )}
        {phase === "expired" && (
          <div className="side-chat-state">
            <strong>侧边对话已过期</strong>
            <span>这个临时侧边对话已结束，点击重新开始即可从主对话最新上下文继续。</span>
            <button type="button" onClick={restart}><RotateCcw size={14} />重新开始</button>
          </div>
        )}
        {phase === "ready" && messages.length === 0 && (
          <div className="side-chat-state side-chat-empty-state">
            <MessageSquare size={22} strokeWidth={1.45} />
            <strong>侧边对话</strong>
            <span>继承当前主对话上下文，用于临时追问、验证想法或查阅代码。</span>
            <small>这里的提问和回复完全独立，不会写入或打乱左侧主对话。</small>
          </div>
        )}
        {displayMessages.map((message, index) => (
          <Message
            key={message.id}
            message={message}
            showThinking={showThinking}
            expectVisibleThinking={thinkingLevel !== "off" && model?.reasoning === true}
            isLastAssistant={message.role === "assistant" && index === displayMessages.length - 1}
            globalStreaming={isStreaming}
            requireCtrlEnter={settings?.requireCtrlEnter}
            allowRichContent
          />
        ))}
      </div>

      <div className="side-chat-composer-dock">
        <Composer
          variant="follow-up"
          scope="side"
          isStreaming={isStreaming}
          isSwitchingModel={isSwitchingModel}
          disabled={phase !== "ready"}
          attachments={attachments}
          commands={commands}
          models={visibleModels}
          model={model}
          thinkingLevel={thinkingLevel}
          thinkingLevels={mergeThinkingLevels(thinkingLevels, settings?.customThinkingLevels)}
          pendingCount={0}
          requireCtrlEnter={settings?.requireCtrlEnter}
          defaultFollowUpBehavior={settings?.followUpBehavior}
          workspace={cwd}
          permissionMode={permissionMode}
          permissionLabel={permissionLabel(permissionMode)}
          agentMode={agentMode}
          contextUsage={stats?.contextUsage}
          sessionCost={stats?.cost}
          sessionTokens={stats?.tokens}
          onSend={submit}
          onStop={stop}
          onPickAttachments={() => void pickAttachments()}
          onAttachFiles={(files) => void attachFiles(files)}
          onAttachPayloads={(added) => setAttachments((current) => mergeAttachments(current, added))}
          onSearchFiles={cwd ? (query, signal) => findMentionCandidates(cwd, query, signal) : undefined}
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
