import type { Window as TauriWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, ArrowRight, Minus, PanelLeft, Square, X } from "lucide-react";
import { requestAppQuit } from "../../lib/quitGuard";
import {
  TRANSCRIPT_DENSITY_LABELS,
  TRANSCRIPT_DENSITY_ORDER,
  type TranscriptDensity,
} from "../../lib/transcriptDensity";
import type { SettingsPage } from "../SettingsModal";
import type { WorkspaceEditorInfo } from "../../types";
import type { AppMenu, NavigationTarget } from "./shellTypes";

export interface WindowMenubarProps {
  appWindow: TauriWindow | null;
  sidebarVisible: boolean;
  settingsOpen: boolean;
  setSettingsOpen: (next: boolean) => void;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  navigateBack: () => void;
  navigateForward: () => void;
  navigateTo: (target: NavigationTarget) => void;
  togglePrimarySidebar: () => void;
  showSidebarHoverPreview: () => void;
  scheduleSidebarHoverClose: () => void;
  appMenu: AppMenu | null;
  setAppMenu: React.Dispatch<React.SetStateAction<AppMenu | null>>;
  draftWorkspace: string;
  cwd: string;
  canOpenWorkspace: boolean;
  preferredWorkspaceEditor: WorkspaceEditorInfo | null;
  openWorkspaceInPreferredApp: () => void;
  pickFolder: () => Promise<void>;
  connected: boolean;
  sessionFile: string | null;
  exportConversationMarkdown: () => Promise<void>;
  transcriptDensity: TranscriptDensity;
  setTranscriptDensity: (density: TranscriptDensity) => void;
  toggleWorkspaceSidebar: () => void;
  openBrowserAt: (url?: string) => void;
  toggleBottomPanel: () => void;
  openSettingsPage: (page: SettingsPage) => void;
  openDiagnostics: () => void;
}

