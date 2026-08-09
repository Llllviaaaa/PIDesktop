import { useState } from "react";
import { Brain, ChevronDown, ChevronRight, CircleAlert, Terminal } from "lucide-react";
import type { UiMessage } from "../types";
import { Markdown } from "./Markdown";
import { ToolCall } from "./ToolCall";

export function Message({ message, showThinking = true }: { message: UiMessage; showThinking?: boolean }) {
  const [thinkingOpen, setThinkingOpen] = useState(false);

  if (message.role === "user") {
    return (
      <article className="message-row user-message">
        <div className="user-content">
          {message.images && message.images.length > 0 && (
            <div className="message-images">
              {message.images.map((image, index) => (
                <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`附件 ${index + 1}`} />
              ))}
            </div>
          )}
          {message.content && <Markdown content={message.content} />}
        </div>
      </article>
    );
  }

  if (message.role === "terminal") {
    return (
      <article className={`message-row terminal-message ${message.isError ? "error" : ""}`}>
        <div className="notice-heading"><Terminal size={14} /> 终端</div>
        <pre>{message.content}</pre>
      </article>
    );
  }

  if (message.role === "notice") {
    return (
      <article className="message-row notice-message">
        <Markdown content={message.content} />
      </article>
    );
  }

  return (
    <article className={`message-row assistant-message ${message.isError ? "error" : ""}`}>
      {showThinking && message.thinking && (
        <div className="thinking-block">
          <button onClick={() => setThinkingOpen((value) => !value)}>
            {thinkingOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <Brain size={13} />
            {message.isStreaming ? "正在思考…" : "推理过程"}
          </button>
          {thinkingOpen && <pre>{message.thinking}</pre>}
        </div>
      )}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="tool-list">
          {message.toolCalls.map((call) => <ToolCall call={call} key={call.id} />)}
        </div>
      )}
      {message.content && (
        <div className="assistant-content">
          {message.isError && <CircleAlert size={15} className="message-error-icon" />}
          <Markdown content={message.content} />
        </div>
      )}
      {message.usage && !message.isStreaming && (
        <div className="message-usage">
          {message.model && <span>{message.model}</span>}
          <span>{(message.usage.totalTokens ?? message.usage.input + message.usage.output).toLocaleString()} 个 token</span>
        </div>
      )}
      {message.isStreaming && !message.content && <span className="stream-caret" />}
    </article>
  );
}
