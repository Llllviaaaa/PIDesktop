import {
  Archive,
  Folder,
  FolderOpen,
  GitBranch,
  Pin,
  Settings,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { sessionTitle } from "../../lib/sessionTitle";
import type { ProjectConfig, SessionInfo } from "../../types";
import { PluginMenuItems } from "../common/PluginMenuItems";
import type { SettingsPage } from "../SettingsModal";
import {
  relativeTime,
  type PositionedProjectMenu,
  type PositionedThreadPreview,
} from "./sidebarHelpers";

export interface SidebarFloatingMenusAndFooterProps {
  projectMenu: PositionedProjectMenu | null;
  setProjectMenu: (next: PositionedProjectMenu | null) => void;
  groups: Array<[string, SessionInfo[]]>;
  projectConfig: (workspace: string) => ProjectConfig;
  updateProjectConfig: (workspace: string, changes: Partial<ProjectConfig>) => Promise<void>;
  onOpenProjectFolder: (workspace: string) => void;
  onCreateWorktree: (workspace: string) => void | Promise<void>;
  beginProjectRename: (workspace: string) => void;
  onArchiveProject: (workspace: string, sessions: SessionInfo[]) => void | Promise<void>;
  removeProject: (workspace: string) => Promise<void>;
  threadPreview: PositionedThreadPreview | null;
  keepPreviewOpen: () => void;
  schedulePreviewClose: () => void;
  displayProjectName: (workspace: string) => string;
  branchByWorkspace: Record<string, string>;
  closePopovers: () => void;
  onOpenSettings: (page: SettingsPage) => void;
  settingsShortcut?: string;
}

export function SidebarFloatingMenusAndFooter({
  projectMenu,
  setProjectMenu,
  groups,
  projectConfig,
  updateProjectConfig,
  onOpenProjectFolder,
  onCreateWorktree,
  beginProjectRename,
  onArchiveProject,
  removeProject,
  threadPreview,
  keepPreviewOpen,
  schedulePreviewClose,
  displayProjectName,
  branchByWorkspace,
  closePopovers,
  onOpenSettings,
  settingsShortcut,
}: SidebarFloatingMenusAndFooterProps) {
  return (
    <>
      {projectMenu && (() => {
        const chats = groups.find(([workspace]) => workspace === projectMenu.workspace)?.[1] ?? [];
        const pinned = projectConfig(projectMenu.workspace).pinned;
        return (
          <div className="sidebar-popover project-context-menu" style={{ top: projectMenu.top }} data-sidebar-popover>
            <button
              type="button"
              onClick={() => {
                void updateProjectConfig(projectMenu.workspace, { pinned: !pinned });
                setProjectMenu(null);
              }}
            >
              <Pin size={15} />{pinned ? "取消置顶项目" : "置顶项目"}
            </button>
            <button
              type="button"
              onClick={() => {
                onOpenProjectFolder(projectMenu.workspace);
                setProjectMenu(null);
              }}
            >
              <FolderOpen size={15} />在资源管理器中打开
            </button>
            <button
              type="button"
              onClick={() => {
                void onCreateWorktree(projectMenu.workspace);
                setProjectMenu(null);
              }}
            >
              <GitBranch size={15} />创建永久工作树
            </button>
            <button type="button" onClick={() => beginProjectRename(projectMenu.workspace)}>
              <SlidersHorizontal size={15} />编辑项目
            </button>
            <button
              type="button"
              onClick={() => {
                void onArchiveProject(projectMenu.workspace, chats);
                setProjectMenu(null);
              }}
            >
              <Archive size={15} />归档聊天
            </button>
            <PluginMenuItems
              location="sidebar.project"
              context={{ workspace: projectMenu.workspace, sessionFiles: chats.map((chat) => chat.file) }}
              onClose={() => setProjectMenu(null)}
              separatorClassName="sidebar-popover-separator"
            />
            <div className="sidebar-popover-separator" />
            <button type="button" className="danger" onClick={() => void removeProject(projectMenu.workspace)}>
              <X size={15} />移除本地项目
            </button>
          </div>
        );
      })()}

      {threadPreview && (
        <div
          className="thread-hover-card"
          style={{ top: threadPreview.top }}
          onMouseEnter={keepPreviewOpen}
          onMouseLeave={schedulePreviewClose}
        >
          <div className="thread-hover-heading">
            <strong>{sessionTitle(threadPreview.session)}</strong>
            <span>{relativeTime(threadPreview.session)}</span>
          </div>
          <div><Folder size={15} /><span>{displayProjectName(threadPreview.session.cwd)}</span></div>
          <div><GitBranch size={15} /><span>{branchByWorkspace[threadPreview.session.cwd] || "读取中..."}</span></div>
        </div>
      )}

      <div className="sidebar-footer codex-footer">
        <button
          type="button"
          className="footer-account dsh-claude-account-btn"
          onClick={() => {
            closePopovers();
            onOpenSettings("general");
          }}
          title={settingsShortcut ? `设置 (${settingsShortcut})` : "设置"}
          aria-label="设置"
        >
          <Settings size={15} strokeWidth={1.7} aria-hidden="true" />
          <span className="dsh-claude-account-user">设置</span>
          {settingsShortcut && <span className="sidebar-footer-shortcut" aria-hidden="true">{settingsShortcut}</span>}
        </button>
      </div>
    </>
  );
}
