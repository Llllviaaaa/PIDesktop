import { Folder, Menu, MoreHorizontal } from "lucide-react";
import type { GitSnapshot, SessionInfo, TerminalAppInfo, WorkspaceEditorInfo } from "../../types";
import { GitActionButton } from "../GitActionButton";
import { OpenInMenu } from "../WorkspaceOpeners";
import { WorkbenchTopbarControls } from "../workbench/RightWorkbench";
import type { HubView, NavigationTarget } from "./shellTypes";

export interface StageTopbarProps {
  newTask: boolean;
  hubView: HubView | null;
  sidebarVisible: boolean;
  sidebarRendered: boolean;
  isNarrowViewport: boolean;
  toggleSidebarShortcut?: string;
  togglePrimarySidebar: () => void;
  connected: boolean;
  isStreaming: boolean;
  editingTitle: boolean;
  setEditingTitle: (next: boolean) => void;
  titleDraft: string;
  setTitleDraft: (next: string) => void;
  resolvedThreadTitle: string;
  setSessionName: (name: string) => Promise<unknown>;
  moreOpen: boolean;
  setMoreOpen: React.Dispatch<React.SetStateAction<boolean>>;
  navigateTo: (target: NavigationTarget) => void;
  draftWorkspace: string;
  cwd: string;
  workspaceCwd: string;
  sessionFile: string | null;
  git: GitSnapshot | null;
  reviewGit: GitSnapshot | null;
  newWorktreeChat: () => Promise<void>;
  cloneSession: () => Promise<unknown>;
  forkLatest: () => Promise<unknown>;
  compact: () => Promise<unknown>;
  exportConversationMarkdown: () => Promise<void>;
  archiveConversations: (
    targets: Array<Pick<SessionInfo, "cwd" | "file">>,
    fallbackWorkspace: string,
    successMessage: string,
  ) => Promise<void>;
  setSettingsOpen: (next: boolean) => void;
  disconnect: () => Promise<unknown>;
  reviewFileCount: number;
  gitDiffStats: { additions: number; deletions: number };
  openReview: () => void;
  canOpenWorkspace: boolean;
  gitPushing: boolean;
  openCommitDialog: (push: boolean) => void;
  pushCurrentBranch: () => Promise<void>;
  workspaceEditors: WorkspaceEditorInfo[];
  preferredWorkspaceEditor: WorkspaceEditorInfo | null;
  terminalApps: TerminalAppInfo[];
  openWorkspaceInPreferredApp: () => void;
  chooseWorkspaceEditor: (editor: WorkspaceEditorInfo) => void;
  openWorkspaceTerminalApp: (app: TerminalAppInfo) => void;
  revealWorkspaceInExplorer: (workspace: string) => void;
  openBottomTerminal: () => void;
}

