import { FileDiff, Folders, Globe2, MessageSquarePlus, SquareTerminal } from "lucide-react";

export type WorkspaceTool = "review" | "terminal" | "browser" | "files" | "side-chat";

interface ToolRailProps {
  onSelect: (tool: WorkspaceTool) => void;
}

const ITEMS: Array<{
  id: WorkspaceTool;
  label: string;
  shortcut: string;
  Icon: typeof FileDiff;
}> = [
  { id: "review", label: "审查", shortcut: "Ctrl+Shift+G", Icon: FileDiff },
  { id: "terminal", label: "终端", shortcut: "Ctrl+`", Icon: SquareTerminal },
  { id: "browser", label: "浏览器", shortcut: "Ctrl+T", Icon: Globe2 },
  { id: "files", label: "文件", shortcut: "Ctrl+P", Icon: Folders },
  { id: "side-chat", label: "侧边聊天", shortcut: "Ctrl+Alt+S", Icon: MessageSquarePlus },
];

export function ToolRail({ onSelect }: ToolRailProps) {
  return (
    <aside className="workspace-launcher" aria-label="侧边栏工具">
      <div className="workspace-launcher-list">
        {ITEMS.map((item) => {
          const Icon = item.Icon;
          return (
            <button
              key={item.id}
              type="button"
              className="workspace-launcher-item"
              title={item.shortcut ? `${item.label} (${item.shortcut})` : item.label}
              onClick={() => onSelect(item.id)}
            >
              <Icon size={18} strokeWidth={1.7} />
              <span>{item.label}</span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
