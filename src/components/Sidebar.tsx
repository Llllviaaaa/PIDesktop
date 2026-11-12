import { useRef } from "react";
import { SidebarFloatingMenusAndFooter } from "./sidebar/SidebarFloatingMenusAndFooter";
import { SidebarHeaderAndPopovers } from "./sidebar/SidebarHeaderAndPopovers";
import type { SidebarProps } from "./sidebar/sidebarHelpers";
import { SidebarThreadAndProjectLists } from "./sidebar/SidebarThreadAndProjectLists";
import { SidebarThreadMenu, useSidebarThreadMenu } from "./sidebar/SidebarThreadMenu";
import { useSidebarState } from "./sidebar/useSidebarState";

export type { SidebarProps };

export function Sidebar({
  sessions,
  currentSessionFile,
  runningSessionFiles,
  approvalSessionFiles,
  notifications,
  cwd,
  newTaskActive,
  activeHub,
  onNewSession,
  onOpenScheduled,
  onOpenSession,
  onOpenNotification,
  onMarkAllNotificationsRead,
  onDismissNotification,
  onOpenProject,
  onNewProjectSession,
  onArchiveSession,
  onSessionRestored,
  onOpenProjectFolder,
  onCreateWorktree,
  onArchiveProject,
  onOpenSettings,
  onPickFolder,
  settingsShortcut,
  newChatShortcut,
  toggleSidebarShortcut,
  searchRequested = false,
  onSearchRequestHandled,
  hoverPreview = false,
  onPinSidebar,
  onCloseSidebar,
  onHoverEnter,
  onHoverLeave,
}: SidebarProps) {
  const sidebarRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const state = useSidebarState({
    sidebarRef,
    searchInputRef,
    sessions,
    currentSessionFile,
    notifications,
    searchRequested,
    onSearchRequestHandled,
  });
  const { threadMenu, openThreadMenu, closeThreadMenu } = useSidebarThreadMenu(sidebarRef);

  return (
    <aside
      className={`sidebar codex-sidebar${hoverPreview ? " sidebar-hover-preview" : ""}${state.draggingWorkspace ? " is-reordering-projects" : ""}`}
      data-slot="sidebar"
      data-sidebar-mode={hoverPreview ? "preview" : "pinned"}
      onMouseEnter={onHoverEnter}
      onMouseLeave={state.searchOpen ? undefined : onHoverLeave}
      ref={sidebarRef}
    >
      <SidebarHeaderAndPopovers
        query={state.query}
        setQuery={state.setQuery}
        searchOpen={state.searchOpen}
        setSearchOpen={state.setSearchOpen}
        searchInputRef={searchInputRef}
        notificationsOpen={state.notificationsOpen}
        setNotificationsOpen={state.setNotificationsOpen}
        unreadNotificationCount={state.unreadNotificationCount}
        notifications={notifications}
        onMarkAllNotificationsRead={onMarkAllNotificationsRead}
        onOpenNotification={onOpenNotification}
        onDismissNotification={onDismissNotification}
        newTaskActive={newTaskActive}
        activeHub={activeHub}
        newChatShortcut={newChatShortcut}
        onNewSession={onNewSession}
        onOpenScheduled={onOpenScheduled}
        workspaceView={state.workspaceView}
        setWorkspaceView={state.setWorkspaceView}
        groupMode={state.groupMode}
        setGroupMode={state.setGroupMode}
        filterMenuOpen={state.filterMenuOpen}
        setFilterMenuOpen={state.setFilterMenuOpen}
        closePopovers={state.closePopovers}
        clearProjectMenu={() => state.setProjectMenu(null)}
        onPickFolder={onPickFolder}
        toggleSidebarShortcut={toggleSidebarShortcut}
        onPinSidebar={hoverPreview ? onPinSidebar : undefined}
        onCloseSidebar={hoverPreview ? onCloseSidebar : undefined}
      />

      <SidebarThreadAndProjectLists
        workspaceView={state.workspaceView}
        groupMode={state.groupMode}
        query={state.query}
        setQuery={state.setQuery}
        trimmedQuery={state.trimmedQuery}
        cwd={cwd}
        newTaskActive={newTaskActive}
        currentSessionFile={currentSessionFile}
        runningSessionFiles={runningSessionFiles}
        approvalSessionFiles={approvalSessionFiles}
        pinnedSessionFiles={state.pinnedSessionFiles}
        togglePinnedSession={state.togglePinnedSession}
        snippetByFile={state.snippetByFile}
        archivedLoading={state.archivedSessionsQuery.isLoading}
        archivedSessions={state.archivedSessions}
        refetchArchived={state.archivedSessionsQuery.refetch}
        onSessionRestored={onSessionRestored}
        groups={state.groups}
        recentSessions={state.recentSessions}
        recentExpanded={state.recentExpanded}
        setRecentExpanded={state.setRecentExpanded}
        expandedProjects={state.expandedProjects}
        setExpandedProjects={state.setExpandedProjects}
        collapsedProjectPaths={state.collapsedProjectPaths}
        setProjectCollapsed={state.setProjectCollapsed}
        projectConfig={state.projectConfig}
        displayProjectName={state.displayProjectName}
        editingProject={state.editingProject}
        setEditingProject={state.setEditingProject}
        aliasDraft={state.aliasDraft}
        setAliasDraft={state.setAliasDraft}
        finishProjectRename={state.finishProjectRename}
        draggingWorkspace={state.draggingWorkspace}
        projectDropTarget={state.projectDropTarget}
        consumeSuppressedProjectClick={state.consumeSuppressedProjectClick}
        startProjectDrag={state.startProjectDrag}
        openProjectMenu={state.openProjectMenu}
        openThreadMenu={(event, session) => {
          state.closePopovers();
          openThreadMenu(event, session);
        }}
        showThreadPreview={state.showThreadPreview}
        schedulePreviewClose={state.schedulePreviewClose}
        clearThreadPreview={() => state.setThreadPreview(null)}
        closePopovers={state.closePopovers}
        onOpenSession={onOpenSession}
        onArchiveSession={onArchiveSession}
        onOpenProject={onOpenProject}
        onNewProjectSession={onNewProjectSession}
        onPickFolder={onPickFolder}
      />

      <SidebarFloatingMenusAndFooter
        projectMenu={state.projectMenu}
        setProjectMenu={state.setProjectMenu}
        groups={state.groups}
        projectConfig={state.projectConfig}
        updateProjectConfig={state.updateProjectConfig}
        onOpenProjectFolder={onOpenProjectFolder}
        onCreateWorktree={onCreateWorktree}
        beginProjectRename={state.beginProjectRename}
        onArchiveProject={onArchiveProject}
        removeProject={state.removeProject}
        threadPreview={state.threadPreview}
        keepPreviewOpen={state.keepPreviewOpen}
        schedulePreviewClose={state.schedulePreviewClose}
        displayProjectName={state.displayProjectName}
        branchByWorkspace={state.branchByWorkspace}
        closePopovers={state.closePopovers}
        onOpenSettings={onOpenSettings}
        settingsShortcut={settingsShortcut}
      />

      {threadMenu && (
        <SidebarThreadMenu
          menu={threadMenu}
          pinned={state.pinnedSessionFiles.includes(threadMenu.session.file)}
          onClose={closeThreadMenu}
          onTogglePinned={state.togglePinnedSession}
          onArchive={onArchiveSession}
        />
      )}
    </aside>
  );
}