export function StageTopbar({
  newTask,
  hubView,
  sidebarVisible,
  sidebarRendered,
  isNarrowViewport,
  toggleSidebarShortcut = "Ctrl+B",
  togglePrimarySidebar,
  connected,
  isStreaming,
  editingTitle,
  setEditingTitle,
  titleDraft,
  setTitleDraft,
  resolvedThreadTitle,
  setSessionName,
  moreOpen,
  setMoreOpen,
  navigateTo,
  draftWorkspace,
  cwd,
  workspaceCwd,
  sessionFile,
  git,
  reviewGit,
  newWorktreeChat,
  cloneSession,
  forkLatest,
  compact,
  exportConversationMarkdown,
  archiveConversations,
  setSettingsOpen,
  disconnect,
  reviewFileCount,
  gitDiffStats,
  openReview,
  canOpenWorkspace,
  gitPushing,
  openCommitDialog,
  pushCurrentBranch,
  workspaceEditors,
  preferredWorkspaceEditor,
  terminalApps,
  openWorkspaceInPreferredApp,
  chooseWorkspaceEditor,
  openWorkspaceTerminalApp,
  revealWorkspaceInExplorer,
  openBottomTerminal,
}: StageTopbarProps) {
  const sidebarToggleLabel = isNarrowViewport
    ? (sidebarRendered ? "隐藏侧栏" : "显示侧栏")
    : "固定侧栏";
  return (
    <header className={`topbar ${newTask && !hubView ? "topbar-home" : ""}`} data-tauri-drag-region>
      <div className="topbar-left" data-tauri-drag-region>
        {!sidebarVisible && (
          <button
            type="button"
            className="icon-button"
            data-sidebar-toggle
            onClick={togglePrimarySidebar}
            title={`${sidebarToggleLabel} (${toggleSidebarShortcut})`}
            aria-label={sidebarToggleLabel}
          >
            <Menu size={17} />
          </button>
        )}
        {!newTask && !hubView && (
          <div className="thread-title-cluster">
            {editingTitle && connected ? (
              <input
                autoFocus
                className="title-input"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => {
                  setEditingTitle(false);
                  if (titleDraft.trim() !== resolvedThreadTitle) void setSessionName(titleDraft);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setTitleDraft(resolvedThreadTitle);
                    setEditingTitle(false);
                  }
                }}
              />
            ) : (
              <button className="chat-title" onClick={() => connected && setEditingTitle(true)} title="重命名线程">
                <Folder size={14} strokeWidth={1.75} className="title-doc-icon" />
                <span>{titleDraft || "新对话"}</span>
              </button>
            )}
            <div className="topbar-menu-wrap title-actions">
              <button
                type="button"
                className="icon-button title-more"
                title="线程操作"
                onClick={() => setMoreOpen((value) => !value)}
              >
                <MoreHorizontal size={16} strokeWidth={1.75} />
              </button>
              {moreOpen && (
                <div className="topbar-menu title-menu">
                  <button
                    onClick={() => {
                      setMoreOpen(false);
                      navigateTo({ kind: "home", workspace: draftWorkspace || cwd });
                    }}
                  >
                    新对话
                  </button>
                  <button
                    disabled={!connected || !git?.isRepository}
                    onClick={() => {
                      setMoreOpen(false);
                      void newWorktreeChat();
                    }}
                  >
                    新建 Worktree 任务
                  </button>
                  <button
                    disabled={!connected}
                    onClick={() => {
                      setMoreOpen(false);
                      void cloneSession();
                    }}
                  >
                    克隆当前分支
                  </button>
                  <button
                    disabled={!connected || isStreaming}
                    onClick={() => {
                      setMoreOpen(false);
                      void forkLatest();
                    }}
                  >
                    从最新检查点分叉
                  </button>
                  <button
                    disabled={!connected || isStreaming}
                    onClick={() => {
                      setMoreOpen(false);
                      void compact();
                    }}
                  >
                    压缩上下文
                  </button>
                  <button
                    disabled={!connected || !sessionFile}
                    onClick={() => {
                      setMoreOpen(false);
                      void exportConversationMarkdown();
                    }}
                  >
                    导出为 Markdown...
                  </button>
                  <button
                    disabled={!sessionFile || isStreaming}
                    onClick={() => {
                      setMoreOpen(false);
                      if (!sessionFile) return;
                      void archiveConversations([{ cwd, file: sessionFile }], cwd, "已归档对话");
                    }}
                  >
                    归档任务
                  </button>
                  <div className="menu-separator" />
                  <button
                    onClick={() => {
                      setMoreOpen(false);
                      setSettingsOpen(true);
                    }}
                  >
                    设置
                  </button>
                  <button
                    disabled={!connected}
                    onClick={() => {
                      setMoreOpen(false);
                      void disconnect();
                    }}
                  >
                    断开连接
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="topbar-right" data-tauri-drag-region>
        {!hubView && (
          <div className="panel-toggles codex-layout-chrome">
            <div className="main-pane-controls">
              {reviewFileCount > 0 && (
                <button
                  type="button"
                  className="title-diff-chip topbar-diff-chip"
                  title={`${reviewFileCount} 个文件有未提交的变更`}
                  aria-label={`审查 ${reviewFileCount} 个文件的变更`}
                  onClick={openReview}
                >
                  {gitDiffStats.additions > 0 && <em>+{gitDiffStats.additions.toLocaleString()}</em>}
                  {gitDiffStats.deletions > 0 && <b>−{gitDiffStats.deletions.toLocaleString()}</b>}
                  {gitDiffStats.additions === 0 && gitDiffStats.deletions === 0 && <span>{reviewFileCount} 个文件</span>}
                </button>
              )}
              {canOpenWorkspace && (
                <GitActionButton
                  git={reviewGit}
                  pushing={gitPushing}
                  onCommit={openCommitDialog}
                  onPush={() => void pushCurrentBranch()}
                />
              )}
              {canOpenWorkspace && (
                <OpenInMenu
                  workspace={workspaceCwd}
                  editors={workspaceEditors}
                  preferredEditor={preferredWorkspaceEditor}
                  terminalApps={terminalApps}
                  onOpenPreferred={openWorkspaceInPreferredApp}
                  onChooseEditor={chooseWorkspaceEditor}
                  onOpenTerminalApp={openWorkspaceTerminalApp}
                  onReveal={() => revealWorkspaceInExplorer(workspaceCwd)}
                  onOpenIntegratedTerminal={openBottomTerminal}
                />
              )}
            </div>
            <div className="workspace-pane-controls">
              <WorkbenchTopbarControls
                cwd={workspaceCwd || cwd}
                sessionFile={sessionFile}
              />
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
