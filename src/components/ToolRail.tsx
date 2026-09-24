import { ClipboardList, FileDiff, Folders, Globe2, MessageSquarePlus, X } from "lucide-react";

/**
 * Tools of the right-hand workspace dock. The terminal is not one of them: it
 * has a single home in the bottom panel (Ctrl+J), so there is one set of
 * shells instead of two.
 */
export type WorkspaceTool = "summary" | "review" | "browser" | "files" | "side-chat";

export const WORKSPACE_TOOLS: Array<{
  id: WorkspaceTool;
  label: string;
  shortcut: string;
  Icon: typeof FileDiff;
}> = [
  { id: "summary", label: "摘要", shortcut: "", Icon: ClipboardList },
  { id: "review", label: "审查", shortcut: "Ctrl+Shift+G", Icon: FileDiff },
  { id: "browser", label: "浏览器", shortcut: "Ctrl+T", Icon: Globe2 },
  { id: "files", label: "文件", shortcut: "Ctrl+P", Icon: Folders },
  { id: "side-chat", label: "侧边聊天", shortcut: "Ctrl+Alt+S", Icon: MessageSquarePlus },
];

export function isWorkspaceTool(value: unknown): value is WorkspaceTool {
  return WORKSPACE_TOOLS.some((tool) => tool.id === value);
}

interface ToolRailProps {
  active: WorkspaceTool;
  onSelect: (tool: WorkspaceTool) => void;
  onClose: () => void;
  /** Small counts next to a tab label (changed files, side chats). */
  badges?: Partial<Record<WorkspaceTool, number>>;
  /** Tools that are working in the background (a streaming side chat). */
  busy?: Partial<Record<WorkspaceTool, boolean>>;
}

/**
 * The dock's tab strip: one click switches tools, and every tool keeps its state.
 * Only the active tab shows its label, so all five fit a narrow dock.
 */
export function ToolRail({ active, onSelect, onClose, badges = {}, busy = {} }: ToolRailProps) {
  return (
    <nav className="workspace-dock-tabs" aria-label="侧边栏工具">
      <div className="workspace-dock-tab-list" role="tablist">
      {WORKSPACE_TOOLS.map((item) => {
        const Icon = item.Icon;
        const badge = badges[item.id];
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active === item.id}
            className={`workspace-dock-tab ${active === item.id ? "active" : ""}${busy[item.id] ? " busy" : ""}`}
            title={item.shortcut ? `${item.label} (${item.shortcut})` : item.label}
            onClick={() => onSelect(item.id)}
          >
            <Icon size={14} strokeWidth={1.75} />
            <span className={active === item.id ? undefined : "visually-hidden"}>{item.label}</span>
            {badge ? <small>{badge > 99 ? "99+" : badge}</small> : null}
          </button>
        );
      })}
      </div>
      <button type="button" className="workspace-dock-close" title="关闭侧边栏 (Ctrl+Alt+B)" aria-label="关闭侧边栏" onClick={onClose}>
        <X size={14} strokeWidth={1.75} />
      </button>
    </nav>
  );
}
