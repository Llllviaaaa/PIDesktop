import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  File,
  Folder,
  GitBranch,
  Image as ImageIcon,
  MessageCircle,
  Mic,
  Monitor,
  Paperclip,
  Plus,
  Search,
  Shield,
  Square,
  X,
} from "lucide-react";
import type { AttachmentPayload, ModelInfo, SlashCommand } from "../types";

const THINKING_LABELS: Record<string, string> = {
  off: "关闭",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

interface ComposerProps {
  isStreaming: boolean;
  disabled?: boolean;
  attachments: AttachmentPayload[];
  commands: SlashCommand[];
  models: ModelInfo[];
  model: ModelInfo | null;
  thinkingLevel: string;
  thinkingLevels: string[];
  prefill?: string | null;
  pendingCount: number;
  requireCtrlEnter?: boolean;
  defaultFollowUpBehavior?: "steer" | "followUp";
  workspace?: string;
  workspaceOptions?: string[];
  environment?: "local" | "worktree";
  quickChat?: boolean;
  permissionLabel?: string;
  variant?: "task-start" | "follow-up";
  onSend: (text: string, behavior?: "steer" | "followUp") => Promise<void> | void;
  onStop: () => void;
  onPickAttachments: () => void;
  onRemoveAttachment: (path: string) => void;
  onModelChange: (model: ModelInfo) => void;
  onThinkingChange: (level: string) => void;
  onWorkspaceSelect?: (workspace: string) => void;
  onPickWorkspace?: () => void;
  onQuickChat?: () => void;
  onEnvironmentChange?: (environment: "local" | "worktree") => void;
  onPermissionClick?: () => void;
  onPrefillConsumed?: () => void;
}

export function Composer({
  isStreaming,
  disabled,
  attachments,
  commands,
  models,
  model,
  thinkingLevel,
  thinkingLevels,
  prefill,
  pendingCount,
  requireCtrlEnter = false,
  defaultFollowUpBehavior = "steer",
  workspace = "",
  workspaceOptions = [],
  environment = "local",
  quickChat = false,
  permissionLabel = "先询问",
  variant = "follow-up",
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
  onPermissionClick,
  onPrefillConsumed,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [streamingBehavior, setStreamingBehavior] = useState<"steer" | "followUp">(defaultFollowUpBehavior);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [actionsOpen, setActionsOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<VoiceRecognition | null>(null);

  useEffect(() => {
    if (prefill === null || prefill === undefined) return;
    setText(prefill);
    textareaRef.current?.focus();
    onPrefillConsumed?.();
  }, [prefill, onPrefillConsumed]);

  useEffect(() => setStreamingBehavior(defaultFollowUpBehavior), [defaultFollowUpBehavior]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

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

  const toggleVoice = () => {
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const VoiceConstructor = (window as VoiceWindow).SpeechRecognition || (window as VoiceWindow).webkitSpeechRecognition;
    if (!VoiceConstructor) return;
    const recognition = new VoiceConstructor();
    recognition.lang = "zh-CN";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim();
      if (transcript) setText((current) => `${current}${current.trim() ? " " : ""}${transcript}`);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  };

  const submit = async () => {
    if (disabled || (!text.trim() && attachments.length === 0)) return;
    await onSend(text, isStreaming ? streamingBehavior : undefined);
    setText("");
    textareaRef.current?.focus();
  };

  return (
    <div className={`composer-area ${variant === "task-start" ? "task-start-composer" : "follow-up-composer"}`}>
      {variant === "task-start" && <div className="composer-context-row">
        <div className="workspace-context-wrap">
          <button className="composer-context-button" onClick={() => setWorkspaceOpen((value) => !value)} title={workspace || "选择项目"}>
            {quickChat ? <MessageCircle size={14} /> : <Folder size={14} />}
            <span>{quickChat ? "快速对话" : workspaceName}</span>
            <ChevronDown size={12} />
          </button>
          {workspaceOpen && (
            <div className="workspace-context-menu">
              <label><Search size={13} /><input autoFocus value={workspaceQuery} onChange={(event) => setWorkspaceQuery(event.target.value)} placeholder="搜索项目" /></label>
              <div className="workspace-context-list">
                {visibleWorkspaces.map((item) => (
                  <button key={item} onClick={() => { onWorkspaceSelect?.(item); setWorkspaceOpen(false); setWorkspaceQuery(""); }} title={item}>
                    <Folder size={13} />
                    <span>{item.split(/[\\/]/).filter(Boolean).pop()}</span>
                    {item === workspace && <Check size={13} />}
                  </button>
                ))}
                {visibleWorkspaces.length === 0 && <small>没有已知项目</small>}
              </div>
              <button className="workspace-context-new" onClick={() => { setWorkspaceOpen(false); onPickWorkspace?.(); }}>
                <Folder size={13} /> 打开其他文件夹…
              </button>
              <button className="workspace-context-new" onClick={() => { setWorkspaceOpen(false); onQuickChat?.(); }}>
                <MessageCircle size={13} /> 不在项目中工作
              </button>
            </div>
          )}
        </div>
      </div>}
      <div className="composer-card">
        {commandMatches.length > 0 && (
          <div className="command-menu">
            {commandMatches.map((command) => (
              <button
                key={`${command.source}-${command.name}`}
                onClick={() => {
                  setText(`/${command.name} `);
                  textareaRef.current?.focus();
                }}
              >
                <span>/{command.name}</span>
                <small>{command.description || command.source}</small>
                <em>{command.source}</em>
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
                <button onClick={() => onRemoveAttachment(attachment.path)} title="移除附件">
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          rows={1}
          disabled={disabled}
          className="composer-input"
          placeholder={disabled ? "正在准备任务环境…" : isStreaming ? "继续指示 Pi，或排队一个跟进任务" : variant === "task-start" ? "描述你想让 Pi 完成的工作" : "让 Pi 继续处理这个任务"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            const shouldSubmit = requireCtrlEnter ? event.ctrlKey || event.metaKey : !event.shiftKey;
            if (event.key === "Enter" && shouldSubmit && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />

        <div className="composer-toolbar">
          <div className="composer-toolbar-left">
            <div className="composer-actions-wrap">
              <button className="composer-icon-button" onClick={() => setActionsOpen((value) => !value)} disabled={disabled} title="添加内容和选择环境">
                <Plus size={17} />
              </button>
              {actionsOpen && <div className="composer-actions-menu">
                <button onClick={() => { setActionsOpen(false); onPickAttachments(); }}><Paperclip size={14} /><span>添加文件或图片</span></button>
                {!quickChat && <>
                  <button onClick={() => { setActionsOpen(false); onEnvironmentChange?.("local"); }}><Monitor size={14} /><span>在本地工作</span>{environment === "local" && <Check size={13} />}</button>
                  <button onClick={() => { setActionsOpen(false); onEnvironmentChange?.("worktree"); }}><GitBranch size={14} /><span>创建 Worktree</span>{environment === "worktree" && <Check size={13} />}</button>
                </>}
              </div>}
            </div>
            <button className="composer-permission-button" onClick={onPermissionClick} title="任务权限">
              <Shield size={13} /> {permissionLabel}
            </button>
          </div>

          <div className="composer-toolbar-right">
            {isStreaming && (
              <label className="compact-select queue-mode">
                <select value={streamingBehavior} onChange={(event) => setStreamingBehavior(event.target.value as "steer" | "followUp")}>
                  <option value="steer">调整当前任务</option>
                  <option value="followUp">排队跟进</option>
                </select>
                <ChevronDown size={12} />
              </label>
            )}
            <label className="compact-select model-select" title="模型">
              <select
                value={model ? `${model.provider}/${model.id}` : ""}
                disabled={disabled || models.length === 0}
                onChange={(event) => {
                  const next = models.find((candidate) => `${candidate.provider}/${candidate.id}` === event.target.value);
                  if (next) onModelChange(next);
                }}
              >
                {!model && <option value="">默认模型</option>}
                {models.map((candidate) => (
                  <option key={`${candidate.provider}/${candidate.id}`} value={`${candidate.provider}/${candidate.id}`}>
                    {candidate.name || candidate.id} · {candidate.provider}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
            <label className="compact-select" title="推理等级">
              <select
                value={thinkingLevel}
                disabled={disabled}
                onChange={(event) => onThinkingChange(event.target.value)}
              >
                {(thinkingLevels.length ? thinkingLevels : ["off"]).map((level) => (
                  <option key={level} value={level}>{THINKING_LABELS[level] || level}</option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
            <button className={`composer-icon-button voice-button ${listening ? "listening" : ""}`} onClick={toggleVoice} disabled={disabled} title={listening ? "停止听写" : "语音输入"}>
              <Mic size={15} />
            </button>
            {isStreaming && (
                <button className="stop-button" onClick={onStop} title="停止智能体">
                  <Square size={12} fill="currentColor" />
                </button>
            )}
            <button
              className="send-button"
              disabled={disabled || (!text.trim() && attachments.length === 0)}
              onClick={() => void submit()}
              title={requireCtrlEnter ? "发送（Ctrl+Enter）" : isStreaming ? "消息入队" : "发送"}
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </div>
      </div>
      <div className="composer-meta">
        <span>{quickChat ? "快速对话不会使用本地项目文件或终端。" : environment === "worktree" ? "首条消息发送时创建隔离 Worktree。" : "Pi 将在所选项目中读取文件并运行命令。"}</span>
        {pendingCount > 0 && <strong>{pendingCount} 条待处理</strong>}
      </div>
    </div>
  );
}

interface VoiceResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

interface VoiceRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: VoiceResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type VoiceWindow = Window & {
  SpeechRecognition?: new () => VoiceRecognition;
  webkitSpeechRecognition?: new () => VoiceRecognition;
};
