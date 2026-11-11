import { memo, useMemo, useRef, useState } from "react";
import { useClientContributions } from "../lib/clientContributions";
import { insertNewlineAtSelection, resolveChatEnterAction } from "../lib/composerKeys";
import { rewindController } from "../lib/rewindController";
import { SlotEntryHost } from "./common/ErrorBoundary";
import { ComposerBottomToolbar } from "./composer/ComposerBottomToolbar";
import {
  ComposerAttachmentStrip,
  ComposerBreadcrumbTrail,
  ComposerQueuedDrawer,
  ComposerSuggestionMenus,
} from "./composer/ComposerBreadcrumbAndMenus";
import {
  buildComposerPlaceholder,
  computeContextUsageMetrics,
  type ComposerProps,
} from "./composer/composerHelpers";
import { useComposerLifecycleEffects } from "./composer/useComposerLifecycleEffects";
import { useComposerSuggestionsAndDrop } from "./composer/useComposerSuggestionsAndDrop";

export type { ComposerProps };

export const Composer = memo(function Composer({
  isStreaming,
  isSwitchingModel = false,
  disabled,
  attachments,
  commands,
  models,
  model,
  thinkingLevel,
  thinkingLevels,
  prefill,
  insertRequest = null,
  pendingCount,
  queuedMessages = [],
  requireCtrlEnter = false,
  defaultFollowUpBehavior = "steer",
  workspace = "",
  sessionFile = null,
  workspaceOptions = [],
  environment = "local",
  branchLabel = "",
  quickChat = false,
  permissionMode = "ask",
  permissionLabel: _permissionLabel = "先询问",
  agentMode = "agent",
  contextUsage,
  sessionCost,
  sessionTokens,
  variant = "follow-up",
  scope = "main",
  transcriptDensity: _transcriptDensity = "normal",
  onTranscriptDensityChange: _onTranscriptDensityChange,
  onSend,
  onStop,
  onPickAttachments,
  onAttachFiles,
  onAttachPayloads,
  onSearchFiles,
  onRemoveAttachment,
  onModelChange,
  onThinkingChange,
  onWorkspaceSelect,
  onPickWorkspace,
  onQuickChat,
  onEnvironmentChange,
  onPermissionChange,
  onAgentModeChange,
  onPrefillConsumed,
  onRemoveQueuedMessage,
  onMoveQueuedMessage,
  onSteerQueuedMessage,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const contributions = useClientContributions();
  const [streamingBehavior, setStreamingBehavior] = useState<"steer" | "followUp">(defaultFollowUpBehavior);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [streamingMenuOpen, setStreamingMenuOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);

  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionMenuRef = useRef<HTMLDivElement>(null);
  const textRef = useRef(text);

  useComposerLifecycleEffects({
    text, setText, setCaret, textRef, textareaRef, disabled, scope, prefill, onPrefillConsumed,
    insertRequest, defaultFollowUpBehavior, setStreamingBehavior, isStreaming, setStreamingMenuOpen,
    isSwitchingModel, setModelMenuOpen, workspaceOpen, setWorkspaceOpen, setWorkspaceQuery,
    environmentOpen, setEnvironmentOpen, actionsOpen, setActionsOpen, permissionOpen, setPermissionOpen,
    modelMenuOpen, streamingMenuOpen,
  });

  const suggest = useComposerSuggestionsAndDrop({
    text, setText, caret, setCaret, disabled, commands, cardRef, textareaRef, suggestionMenuRef,
    onAttachFiles, onAttachPayloads, onSearchFiles,
  });

  const visibleWorkspaces = useMemo(() => {
    const normalized = workspaceQuery.trim().toLowerCase();
    return workspaceOptions
      .filter((item, index, all) => item && all.indexOf(item) === index)
      .filter((item) => !normalized || item.toLowerCase().includes(normalized))
      .slice(0, 8);
  }, [workspaceOptions, workspaceQuery]);

  const isDefaultWorkspaceMode = quickChat || !workspace;
  const workspaceName = isDefaultWorkspaceMode
    ? "默认工作区"
    : (workspace.split(/[\\/]/).filter(Boolean).pop() || "默认工作区");
  const contextMetrics = useMemo(() => computeContextUsageMetrics(contextUsage), [contextUsage]);
  const placeholder = buildComposerPlaceholder({
    disabled, isStreaming, streamingBehavior, variant, hasSearchFiles: Boolean(onSearchFiles), requireCtrlEnter,
  });

  const submit = async () => {
    if (disabled || isSwitchingModel || (!text.trim() && attachments.length === 0)) return;
    const submittedText = text;
    setText("");
    textareaRef.current?.focus();
    const sent = await onSend(submittedText, isStreaming ? streamingBehavior : undefined);
    if (sent === true) {
      rewindController.notifyDraftSent();
    } else {
      setText(submittedText);
      textareaRef.current?.focus();
    }
  };

  const showWorkspaceChips = variant === "task-start";
  const isInlineVariant = variant === "follow-up";
  const sendDisabled = disabled || isSwitchingModel || (!text.trim() && attachments.length === 0);

  return (
    <div
      className={`composer-area codex-composer ${variant === "task-start" ? "task-start-composer" : "follow-up-composer"}`}
      data-composer-variant={isInlineVariant ? "inline" : "hero"}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (modelMenuOpen) setModelMenuOpen(false);
        else if (streamingMenuOpen) setStreamingMenuOpen(false);
        else if (actionsOpen) setActionsOpen(false);
        else if (permissionOpen) setPermissionOpen(false);
        else if (environmentOpen) setEnvironmentOpen(false);
        else if (workspaceOpen) {
          setWorkspaceOpen(false);
          setWorkspaceQuery("");
        } else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {showWorkspaceChips && (
        <ComposerBreadcrumbTrail
          workspace={workspace} workspaceName={workspaceName} isDefaultWorkspaceMode={isDefaultWorkspaceMode}
          visibleWorkspaces={visibleWorkspaces} workspaceOpen={workspaceOpen} setWorkspaceOpen={setWorkspaceOpen}
          workspaceQuery={workspaceQuery} setWorkspaceQuery={setWorkspaceQuery} environment={environment}
          environmentOpen={environmentOpen} setEnvironmentOpen={setEnvironmentOpen} setActionsOpen={setActionsOpen}
          branchLabel={branchLabel} onWorkspaceSelect={onWorkspaceSelect} onPickWorkspace={onPickWorkspace}
          onQuickChat={onQuickChat} onEnvironmentChange={onEnvironmentChange}
        />
      )}

      <div
        ref={cardRef}
        className={`composer-card unified ${showWorkspaceChips ? "with-chips" : "follow-up"}`}
        data-composer-card=""
        data-drag-over={suggest.dragOver ? "true" : undefined}
        onDragOver={suggest.browserDrop ? (event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          suggest.setDragOver(true);
        } : undefined}
        onDragLeave={suggest.browserDrop ? (event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) suggest.setDragOver(false);
        } : undefined}
        onDrop={suggest.browserDrop ? (event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          suggest.setDragOver(false);
          void suggest.attachImageFiles(Array.from(event.dataTransfer.files));
        } : undefined}
        data-composer-variant={isInlineVariant ? "inline" : "hero"}
        data-has-attachments={attachments.length > 0 ? "true" : undefined}
        data-dsh-claude-draft-empty={!text.trim() ? "" : undefined}
      >
        <ComposerSuggestionMenus
          commandMenuOpen={suggest.commandMenuOpen} commandMatches={suggest.commandMatches}
          activeCommand={suggest.activeCommand} chooseCommand={suggest.chooseCommand}
          mentionMenuOpen={suggest.mentionMenuOpen} mentionQuery={suggest.mentionQuery}
          mentionEntries={suggest.mentionEntries} mentionLoading={suggest.mentionLoading}
          activeEntry={suggest.activeEntry} chooseEntry={suggest.chooseEntry}
          suggestionsId={suggest.suggestionsId} suggestionMenuRef={suggestionMenuRef}
          setSuggestionIndex={suggest.setSuggestionIndex}
        />

        {!disabled && scope === "main" && contributions.composerBanners.map((banner) => (
          <div key={banner.id} className="composer-plugin-banner">
            <SlotEntryHost entry={banner} context={{ cwd: workspace, sessionFile, variant }} slotName="composerBanners" />
          </div>
        ))}

        <ComposerAttachmentStrip attachments={attachments} onRemoveAttachment={onRemoveAttachment} />

        <div className="dsh-claude-input-box" data-input-scroll="" onClick={() => textareaRef.current?.focus()}>
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            disabled={disabled}
            className="composer-input"
            data-phase={isStreaming ? "streaming" : "idle"}
            placeholder={placeholder}
            role="combobox"
            aria-expanded={suggest.commandMenuOpen || suggest.mentionMenuOpen}
            aria-controls={suggest.commandMenuOpen || suggest.mentionMenuOpen ? suggest.suggestionsId : undefined}
            aria-activedescendant={suggest.suggestionCount > 0 ? `${suggest.suggestionsId}-${Math.min(suggest.suggestionIndex, suggest.suggestionCount - 1)}` : undefined}
            aria-autocomplete="list"
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onPaste={suggest.handlePaste}
            onKeyDown={(event) => {
              const menuOpen = suggest.commandMenuOpen || suggest.mentionMenuOpen;
              if (menuOpen && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  suggest.setSuggestionsDismissedFor(text);
                  return;
                }
                if (suggest.suggestionCount > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  suggest.setSuggestionIndex((idx) => (Math.min(idx, suggest.suggestionCount - 1) + step + suggest.suggestionCount) % suggest.suggestionCount);
                  return;
                }
              }

              const action = resolveChatEnterAction(
                {
                  key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
                  altKey: event.altKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode,
                  defaultPrevented: event.defaultPrevented,
                },
                { requireCtrlEnter, hasActiveSuggestion: menuOpen && suggest.suggestionCount > 0 },
              );

              if (action === "accept-suggestion") {
                event.preventDefault();
                if (suggest.activeCommand) suggest.chooseCommand(suggest.activeCommand);
                else if (suggest.activeEntry) suggest.chooseEntry(suggest.activeEntry, event.key === "Tab");
                return;
              }
              if (action === "submit") {
                event.preventDefault();
                void submit();
                return;
              }
              if (action === "insert-newline") {
                event.preventDefault();
                const { value: nextText, caret: nextCaret } = insertNewlineAtSelection(
                  text, event.currentTarget.selectionStart, event.currentTarget.selectionEnd,
                );
                textRef.current = nextText;
                setText(nextText);
                setCaret(nextCaret);
                window.requestAnimationFrame(() => {
                  const el = textareaRef.current;
                  if (!el) return;
                  el.setSelectionRange(nextCaret, nextCaret);
                });
              }
            }}
          />
        </div>

        <ComposerBottomToolbar
          disabled={disabled} scope={scope} workspace={workspace} sessionFile={sessionFile} variant={variant}
          contributions={contributions} agentMode={agentMode} permissionMode={permissionMode}
          actionsOpen={actionsOpen} setActionsOpen={setActionsOpen} permissionOpen={permissionOpen}
          setPermissionOpen={setPermissionOpen} setWorkspaceOpen={setWorkspaceOpen}
          setEnvironmentOpen={setEnvironmentOpen} isStreaming={isStreaming}
          streamingBehavior={streamingBehavior} setStreamingBehavior={setStreamingBehavior}
          streamingMenuOpen={streamingMenuOpen} setStreamingMenuOpen={setStreamingMenuOpen}
          sessionCost={sessionCost} sessionTokens={sessionTokens} contextMetrics={contextMetrics}
          model={model} models={models} thinkingLevel={thinkingLevel} thinkingLevels={thinkingLevels}
          isSwitchingModel={isSwitchingModel} modelMenuOpen={modelMenuOpen} setModelMenuOpen={setModelMenuOpen}
          sendDisabled={sendDisabled} requireCtrlEnter={requireCtrlEnter}
          focusTextarea={() => textareaRef.current?.focus()} onPickAttachments={onPickAttachments}
          onPermissionChange={onPermissionChange} onAgentModeChange={onAgentModeChange}
          onModelChange={onModelChange} onThinkingChange={onThinkingChange} onStop={onStop}
          onSubmit={() => void submit()}
        />
      </div>

      <ComposerQueuedDrawer
        pendingCount={pendingCount} queuedMessages={queuedMessages} queueOpen={queueOpen} setQueueOpen={setQueueOpen}
        onMoveQueuedMessage={onMoveQueuedMessage} onSteerQueuedMessage={onSteerQueuedMessage}
        onRemoveQueuedMessage={onRemoveQueuedMessage}
      />
    </div>
  );
});
