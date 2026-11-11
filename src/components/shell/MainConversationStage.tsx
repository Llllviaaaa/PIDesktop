import { lazy, Suspense } from "react";
import { Code2, GitCompare, Globe2, Sparkles } from "lucide-react";
import type { ClientContributionsSnapshot } from "../../lib/clientContributions";
import type { CodeReviewScope } from "../../lib/codeReview";
import type { TranscriptDensity } from "../../lib/transcriptDensity";
import { useAppStore } from "../../store";
import type { UiSlice } from "../../store/types";
import type {
  AppSettings,
  ExtensionUIRequest,
  GitFileChange,
  ModelInfo,
  UiMessage,
} from "../../types";
import { ActiveGoalBar } from "../ActiveGoalBar";
import { RegionErrorBoundary, SlotEntryHost } from "../common/ErrorBoundary";
import { ConversationMessages } from "../ConversationMessages";
import { ExtensionDialog } from "../ExtensionDialog";
import { LivePlanBar } from "../LivePlanBar";
import { SessionChangeCard } from "../SessionChangeCard";
import type { SettingsPage } from "../SettingsModal";
import { BottomWorkbench } from "../workbench/BottomWorkbench";
import { WorkspaceTrustBanner } from "../WorkspaceTrustBanner";
import type { HubView, NavigationTarget } from "./shellTypes";

const ScheduledTasksPage = lazy(() =>
  import("../ScheduledTasksPage").then((module) => ({ default: module.ScheduledTasksPage })),
);

export interface MainConversationStageProps {
  workspaceCwd: string;
  cwd: string;
  draftWorkspace: string;
  defaultWorkspaceDir: string;
  workspaceOptions: string[];
  sessionFile: string | null;
  runtimeId: string | null;
  hubView: HubView | null;
  setHubView: (next: HubView | null) => void;
  newTask: boolean;
  transcriptDensity: TranscriptDensity;
  homeHeadline: string;
  lastError: string | null;
  settings: AppSettings | null;
  thinkingLevel: string;
  model: ModelInfo | null;
  isStreaming: boolean;
  statusText: string;
  editingMessageId: string | undefined;
  editUserMessage: (message: UiMessage) => void;
  rewindUserMessage: (message: UiMessage) => Promise<boolean>;
  cancelMessageEdit: () => void;
  submitMessageEdit: (message: UiMessage, text: string) => Promise<boolean>;
  conversationScrollRef: React.RefObject<HTMLDivElement | null>;
  autoFollowConversationRef: React.RefObject<boolean>;
  lastAutoScrollAtRef: React.RefObject<number>;
  openSummary: () => void;
  sessionChanges: GitFileChange[];
  sessionFileStats: Map<string, { add: number; del: number }>;
  openPreviewFile: (path: string, line?: number) => void;
  restoreGitFiles: (paths?: string[]) => Promise<void>;
  requestReview: (target?: CodeReviewScope) => Promise<void>;
  extensionWidgets: Record<string, string[]>;
  extensionRequest: ExtensionUIRequest | null;
  answerExtension: UiSlice["answerExtension"];
  refreshSessions: () => Promise<unknown>;
  navigateTo: (target: NavigationTarget) => void;
  showErrorToast: (message: string) => void;
  openSettingsPage: (page: SettingsPage) => void;
  sendFromComposer: (text: string, behavior?: "steer" | "followUp") => Promise<boolean>;
  renderComposer: (variant: "task-start" | "follow-up") => React.ReactNode;
  layoutScale: number;
  contributions: ClientContributionsSnapshot;
}

