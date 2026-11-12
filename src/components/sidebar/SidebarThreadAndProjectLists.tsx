import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  ArchiveRestore,
  Check,
  ChevronDown,
  Folder,
  MoreHorizontal,
  Pin,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import { agent } from "../../lib/agent";
import { sameLocalPath } from "../../lib/pathIdentity";
import { sessionTitle } from "../../lib/sessionTitle";
import type { ProjectConfig, SessionInfo } from "../../types";
import {
  compactRelativeTime,
  pathsEqual,
  VISIBLE_RECENT_THREADS,
  VISIBLE_THREADS_PER_PROJECT,
  type ProjectDropTarget,
  type SidebarGroupMode,
} from "./sidebarHelpers";
import { SidebarThreadRow } from "./SidebarThreadRow";

export interface SidebarThreadAndProjectListsProps {
  workspaceView: "active" | "archived";
  groupMode: SidebarGroupMode;
  query: string;
  setQuery: (next: string) => void;
  trimmedQuery: string;
  cwd: string;
  newTaskActive: boolean;
  currentSessionFile: string | null;
  runningSessionFiles: string[];
  approvalSessionFiles: string[];
  pinnedSessionFiles: string[];
  togglePinnedSession: (file: string) => void;
  snippetByFile: Map<string, string>;
  archivedLoading: boolean;
  archivedSessions: SessionInfo[];
  refetchArchived: () => Promise<unknown>;
  onSessionRestored: () => void;
  groups: Array<[string, SessionInfo[]]>;
  recentSessions: SessionInfo[];
  recentExpanded: boolean;
  setRecentExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  expandedProjects: Record<string, boolean>;
  setExpandedProjects: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  collapsedProjectPaths: string[];
  setProjectCollapsed: (workspace: string, collapsed: boolean) => void;
  projectConfig: (workspace: string) => ProjectConfig;
  displayProjectName: (workspace: string) => string;
  editingProject: string | null;
  setEditingProject: (next: string | null) => void;
  aliasDraft: string;
  setAliasDraft: (next: string) => void;
  finishProjectRename: () => void;
  draggingWorkspace: string | null;
  projectDropTarget: ProjectDropTarget | null;
  consumeSuppressedProjectClick: () => boolean;
  startProjectDrag: (event: ReactPointerEvent<HTMLDivElement>, workspace: string, pinned: boolean) => void;
  openProjectMenu: (event: ReactMouseEvent<HTMLButtonElement>, workspace: string) => void;
  openThreadMenu: (event: ReactMouseEvent<HTMLElement>, session: SessionInfo) => void;
  showThreadPreview: (session: SessionInfo, element: HTMLElement) => void;
  schedulePreviewClose: () => void;
  clearThreadPreview: () => void;
  closePopovers: () => void;
  onOpenSession: (session: SessionInfo) => void;
  onArchiveSession: (session: SessionInfo) => void | Promise<void>;
  onOpenProject: (workspace: string) => void;
  onNewProjectSession: (workspace: string) => void;
  onPickFolder: () => void;
}

