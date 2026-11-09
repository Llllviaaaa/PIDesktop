import { useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { LayoutGroup, motion } from "motion/react";
import {
  Activity,
  FileCode2,
  FolderTree,
  GitCompare,
  Globe,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelBottom,
  PanelRight,
  X,
} from "lucide-react";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import { useClientContributions } from "../../lib/clientContributions";
import { useWorkbenchStore } from "../../stores/workbenchStore";
import type { GitSnapshot } from "../../types";
import { SideChatTab } from "../SideChatTab";
import { BrowserPreviewTab } from "./BrowserPreviewTab";
import { CodeEditorTab } from "./CodeEditorTab";
import { ReviewDiffTab } from "./ReviewDiffTab";
import { TaskSummaryTab } from "./TaskSummaryTab";
import { WorkspaceFilesTab } from "./WorkspaceFilesTab";

export interface WorkbenchTopbarControlsProps {
  cwd: string;
  sessionFile: string | null;
}

export function WorkbenchTopbarControls({ cwd, sessionFile }: WorkbenchTopbarControlsProps) {
  const rightOpen = useWorkbenchStore((state) => state.rightOpen);
  const bottomOpen = useWorkbenchStore((state) => state.bottomOpen);
  const toggleRight = useWorkbenchStore((state) => state.toggleRight);
  const toggleBottom = useWorkbenchStore((state) => state.toggleBottom);
  const contributions = useClientContributions();

  return (
    <div className="pid-wb-topbar-controls">
      {contributions.topbarActions.map((action) => (
        <span key={action.id} className="pid-wb-plugin-action">
          {action.render({ cwd, sessionFile })}
        </span>
      ))}
      <button
        type="button"
        className={`icon-button${bottomOpen ? " active" : ""}`}
        title="切换底部终端面板 (Ctrl+J)"
        aria-pressed={bottomOpen}
        onClick={toggleBottom}
      >
        <PanelBottom size={16} strokeWidth={1.7} />
      </button>
      <button
        type="button"
        className={`icon-button${rightOpen ? " active" : ""}`}
        title="切换右侧工作台 (Ctrl+Alt+B)"
        aria-pressed={rightOpen}
        onClick={toggleRight}
      >
        <PanelRight size={16} strokeWidth={1.7} />
      </button>
    </div>
  );
}

export interface RightWorkbenchProps {
  cwd: string;
  sessionFile: string | null;
  width: number;
  git: GitSnapshot | null;
  onRefreshGit: () => Promise<void>;
  onRestoreFiles: (paths?: string[]) => Promise<void>;
  onRequestReview: () => void;
  onAddToChat?: (path: string) => void;
  resize: {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
    min: number;
    max: number;
  };
}

export function RightWorkbench({
  cwd,
  sessionFile,
  width,
  git,
  onRefreshGit,
  onRestoreFiles,
  onRequestReview,
  onAddToChat,
  resize,
}: RightWorkbenchProps) {
  const rightOpen = useWorkbenchStore((state) => state.rightOpen);
  const rightMaximized = useWorkbenchStore((state) => state.rightMaximized);
  const activeTab = useWorkbenchStore((state) => state.activeTab);
  const openFilesCount = useWorkbenchStore((state) => state.openFiles.length);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const setRightOpen = useWorkbenchStore((state) => state.setRightOpen);
  const toggleRightMaximized = useWorkbenchStore((state) => state.toggleRightMaximized);
  const contributions = useClientContributions();

  const [sideChatVisited, setSideChatVisited] = useState(false);

  useSyncOnChange([activeTab], () => {
    if (activeTab === "side-chat") setSideChatVisited(true);
  });

  useSyncOnChange([sessionFile], () => {
    if (activeTab !== "side-chat") setSideChatVisited(false);
  });

  if (!rightOpen) return null;

  const reviewCount = git?.files.length ?? 0;
  const activePluginTab = contributions.rightWorkbenchTabs.find((tab) => tab.id === activeTab);
  const mountSideChat = sideChatVisited || activeTab === "side-chat";

  return (
    <>
      {!rightMaximized && (
        <div
          className="pid-right-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右侧工作台宽度"
          aria-valuemin={Math.round(resize.min)}
          aria-valuemax={Math.round(resize.max)}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onPointerDown={resize.onPointerDown}
          onKeyDown={resize.onKeyDown}
        />
      )}
      <aside
        className={`pid-right-workbench${rightMaximized ? " maximized" : ""}`}
        data-rightbar-col=""
        style={rightMaximized ? undefined : { width: `${Math.round(width)}px` }}
        aria-label="右侧工作台"
      >
        <header className="pid-wb-header">
          <LayoutGroup id="pid-wb-header-tabs">
          <div className="pid-wb-tabs" role="tablist" aria-label="工作台视图">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "files"}
              className={`pid-wb-tab-btn${activeTab === "files" ? " active" : ""}`}
              onClick={() => openTab("files")}
              title="工作区文件"
            >
              {activeTab === "files" && <motion.span layoutId="pid-wb-active-pill" className="pid-wb-tab-pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
              <FolderTree size={13} />
              <span>文件</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "editor"}
              className={`pid-wb-tab-btn${activeTab === "editor" ? " active" : ""}`}
              onClick={() => openTab("editor")}
              title="代码编辑器"
            >
              {activeTab === "editor" && <motion.span layoutId="pid-wb-active-pill" className="pid-wb-tab-pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
              <FileCode2 size={13} />
              <span>编辑器</span>
              {openFilesCount > 0 && <em className="pid-wb-tab-count">{openFilesCount}</em>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "review"}
              className={`pid-wb-tab-btn${activeTab === "review" ? " active" : ""}`}
              onClick={() => openTab("review")}
              title="代码变更与审查"
            >
              {activeTab === "review" && <motion.span layoutId="pid-wb-active-pill" className="pid-wb-tab-pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
              <GitCompare size={13} />
              <span>审查</span>
              {reviewCount > 0 && <em className="pid-wb-tab-count">{reviewCount}</em>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "preview"}
              className={`pid-wb-tab-btn${activeTab === "preview" ? " active" : ""}`}
              onClick={() => openTab("preview")}
              title="Web 与浏览器预览 (Ctrl+T)"
            >
              {activeTab === "preview" && <motion.span layoutId="pid-wb-active-pill" className="pid-wb-tab-pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
              <Globe size={13} />
              <span>预览</span>
            </button>
            {contributions.rightWorkbenchTabs
              .filter((tab) => (tab.order ?? 100) < 20)
              .map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  className={`pid-wb-tab-btn${activeTab === tab.id ? " active" : ""}`}
                  onClick={() => openTab(tab.id)}
                >
                  {activeTab === tab.id && <motion.span layoutId="pid-wb-active-pill" className="pid-wb-tab-pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "summary"}
              className={`pid-wb-tab-btn${activeTab === "summary" ? " active" : ""}`}
              onClick={() => openTab("summary")}
              title="任务计划、子代理与诊断日志"
            >
              {activeTab === "summary" && <motion.span layoutId="pid-wb-active-pill" className="pid-wb-tab-pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
              <Activity size={13} />
              <span>摘要</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "side-chat"}
              className={`pid-wb-tab-btn${activeTab === "side-chat" ? " active" : ""}`}
              onClick={() => openTab("side-chat")}
              title="基于当前会话分叉的独立侧边对话"
            >
              {activeTab === "side-chat" && <motion.span layoutId="pid-wb-active-pill" className="pid-wb-tab-pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
              <MessageSquare size={13} />
              <span>侧边对话(beta)</span>
            </button>
            {contributions.rightWorkbenchTabs
              .filter((tab) => (tab.order ?? 100) >= 20)
              .map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  className={`pid-wb-tab-btn${activeTab === tab.id ? " active" : ""}`}
                  onClick={() => openTab(tab.id)}
                >
                  {activeTab === tab.id && <motion.span layoutId="pid-wb-active-pill" className="pid-wb-tab-pill" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
          </div>
          </LayoutGroup>

          <div className="pid-wb-window-btns">
            <button
              type="button"
              className="pid-wb-icon-btn"
              title={rightMaximized ? "还原宽度" : "最大化工作台"}
              onClick={toggleRightMaximized}
            >
              {rightMaximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <button
              type="button"
              className="pid-wb-icon-btn"
              title="隐藏工作台 (Ctrl+Alt+B)"
              onClick={() => setRightOpen(false)}
            >
              <X size={14} />
            </button>
          </div>
        </header>

        <div className="pid-wb-body">
          {activeTab === "files" && (
            <WorkspaceFilesTab cwd={cwd} onAddToChat={onAddToChat} />
          )}
          {activeTab === "editor" && (
            <CodeEditorTab cwd={cwd} />
          )}
          {activeTab === "review" && (
            <ReviewDiffTab
              cwd={cwd}
              git={git}
              onRefreshGit={onRefreshGit}
              onRestoreFiles={onRestoreFiles}
              onRequestReview={onRequestReview}
            />
          )}
          {activeTab === "preview" && (
            <BrowserPreviewTab />
          )}
          {activeTab === "summary" && (
            <TaskSummaryTab cwd={cwd} sessionFile={sessionFile} />
          )}
          {mountSideChat && (
            <div className="pid-wb-sidechat-host" hidden={activeTab !== "side-chat"}>
              <SideChatTab
                key={sessionFile ?? "draft"}
                sessionFile={sessionFile ?? ""}
                tabId={`side-${sessionFile ?? "draft"}`}
                visible={activeTab === "side-chat"}
              />
            </div>
          )}
          {activePluginTab && activePluginTab.render({ cwd, sessionFile })}
        </div>
      </aside>
    </>
  );
}