export function MainConversationStage({
  workspaceCwd,
  cwd,
  draftWorkspace,
  defaultWorkspaceDir,
  workspaceOptions,
  sessionFile,
  runtimeId,
  hubView,
  setHubView,
  newTask,
  transcriptDensity,
  homeHeadline,
  lastError,
  settings,
  thinkingLevel,
  model,
  isStreaming,
  statusText,
  editingMessageId,
  editUserMessage,
  rewindUserMessage,
  cancelMessageEdit,
  submitMessageEdit,
  conversationScrollRef,
  autoFollowConversationRef,
  lastAutoScrollAtRef,
  openSummary,
  sessionChanges,
  sessionFileStats,
  openPreviewFile,
  restoreGitFiles,
  requestReview,
  extensionWidgets,
  extensionRequest,
  answerExtension,
  refreshSessions,
  navigateTo,
  showErrorToast,
  openSettingsPage,
  sendFromComposer,
  renderComposer,
  layoutScale,
  contributions,
}: MainConversationStageProps) {
  return (
    <>
      <div className="work-body">
        <main className="main-stage">
          <WorkspaceTrustBanner
            workspace={workspaceCwd || cwd}
            onOpenPluginsSettings={() => openSettingsPage("plugins")}
          />
          <Suspense fallback={<div className="page-loading">正在加载…</div>}>
            {hubView === "scheduled" ? (
              <ScheduledTasksPage
                workspaces={workspaceOptions}
                defaultWorkspace={defaultWorkspaceDir}
                onTasksChanged={() => void refreshSessions()}
                onOpenSession={(workspace, file) => navigateTo({ kind: "session", cwd: workspace, file })}
                onError={showErrorToast}
              />
            ) : hubView === "sites" ? (
              <div className="feature-hub">
                <div className="feature-hub-heading">
                  <span className="feature-hub-icon"><Globe2 size={22} /></span>
                  <div>
                    <h1>站点快捷方式</h1>
                    <p>识别当前项目中的 Web 应用并在本地启动检查。</p>
                  </div>
                </div>
                <div className="feature-hub-card">
                  <div className="feature-hub-stat">
                    <strong>{draftWorkspace.split(/[\\/]/).filter(Boolean).pop() || "选择一个项目"}</strong>
                    <span>本地 Web 工作区</span>
                  </div>
                  <div className="feature-hub-actions">
                    <button
                      className="primary-button"
                      onClick={() => {
                        setHubView(null);
                        void sendFromComposer(
                          "识别这个项目中的 Web 应用，启动本地开发服务器，检查首页是否可用，并把预览地址告诉我。若启动失败，请直接修复。",
                          undefined,
                        );
                      }}
                    >
                      启动并检查
                    </button>
                  </div>
                </div>
              </div>
            ) : hubView?.startsWith("plugin:") ? (
              <div className="pid-plugin-page-stage">
                {(() => {
                  const activePluginPage = contributions.pages.find((page) => `plugin:${page.id}` === hubView);
                  if (!activePluginPage) return null;
                  return (
                    <SlotEntryHost
                      entry={activePluginPage}
                      context={{ cwd: workspaceCwd || cwd, sessionFile }}
                      slotName="pages"
                    />
                  );
                })()}
              </div>
            ) : (
              <>
                <div
                  ref={conversationScrollRef}
                  className={`conversation-scroll ${newTask ? "new-task-scroll" : ""}`}
                  onScroll={(event) => {
                    const scroller = event.currentTarget;
                    autoFollowConversationRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
                  }}
                >
                  <div className={`conversation ${newTask ? "new-task-conversation" : ""} ${!newTask ? `density-${transcriptDensity}` : ""}`}>
                    {newTask ? (
                      <div className="new-task-screen codex-home vetta-home dsh-claude-home">
                        <div className="minimal-home-core">
                          <h1 className="new-task-heading">{homeHeadline}</h1>
                          {lastError && <p className="new-task-error">{lastError}</p>}
                          <div className="dsh-claude-home-composer-wrap">
                            {renderComposer("task-start")}
                          </div>
                          <div className="dsh-home-starters" aria-label="快捷指令建议">
                            <button
                              type="button"
                              className="dsh-home-starter-pill"
                              onClick={() => useAppStore.setState({ composerPrefill: "梳理当前项目的核心目录架构，指出值得优先优化的模块。" })}
                            >
                              <Code2 size={13} strokeWidth={1.8} />
                              <span>梳理项目架构</span>
                            </button>
                            <button
                              type="button"
                              className="dsh-home-starter-pill"
                              onClick={() => useAppStore.setState({ composerPrefill: "排查当前项目里值得优先修复的潜在缺陷或边界情况，并给出修复建议。" })}
                            >
                              <Sparkles size={13} strokeWidth={1.8} />
                              <span>排查潜在缺陷</span>
                            </button>
                            <button
                              type="button"
                              className="dsh-home-starter-pill"
                              onClick={() => useAppStore.setState({ composerPrefill: "检查当前工作区的 Git 未提交变更，总结风险点并给出改进建议。" })}
                            >
                              <GitCompare size={13} strokeWidth={1.8} />
                              <span>审查未提交变更</span>
                            </button>
                            {contributions.homeQuickActions.map((item) => {
                              const quickCtx = {
                                cwd: workspaceCwd || cwd,
                                sessionFile,
                                prefillComposer: (prompt: string) => {
                                  useAppStore.setState({ composerPrefill: prompt });
                                },
                                sendPrompt: (prompt: string) => {
                                  void sendFromComposer(prompt, undefined);
                                },
                              };
                              if (typeof item.render === "function") {
                                return (
                                  <SlotEntryHost
                                    key={item.id}
                                    entry={{ id: item.id, pluginId: item.pluginId, render: item.render }}
                                    context={quickCtx}
                                    slotName="home.quickActions"
                                    compact
                                  />
                                );
                              }
                              return (
                                <button
                                  key={item.id}
                                  type="button"
                                  className="dsh-home-starter-pill"
                                  data-qj-plugin={item.pluginId ?? "builtin"}
                                  onClick={() => {
                                    try {
                                      if (typeof item.onSelect === "function") {
                                        item.onSelect(quickCtx);
                                      } else if (typeof item.prompt === "string" && item.prompt.trim() !== "") {
                                        quickCtx.prefillComposer(item.prompt);
                                      }
                                    } catch (error) {
                                      console.error(`[qianji-client-plugins] homeQuickAction "${item.id}" failed:`, error);
                                    }
                                  }}
                                >
                                  {item.icon ?? <Sparkles size={13} strokeWidth={1.8} />}
                                  <span>{item.label ?? item.id}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <>
                        <ConversationMessages
                          showThinking={settings?.showThinking ?? true}
                          expectVisibleThinking={thinkingLevel !== "off" && model?.reasoning === true}
                          isStreaming={isStreaming}
                          statusText={statusText}
                          editingMessageId={editingMessageId}
                          onEdit={editUserMessage}
                          onRewind={rewindUserMessage}
                          onCancelEdit={cancelMessageEdit}
                          onSubmitEdit={submitMessageEdit}
                          scrollerRef={conversationScrollRef}
                          autoFollowRef={autoFollowConversationRef}
                          lastAutoScrollAtRef={lastAutoScrollAtRef}
                          conversationKey={`${runtimeId ?? "none"}:${sessionFile ?? "new"}`}
                          density={transcriptDensity}
                          onOpenPlan={openSummary}
                          lastTurnFooter={sessionChanges.length > 0 ? (
                            <SessionChangeCard
                              files={sessionChanges}
                              stats={sessionFileStats}
                              onOpenFile={openPreviewFile}
                              onRestore={() => void restoreGitFiles(sessionChanges.map((file) => file.path))}
                              onReview={() => void requestReview({ mode: "uncommitted" })}
                            />
                          ) : undefined}
                        />
                        {Object.entries(extensionWidgets)
                          .filter(([key]) => key !== "qianji-plan" && key !== "pidesktop-plan")
                          .map(([key, lines]) => (
                            <div className="extension-widget" key={key}>
                              {lines.map((line, lineIndex) => <div key={lineIndex}>{line}</div>)}
                            </div>
                          ))}
                        {extensionRequest && (
                          <ExtensionDialog
                            request={extensionRequest}
                            onAnswer={(response) => void answerExtension(response)}
                          />
                        )}
                      </>
                    )}
                  </div>
                </div>

                {!newTask && !hubView && (
                  <div className="composer-dock">
                    <LivePlanBar />
                    <ActiveGoalBar />
                    {renderComposer("follow-up")}
                  </div>
                )}
              </>
            )}
          </Suspense>
        </main>
      </div>

      <RegionErrorBoundary region="底部工作台" resetKey={workspaceCwd || cwd}>
        <BottomWorkbench
          cwd={workspaceCwd || cwd}
          sessionFile={sessionFile}
          layoutScale={layoutScale}
        />
      </RegionErrorBoundary>

      {contributions.statusBarItems.length > 0 && (
        <footer
          className="qj-workspace-statusbar"
          role="status"
          aria-label="工作区状态栏"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            minHeight: "24px",
            padding: "0 12px",
            borderTop: "1px solid var(--qj-border-subtle, var(--border))",
            background: "var(--qj-bg-surface, var(--panel))",
            color: "var(--qj-text-secondary, var(--text-2))",
            fontSize: "11.5px",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "inline-flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
            {contributions.statusBarItems
              .filter((item) => item.align !== "right")
              .map((item) => (
                <SlotEntryHost
                  key={item.id}
                  entry={item}
                  context={{ cwd: workspaceCwd || cwd, sessionFile }}
                  slotName="status.bar"
                  compact
                />
              ))}
          </div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
            {contributions.statusBarItems
              .filter((item) => item.align === "right")
              .map((item) => (
                <SlotEntryHost
                  key={item.id}
                  entry={item}
                  context={{ cwd: workspaceCwd || cwd, sessionFile }}
                  slotName="status.bar"
                  compact
                />
              ))}
          </div>
        </footer>
      )}
    </>
  );
}
