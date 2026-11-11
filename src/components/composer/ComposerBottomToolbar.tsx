import type { CSSProperties } from "react";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleCheck,
  CornerUpRight,
  ListChecks,
  ListOrdered,
  MessageCircleQuestion,
  Paperclip,
  Plus,
  Square,
} from "lucide-react";
import type { ClientContributionsSnapshot } from "../../lib/clientContributions";
import { formatSendShortcutHint } from "../../lib/composerKeys";
import type { AppSettings, ModelInfo, SessionStats } from "../../types";
import { SlotEntryHost } from "../common/ErrorBoundary";
import { ModelPicker } from "../ModelPicker";
import {
  PERMISSION_OPTIONS,
  STREAMING_BEHAVIOR_OPTIONS,
  type ContextUsageMetrics,
} from "./composerHelpers";

export interface ComposerBottomToolbarProps {
  disabled?: boolean;
  scope: "main" | "side";
  workspace: string;
  sessionFile: string | null;
  variant: "task-start" | "follow-up";
  contributions: ClientContributionsSnapshot;
  agentMode: AppSettings["agentMode"];
  permissionMode: AppSettings["permissionMode"];
  actionsOpen: boolean;
  setActionsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  permissionOpen: boolean;
  setPermissionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setWorkspaceOpen: (next: boolean) => void;
  setEnvironmentOpen: (next: boolean) => void;
  isStreaming: boolean;
  streamingBehavior: "steer" | "followUp";
  setStreamingBehavior: (next: "steer" | "followUp") => void;
  streamingMenuOpen: boolean;
  setStreamingMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sessionCost?: number;
  sessionTokens?: SessionStats["tokens"];
  contextMetrics: ContextUsageMetrics;
  model: ModelInfo | null;
  models: ModelInfo[];
  thinkingLevel: string;
  thinkingLevels: string[];
  isSwitchingModel: boolean;
  modelMenuOpen: boolean;
  setModelMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sendDisabled: boolean;
  requireCtrlEnter: boolean;
  focusTextarea: () => void;
  onPickAttachments: () => void;
  onPermissionChange?: (mode: AppSettings["permissionMode"]) => void | Promise<void>;
  onAgentModeChange?: (mode: AppSettings["agentMode"]) => void | Promise<void>;
  onModelChange: (model: ModelInfo) => void;
  onThinkingChange: (level: string) => void;
  onStop: () => void;
  onSubmit: () => void;
}

