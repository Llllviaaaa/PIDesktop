import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { usePanelResize } from "./hooks/usePanelResize";
import { useRuntimeBootstrap } from "./hooks/useRuntimeBootstrap";
import { useSyncOnChange } from "./hooks/useSyncOnChange";
import { mergeAppearanceCatalog } from "./lib/appearanceCatalog";
import { useClientContributions } from "./lib/clientContributions";
import { aggregateDiffStats, perFileDiffStats } from "./lib/gitDiffStats";
import { harnessRuntimes } from "./lib/harnessRuntime";
import { filterHiddenModels } from "./lib/modelProviders";
import {
  resolveUiScale, SIDEBAR_BOUNDS, SIDEBAR_KEYS, SIDEBAR_WIDTH_KEY,
  WORKSPACE_PANEL_BOUNDS, WORKSPACE_PANEL_KEYS, WORKSPACE_PANEL_WIDTH_KEY, workspacePanelMaxWidth as panelMaxWidth,
} from "./lib/panelLayout";
import { hasActiveStreamingTasks } from "./lib/quitGuard";
import { rewindController } from "./lib/rewindController";
import { changesEditedBy, sessionEditedPaths } from "./lib/sessionEdits";
import { activeSessionTitle } from "./lib/sessionTitle";
import { nextTranscriptDensity, normalizeTranscriptDensity } from "./lib/transcriptDensity";
import { useAppStore } from "./store";
import { useSlices } from "./store/selectors";
import { useWorkbenchStore } from "./stores/workbenchStore";
import { RegionErrorBoundary } from "./components/common/ErrorBoundary";
import { WorkspaceFileOpenContext } from "./components/Markdown";
import type { SettingsPage } from "./components/SettingsModal";
import { MainConversationStage } from "./components/shell/MainConversationStage";
import { PrimarySidebarShell } from "./components/shell/PrimarySidebarShell";
import { ShellComposer } from "./components/shell/ShellComposer";
import { ShellOverlaysAndModals } from "./components/shell/ShellOverlaysAndModals";
import type { AppMenu, HubView } from "./components/shell/shellTypes";
import { StageTopbar } from "./components/shell/StageTopbar";
import { useAppearanceAndShellEffects } from "./components/shell/useAppearanceAndShellEffects";
import { useShellNavigation } from "./components/shell/useShellNavigation";
import { useShellTaskAndGitActions } from "./components/shell/useShellTaskAndGitActions";
import { useShellWorkspaceAndSidebar } from "./components/shell/useShellWorkspaceAndSidebar";
import { WindowMenubar } from "./components/shell/WindowMenubar";
import { RightWorkbench } from "./components/workbench/RightWorkbench";
import { FileActionsProvider } from "./components/WorkspaceOpeners";
import type { AttachmentPayload } from "./types";

