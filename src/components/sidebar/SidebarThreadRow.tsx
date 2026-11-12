import type { MouseEvent as ReactMouseEvent } from "react";
import { Archive, Pin } from "lucide-react";
import { sessionTitle } from "../../lib/sessionTitle";
import type { SessionInfo } from "../../types";
import { compactRelativeTime } from "./sidebarHelpers";

export interface SidebarThreadRowProps {
  session: SessionInfo;
  active: boolean;
  running: boolean;
  approval: boolean;
  pinned: boolean;
  /** Search hit excerpt shown under the title while filtering. */
  snippet?: string;
  onOpen: () => void;
  onTogglePinned: () => void;
  onArchive: () => void;
  onShowPreview: (element: HTMLElement) => void;
  onHidePreview: () => void;
  /** Right-click (or the context-menu key) on the row. */
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}

/** One session row in the primary sidebar, with hover pin/archive actions. */
export function SidebarThreadRow({
  session,
  active,
  running,
  approval,
  pinned,
  snippet,
  onOpen,
  onTogglePinned,
  onArchive,
  onShowPreview,
  onHidePreview,
  onContextMenu,
}: SidebarThreadRowProps) {
  const status = approval ? "approval" : running ? "running" : active ? "active" : "idle";
  return (
    <div
      className={`thread-row-shell ${active ? "active" : ""}${snippet ? " has-snippet" : ""}`}
      onMouseEnter={(event) => onShowPreview(event.currentTarget)}
      onMouseLeave={onHidePreview}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        className={`thread-row ${active ? "active" : ""}`}
        onClick={onOpen}
        title={sessionTitle(session)}
      >
        <span
          className="thread-status"
          data-status={status}
          title={approval ? "等待审批" : running ? "运行中" : undefined}
        />
        <span className="thread-title">{sessionTitle(session)}</span>
        {approval
          ? <span className="thread-row-time thread-row-badge">待审批</span>
          : <span className="thread-row-time">{compactRelativeTime(session)}</span>}
      </button>
      {snippet && (
        <button
          type="button"
          className="thread-search-snippet"
          onClick={onOpen}
          title={snippet}
        >
          {snippet}
        </button>
      )}
      <div className="thread-row-actions">
        <button
          type="button"
          className={pinned ? "is-pinned" : ""}
          title={pinned ? "取消置顶" : "置顶对话"}
          aria-label={pinned ? "取消置顶对话" : "置顶对话"}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePinned();
          }}
        >
          <Pin size={14} />
        </button>
        <button
          type="button"
          title="归档对话"
          aria-label="归档对话"
          onClick={(event) => {
            event.stopPropagation();
            onArchive();
          }}
        >
          <Archive size={14} />
        </button>
      </div>
    </div>
  );
}