export function ComposerBottomToolbar({
  disabled,
  scope,
  workspace,
  sessionFile,
  variant,
  contributions,
  agentMode,
  permissionMode,
  actionsOpen,
  setActionsOpen,
  permissionOpen,
  setPermissionOpen,
  setWorkspaceOpen,
  setEnvironmentOpen,
  isStreaming,
  streamingBehavior,
  setStreamingBehavior,
  streamingMenuOpen,
  setStreamingMenuOpen,
  sessionCost,
  sessionTokens,
  contextMetrics,
  model,
  models,
  thinkingLevel,
  thinkingLevels,
  isSwitchingModel,
  modelMenuOpen,
  setModelMenuOpen,
  sendDisabled,
  requireCtrlEnter,
  focusTextarea,
  onPickAttachments,
  onPermissionChange,
  onAgentModeChange,
  onModelChange,
  onThinkingChange,
  onStop,
  onSubmit,
}: ComposerBottomToolbarProps) {
  const activePermission = PERMISSION_OPTIONS.find((opt) => opt.value === permissionMode) ?? PERMISSION_OPTIONS[1];
  const activeStreamingBehavior = STREAMING_BEHAVIOR_OPTIONS.find((opt) => opt.value === streamingBehavior) ?? STREAMING_BEHAVIOR_OPTIONS[0];
  const { normalizedContextPercent, contextUsedThousands, contextWindowThousands, remainingContextPercent } = contextMetrics;

  return (
    <div className="composer-toolbar">
      <div className="composer-toolbar-left">
        <button
          type="button"
          className="composer-icon-button composer-add-trigger dsh-input-add-btn"
          data-dsh-claude-control="commands"
          onClick={() => {
            setWorkspaceOpen(false);
            setEnvironmentOpen(false);
            setActionsOpen((v) => !v);
          }}
          disabled={disabled}
          title="添加附件与切换模式"
        >
          <Plus size={16} strokeWidth={1.9} />
        </button>

        {agentMode !== "agent" && (
          <button
            type="button"
            className="chip chip-agent-mode"
            disabled={disabled}
            onClick={() => {
              setWorkspaceOpen(false);
              setEnvironmentOpen(false);
              setPermissionOpen(false);
              setActionsOpen((v) => !v);
            }}
            title={`当前工作模式：${agentMode === "plan" ? "计划（只读梳理方案）" : "问答（只读回答问题）"}`}
          >
            {agentMode === "plan" ? <ListChecks size={13} strokeWidth={1.8} /> : <MessageCircleQuestion size={13} strokeWidth={1.8} />}
            <span>{agentMode === "plan" ? "计划模式" : "问答模式"}</span>
          </button>
        )}

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
            title={`权限模式：${activePermission?.label ?? ""} · ${activePermission?.description ?? ""}`}
            aria-label={`权限模式：${activePermission?.label ?? ""}`}
            aria-haspopup="menu"
            aria-expanded={permissionOpen}
          >
            <CircleCheck size={13} strokeWidth={1.75} />
            <span>{activePermission?.label}</span>
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

        {!disabled && scope === "main" && contributions.composerToolbar.map((action) => (
          <span key={action.id} className="composer-plugin-action">
            <SlotEntryHost
              entry={action}
              context={{ cwd: workspace, sessionFile, variant }}
              slotName="composerToolbar"
              compact
            />
          </span>
        ))}

        {actionsOpen && (
          <div className="composer-actions-menu" role="menu">
            <div className="composer-actions-heading">添加</div>
            <button type="button" role="menuitem" onClick={() => { setActionsOpen(false); onPickAttachments(); }}>
              <Paperclip size={14} />
              <span>文件或图片</span>
              <small className="composer-actions-hint">可直接粘贴或拖入</small>
            </button>
            <div className="composer-actions-separator" role="separator" />
            <div className="composer-actions-heading">工作模式</div>
            {([
              ["agent", "执行", "可以修改代码、运行命令", Bot],
              ["plan", "计划", "只读梳理方案，不改文件", ListChecks],
              ["ask", "问答", "只读回答问题，不改文件", MessageCircleQuestion],
            ] as const).map(([value, label, description, Icon]) => (
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
                <small className="composer-actions-hint">{description}</small>
                {agentMode === value && <Check className="composer-actions-check" size={14} />}
              </button>
            ))}
          </div>
        )}

        {isStreaming && (
          <div className="streaming-behavior-wrap permission-context-wrap">
            <button
              type="button"
              className={`chip chip-permission chip-streaming-behavior ${streamingMenuOpen ? "active" : ""}`}
              onClick={() => {
                setActionsOpen(false);
                setPermissionOpen(false);
                setStreamingMenuOpen((value) => !value);
              }}
              title={`运行中发送：${activeStreamingBehavior?.label ?? ""} · ${activeStreamingBehavior?.description ?? ""}`}
              aria-label={`运行中发送：${activeStreamingBehavior?.label ?? ""}`}
              aria-haspopup="menu"
              aria-expanded={streamingMenuOpen}
            >
              {streamingBehavior === "steer" ? <CornerUpRight size={13} strokeWidth={1.75} /> : <ListOrdered size={13} strokeWidth={1.75} />}
              <span>{activeStreamingBehavior?.chip}</span>
              <ChevronDown size={11} strokeWidth={1.75} />
            </button>
            {streamingMenuOpen && (
              <div className="permission-menu" role="menu" aria-label="运行中发送">
                <div className="permission-menu-heading">运行中发送消息时</div>
                {STREAMING_BEHAVIOR_OPTIONS.map((option) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={streamingBehavior === option.value}
                    className={streamingBehavior === option.value ? "active" : ""}
                    key={option.value}
                    onClick={() => {
                      setStreamingBehavior(option.value);
                      setStreamingMenuOpen(false);
                      focusTextarea();
                    }}
                  >
                    <div className="permission-menu-copy">
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </div>
                    {streamingBehavior === option.value && <Check size={14} />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="composer-toolbar-right">
        {!disabled && scope === "main" && contributions.composerStatus
          .filter((item) => item.position === "before-model")
          .map((item) => (
            <SlotEntryHost
              key={item.id}
              entry={item}
              context={{ cwd: workspace, sessionFile, variant }}
              slotName="composerStatus"
              className="composer-plugin-status"
              compact
            />
          ))}
        {(scope !== "main" || contributions.composerStatus.length === 0) && sessionCost !== undefined && sessionCost > 0 && (
          <span
            className="composer-session-cost"
            title={sessionTokens
              ? `会话预估成本 · 输入 ${sessionTokens.input.toLocaleString()} / 输出 ${sessionTokens.output.toLocaleString()}${sessionTokens.reasoning ? `（推理 ${sessionTokens.reasoning.toLocaleString()}）` : ""}`
              : "会话预估成本"}
          >
            {sessionCost < 0.01 ? `$${sessionCost.toFixed(4)}` : `$${sessionCost.toFixed(2)}`}
          </span>
        )}
        {(scope !== "main" || contributions.composerStatus.length === 0) && normalizedContextPercent !== null && (
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
        {!disabled && scope === "main" && contributions.composerStatus
          .filter((item) => item.position !== "before-model")
          .map((item) => (
            <SlotEntryHost
              key={item.id}
              entry={item}
              context={{ cwd: workspace, sessionFile, variant }}
              slotName="composerStatus"
              className="composer-plugin-status"
              compact
            />
          ))}
        {isStreaming ? (
          <button type="button" className="stop-button dsh-primary-send" onClick={onStop} title="停止">
            <Square size={11} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            className="send-button dsh-primary-send"
            disabled={sendDisabled}
            onClick={onSubmit}
            aria-label="发送"
            title={`发送 (${formatSendShortcutHint(requireCtrlEnter)})`}
          >
            <ArrowUp size={16} strokeWidth={2.25} />
          </button>
        )}
      </div>
    </div>
  );
}
