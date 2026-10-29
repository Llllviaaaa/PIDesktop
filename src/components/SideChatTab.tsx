import { MessageSquare } from "lucide-react";
import { sameLocalPath } from "../lib/pathIdentity";
import { usePiStore } from "../store";
import { SideChatPanel } from "./SideChatPanel";

interface SideChatTabProps {
  /** better-sidebar's session id, which is the desktop's session file. */
  sessionFile: string;
  tabId: string;
  visible: boolean;
}

/** The right sidebar's Side Chat tab: one side chat of the conversation on screen per tab. */
export function SideChatTab({ sessionFile, tabId, visible }: SideChatTabProps) {
  const settings = usePiStore((state) => state.settings);
  const cwd = usePiStore((state) => state.sessions.find((session) => sameLocalPath(session.file, sessionFile))?.cwd
    ?? (state.sessionFile !== null && sameLocalPath(state.sessionFile, sessionFile) ? state.cwd : undefined));

  if (!sessionFile || !cwd) {
    return (
      <section className="side-chat-pane" aria-label="侧边聊天" hidden={!visible}>
        <div className="side-chat-messages">
          <div className="side-chat-state side-chat-empty-state">
            <MessageSquare size={22} strokeWidth={1.45} />
            <strong>侧边聊天</strong>
            <span>先开始一个任务，再在侧边聊天里就它提问。</span>
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
      hidden={!visible}
      showThinking={settings?.showThinking ?? true}
      settings={settings}
    />
  );
}
