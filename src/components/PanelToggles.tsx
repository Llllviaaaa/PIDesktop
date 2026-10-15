/**
 * The topbar's panel switches: icons for the terminal, review and browser,
 * and a ⋯ menu for the dock's other tools. Each icon opens its panel, or
 * closes it when it is already showing.
 */
import { useEffect, useRef, useState } from "react";
import { Check, MoreHorizontal, SquareTerminal } from "lucide-react";
import { WORKSPACE_TOOLS, type WorkspaceTool } from "./ToolRail";

const PINNED_IDS: WorkspaceTool[] = ["review", "browser"];
const PINNED_TOOLS = WORKSPACE_TOOLS.filter((tool) => PINNED_IDS.includes(tool.id));
const MENU_TOOLS = WORKSPACE_TOOLS.filter((tool) => !PINNED_IDS.includes(tool.id));

interface PanelTogglesProps {
  terminalOpen: boolean;
  terminalTitle: string;
  /** Terminals running while the panel is hidden; `unseen` when they printed since. */
  backgroundTerminals: "none" | "seen" | "unseen";
  onToggleTerminal: () => void;
  /** The tool the dock is showing, or null while the dock is closed. */
  activeTool: WorkspaceTool | null;
  onToggleTool: (tool: WorkspaceTool) => void;
}

function toolTitle(tool: (typeof WORKSPACE_TOOLS)[number]): string {
  return tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label;
}

export function PanelToggles({
  terminalOpen,
  terminalTitle,
  backgroundTerminals,
  onToggleTerminal,
  activeTool,
  onToggleTool,
}: PanelTogglesProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuToolActive = MENU_TOOLS.some((tool) => tool.id === activeTool);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={`panel-toggle terminal-toggle ${terminalOpen ? "active" : ""}`}
        title={terminalTitle}
        aria-label={terminalTitle}
        aria-pressed={terminalOpen}
        onClick={onToggleTerminal}
      >
        <SquareTerminal size={16} strokeWidth={1.75} />
        {backgroundTerminals !== "none" && (
          <i className={`panel-toggle-dot ${backgroundTerminals === "unseen" ? "unseen" : ""}`} aria-hidden />
        )}
      </button>
      {PINNED_TOOLS.map((tool) => {
        const Icon = tool.Icon;
        return (
          <button
            key={tool.id}
            type="button"
            className={`panel-toggle ${activeTool === tool.id ? "active" : ""}`}
            title={toolTitle(tool)}
            aria-label={tool.label}
            aria-pressed={activeTool === tool.id}
            onClick={() => onToggleTool(tool.id)}
          >
            <Icon size={16} strokeWidth={1.75} />
          </button>
        );
      })}
      <div className="topbar-menu-wrap panel-more-menu" ref={wrapRef}>
        <button
          type="button"
          className={`panel-toggle ${menuToolActive || open ? "active" : ""}`}
          title="更多面板"
          aria-label="更多面板"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <MoreHorizontal size={16} strokeWidth={1.75} />
        </button>
        {open && (
          <div className="topbar-menu workspace-tools-popover panel-more-popover" role="menu">
            {MENU_TOOLS.map((tool) => {
              const Icon = tool.Icon;
              const active = activeTool === tool.id;
              return (
                <button
                  key={tool.id}
                  role="menuitemcheckbox"
                  aria-checked={active}
                  onClick={() => {
                    setOpen(false);
                    onToggleTool(tool.id);
                  }}
                >
                  <Icon size={15} />
                  <span>{tool.label}</span>
                  <span className="panel-more-meta">
                    {tool.shortcut && <kbd>{tool.shortcut}</kbd>}
                    {active && <Check className="workspace-editor-selected" size={14} />}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
