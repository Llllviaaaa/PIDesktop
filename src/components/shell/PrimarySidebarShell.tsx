import { agent } from "../../lib/agent";
import type { ClientContributionsSnapshot } from "../../lib/clientContributions";
import { describeError } from "../../lib/errors";
import { sameLocalPath } from "../../lib/pathIdentity";
import type { AppNotification, AppSettings, SessionInfo } from "../../types";
import { RegionErrorBoundary, SlotEntryHost } from "../common/ErrorBoundary";
import type { SettingsPage } from "../SettingsModal";
import { Sidebar } from "../Sidebar";
import type { HubView, NavigationTarget } from "./shellTypes";

export interface PrimarySidebarShellProps {
  sidebarVisible: boolean;
  isNarrowViewport: boolean;
  sidebarHoverPreview: boolean;
  sidebarRendered: boolean;
  sidebarWidth: number;
  settingsOpen: boolean;
  pinPrimarySidebar: () => void;
  closeSidebarHoverPreview: () => void;
  showSidebarHoverPreview: () => void;
  cancelSidebarHoverClose: () => void;
  scheduleSidebarHoverClose: () => void;
  onResizePointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onResizeKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  sessions: SessionInfo[];
  sessionFile: string | null;
  runningSessionFiles: string[];
  approvalSessionFiles: string[];
  notifications: AppNotification[];
  workspaceCwd: string;
  cwd: string;
  draftWorkspace: string;
  newTask: boolean;
  hubView: HubView | null;
  settings: AppSettings | null;
  sidebarSearchRequested: boolean;
  setSidebarSearchRequested: (next: boolean) => void;
  navigateTo: (target: NavigationTarget) => void;
  archiveConversations: (
    targets: Array<Pick<SessionInfo, "cwd" | "file">>,
    fallbackWorkspace: string,
    successMessage: string,
  ) => Promise<void>;
  refreshSessions: () => Promise<unknown>;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  dismissNotification: (id: string) => void;
  showToast: (message: string, kind?: "info" | "warning" | "error") => void;
  revealWorkspaceInExplorer: (workspace: string) => void;
  openSettingsPage: (page: SettingsPage) => void;
  pickFolder: () => Promise<void>;
  contributions: ClientContributionsSnapshot;
}

