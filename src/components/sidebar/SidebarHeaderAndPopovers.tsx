import {
  Bell,
  Check,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  FolderPlus,
  ListFilter,
  MessageCircleQuestion,
  PanelLeftClose,
  Pin,
  Plus,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { QIANJI_BRAND_MARK_SVG } from "../../lib/claudeCrabSheets";
import type { AppNotification } from "../../types";
import type { SidebarGroupMode, SidebarHub } from "./sidebarHelpers";

export interface SidebarHeaderAndPopoversProps {
  query: string;
  setQuery: (next: string) => void;
  searchOpen: boolean;
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  notificationsOpen: boolean;
  setNotificationsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  unreadNotificationCount: number;
  notifications: AppNotification[];
  onMarkAllNotificationsRead: () => void;
  onOpenNotification: (notification: AppNotification) => void;
  onDismissNotification: (id: string) => void;
  newTaskActive: boolean;
  activeHub: SidebarHub;
  newChatShortcut?: string;
  onNewSession: () => void;
  onOpenScheduled: () => void;
  workspaceView: "active" | "archived";
  setWorkspaceView: (next: "active" | "archived") => void;
  groupMode: SidebarGroupMode;
  setGroupMode: (next: SidebarGroupMode) => void;
  filterMenuOpen: boolean;
  setFilterMenuOpen: (next: boolean) => void;
  closePopovers: () => void;
  clearProjectMenu: () => void;
  onPickFolder: () => void;
  toggleSidebarShortcut?: string;
  onPinSidebar?: () => void;
  onCloseSidebar?: () => void;
}

export function SidebarHeaderAndPopovers({
  query,
  setQuery,
  searchOpen,
  setSearchOpen,
  searchInputRef,
  notificationsOpen,
  setNotificationsOpen,
  unreadNotificationCount,
  notifications,
  onMarkAllNotificationsRead,
  onOpenNotification,
  onDismissNotification,
  newTaskActive,
  activeHub,
  newChatShortcut,
  onNewSession,
  onOpenScheduled,
  workspaceView,
  setWorkspaceView,
  groupMode,
  setGroupMode,
  filterMenuOpen,
  setFilterMenuOpen,
  closePopovers,
  clearProjectMenu,
  onPickFolder,
  toggleSidebarShortcut = "Ctrl+B",
  onPinSidebar,
  onCloseSidebar,
}: SidebarHeaderAndPopoversProps) {
  return (
    <>
      <div className="sidebar-brand-row" data-dsh-claude-search-row="">
        <button
          type="button"
          className="codex-brand"
          onClick={onNewSession}
          title="千机"
        >
          <span
            className="dsh-claude-brand-mark"
            style={{ backgroundImage: `url("${QIANJI_BRAND_MARK_SVG}")` }}
            aria-hidden="true"
          />
          <span className="codex-brand-name">千机</span>
        </button>

        <div className="sidebar-brand-actions">
          {onPinSidebar && (
            <button
              type="button"
              className="icon-button sidebar-pin-button"
              title={`固定侧栏 (${toggleSidebarShortcut})`}
              aria-label="固定侧栏"
              onClick={onPinSidebar}
            >
              <Pin size={14} strokeWidth={1.75} />
            </button>
          )}
          {!onPinSidebar && onCloseSidebar && (
            <button
              type="button"
              className="icon-button sidebar-pin-button"
              title={`收起侧栏 (${toggleSidebarShortcut})`}
              aria-label="收起侧栏"
              onClick={onCloseSidebar}
            >
              <PanelLeftClose size={15} strokeWidth={1.75} />
            </button>
          )}
          <button
            type="button"
            className={`icon-button ${searchOpen || query ? "active" : ""}`}
            title={query ? `搜索：${query} (Ctrl+K)` : "搜索会话与项目 (Ctrl+K)"}
            aria-label="搜索会话与项目"
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((value) => !value);
              setNotificationsOpen(false);
              clearProjectMenu();
            }}
          >
            <Search size={15} strokeWidth={1.7} />
          </button>
          <button
            type="button"
            className={`icon-button notification-button ${notificationsOpen ? "active" : ""}`}
            title="通知"
            aria-label="通知"
            aria-expanded={notificationsOpen}
            onClick={() => {
              setNotificationsOpen((value) => !value);
              setSearchOpen(false);
              clearProjectMenu();
            }}
          >
            <Bell size={15} strokeWidth={1.7} />
            {unreadNotificationCount > 0 && <span className="notification-dot" />}
          </button>
        </div>
      </div>

      {searchOpen && (
        <label className="session-search sidebar-search-popover" data-sidebar-popover>
          <Search size={13} />
          <input
            ref={searchInputRef}
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setSearchOpen(false);
                setQuery("");
              }
            }}
            placeholder="搜索会话标题、正文或项目…"
          />
        </label>
      )}

      {notificationsOpen && (
        <div className="sidebar-popover sidebar-notifications" data-sidebar-popover>
          <div className="sidebar-popover-heading">
            <strong>通知</strong>
            {unreadNotificationCount > 0 && (
              <button type="button" onClick={onMarkAllNotificationsRead} title="全部标为已读">
                <Check size={13} />全部已读
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div className="sidebar-notification-empty">暂无新通知</div>
          ) : (
            notifications.map((notification) => (
              <div
                key={notification.id}
                className={`sidebar-notification-row${notification.read ? "" : " unread"}`}
              >
                <button
                  type="button"
                  className="sidebar-notification-open"
                  onClick={() => {
                    setNotificationsOpen(false);
                    onOpenNotification(notification);
                  }}
                >
                  <span className={`sidebar-notification-icon ${notification.kind}`}>
                    {notification.kind === "completion"
                      ? <CheckCircle2 size={15} />
                      : notification.kind === "approval"
                        ? <ShieldCheck size={15} />
                        : <MessageCircleQuestion size={15} />}
                  </span>
                  <span className="sidebar-notification-copy">
                    <strong>{notification.title}</strong>
                    <small>{notification.body}</small>
                    <time>{new Date(notification.createdAt).toLocaleString()}</time>
                  </span>
                </button>
                <button
                  type="button"
                  className="sidebar-notification-dismiss"
                  title="移除通知"
                  aria-label="移除通知"
                  onClick={() => onDismissNotification(notification.id)}
                >
                  <X size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <nav className="sidebar-main-nav">
        <button
          type="button"
          className={`nav-item dsh-claude-new-session ${newTaskActive ? "active" : ""}`}
          onClick={() => { closePopovers(); onNewSession(); }}
        >
          <Plus size={15} strokeWidth={1.85} aria-hidden="true" />
          <span className="dsh-claude-new-session-label">新会话</span>
          {newChatShortcut && (
            <span className="dsh-claude-new-session-shortcut" aria-hidden="true">
              {newChatShortcut}
            </span>
          )}
        </button>
        <button
          type="button"
          className={`nav-item ${activeHub === "scheduled" ? "active" : ""}`}
          onClick={() => { closePopovers(); onOpenScheduled(); }}
        >
          <Clock3 size={15} strokeWidth={1.75} />
          <span>定时任务</span>
        </button>
      </nav>

      <div className="sidebar-projects-header" data-ws-view={workspaceView}>
        {workspaceView === "archived" ? (
          <button
            type="button"
            className="sidebar-projects-back"
            title="返回会话列表"
            onClick={() => setWorkspaceView("active")}
          >
            <ChevronLeft size={13} strokeWidth={1.8} />
            <span>已归档</span>
          </button>
        ) : (
          <span className="sidebar-projects-label">{groupMode === "recent" ? "最近" : "工作区"}</span>
        )}
        <div className="sidebar-projects-tools">
          <button
            type="button"
            className={filterMenuOpen ? "active" : ""}
            title="筛选与分组"
            aria-label="筛选与分组"
            aria-expanded={filterMenuOpen}
            onClick={(event) => {
              event.stopPropagation();
              const nextOpen = !filterMenuOpen;
              closePopovers();
              setFilterMenuOpen(nextOpen);
            }}
          >
            <ListFilter size={14} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            title="打开项目文件夹"
            aria-label="打开项目文件夹"
            onClick={() => { closePopovers(); onPickFolder(); }}
          >
            <FolderPlus size={14} strokeWidth={1.8} />
          </button>
        </div>
        {filterMenuOpen && (
          <div className="sidebar-popover sidebar-filter-menu" data-sidebar-popover role="menu">
            <div className="sidebar-popover-caption">分组方式</div>
            {([["project", "按项目"], ["recent", "按时间"]] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="menuitemradio"
                aria-checked={workspaceView === "active" && groupMode === mode}
                onClick={() => { setGroupMode(mode); setWorkspaceView("active"); setFilterMenuOpen(false); }}
              >
                <span>{label}</span>
                {workspaceView === "active" && groupMode === mode && <Check size={14} />}
              </button>
            ))}
            <div className="sidebar-popover-separator" />
            <button
              type="button"
              role="menuitemradio"
              aria-checked={workspaceView === "archived"}
              onClick={() => { setWorkspaceView(workspaceView === "archived" ? "active" : "archived"); setFilterMenuOpen(false); }}
            >
              <span>已归档会话</span>
              {workspaceView === "archived" && <Check size={14} />}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