export default function App() {
  const store = useSlices({
    runtime: [
      "connection", "cwd", "settings", "sessionFile", "sessionId", "sessionName", "isSwitchingModel", "model",
      "thinkingLevel", "availableModels", "availableThinkingLevels", "commands", "stats", "git", "runtimeId", "runtimes",
      "lastError", "prepareNewTask", "connect", "appendLog", "switchSession", "disconnect", "saveSettings",
    ],
    sessions: ["sessions", "refreshSessions", "setSessionName", "cloneSession", "forkLatest"],
    transcript: [
      "isStreaming", "isCompacting", "retryStatus", "extensionWidgets", "managedFollowUpQueue", "steeringQueue",
      "followUpQueue", "steerManagedFollowUp", "removeManagedFollowUp", "moveManagedFollowUp", "compact",
    ],
    ui: [
      "extensionRequest", "composerPrefill", "toasts", "notifications", "setViewedSession", "showToast",
      "markNotificationRead", "markAllNotificationsRead", "dismissToast", "dismissNotification", "answerExtension",
    ],
  });
  const {
    connection, cwd, sessions, settings, sessionFile, sessionId, sessionName, isStreaming, isSwitchingModel,
    isCompacting, retryStatus, model, thinkingLevel, availableModels, availableThinkingLevels, commands, stats, git,
    extensionRequest, extensionWidgets, composerPrefill, runtimeId, runtimes, toasts, notifications,
    prepareNewTask, setViewedSession, connect, appendLog, switchSession,
  } = store;

  const isTauri = "__TAURI_INTERNALS__" in window;
  const appWindow = isTauri ? getCurrentWindow() : null;
  const pickerModels = useMemo(() => filterHiddenModels(availableModels, settings?.hiddenModels, model), [availableModels, settings?.hiddenModels, model]);
  const adapterStreamingIds = useSyncExternalStore(
    harnessRuntimes.subscribeStreaming, harnessRuntimes.getStreamingRuntimeIdsSnapshot, harnessRuntimes.getStreamingRuntimeIdsSnapshot,
  );
  const anyTaskStreaming = useMemo(
    () => hasActiveStreamingTasks({ runtimeId, isStreaming, isCompacting, runtimes }, adapterStreamingIds),
    [runtimeId, isStreaming, isCompacting, runtimes, adapterStreamingIds],
  );
  const [draftMode, setDraftMode] = useState(() => {
    if (!import.meta.env.DEV) return true;
    const fixture = new URLSearchParams(window.location.search).get("fixture");
    return !["thread", "performance", "stream", "queue", "title", "diagrams", "goal"].includes(fixture ?? "");
  });
  const newTask = draftMode;
  const [localTranscriptDensity, setLocalTranscriptDensity] = useState<ReturnType<typeof normalizeTranscriptDensity>>("normal");
  const transcriptDensity = settings ? normalizeTranscriptDensity(settings.transcriptDensity) : localTranscriptDensity;
  const setTranscriptDensity = useCallback((density: typeof transcriptDensity) => {
    const current = useAppStore.getState();
    if (current.settings) { void current.saveSettings({ ...current.settings, transcriptDensity: density }); return; }
    setLocalTranscriptDensity(density);
  }, []);
  const cycleTranscriptDensity = useCallback(() => setTranscriptDensity(nextTranscriptDensity(transcriptDensity)), [setTranscriptDensity, transcriptDensity]);

  const [sidebarSearchRequested, setSidebarSearchRequested] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("general");
  const [hubView, setHubView] = useState<HubView | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [appMenu, setAppMenu] = useState<AppMenu | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftWorkspace, setDraftWorkspace] = useState(() => window.localStorage.getItem("qianji:last-workspace") || "");
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([]);
  const attachmentsRef = useRef(attachments);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => rewindController.bindAttachmentBridge({
    getAttachments: () => attachmentsRef.current,
    setAttachments: (next) => { attachmentsRef.current = next; setAttachments(next); },
  }), []);

  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const autoFollowConversationRef = useRef(true);
  const lastAutoScrollAtRef = useRef(0);
  const firstUserMessage = useAppStore((state) => state.messages.find((msg) => msg.role === "user")?.content);
  const resolvedThreadTitle = useMemo(
    () => activeSessionTitle({ sessions, sessionFile, sessionId, sessionName, firstMessage: firstUserMessage }),
    [firstUserMessage, sessionFile, sessionId, sessionName, sessions],
  );
  const contributions = useClientContributions();
  const appearanceCatalog = useMemo(() => mergeAppearanceCatalog(contributions.themes), [contributions.themes]);

  const { runtimeRecoveryDone, startupAutoConnectRef } = useRuntimeBootstrap({
    isTauri, connection, sessions, autoConnect: settings?.autoConnect ?? false, runtimeId, cwd, sessionFile,
    draftMode, onDraftModeChange: setDraftMode, onDraftWorkspaceChange: setDraftWorkspace,
  });

  const ws = useShellWorkspaceAndSidebar({
    isTauri, newTask, cwd, settings, sessions, connection, hubView, setHubView,
    runtimeRecoveryDone, startupAutoConnectRef, connect, draftWorkspace, setDraftWorkspace,
  });

  const layoutScale = resolveUiScale(settings?.uiScale);
  const sidebarResize = usePanelResize({
    storageKey: SIDEBAR_WIDTH_KEY, bounds: SIDEBAR_BOUNDS, keys: SIDEBAR_KEYS, axis: "x", growsWithPointer: true,
    resizingClass: "sidebar-is-resizing", scale: layoutScale, maxSize: useCallback(() => SIDEBAR_BOUNDS.max, []),
  });
  const sidebarWidth = sidebarResize.size;
  const workspacePanelMaxWidth = useCallback(
    () => panelMaxWidth(window.innerWidth, layoutScale, ws.sidebarVisible ? sidebarWidth : 0),
    [layoutScale, sidebarWidth, ws.sidebarVisible],
  );
  const workspaceResize = usePanelResize({
    storageKey: WORKSPACE_PANEL_WIDTH_KEY, bounds: WORKSPACE_PANEL_BOUNDS, keys: WORKSPACE_PANEL_KEYS, axis: "x",
    growsWithPointer: false, resizingClass: "workspace-is-resizing", scale: layoutScale, maxSize: workspacePanelMaxWidth,
  });
  const workspacePanelWidth = workspaceResize.size;

  const showErrorToast = useCallback((msg: string) => useAppStore.getState().showToast(msg, "error"), []);
  const notify = useCallback((msg: string, tone: "info" | "error") => useAppStore.getState().showToast(msg, tone), []);
  const toggleWorkspaceSidebar = useCallback(() => { setHubView(null); useWorkbenchStore.getState().toggleRight(); }, []);
  const toggleBottomPanel = useCallback(() => useWorkbenchStore.getState().toggleBottom(), []);
  const openBottomTerminal = useCallback(() => useWorkbenchStore.getState().openBottomTerminal(), []);
  const openSummary = useCallback(() => { setHubView(null); useWorkbenchStore.getState().openSummary("overview"); }, []);
  const openDiagnostics = useCallback(() => { setHubView(null); useWorkbenchStore.getState().openSummary("diagnostics"); }, []);
  const openReview = useCallback(() => { setHubView(null); useWorkbenchStore.getState().openReview(); }, []);
  const openBrowserAt = useCallback((url?: string) => { setHubView(null); useWorkbenchStore.getState().openPreview(url); }, []);
  const openSettingsPage = useCallback((page: SettingsPage) => { setSettingsPage(page); setSettingsOpen(true); }, []);

  useAppearanceAndShellEffects({
    isTauri, anyTaskStreaming, workspaceCwd: ws.workspaceCwd, cwd, moreOpen, setMoreOpen, appMenu, setAppMenu,
    settingsOpen, setSettingsOpen, setSidebarVisible: ws.setSidebarVisible, appearanceCatalog, settings, connection,
    canOpenWorkspace: ws.canOpenWorkspace, openWorkspaceInPreferredApp: ws.openWorkspaceInPreferredApp,
    pinPrimarySidebar: ws.pinPrimarySidebar, setSidebarSearchRequested, cycleTranscriptDensity, toggleBottomPanel,
    toggleWorkspaceSidebar, openBrowserAt, openReview, togglePrimarySidebar: ws.togglePrimarySidebar,
    prepareNewTask, setDraftMode, setQuickChat: ws.setQuickChat, setHubView,
  });

  const nav = useShellNavigation({
    cwd, draftWorkspace, hubView, newTask, sessionFile, isDefaultWorkspace: ws.isDefaultWorkspace,
    selectWorkspace: ws.selectWorkspace, setDraftWorkspace, setDraftMode, setQuickChat: ws.setQuickChat,
    setTaskEnvironment: ws.setTaskEnvironment, setHubView, setMoreOpen, switchSession,
  });

  const actions = useShellTaskAndGitActions({
    newTask, quickChat: ws.quickChat, defaultWorkspaceDir: ws.defaultWorkspaceDir, draftWorkspace,
    workspaceCwd: ws.workspaceCwd, cwd, taskEnvironment: ws.taskEnvironment, attachments, setAttachments,
    draftGit: ws.draftGit, git, settings, selectWorkspace: ws.selectWorkspace, setDraftWorkspace, setDraftMode,
    setQuickChat: ws.setQuickChat, setTaskEnvironment: ws.setTaskEnvironment, setHubView,
    refreshDraftGit: ws.refreshDraftGit, connect, appendLog,
  });

  const { setEditingMessage } = actions;
  useSyncOnChange([editingTitle, resolvedThreadTitle], () => { if (!editingTitle) setTitleDraft(resolvedThreadTitle); });
  useSyncOnChange([runtimeId, sessionFile], () => setEditingMessage(null));
  useEffect(() => { autoFollowConversationRef.current = true; }, [runtimeId, sessionFile]);
  useEffect(() => {
    const viewed = !newTask && !hubView && !settingsOpen ? sessionFile : null;
    setViewedSession(viewed);
    const markViewed = () => setViewedSession(viewed);
    window.addEventListener("focus", markViewed);
    return () => { window.removeEventListener("focus", markViewed); setViewedSession(null); };
  }, [hubView, newTask, sessionFile, settingsOpen, setViewedSession]);

  const permissionLabel = settings?.permissionMode === "read-only" ? "只读"
    : settings?.permissionMode === "workspace-write" ? "工作区写入"
      : settings?.permissionMode === "full-access" ? "完全访问" : "先询问";
  const connected = connection === "running";
  const runningSessionFiles = useMemo(
    () => Object.values(runtimes).filter((rt) => rt.isStreaming && rt.sessionFile).map((rt) => rt.sessionFile as string),
    [runtimes],
  );
  const approvalSessionFiles = useMemo(
    () => Object.values(runtimes).filter((rt) => rt.extensionRequest && rt.sessionFile).map((rt) => rt.sessionFile as string),
    [runtimes],
  );
  const sessionEditedKey = useAppStore((state) => sessionEditedPaths(state.messages).join("\n"));
  const sessionChanges = useMemo(
    () => changesEditedBy(git?.files ?? [], sessionEditedKey ? sessionEditedKey.split("\n") : []),
    [git?.files, sessionEditedKey],
  );
  const sessionFileStats = useMemo(() => perFileDiffStats(git?.diff), [git?.diff]);
  const reviewGit = newTask ? ws.draftGit : git;
  const gitDiffStats = useMemo(() => {
    const { add, del } = aggregateDiffStats(reviewGit?.diff);
    return { additions: add, deletions: del };
  }, [reviewGit?.diff]);
  const taskWorkspaceName = draftWorkspace.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const homeHeadline = ws.quickChat || !taskWorkspaceName ? "接下来聊些什么？" : `接下来在 ${taskWorkspaceName} 做什么？`;
  const statusText = isCompacting ? "正在压缩上下文…"
    : retryStatus || (isStreaming ? "Agent 正在工作…" : connected ? "就绪" : connection === "starting" ? "正在启动 Harness…" : "未连接");

  const renderComposer = (variant: "task-start" | "follow-up") => (
    <ShellComposer
      variant={variant} sessionFile={sessionFile} isStreaming={isStreaming} isSwitchingModel={isSwitchingModel}
      attachments={attachments} commands={commands} models={pickerModels} model={model} thinkingLevel={thinkingLevel}
      thinkingLevels={availableThinkingLevels} prefill={composerPrefill}
      pendingCount={store.steeringQueue.length + store.followUpQueue.length + store.managedFollowUpQueue.length}
      queuedMessages={store.managedFollowUpQueue} settings={settings} quickChat={ws.quickChat}
      draftWorkspace={draftWorkspace} workspaceCwd={ws.workspaceCwd} workspaceOptions={ws.workspaceOptions}
      environment={ws.taskEnvironment} draftBranch={ws.draftBranch} git={git} permissionLabel={permissionLabel}
      stats={stats} transcriptDensity={transcriptDensity} setTranscriptDensity={setTranscriptDensity}
      onSend={actions.sendFromComposer} onStop={actions.stopFromComposer} onPickAttachments={actions.pickAttachments}
      onAttachFiles={actions.attachFiles} onAttachPayloads={actions.attachPayloads}
      onRemoveAttachment={actions.removeComposerAttachment} onModelChange={actions.changeComposerModel}
      onThinkingChange={actions.changeComposerThinking} onWorkspaceSelect={ws.selectWorkspace}
      onPickWorkspace={ws.pickFolder} onQuickChat={actions.startQuickChatFromComposer}
      onEnvironmentChange={ws.setTaskEnvironment} onPermissionChange={actions.changeComposerPermission}
      onAgentModeChange={actions.changeComposerAgentMode} onPrefillConsumed={actions.consumeComposerPrefill}
      onRemoveQueuedMessage={store.removeManagedFollowUp} onMoveQueuedMessage={store.moveManagedFollowUp}
      onSteerQueuedMessage={store.steerManagedFollowUp}
    />
  );

  return (
    <div className="app-shell codex-shot" style={{ ["--sidebar-width" as string]: `${sidebarWidth}px` }}>
      <WindowMenubar
        appWindow={appWindow} sidebarVisible={ws.sidebarVisible} settingsOpen={settingsOpen} setSettingsOpen={setSettingsOpen}
        canNavigateBack={nav.canNavigateBack} canNavigateForward={nav.canNavigateForward} navigateBack={nav.navigateBack}
        navigateForward={nav.navigateForward} navigateTo={nav.navigateTo} togglePrimarySidebar={ws.togglePrimarySidebar}
        showSidebarHoverPreview={ws.showSidebarHoverPreview} scheduleSidebarHoverClose={ws.scheduleSidebarHoverClose}
        appMenu={appMenu} setAppMenu={setAppMenu} draftWorkspace={draftWorkspace} cwd={cwd} canOpenWorkspace={ws.canOpenWorkspace}
        preferredWorkspaceEditor={ws.preferredWorkspaceEditor} openWorkspaceInPreferredApp={ws.openWorkspaceInPreferredApp}
        pickFolder={ws.pickFolder} connected={connected} sessionFile={sessionFile}
        exportConversationMarkdown={nav.exportConversationMarkdown} transcriptDensity={transcriptDensity}
        setTranscriptDensity={setTranscriptDensity} toggleWorkspaceSidebar={toggleWorkspaceSidebar}
        openBrowserAt={openBrowserAt} toggleBottomPanel={toggleBottomPanel} openSettingsPage={openSettingsPage}
        openDiagnostics={openDiagnostics}
      />
      <div
        className="workspace-shell"
        style={{ ["--sidebar-width" as string]: `${sidebarWidth}px`, ["--workspace-panel-width" as string]: `${workspacePanelWidth}px` }}
      >
        <PrimarySidebarShell
          sidebarVisible={ws.sidebarVisible} sidebarHoverPreview={ws.sidebarHoverPreview} sidebarRendered={ws.sidebarRendered}
          sidebarWidth={sidebarWidth} settingsOpen={settingsOpen} showSidebarHoverPreview={ws.showSidebarHoverPreview}
          cancelSidebarHoverClose={ws.cancelSidebarHoverClose} scheduleSidebarHoverClose={ws.scheduleSidebarHoverClose}
          onResizePointerDown={sidebarResize.beginResize} onResizeKeyDown={sidebarResize.resizeWithKeyboard}
          sessions={sessions} sessionFile={sessionFile} runningSessionFiles={runningSessionFiles}
          approvalSessionFiles={approvalSessionFiles} notifications={notifications} workspaceCwd={ws.workspaceCwd}
          cwd={cwd} draftWorkspace={draftWorkspace} newTask={newTask} hubView={hubView} settings={settings}
          sidebarSearchRequested={sidebarSearchRequested} setSidebarSearchRequested={setSidebarSearchRequested}
          navigateTo={nav.navigateTo} archiveConversations={nav.archiveConversations} refreshSessions={store.refreshSessions}
          markNotificationRead={store.markNotificationRead} markAllNotificationsRead={store.markAllNotificationsRead}
          dismissNotification={store.dismissNotification} showToast={store.showToast}
          revealWorkspaceInExplorer={ws.revealWorkspaceInExplorer} openSettingsPage={openSettingsPage}
          pickFolder={ws.pickFolder} contributions={contributions}
        />
        <FileActionsProvider
          workspace={ws.workspaceCwd} editors={ws.workspaceEditors} preferredEditor={ws.preferredWorkspaceEditor}
          onOpenPreview={ws.openPreviewFile} onAddToChat={(path) => void actions.addWorkspaceFileToChat(path)} onNotify={notify}
        >
          <WorkspaceFileOpenContext.Provider value={ws.openPreviewFile}>
            <div className="work-surface">
              <div className="stage-canvas">
                <StageTopbar
                  newTask={newTask} hubView={hubView} sidebarVisible={ws.sidebarVisible} pinPrimarySidebar={ws.pinPrimarySidebar}
                  showSidebarHoverPreview={ws.showSidebarHoverPreview} scheduleSidebarHoverClose={ws.scheduleSidebarHoverClose}
                  connected={connected} isStreaming={isStreaming} editingTitle={editingTitle} setEditingTitle={setEditingTitle}
                  titleDraft={titleDraft} setTitleDraft={setTitleDraft} resolvedThreadTitle={resolvedThreadTitle}
                  setSessionName={store.setSessionName} moreOpen={moreOpen} setMoreOpen={setMoreOpen} navigateTo={nav.navigateTo}
                  draftWorkspace={draftWorkspace} cwd={cwd} workspaceCwd={ws.workspaceCwd} sessionFile={sessionFile} git={git}
                  reviewGit={reviewGit} newWorktreeChat={actions.newWorktreeChat} cloneSession={store.cloneSession}
                  forkLatest={store.forkLatest} compact={store.compact} exportConversationMarkdown={nav.exportConversationMarkdown}
                  archiveConversations={nav.archiveConversations} setSettingsOpen={setSettingsOpen} disconnect={store.disconnect}
                  reviewFileCount={reviewGit?.files.length ?? 0} gitDiffStats={gitDiffStats} openReview={openReview}
                  canOpenWorkspace={ws.canOpenWorkspace} gitPushing={actions.gitPushing} openCommitDialog={actions.openCommitDialog}
                  pushCurrentBranch={actions.pushCurrentBranch} workspaceEditors={ws.workspaceEditors}
                  preferredWorkspaceEditor={ws.preferredWorkspaceEditor} terminalApps={ws.terminalApps}
                  openWorkspaceInPreferredApp={ws.openWorkspaceInPreferredApp} chooseWorkspaceEditor={ws.chooseWorkspaceEditor}
                  openWorkspaceTerminalApp={ws.openWorkspaceTerminalApp} revealWorkspaceInExplorer={ws.revealWorkspaceInExplorer}
                  openBottomTerminal={openBottomTerminal}
                />
                <MainConversationStage
                  workspaceCwd={ws.workspaceCwd} cwd={cwd} draftWorkspace={draftWorkspace}
                  defaultWorkspaceDir={ws.defaultWorkspaceDir} workspaceOptions={ws.workspaceOptions} sessionFile={sessionFile}
                  runtimeId={runtimeId} hubView={hubView} setHubView={setHubView} newTask={newTask}
                  transcriptDensity={transcriptDensity} homeHeadline={homeHeadline} lastError={store.lastError} settings={settings}
                  thinkingLevel={thinkingLevel} model={model} isStreaming={isStreaming} statusText={statusText}
                  editingMessageId={actions.editingMessage?.messageId} editUserMessage={actions.editUserMessage}
                  rewindUserMessage={actions.rewindUserMessage} cancelMessageEdit={actions.cancelMessageEdit}
                  submitMessageEdit={actions.submitMessageEdit} conversationScrollRef={conversationScrollRef}
                  autoFollowConversationRef={autoFollowConversationRef} lastAutoScrollAtRef={lastAutoScrollAtRef}
                  openSummary={openSummary} sessionChanges={sessionChanges} sessionFileStats={sessionFileStats}
                  openPreviewFile={ws.openPreviewFile} restoreGitFiles={actions.restoreGitFiles}
                  requestReview={actions.requestReview} extensionWidgets={extensionWidgets} extensionRequest={extensionRequest}
                  answerExtension={store.answerExtension} refreshSessions={store.refreshSessions} navigateTo={nav.navigateTo}
                  showErrorToast={showErrorToast} openSettingsPage={openSettingsPage} sendFromComposer={actions.sendFromComposer}
                  renderComposer={renderComposer} layoutScale={layoutScale} contributions={contributions}
                />
              </div>
              <RegionErrorBoundary region="右侧工作台" resetKey={ws.workspaceCwd || cwd}>
                <RightWorkbench
                  cwd={ws.workspaceCwd || cwd} sessionFile={sessionFile} width={workspacePanelWidth} git={reviewGit}
                  onRefreshGit={actions.refreshReviewGit} onRestoreFiles={actions.restoreGitFiles}
                  onRequestReview={() => void actions.requestReview({ mode: "uncommitted" })}
                  onAddToChat={(path) => void actions.addWorkspaceFileToChat(path)}
                  resize={{
                    onPointerDown: workspaceResize.beginResize, onKeyDown: workspaceResize.resizeWithKeyboard,
                    min: WORKSPACE_PANEL_BOUNDS.min, max: workspacePanelMaxWidth(),
                  }}
                />
              </RegionErrorBoundary>
            </div>
          </WorkspaceFileOpenContext.Provider>
        </FileActionsProvider>
      </div>
      <ShellOverlaysAndModals
        commitDialog={actions.commitDialog} setCommitDialog={actions.setCommitDialog} workspaceCwd={ws.workspaceCwd}
        cwd={cwd} sessionFile={sessionFile} reviewGit={reviewGit} model={model} isStreaming={isStreaming}
        finishCommit={actions.finishCommit} settingsOpen={settingsOpen} setSettingsOpen={setSettingsOpen}
        settingsPage={settingsPage} settings={settings} appearanceCatalog={appearanceCatalog}
        saveSettings={store.saveSettings} contributions={contributions} toasts={toasts} dismissToast={store.dismissToast}
      />
    </div>
  );
}
