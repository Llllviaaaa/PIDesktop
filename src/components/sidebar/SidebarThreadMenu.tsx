/**
 * Right-click menu on a session row: pin/archive plus plugin items registered
 * for `sidebar.thread`. It lives inside the sidebar (like the project menu)
 * so hover-preview mode stays open while the pointer is on it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { Archive, Pin } from "lucide-react";
import { sessionTitle } from "../../lib/sessionTitle";
import type { SessionInfo } from "../../types";
import { PluginMenuItems } from "../common/PluginMenuItems";

export interface PositionedThreadMenu {
  session: SessionInfo;
  /** Offset from the sidebar's top edge, before clamping to the sidebar height. */
  top: number;
}

/** Keeps the menu clear of the sidebar header. */
const MIN_TOP = 54;
const BOTTOM_MARGIN = 8;

export function useSidebarThreadMenu(sidebarRef: RefObject<HTMLElement | null>) {
  const [threadMenu, setThreadMenu] = useState<PositionedThreadMenu | null>(null);
  const openThreadMenu = useCallback((event: ReactMouseEvent<HTMLElement>, session: SessionInfo) => {
    event.preventDefault();
    event.stopPropagation();
    const sidebarTop = sidebarRef.current?.getBoundingClientRect().top ?? 0;
    setThreadMenu({ session, top: Math.max(MIN_TOP, event.clientY - sidebarTop - 7) });
  }, [sidebarRef]);
  const closeThreadMenu = useCallback(() => setThreadMenu(null), []);
  return { threadMenu, openThreadMenu, closeThreadMenu };
}

export interface SidebarThreadMenuProps {
  menu: PositionedThreadMenu;
  pinned: boolean;
  onClose: () => void;
  onTogglePinned: (file: string) => void;
  onArchive: (session: SessionInfo) => void | Promise<void>;
}

export function SidebarThreadMenu({ menu, pinned, onClose, onTogglePinned, onArchive }: SidebarThreadMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { session } = menu;
  const title = sessionTitle(session);

  // Pull the menu up when its measured height would run past the sidebar's bottom edge.
  useLayoutEffect(() => {
    const element = ref.current;
    const container = element?.parentElement;
    if (!element || !container) return;
    const maxTop = container.clientHeight - element.offsetHeight - BOTTOM_MARGIN;
    element.style.top = `${Math.max(MIN_TOP, Math.min(menu.top, maxTop))}px`;
  }, [menu.top]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="sidebar-popover project-context-menu thread-context-menu"
      style={{ top: menu.top }}
      data-sidebar-popover
      role="menu"
      aria-label={title}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onTogglePinned(session.file);
        }}
      >
        <Pin size={15} />{pinned ? "取消置顶对话" : "置顶对话"}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          void onArchive(session);
        }}
      >
        <Archive size={15} />归档对话
      </button>
      <PluginMenuItems
        location="sidebar.thread"
        context={{ cwd: session.cwd, sessionFile: session.file, title }}
        onClose={onClose}
        separatorClassName="sidebar-popover-separator"
      />
    </div>
  );
}
