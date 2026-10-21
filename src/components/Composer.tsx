import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  File,
  Folder,
  GitBranch,
  Image as ImageIcon,
  MessageCircleQuestion,
  ListChecks,
  ListOrdered,
  Monitor,
  Paperclip,
  Plus,
  Search,
  CircleCheck,
  Square,
  CornerUpRight,
  Trash2,
  X,
} from "lucide-react";
import type { AppSettings, AttachmentPayload, ManagedQueuedMessage, ModelInfo, SessionStats, SlashCommand } from "../types";
import type { AppearancePetDefinition } from "../lib/appearanceCatalog";
import type { TranscriptDensity } from "../lib/transcriptDensity";
import { ClaudeComposerCrab } from "./ClaudeComposerCrab";
import { ModelPicker } from "./ModelPicker";
import { useSyncOnChange } from "../hooks/useSyncOnChange";

const PERMISSION_OPTIONS: Array<{
  value: AppSettings["permissionMode"];
  label: string;
  description: string;
}> = [
  { value: "read-only", label: "只读", description: "可检查文件，不能修改或执行交互操作" },
  { value: "ask", label: "先询问", description: "写入文件和执行命令前请求确认" },
  { value: "workspace-write", label: "工作区写入", description: "可修改当前工作区，命令仍按规则确认" },
  { value: "full-access", label: "完全访问", description: "允许修改文件并执行命令，不再逐项确认" },
];

interface ComposerProps {
  pet?: AppearancePetDefinition;
  isStreaming: boolean;
  isSwitchingModel?: boolean;
  disabled?: boolean;
  attachments: AttachmentPayload[];
  commands: SlashCommand[];
  models: ModelInfo[];
  model: ModelInfo | null;
  thinkingLevel: string;
  thinkingLevels: string[];
  prefill?: string | null;
  /** Appends to the draft instead of replacing it (terminal output sent to chat). */
  insertRequest?: { text: string; nonce: number } | null;
  pendingCount: number;
  queuedMessages?: ManagedQueuedMessage[];
  requireCtrlEnter?: boolean;
  defaultFollowUpBehavior?: "steer" | "followUp";
  workspace?: string;
  workspaceOptions?: string[];
  environment?: "local" | "worktree";
  /** Git branch label for home chips (Codex shows project · 本地 · main). */
  branchLabel?: string;
  quickChat?: boolean;
  permissionMode?: AppSettings["permissionMode"];
  permissionLabel?: string;
  agentMode?: AppSettings["agentMode"];
  contextUsage?: SessionStats["contextUsage"];
  variant?: "task-start" | "follow-up";
  transcriptDensity?: TranscriptDensity;
  onTranscriptDensityChange?: (density: TranscriptDensity) => void;
  onSend: (text: string, behavior?: "steer" | "followUp") => Promise<boolean | void> | boolean | void;
  onStop: () => void;
  onPickAttachments: () => void;
  onRemoveAttachment: (path: string) => void;
  onModelChange: (model: ModelInfo) => void;
  onThinkingChange: (level: string) => void;
  onWorkspaceSelect?: (workspace: string) => void;
  onPickWorkspace?: () => void;
  onQuickChat?: () => void;
  onEnvironmentChange?: (environment: "local" | "worktree") => void;
  onPermissionChange?: (mode: AppSettings["permissionMode"]) => void | Promise<void>;
  onAgentModeChange?: (mode: AppSettings["agentMode"]) => void | Promise<void>;
  onPrefillConsumed?: () => void;
  onRemoveQueuedMessage?: (id: string) => void;
  onMoveQueuedMessage?: (id: string, direction: -1 | 1) => void;
  onSteerQueuedMessage?: (id: string) => void | Promise<void>;
}