export function WindowMenubar({
  appWindow,
  sidebarVisible,
  settingsOpen,
  setSettingsOpen,
  canNavigateBack,
  canNavigateForward,
  navigateBack,
  navigateForward,
  navigateTo,
  togglePrimarySidebar,
  showSidebarHoverPreview,
  scheduleSidebarHoverClose,
  appMenu,
  setAppMenu,
  draftWorkspace,
  cwd,
  canOpenWorkspace,
  preferredWorkspaceEditor,
  openWorkspaceInPreferredApp,
  pickFolder,
  connected,
  sessionFile,
  exportConversationMarkdown,
  transcriptDensity,
  setTranscriptDensity,
  toggleWorkspaceSidebar,
  openBrowserAt,
  toggleBottomPanel,
  openSettingsPage,
  openDiagnostics,
}: WindowMenubarProps) {
  return (
    <div className="window-menubar" data-tauri-drag-region>
      <div className="window-menubar-left" data-tauri-drag-region>
        <button
          type="button"
          className="window-nav-button"
          onClick={togglePrimarySidebar}
          onMouseEnter={settingsOpen ? undefined : showSidebarHoverPreview}
          onMouseLeave={settingsOpen ? undefined : scheduleSidebarHoverClose}
          title={sidebarVisible ? "隐藏侧栏" : "显示侧栏"}
        >
          <PanelLeft size={17} strokeWidth={1.65} />
        </button>
        <button
          type="button"
          className="window-nav-button"
          disabled={!settingsOpen && !canNavigateBack}
          onClick={() => {
            if (settingsOpen) setSettingsOpen(false);
            else navigateBack();
          }}
          title="后退"
        >
          <ArrowLeft size={18} strokeWidth={1.55} />
        </button>
        <button
          type="button"
          className="window-nav-button"
          disabled={settingsOpen || !canNavigateForward}
          onClick={navigateForward}
          title="前进"
        >
          <ArrowRight size={18} strokeWidth={1.55} />
        </button>
        <div className="app-menu-bar">
          {(["file", "edit", "view", "help"] as AppMenu[]).map((menu) => (
            <button
              type="button"
              key={menu}
              className={`app-menu-trigger ${appMenu === menu ? "active" : ""}`}
              onClick={() => setAppMenu((current) => (current === menu ? null : menu))}
            >
              {menu === "file" ? "文件" : menu === "edit" ? "编辑" : menu === "view" ? "视图" : "帮助"}
            </button>
          ))}
        </div>
        {appMenu && (
          <div className={`app-menu-dropdown menu-${appMenu}`}>
            {appMenu === "file" && (
              <>
                <button
                  onClick={() => {
                    setAppMenu(null);
                    setSettingsOpen(false);
                    navigateTo({ kind: "home", workspace: draftWorkspace || cwd });
                  }}
                >
                  新对话
                </button>
                <button
                  onClick={() => {
                    setAppMenu(null);
                    setSettingsOpen(false);
                    void pickFolder();
                  }}
                >
                  打开项目...
                </button>
                <button
                  disabled={!canOpenWorkspace}
                  onClick={() => {
                    setAppMenu(null);
                    openWorkspaceInPreferredApp();
                  }}
                >
                  {preferredWorkspaceEditor
                    ? `在 ${preferredWorkspaceEditor.name} 中打开`
                    : "在文件资源管理器中打开"}{" "}
                  Ctrl+Shift+O
                </button>
                <button
                  disabled={!connected || !sessionFile}
                  onClick={() => {
                    setAppMenu(null);
                    void exportConversationMarkdown();
                  }}
                >
                  导出为 Markdown...
                </button>
                <div className="menu-separator" />
                <button
                  onClick={() => {
                    setAppMenu(null);
                    void requestAppQuit();
                  }}
                >
                  退出
                </button>
              </>
            )}
            {appMenu === "edit" && (
              <>
                <button
                  onClick={() => {
                    setAppMenu(null);
                    document.execCommand("undo");
                  }}
                >
                  撤销
                </button>
                <button
                  onClick={() => {
                    setAppMenu(null);
                    document.execCommand("redo");
                  }}
                >
                  重做
                </button>
                <div className="menu-separator" />
                <button
                  onClick={() => {
                    setAppMenu(null);
                    document.execCommand("selectAll");
                  }}
                >
                  全选
                </button>
              </>
            )}
            {appMenu === "view" && (
              <>
                <button
                  onClick={() => {
                    setAppMenu(null);
                    togglePrimarySidebar();
                  }}
                >
                  {sidebarVisible ? "隐藏侧栏" : "显示侧栏"}
                </button>
                {TRANSCRIPT_DENSITY_ORDER.map((value) => (
                  <button
                    key={value}
                    onClick={() => {
                      setAppMenu(null);
                      setTranscriptDensity(value);
                    }}
                  >
                    对话{TRANSCRIPT_DENSITY_LABELS[value]}
                    {transcriptDensity === value ? " ✓" : ""}
                    {value === "normal" ? "  Ctrl+O" : ""}
                  </button>
                ))}
                <div className="menu-separator" />
                <button
                  onClick={() => {
                    setAppMenu(null);
                    setSettingsOpen(false);
                    toggleWorkspaceSidebar();
                  }}
                >
                  侧边栏  Ctrl+Alt+B
                </button>
                <button
                  onClick={() => {
                    setAppMenu(null);
                    setSettingsOpen(false);
                    openBrowserAt();
                  }}
                >
                  浏览器  Ctrl+T
                </button>
                <button
                  onClick={() => {
                    setAppMenu(null);
                    setSettingsOpen(false);
                    toggleBottomPanel();
                  }}
                >
                  底部面板  Ctrl+J
                </button>
                <button
                  onClick={() => {
                    setAppMenu(null);
                    openSettingsPage("appearance");
                  }}
                >
                  外观设置
                </button>
              </>
            )}
            {appMenu === "help" && (
              <>
                <button
                  onClick={() => {
                    setAppMenu(null);
                    void openUrl("https://github.com/Llllviaaaa/PIDesktop");
                  }}
                >
                  项目主页
                </button>
                <button
                  onClick={() => {
                    setAppMenu(null);
                    setSettingsOpen(false);
                    openDiagnostics();
                  }}
                >
                  诊断日志
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="window-controls">
        <button
          className="window-control"
          onClick={() => void appWindow?.minimize()}
          title="最小化"
          aria-label="最小化窗口"
        >
          <Minus size={15} strokeWidth={1.6} />
        </button>
        <button
          className="window-control"
          onClick={() => void appWindow?.toggleMaximize()}
          title="最大化或还原"
          aria-label="最大化或还原窗口"
        >
          <Square size={12} strokeWidth={1.5} />
        </button>
        <button
          className="window-control close"
          onClick={() => void appWindow?.close()}
          title="关闭"
          aria-label="关闭窗口"
        >
          <X size={16} strokeWidth={1.6} />
        </button>
      </div>
    </div>
  );
}
