import { MessageSquare } from "lucide-react";
import { sameLocalPath } from "../lib/pathIdentity";
import { useAppStore } from "../store";
import { SideChatPanel } from "./SideChatPanel";

interface SideChatTabProps {
  /** Active session file of the conversation on screen. */
  sessionFile: string;
  /** Workspace path fallback before the session list refreshes. */
  fallbackCwd?: string;
  tabId: string;
  visible: boolean;
}

/** The right sidebar's Side Chat tab: one side chat of the conversation on screen per tab. */
export function SideChatTab({ sessionFile, fallbackCwd = "", tabId, visible }: SideChatTabProps) {
  const settings = useAppStore((state) => state.settings);
  const parentModel = useAppStore((state) => state.model);
  const parentThinkingLevel = useAppStore((state) => state.thinkingLevel);
  const parentCommands = useAppStore((state) => state.commands);
  const parentMessageCount = useAppStore((state) => state.messages.length);
  const parentIsStreaming = useAppStore((state) => state.isStreaming);
  const cwd = useAppStore((state) => state.sessions.find((session) => sameLocalPath(session.file, sessionFile))?.cwd
    ?? (state.sessionFile !== null && sameLocalPath(state.sessionFile, sessionFile) ? state.cwd : undefined))
    || fallbackCwd;

  if (!sessionFile || !cwd) {
    return (
      <section className="side-chat-pane" aria-label="侧边聊天" hidden={!visible}>
        <div className="side-chat-messages">
          <div className="side-chat-state side-chat-empty-state">
            <MessageSquare size={22} strokeWidth={1.45} />
            <strong>侧边对话</strong>
            <span>先在左侧开始一个对话任务，即可在此针对当前上下文独立提问。</span>
            <small>侧边对话不会修改或污染主对话记录。</small>
          </div>
        </div>
      </section>
    );
  }
  return (
    <SideChatPanel
      chatId={tabId}
      cwd={cwd}
      parentSessionFile={sessionFile}
      parentModel={parentModel}
      parentThinkingLevel={parentThinkingLevel}
      parentCommands={parentCommands}
      parentMessageCount={parentMessageCount}
      parentIsStreaming={parentIsStreaming}
      hidden={!visible}
      showThinking={settings?.showThinking ?? true}
      settings={settings}
    />
  );
}