export const Composer = memo(function Composer({
  pet,
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
  workspaceOptions = [],
  environment = "local",
  branchLabel = "",
  quickChat = false,
  permissionMode = "ask",
  permissionLabel: _permissionLabel = "先询问",
  agentMode = "agent",
  contextUsage,
  variant = "follow-up",
  transcriptDensity: _transcriptDensity = "normal",
  onTranscriptDensityChange: _onTranscriptDensityChange,
  onSend,
  onStop,
  onPickAttachments,
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
  const [streamingBehavior, setStreamingBehavior] = useState<"steer" | "followUp">(defaultFollowUpBehavior);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const normalizedContextPercent = typeof contextUsage?.percent === "number" && Number.isFinite(contextUsage.percent)
    ? Math.min(100, Math.max(0, Math.round(contextUsage.percent)))
    : null;
  const contextUsedTokens = typeof contextUsage?.tokens === "number" && Number.isFinite(contextUsage.tokens)
    ? Math.max(0, contextUsage.tokens)
    : null;
  const contextWindow = typeof contextUsage?.contextWindow === "number"
    && Number.isFinite(contextUsage.contextWindow)
    && contextUsage.contextWindow > 0
    ? contextUsage.contextWindow
    : null;
  const contextUsedThousands = contextUsedTokens === null ? null : Math.round(contextUsedTokens / 1_000);
  const contextWindowThousands = contextWindow === null ? null : Math.round(contextWindow / 1_000);
  const remainingContextPercent = normalizedContextPercent === null ? null : Math.max(0, 100 - normalizedContextPercent);

  useEffect(() => {
    if (prefill === null || prefill === undefined) return;
    setText(prefill);
    textareaRef.current?.focus();
    onPrefillConsumed?.();
  }, [prefill, onPrefillConsumed]);

  useSyncOnChange([insertRequest?.nonce], () => {
    if (!insertRequest) return;
    setText((current) => (current.trim() ? `${current.replace(/\s+$/, "")}\n\n${insertRequest.text}` : insertRequest.text));
  });
  useEffect(() => {
    if (insertRequest) textareaRef.current?.focus();
  }, [insertRequest]);

  useEffect(() => setStreamingBehavior(defaultFollowUpBehavior), [defaultFollowUpBehavior]);

  useEffect(() => {
    if (!workspaceOpen && !environmentOpen && !actionsOpen && !permissionOpen && !modelMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (workspaceOpen && !target.closest(".workspace-context-wrap")) {
        setWorkspaceOpen(false);
        setWorkspaceQuery("");
      }
      if (environmentOpen && !target.closest(".environment-context-wrap")) setEnvironmentOpen(false);
      if (actionsOpen && !target.closest(".composer-actions-menu, .composer-add-trigger")) setActionsOpen(false);
      if (permissionOpen && !target.closest(".permission-context-wrap")) setPermissionOpen(false);
      if (modelMenuOpen && !target.closest(".model-picker-wrap")) setModelMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [actionsOpen, environmentOpen, modelMenuOpen, permissionOpen, workspaceOpen]);

  useEffect(() => {
    if (!isSwitchingModel) return;
    setModelMenuOpen(false);
  }, [isSwitchingModel]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    if (resizeFrameRef.current !== null) return;
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      element.style.height = "auto";
      element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
    });
  }, [text]);

  useEffect(() => () => {
    if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
  }, []);

  const commandQuery = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const commandMatches = useMemo(
    () => commandQuery === null
      ? []
      : commands.filter((command) => command.name.toLowerCase().includes(commandQuery)).slice(0, 8),
    [commandQuery, commands],
  );
  const visibleWorkspaces = useMemo(() => {
    const normalized = workspaceQuery.trim().toLowerCase();
    return workspaceOptions
      .filter((item, index, all) => item && all.indexOf(item) === index)
      .filter((item) => !normalized || item.toLowerCase().includes(normalized))
      .slice(0, 8);
  }, [workspaceOptions, workspaceQuery]);
  const workspaceName = workspace.split(/[\\/]/).filter(Boolean).pop() || "选择项目";
  const activePermission = PERMISSION_OPTIONS.find((option) => option.value === permissionMode) ?? PERMISSION_OPTIONS[1];

  const submit = async () => {
    if (disabled || isSwitchingModel || (!text.trim() && attachments.length === 0)) return;
    const submittedText = text;
    setText("");
    textareaRef.current?.focus();
    const sent = await onSend(submittedText, isStreaming ? streamingBehavior : undefined);
    if (sent !== true) {
      setText(submittedText);
      textareaRef.current?.focus();
    }
  };

  // Codex/Claude home: project/local chips on the soft shell.
  // Conversation: NO chips — only + / permission segments / model / send.
  const showWorkspaceChips = variant === "task-start" && !quickChat;
  const isInlineVariant = variant === "follow-up";
  const sendDisabled = disabled || isSwitchingModel || (!text.trim() && attachments.length === 0);

  return (
    <div
      className={`composer-area codex-composer ${variant === "task-start" ? "task-start-composer" : "follow-up-composer"}`}
      data-composer-variant={isInlineVariant ? "inline" : "hero"}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        if (modelMenuOpen) setModelMenuOpen(false);
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
        <div className="composer-breadcrumb-trail" aria-label="项目与工作环境">
          <div className="workspace-context-wrap">
            <button
              type="button"
              className="chip chip-project"
              onClick={() => { setEnvironmentOpen(false); setActionsOpen(false); setWorkspaceOpen((v) => !v); }}
              title={workspace || "选择项目"}
            >
              <Folder size={13} strokeWidth={1.75} />
              <span>{workspaceName}</span>
              <ChevronDown size={11} strokeWidth={1.75} />
            </button>
            {workspaceOpen && (
              <div className="workspace-context-menu">
                <label><Search size={13} /><input autoFocus value={workspaceQuery} onChange={(e) => setWorkspaceQuery(e.target.value)} placeholder="搜索项目" /></label>
                <div className="workspace-context-list">
                  {visibleWorkspaces.map((item) => (
                    <button key={item} type="button" onClick={() => { onWorkspaceSelect?.(item); setWorkspaceOpen(false); setWorkspaceQuery(""); }} title={item}>
                      <span>{item.split(/[\\/]/).filter(Boolean).pop()}</span>
                      {item === workspace && <Check size={13} />}
                    </button>
                  ))}
                  {visibleWorkspaces.length === 0 && <small>没有已知项目</small>}
                </div>
                <button type="button" className="workspace-context-new" onClick={() => { setWorkspaceOpen(false); onPickWorkspace?.(); }}>
                  打开其他文件夹…
                </button>
                <button type="button" className="workspace-context-new" onClick={() => { setWorkspaceOpen(false); onQuickChat?.(); }}>
                  不在项目中工作
                </button>
              </div>
            )}
          </div>
          <div className="environment-context-wrap">
            <button
              type="button"
              className={`chip chip-env ${environment === "worktree" ? "worktree" : "local"}`}
              onClick={() => { setWorkspaceOpen(false); setActionsOpen(false); setEnvironmentOpen((value) => !value); }}
              title={environment === "worktree" ? "Worktree 隔离检出" : "本地工作区"}
              aria-haspopup="menu"
              aria-expanded={environmentOpen}
            >
              {environment === "worktree" ? <GitBranch size={13} /> : <Monitor size={13} />}
              <span>{environment === "worktree" ? "Worktree" : "本地"}</span>
              <ChevronDown size={11} strokeWidth={1.75} />
            </button>
            {environmentOpen && (
              <div className="workspace-context-menu environment-context-menu" role="menu">
                <div className="workspace-context-list">
                  <button type="button" role="menuitem" onClick={() => { onEnvironmentChange?.("local"); setEnvironmentOpen(false); }}>
                    <Monitor size={13} />
                    <span>本地</span>
                    {environment === "local" && <Check size={13} />}
                  </button>
                  <button type="button" role="menuitem" onClick={() => { onEnvironmentChange?.("worktree"); setEnvironmentOpen(false); }}>
                    <GitBranch size={13} />
                    <span>Worktree</span>
                    {environment === "worktree" && <Check size={13} />}
                  </button>
                </div>
              </div>
            )}
          </div>
          {branchLabel ? (
            <span className="chip chip-branch" title="当前分支">
              <GitBranch size={13} strokeWidth={1.75} />
              <span>{branchLabel}</span>
            </span>
          ) : null}
        </div>
      )}

      <div
        className={`composer-card unified ${showWorkspaceChips ? "with-chips" : "follow-up"}`}
        data-composer-card=""
        data-composer-variant={isInlineVariant ? "inline" : "hero"}
        data-has-attachments={attachments.length > 0 ? "true" : undefined}
        data-dsh-claude-draft-empty={!text.trim() ? "" : undefined}
      >
        <ClaudeComposerCrab
          pet={pet}
          isStreaming={isStreaming}
          isThinking={isStreaming && thinkingLevel !== "off"}
        />

        {commandMatches.length > 0 && (
          <div className="command-menu" role="menu" aria-label="快捷指令">
            {commandMatches.map((command) => (
              <button
                key={`${command.source}-${command.name}`}
                type="button"
                className="command-menu-item"
                role="menuitem"
                onClick={() => {
                  setText(`/${command.name} `);
                  textareaRef.current?.focus();
                }}
              >
                <span className="command-item-name">/{command.name}</span>
                <small className="command-item-desc">{command.description || command.source}</small>
                <em className="command-item-source">{command.source}</em>
              </button>
            ))}
          </div>
        )}

        {attachments.length > 0 && (
          <div className="attachment-strip">
            {attachments.map((attachment) => (
              <div className="attachment-chip" key={attachment.path}>
                {attachment.kind === "image" ? <ImageIcon size={14} /> : <File size={14} />}
                <span>{attachment.fileName}</span>
                <button type="button" onClick={() => onRemoveAttachment(attachment.path)} title="移除附件">
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div
          className="dsh-claude-input-box"
          data-input-scroll=""
          onClick={() => textareaRef.current?.focus()}
        >
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            disabled={disabled}
            className="composer-input"
            // DSH's composer marker: better-sidebar inserts file references at this textarea's caret.
            data-phase={isStreaming ? "streaming" : "idle"}
            placeholder={disabled ? "正在准备…" : isStreaming ? "继续指示…" : "发消息，用 / 调用命令，@ 引用文件…"}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              const shouldSubmit = requireCtrlEnter ? event.ctrlKey || event.metaKey : !event.shiftKey;
              if (event.key === "Enter" && shouldSubmit && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </div>

        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            <button
              type="button"
              className="composer-icon-button composer-add-trigger dsh-input-add-btn"
              data-dsh-claude-control="commands"
              onClick={() => { setWorkspaceOpen(false); setEnvironmentOpen(false); setActionsOpen((v) => !v); }}
              disabled={disabled}
              title="添加附件与切换模式"
            >
              <Plus size={16} strokeWidth={1.9} />
            </button>

            <div className="permission-context-wrap">
              <button
                type="button"
                className={`chip chip-permission ${permissionOpen ? "active" : ""}`}
                disabled={disabled}
                onClick={() => {
                  setWorkspaceOpen(false);
                  setEnvironmentOpen(false);
                  setActionsOpen(false);
                  setPermissionOpen((value) => !value);
                }}
                title={`权限模式：${activePermission.label} · ${activePermission.description}`}
                aria-label={`权限模式：${activePermission.label}`}
                aria-haspopup="menu"
                aria-expanded={permissionOpen}
              >
                <CircleCheck size={13} strokeWidth={1.75} />
                <span>{activePermission.label}</span>
                <ChevronDown size={11} strokeWidth={1.75} />
              </button>
              {permissionOpen && (
                <div className="permission-menu" role="menu" aria-label="权限模式">
                  <div className="permission-menu-heading">执行权限</div>
                  {PERMISSION_OPTIONS.map((option) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={permissionMode === option.value}
                      className={permissionMode === option.value ? "active" : ""}
                      key={option.value}
                      onClick={() => {
                        setPermissionOpen(false);
                        void onPermissionChange?.(option.value);
                      }}
                    >
                      <div className="permission-menu-copy">
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </div>
                      {permissionMode === option.value && <Check size={14} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {actionsOpen && (
              <div className="composer-actions-menu" role="menu">
                <button type="button" onClick={() => { setActionsOpen(false); onPickAttachments(); }}>
                  <Paperclip size={14} /><span>添加文件或图片</span>
                </button>
                <div className="composer-actions-separator" role="separator" />
                <div className="composer-actions-heading">工作模式</div>
                {([
                  ["agent", "执行", Bot],
                  ["plan", "计划", ListChecks],
                  ["ask", "问答", MessageCircleQuestion],
                ] as const).map(([value, label, Icon]) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={agentMode === value}
                    className={agentMode === value ? "active" : ""}
                    key={value}
                    onClick={() => {
                      setActionsOpen(false);
                      if (agentMode !== value) void onAgentModeChange?.(value);
                    }}
                  >
                    <Icon size={14} />
                    <span>{label}</span>
                    {agentMode === value && <Check size={14} />}
                  </button>
                ))}
                <div className="composer-actions-separator" role="separator" />
                <div className="composer-actions-heading">权限说明</div>
                {PERMISSION_OPTIONS.map((option) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={permissionMode === option.value}
                    className={permissionMode === option.value ? "active" : ""}
                    key={option.value}
                    onClick={() => {
                      setActionsOpen(false);
                      void onPermissionChange?.(option.value);
                    }}
                  >
                    <CircleCheck size={14} />
                    <span className="permission-menu-copy">
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                    {permissionMode === option.value && <Check size={14} />}
                  </button>
                ))}
              </div>
            )}
            {isStreaming && (
              <label className="compact-select queue-mode">
                <select value={streamingBehavior} onChange={(event) => setStreamingBehavior(event.target.value as "steer" | "followUp")}>
                  <option value="steer">调整</option>
                  <option value="followUp">跟进</option>
                </select>
                <ChevronDown size={12} />
              </label>
            )}
          </div>

          <div className="composer-toolbar-right">
            {normalizedContextPercent !== null && (
              <span className="composer-context-usage">
                <span
                  className="composer-context-indicator"
                  role="img"
                  tabIndex={0}
                  aria-label={`上下文用量：${normalizedContextPercent}%`}
                  aria-describedby="composer-context-usage-tooltip"
                  style={{ "--context-percent": `${normalizedContextPercent}%` } as CSSProperties}
                />
                <span id="composer-context-usage-tooltip" className="composer-context-tooltip" role="tooltip">
                  <span className="composer-context-tooltip-label">上下文窗口：</span>
                  <span className={normalizedContextPercent >= 50 ? "composer-context-tooltip-muted" : undefined}>
                    {normalizedContextPercent >= 50
                      ? `${normalizedContextPercent}% 已用`
                      : `${normalizedContextPercent}% 已用（剩余 ${remainingContextPercent}%）`}
                  </span>
                  {contextUsedThousands !== null && contextWindowThousands !== null && (
                    <span>已用 {contextUsedThousands}K token，共 {contextWindowThousands}K</span>
                  )}
                </span>
              </span>
            )}
            <ModelPicker
              model={model}
              models={models}
              thinkingLevel={thinkingLevel}
              thinkingLevels={thinkingLevels}
              disabled={disabled}
              isSwitchingModel={isSwitchingModel}
              open={modelMenuOpen}
              onToggle={() => {
                setWorkspaceOpen(false);
                setEnvironmentOpen(false);
                setActionsOpen(false);
                setPermissionOpen(false);
                setModelMenuOpen((value) => !value);
              }}
              onClose={() => setModelMenuOpen(false)}
              onModelChange={onModelChange}
              onThinkingChange={onThinkingChange}
            />
            {isStreaming ? (
              <button type="button" className="stop-button dsh-primary-send" onClick={onStop} title="停止">
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                className="send-button dsh-primary-send"
                disabled={sendDisabled}
                onClick={() => void submit()}
                title="发送"
              >
                <ArrowUp size={16} strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>
      </div>

      {pendingCount > 0 && (
        <div className={`composer-queue ${queueOpen ? "open" : ""}`}>
          <button
            type="button"
            className="composer-queue-summary"
            onClick={() => queuedMessages.length > 0 && setQueueOpen((value) => !value)}
            aria-expanded={queuedMessages.length > 0 ? queueOpen : undefined}
            title={queuedMessages.length > 0 ? "查看待处理消息" : "Pi 内部待处理消息"}
          >
            <ListOrdered size={14} />
            <strong>{pendingCount} 条待处理</strong>
            {queuedMessages.length > 0 && (queueOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />)}
          </button>
          {queueOpen && queuedMessages.length > 0 && (
            <ol className="composer-queue-list" aria-label="待处理消息">
              {queuedMessages.map((item, index) => (
                <li key={item.id}>
                  <span className="composer-queue-order">{index + 1}</span>
                  <span className="composer-queue-copy" title={item.text || item.attachments.map((file) => file.fileName).join(", ")}>
                    {item.text || item.attachments.map((file) => file.fileName).join(", ")}
                  </span>
                  <span className="composer-queue-actions">
                    <button type="button" disabled={index === 0} onClick={() => onMoveQueuedMessage?.(item.id, -1)} title="上移">
                      <ChevronUp size={14} />
                    </button>
                    <button type="button" disabled={index === queuedMessages.length - 1} onClick={() => onMoveQueuedMessage?.(item.id, 1)} title="下移">
                      <ChevronDown size={14} />
                    </button>
                    <button type="button" onClick={() => void onSteerQueuedMessage?.(item.id)} title="立即作为调整发送">
                      <CornerUpRight size={14} />
                    </button>
                    <button type="button" onClick={() => onRemoveQueuedMessage?.(item.id)} title="删除">
                      <Trash2 size={14} />
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
});