export function PrimarySidebarShell({
  sidebarVisible,
  isNarrowViewport,
  sidebarHoverPreview,
  sidebarRendered,
  sidebarWidth,
  settingsOpen,
  pinPrimarySidebar,
  closeSidebarHoverPreview,
  showSidebarHoverPreview,
  cancelSidebarHoverClose,
  scheduleSidebarHoverClose,
  onResizePointerDown,
  onResizeKeyDown,
  sessions,
  sessionFile,
  runningSessionFiles,
  approvalSessionFiles,
  notifications,
  workspaceCwd,
  cwd,
  draftWorkspace,
  newTask,
  hubView,
  settings,
  sidebarSearchRequested,
  setSidebarSearchRequested,
  navigateTo,
  archiveConversations,
  refreshSessions,
  markNotificationRead,
  markAllNotificationsRead,
  dismissNotification,
  showToast,
  revealWorkspaceInExplorer,
  openSettingsPage,
  pickFolder,
  contributions,
}: PrimarySidebarShellProps) {
  const navigateFromSidebar = (target: NavigationTarget) => {
    navigateTo(target);
    if (!sidebarVisible) closeSidebarHoverPreview();
  };

  return (
    <>
      {!sidebarVisible && !settingsOpen && (
        <div
          aria-hidden="true"
          className="sidebar-hover-zone"
          onMouseEnter={showSidebarHoverPreview}
          onMouseLeave={scheduleSidebarHoverClose}
        />
      )}
      <div
        className={`primary-sidebar-panel${sidebarRendered ? " open" : ""}${sidebarHoverPreview ? " hover-preview" : ""}`}
        data-panel
        data-sidebar-panel-state={sidebarVisible ? "pinned" : sidebarHoverPreview ? "preview" : "closed"}
      >
        {sidebarRendered && (
          <>
            <RegionErrorBoundary region="左侧边栏" resetKey={workspaceCwd || cwd}>
              <Sidebar
                sessions={sessions}
                currentSessionFile={sessionFile}
                runningSessionFiles={runningSessionFiles}
                approvalSessionFiles={approvalSessionFiles}
                notifications={notifications}
                cwd={newTask ? draftWorkspace : cwd}
                newTaskActive={newTask && hubView === null}
                activeHub={hubView === "scheduled" ? "scheduled" : null}
                onNewSession={() => navigateFromSidebar({ kind: "home", workspace: draftWorkspace || cwd })}
                onOpenScheduled={() => navigateFromSidebar({ kind: "hub", view: "scheduled" })}
                onOpenSession={(session) => navigateFromSidebar({ kind: "session", cwd: session.cwd, file: session.file })}
                onOpenNotification={(notification) => {
                  markNotificationRead(notification.id);
                  const targetSession = notification.sessionFile
                    ? sessions.find((session) => sameLocalPath(session.file, notification.sessionFile as string))
                    : null;
                  if (targetSession) {
                    navigateFromSidebar({ kind: "session", cwd: targetSession.cwd, file: targetSession.file });
                  } else if (notification.cwd) {
                    navigateFromSidebar({ kind: "home", workspace: notification.cwd });
                    if (notification.sessionFile) showToast("原任务记录已不可用，已打开对应项目", "warning");
                  }
                }}
                onMarkAllNotificationsRead={markAllNotificationsRead}
                onDismissNotification={dismissNotification}
                onOpenProject={(workspace) => navigateFromSidebar({ kind: "home", workspace })}
                onNewProjectSession={(workspace) => navigateFromSidebar({ kind: "home", workspace })}
                onArchiveSession={(session) => void archiveConversations([session], session.cwd, "已归档对话")}
                onSessionRestored={() => void refreshSessions()}
                onOpenProjectFolder={(workspace) => {
                  revealWorkspaceInExplorer(workspace);
                }}
                onCreateWorktree={async (workspace) => {
                  try {
                    const snapshot = await agent.gitSnapshot(workspace);
                    const worktree = await agent.createWorktree(workspace, snapshot.branch);
                    navigateFromSidebar({ kind: "home", workspace: worktree.path });
                    showToast(`已创建工作树：${worktree.branch || worktree.path}`, "info");
                  } catch (error) {
                    showToast(`创建工作树失败：${describeError(error)}`, "error");
                  }
                }}
                onArchiveProject={(workspace, projectSessions) => void archiveConversations(
                  projectSessions,
                  workspace,
                  `已归档 ${projectSessions.length} 个对话`,
                )}
                onOpenSettings={openSettingsPage}
                settingsShortcut={settings?.shortcutSettings ?? "Ctrl+,"}
                onPickFolder={() => void pickFolder()}
                newChatShortcut={settings?.shortcutNewChat ?? "Ctrl+Shift+N"}
                toggleSidebarShortcut={settings?.shortcutToggleSidebar || "Ctrl+B"}
                searchRequested={sidebarSearchRequested}
                onSearchRequestHandled={() => setSidebarSearchRequested(false)}
                hoverPreview={!sidebarVisible}
                onPinSidebar={!sidebarVisible && !isNarrowViewport ? pinPrimarySidebar : undefined}
                onCloseSidebar={!sidebarVisible && isNarrowViewport ? closeSidebarHoverPreview : undefined}
                onHoverEnter={cancelSidebarHoverClose}
                onHoverLeave={scheduleSidebarHoverClose}
              />
            </RegionErrorBoundary>
            {(contributions.pages.length > 0 || contributions.leftSidebar.length > 0) && (
              <div
                className="pid-sidebar-plugin-slot"
                onMouseEnter={!sidebarVisible ? cancelSidebarHoverClose : undefined}
                onMouseLeave={!sidebarVisible ? scheduleSidebarHoverClose : undefined}
              >
                {contributions.pages.map((page) => {
                  const targetView: HubView = `plugin:${page.id}`;
                  return (
                    <button
                      key={page.id}
                      type="button"
                      className={`pid-sidebar-plugin-page-btn${hubView === targetView ? " active" : ""}`}
                      onClick={() => navigateFromSidebar({ kind: "hub", view: targetView })}
                    >
                      {page.icon}
                      <span>{page.label}</span>
                    </button>
                  );
                })}
                {contributions.leftSidebar.map((section) => (
                  <div key={section.id} className="pid-sidebar-plugin-section">
                    <SlotEntryHost
                      entry={section}
                      context={{ cwd: workspaceCwd || cwd, sessionFile }}
                      slotName="leftSidebar"
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      {sidebarVisible && (
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          aria-valuemin={200}
          aria-valuemax={380}
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={0}
          onPointerDown={onResizePointerDown}
          onKeyDown={onResizeKeyDown}
        />
      )}
    </>
  );
}
