import { useEffect, useRef, useState } from "react";
import { LoaderCircle, MessageSquare, SendHorizontal, Square, X } from "lucide-react";
import { pi, respondToExtension, sendCommand, subscribeToPi } from "../lib/pi";
import type { AgentMessage, AssistantMessage, ExtensionUIRequest, PiEvent, UiMessage, UiToolCall } from "../types";
import { ExtensionDialog } from "./ExtensionDialog";
import { Message } from "./Message";

interface SideChatPanelProps {
  cwd: string;
  parentSessionFile: string | null;
  showThinking: boolean;
  onClose: () => void;
}

function contentText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function assistantThinking(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === "thinking").map((block) => block.thinking).join("");
}

function assistantToUi(message: AssistantMessage, id?: string): UiMessage {
  return {
    id: id || `side-assistant-${message.timestamp}-${Math.random().toString(36).slice(2, 7)}`,
    role: "assistant",
    content: contentText(message),
    thinking: assistantThinking(message) || undefined,
    model: message.model,
    usage: message.usage,
    isError: message.stopReason === "error",
    isStreaming: message.stopReason === "pending",
    timestamp: message.timestamp || Date.now(),
  };
}

export function SideChatPanel({ cwd, parentSessionFile, showThinking, onClose }: SideChatPanelProps) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [phase, setPhase] = useState<"starting" | "ready" | "error">("starting");
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [extensionRequest, setExtensionRequest] = useState<ExtensionUIRequest | null>(null);
  const runtimeRef = useRef<string | null>(null);
  const sideSessionFileRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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

    const handleEvent = (runtimeId: string, event: PiEvent) => {
      if (runtimeId !== runtimeRef.current) return;
      if (event.type === "agent_start") setIsStreaming(true);
      if (event.type === "agent_end" && !event.willRetry) setIsStreaming(false);
      if (event.type === "agent_settled") setIsStreaming(false);
      if (event.type === "message_start" && event.message.role === "assistant") {
        const message = assistantToUi(event.message, `side-stream-${Date.now()}`);
        setMessages((current) => [...current, { ...message, isStreaming: true }]);
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
            toolCalls: [...(message.toolCalls ?? []), {
              id: call.id,
              name: call.name,
              args: call.arguments,
              running: true,
            }],
            isStreaming: true,
          }));
        }
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const completedMessage = event.message;
        setMessages((current) => {
          const next = [...current];
          let index = next.length - 1;
          while (index >= 0 && next[index].role !== "assistant") index -= 1;
          const completed = assistantToUi(completedMessage, index >= 0 ? next[index].id : undefined);
          if (index >= 0 && next[index].isStreaming) {
            next[index] = {
              ...next[index],
              ...completed,
              isStreaming: false,
              thinking: completed.thinking || next[index].thinking,
            };
          }
          else next.push({ ...completed, isStreaming: false });
          return next;
        });
      }
      if (event.type === "tool_execution_start") {
        updateAssistant((message) => ({
          ...message,
          toolCalls: upsertToolCall(message.toolCalls, {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
            running: true,
          }),
        }));
      }
      if (event.type === "tool_execution_end") {
        updateAssistant((message) => ({
          ...message,
          toolCalls: upsertToolCall(message.toolCalls, {
            id: event.toolCallId,
            name: event.toolName,
            args: {},
            running: false,
            isError: event.isError,
            result: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
          }),
        }));
      }
      if (event.type === "extension_ui_request" && !["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(event.method)) {
        setExtensionRequest(event);
      }
    };

    void (async () => {
      try {
        unsubscribe = await subscribeToPi({
          onEvent: handleEvent,
          onStatus: () => undefined,
          onLog: () => undefined,
        });
        if (disposed) return;
        const started = await pi.start(cwd, parentSessionFile || undefined, true);
        if (disposed) { void pi.stop(started.runtimeId); return; }
        runtimeRef.current = started.runtimeId;
        if (parentSessionFile) {
          const state = await sendCommand(started.runtimeId, "get_state");
          const sideFile = typeof state.data?.sessionFile === "string" ? state.data.sessionFile : null;
          if (!sideFile || sideFile === parentSessionFile) throw new Error("无法创建临时分叉");
          sideSessionFileRef.current = sideFile;
          await pi.bindSession(started.runtimeId, sideFile);
        }
        if (!disposed) setPhase("ready");
      } catch (reason) {
        if (!disposed) {
          setPhase("error");
          setError(reason instanceof Error ? reason.message : String(reason));
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
      if (runtimeId) {
        void pi.stop(runtimeId).finally(() => {
          if (sideFile) void pi.deleteSession(sideFile).catch(() => undefined);
        });
      }
    };
  }, [cwd, parentSessionFile]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, isStreaming]);

  const submit = async () => {
    const text = draft.trim();
    const runtimeId = runtimeRef.current;
    if (!text || !runtimeId || phase !== "ready" || isStreaming) return;
    setDraft("");
    setMessages((current) => [...current, {
      id: `side-user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
    }]);
    setIsStreaming(true);
    try {
      await sendCommand(runtimeId, "prompt", { message: text, images: [] }, 60_000);
    } catch (reason) {
      setIsStreaming(false);
      setMessages((current) => [...current, {
        id: `side-error-${Date.now()}`,
        role: "notice",
        content: reason instanceof Error ? reason.message : String(reason),
        isError: true,
        timestamp: Date.now(),
      }]);
    }
  };

  const stop = () => {
    const runtimeId = runtimeRef.current;
    if (runtimeId) void sendCommand(runtimeId, "abort").finally(() => setIsStreaming(false));
  };

  return (
    <section className="side-chat-pane" aria-label="侧边聊天">
      <header className="workspace-pane-header">
        <span className="workspace-pane-title">
          <MessageSquare size={15} strokeWidth={1.75} />
          <strong>侧边聊天</strong>
          <small>{phase === "starting" ? "正在创建分叉" : "临时分叉"}</small>
        </span>
        <button type="button" className="icon-button" title="关闭侧边聊天" onClick={onClose}>
          <X size={14} strokeWidth={1.75} />
        </button>
      </header>
      <div ref={scrollRef} className="side-chat-messages">
        {phase === "starting" && <div className="side-chat-empty"><LoaderCircle className="spin" size={17} />正在从当前对话创建临时分叉…</div>}
        {phase === "error" && <div className="side-chat-empty error">{error || "无法创建侧边聊天"}</div>}
        {phase === "ready" && messages.length === 0 && <div className="side-chat-empty">从这里询问不会改变主对话上下文</div>}
        {messages.map((message, index) => (
          <Message
            key={message.id}
            message={message}
            showThinking={showThinking}
            isLastAssistant={message.role === "assistant" && index === messages.length - 1}
            globalStreaming={isStreaming}
            summaryMode
          />
        ))}
      </div>
      <div className="side-chat-composer">
        <textarea
          value={draft}
          rows={3}
          placeholder="在临时分叉中提问"
          disabled={phase !== "ready"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {isStreaming ? (
          <button type="button" className="side-chat-send" title="停止" onClick={stop}>
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button type="button" className="side-chat-send" title="发送" disabled={phase !== "ready" || !draft.trim()} onClick={() => void submit()}>
            <SendHorizontal size={15} strokeWidth={1.8} />
          </button>
        )}
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

function upsertToolCall(calls: UiToolCall[] | undefined, call: UiToolCall): UiToolCall[] {
  const next = [...(calls ?? [])];
  const index = next.findIndex((item) => item.id === call.id);
  if (index >= 0) next[index] = { ...next[index], ...call, args: Object.keys(call.args).length ? call.args : next[index].args };
  else next.push(call);
  return next;
}