export function SidebarThreadAndProjectLists({
  workspaceView,
  groupMode,
  query,
  setQuery,
  trimmedQuery,
  cwd,
  newTaskActive,
  currentSessionFile,
  runningSessionFiles,
  approvalSessionFiles,
  pinnedSessionFiles,
  togglePinnedSession,
  snippetByFile,
  archivedLoading,
  archivedSessions,
  refetchArchived,
  onSessionRestored,
  groups,
  recentSessions,
  recentExpanded,
  setRecentExpanded,
  expandedProjects,
  setExpandedProjects,
  collapsedProjectPaths,
  setProjectCollapsed,
  projectConfig,
  displayProjectName,
  editingProject,
  setEditingProject,
  aliasDraft,
  setAliasDraft,
  finishProjectRename,
  draggingWorkspace,
  projectDropTarget,
  consumeSuppressedProjectClick,
  startProjectDrag,
  openProjectMenu,
  openThreadMenu,
  showThreadPreview,
  schedulePreviewClose,
  clearThreadPreview,
  closePopovers,
  onOpenSession,
  onArchiveSession,
  onOpenProject,
  onNewProjectSession,
  onPickFolder,
}: SidebarThreadAndProjectListsProps) {
  const renderThreadRow = (session: SessionInfo) => {
    const openTargetSession = () => {
      closePopovers();
      setQuery("");
      setProjectCollapsed(session.cwd, false);
      onOpenSession(session);
    };
    return (
      <SidebarThreadRow
        key={session.file}
        session={session}
        active={!newTaskActive && sameLocalPath(session.file, currentSessionFile)}
        running={runningSessionFiles.some((file) => sameLocalPath(file, session.file))}
        approval={approvalSessionFiles.some((file) => sameLocalPath(file, session.file))}
        pinned={pinnedSessionFiles.includes(session.file)}
        snippet={trimmedQuery ? snippetByFile.get(session.file) : undefined}
        onOpen={openTargetSession}
        onTogglePinned={() => togglePinnedSession(session.file)}
        onArchive={() => {
          clearThreadPreview();
          void onArchiveSession(session);
        }}
        onShowPreview={(element) => showThreadPreview(session, element)}
        onHidePreview={schedulePreviewClose}
        onContextMenu={(event) => openThreadMenu(event, session)}
      />
    );
  };

  return (
    <div className="sidebar-scroll" data-dsh-claude-ws-view={workspaceView}>
      {workspaceView === "archived" ? (
        <div className="dsh-claude-archive-list">
          {archivedLoading ? (
            <div className="dsh-claude-archive-status">正在加载…</div>
          ) : archivedSessions.length === 0 ? (
            <div className="dsh-claude-archive-status">没有已归档的会话</div>
          ) : (
            archivedSessions.map((session) => (
              <div key={session.file} className="dsh-claude-archive-row" role="button" tabIndex={0}>
                <span className="dsh-claude-archive-title" title={sessionTitle(session)}>
                  {sessionTitle(session)}
                </span>
                <span className="dsh-claude-archive-time">{compactRelativeTime(session)}</span>
                <span className="dsh-claude-archive-action">
                  <button
                    type="button"
                    className="dsh-claude-archive-restore"
                    title="取消归档"
                    aria-label="取消归档"
                    onClick={(event) => {
                      event.stopPropagation();
                      void agent.restoreSession(session.file).then(() => {
                        void refetchArchived();
                        onSessionRestored();
                        window.dispatchEvent(new Event("qianji:projects-changed"));
                      });
                    }}
                  >
                    <ArchiveRestore size={14} />
                  </button>
                </span>
                <span className="dsh-claude-archive-action">
                  <button
                    type="button"
                    className="dsh-claude-archive-delete"
                    title="删除会话"
                    aria-label="删除会话"
                    onClick={(event) => {
                      event.stopPropagation();
                      void agent.deleteSession(session.file).then(() => {
                        void refetchArchived();
                      });
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            ))
          )}
        </div>
      ) : groups.length === 0 ? (
        <div className="sidebar-empty">
          <span>{query ? "没有匹配项" : "打开项目以开始"}</span>
          <button type="button" className="text-link" onClick={onPickFolder}>选择文件夹</button>
        </div>
      ) : groupMode === "recent" ? (
        <div className="thread-list thread-list-recent">
          {(recentExpanded || query.trim() ? recentSessions : recentSessions.slice(0, VISIBLE_RECENT_THREADS)).map(renderThreadRow)}
          {!query.trim() && recentSessions.length > VISIBLE_RECENT_THREADS && (
            <button type="button" className="expand-threads" onClick={() => setRecentExpanded((value) => !value)}>
              {recentExpanded ? "收起" : `展开其余 ${recentSessions.length - VISIBLE_RECENT_THREADS} 个会话`}
            </button>
          )}
        </div>
      ) : (
        groups.map(([workspace, chats]) => {
          const collapsed = !query.trim() && collapsedProjectPaths.some((path) => pathsEqual(path, workspace));
          const expanded = Boolean(query.trim()) || expandedProjects[workspace];
          const visibleChats = expanded ? chats : chats.slice(0, VISIBLE_THREADS_PER_PROJECT);
          const hiddenChatCount = chats.length - VISIBLE_THREADS_PER_PROJECT;
          const projectPinned = projectConfig(workspace).pinned;
          const isEditing = editingProject === workspace;
          const projectStatus = chats.some((session) => approvalSessionFiles.some((file) => sameLocalPath(file, session.file)))
            ? "approval"
            : chats.some((session) => runningSessionFiles.some((file) => sameLocalPath(file, session.file)))
              ? "running"
              : null;
          const isDragging = draggingWorkspace !== null && pathsEqual(draggingWorkspace, workspace);
          const dropPosition = projectDropTarget && pathsEqual(projectDropTarget.workspace, workspace)
            ? projectDropTarget.position
            : undefined;

          return (
            <section
              className={`project-block${cwd && pathsEqual(workspace, cwd) ? " is-current" : ""}${isDragging ? " is-dragging" : ""}`}
              data-workspace={workspace}
              data-pinned={projectPinned ? "true" : "false"}
              data-drop-position={dropPosition}
              key={workspace}
            >
              <div
                className="project-header-row"
                onPointerDown={(event) => startProjectDrag(event, workspace, projectPinned)}
              >
                {isEditing ? (
                  <form className="project-rename-editor" onSubmit={(event) => { event.preventDefault(); finishProjectRename(); }}>
                    <input
                      autoFocus
                      value={aliasDraft}
                      onChange={(event) => setAliasDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setEditingProject(null);
                      }}
                      aria-label="项目名称"
                    />
                    <button type="submit" title="保存" aria-label="保存"><Check size={14} /></button>
                    <button type="button" title="取消" aria-label="取消" onClick={() => setEditingProject(null)}><X size={14} /></button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="project-header"
                      title={workspace}
                      onClick={(event) => {
                        if (consumeSuppressedProjectClick()) {
                          event.preventDefault();
                          event.stopPropagation();
                          return;
                        }
                        closePopovers();
                        setProjectCollapsed(workspace, false);
                        onOpenProject(workspace);
                      }}
                    >
                      <Folder size={15} strokeWidth={1.7} />
                      <span className="project-name">{displayProjectName(workspace)}</span>
                      {collapsed && projectStatus && (
                        <span
                          className="thread-status project-status"
                          data-status={projectStatus}
                          title={projectStatus === "approval" ? "有会话等待审批" : "有会话正在运行"}
                        />
                      )}
                      {collapsed && chats.length > 0 && <span className="project-count">{chats.length}</span>}
                    </button>
                    <button
                      type="button"
                      className={`project-collapse-toggle ${collapsed ? "is-collapsed" : ""}`}
                      title={collapsed ? "展开会话" : "折叠会话"}
                      aria-label={`${collapsed ? "展开" : "折叠"} ${displayProjectName(workspace)} 的会话`}
                      aria-expanded={!collapsed}
                      disabled={chats.length === 0}
                      onClick={(event) => {
                        event.stopPropagation();
                        setProjectCollapsed(workspace, !collapsed);
                      }}
                    >
                      <ChevronDown size={13} strokeWidth={1.8} />
                    </button>
                    <div className="project-actions">
                      {projectPinned && <Pin className="project-pinned-mark" size={13} />}
                      <button
                        type="button"
                        title="项目操作"
                        aria-label={`${displayProjectName(workspace)} 项目操作`}
                        onClick={(event) => openProjectMenu(event, workspace)}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                      <button
                        type="button"
                        title="在此项目中新建对话"
                        aria-label={`在 ${displayProjectName(workspace)} 中新建对话`}
                        onClick={(event) => {
                          event.stopPropagation();
                          closePopovers();
                          onNewProjectSession(workspace);
                        }}
                      >
                        <SquarePen size={14} />
                      </button>
                    </div>
                  </>
                )}
              </div>
              {!collapsed && (
                <div className="thread-list">
                  {visibleChats.map(renderThreadRow)}
                  {!query.trim() && hiddenChatCount > 0 && (
                    <button
                      type="button"
                      className="expand-threads"
                      onClick={() => setExpandedProjects((current) => ({ ...current, [workspace]: !current[workspace] }))}
                    >
                      {expanded ? "收起" : `展开其余 ${hiddenChatCount} 个会话`}
                    </button>
                  )}
                </div>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
