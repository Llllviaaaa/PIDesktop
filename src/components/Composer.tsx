import { memo, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties } from "react";
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
import type { AppSettings, AttachmentPayload, ManagedQueuedMessage, ModelInfo, SessionStats, SlashCommand, WorkspaceDirEntry } from "../types";
import type { TranscriptDensity } from "../lib/transcriptDensity";
import { ModelPicker } from "./ModelPicker";
import { useSyncOnChange } from "../hooks/useSyncOnChange";
import { imageAttachmentFromBlob } from "../lib/attachments";
import { useClientContributions } from "../lib/clientContributions";
import { rewindController } from "../lib/rewindController";

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

/** What a message sent while the agent works does; the labels match the settings page. */
const STREAMING_BEHAVIOR_OPTIONS: Array<{
  value: "steer" | "followUp";
  chip: string;
  label: string;
  description: string;
}> = [
  { value: "steer", chip: "调整", label: "调整当前任务", description: "插进正在进行的任务" },
  { value: "followUp", chip: "排队", label: "排队到下一轮", description: "等这一轮做完再发送" },
];

/** The suggestion menus scroll; these only bound how many rows they render. */
const MAX_COMMAND_MATCHES = 50;
const MAX_MENTION_RESULTS = 50;

interface ComposerProps {
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
  sessionCost?: number;
  sessionTokens?: SessionStats["tokens"];
  variant?: "task-start" | "follow-up";
  /** Isolates side-chat composers from main-conversation rewind & plugin slots. */
  scope?: "main" | "side";
  transcriptDensity?: TranscriptDensity;
  onTranscriptDensityChange?: (density: TranscriptDensity) => void;
  onSend: (text: string, behavior?: "steer" | "followUp") => Promise<boolean | void> | boolean | void;
  onStop: () => void;
  onPickAttachments: () => void;
  /** Files dropped onto the composer from the desktop, by path. */
  onAttachFiles?: (paths: string[]) => void;
  /** Images pasted or dropped without a path on disk, already read. */
  onAttachPayloads?: (attachments: AttachmentPayload[]) => void;
  /** Workspace files for an `@` mention; without it `@` is plain text. */
  onSearchFiles?: (query: string, signal: AbortSignal) => Promise<WorkspaceDirEntry[]>;
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
  // One highlighted row for whichever suggestion menu is open (/ commands or @ files).
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  // Escape hides the suggestions for the draft it was pressed on; typing brings them back.
  const [suggestionsDismissedFor, setSuggestionsDismissedFor] = useState<string | null>(null);
  const suggestionsId = useId();
  const suggestionMenuRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [fileResults, setFileResults] = useState<{ query: string; entries: WorkspaceDirEntry[] } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);
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

  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    if (disabled || scope !== "main") return undefined;
    return rewindController.bindTextBridge({
      getText: () => textRef.current,
      setText: (nextText, focus) => {
        textRef.current = nextText;
        setText(nextText);
        setCaret(nextText.length);
        if (focus) {
          window.requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (!el) return;
            el.focus();
            el.setSelectionRange(nextText.length, nextText.length);
          });
        }
      },
    });
  }, [disabled, scope]);

  useEffect(() => {
    if (prefill === null || prefill === undefined) return;
    textRef.current = prefill;
    setText(prefill);
    setCaret(prefill.length);
    window.requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(prefill.length, prefill.length);
    });
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
    if (!workspaceOpen && !environmentOpen && !actionsOpen && !permissionOpen && !modelMenuOpen && !streamingMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (workspaceOpen && !target.closest(".workspace-context-wrap")) {
        setWorkspaceOpen(false);
        setWorkspaceQuery("");
      }
      if (environmentOpen && !target.closest(".environment-context-wrap")) setEnvironmentOpen(false);
      if (actionsOpen && !target.closest(".composer-actions-menu, .composer-add-trigger, .chip-agent-mode")) setActionsOpen(false);
      if (permissionOpen && !target.closest(".permission-context-wrap")) setPermissionOpen(false);
      if (modelMenuOpen && !target.closest(".model-picker-wrap")) setModelMenuOpen(false);
      if (streamingMenuOpen && !target.closest(".streaming-behavior-wrap")) setStreamingMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [actionsOpen, environmentOpen, modelMenuOpen, permissionOpen, streamingMenuOpen, workspaceOpen]);

  // The behaviour menu only means something while a turn runs.
  useEffect(() => {
    if (!isStreaming) setStreamingMenuOpen(false);
  }, [isStreaming]);

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

  // The desktop webview takes file drops itself and reports them with their paths;
  // only a drop that lands on this composer's card attaches to it.
  const attachFilesRef = useRef(onAttachFiles);
  attachFilesRef.current = onAttachFiles;
  const canAttachFiles = Boolean(onAttachFiles) && !disabled;
  useEffect(() => {
    if (!canAttachFiles || !("__TAURI_INTERNALS__" in window)) return;
    const overCard = (position: { x: number; y: number }) => {
      const rect = cardRef.current?.getBoundingClientRect();
      if (!rect) return false;
      const x = position.x / window.devicePixelRatio;
      const y = position.y / window.devicePixelRatio;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") {
        setDragOver(false);
        return;
      }
      const over = overCard(payload.position);
      if (payload.type === "drop") {
        setDragOver(false);
        if (over && payload.paths.length > 0) attachFilesRef.current?.(payload.paths);
        return;
      }
      setDragOver(over);
    })).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    }).catch(() => {
      // Without the drag-and-drop event the composer still takes pastes and the + menu.
    });
    return () => {
      cancelled = true;
      unlisten?.();
      setDragOver(false);
    };
  }, [canAttachFiles]);

  const attachImageFiles = async (files: File[]) => {
    const payloads = (await Promise.all(files.map(imageAttachmentFromBlob)))
      .filter((item): item is AttachmentPayload => item !== null);
    if (payloads.length > 0) onAttachPayloads?.(payloads);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onAttachPayloads || disabled) return;
    const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    // Text wins when the clipboard has both, as when copying from a rich document.
    if (images.length === 0 || event.clipboardData.getData("text/plain")) return;
    event.preventDefault();
    void attachImageFiles(images);
  };

  // Outside the desktop (the browser build) drops arrive as files without paths.
  const browserDrop = onAttachPayloads && !disabled && !("__TAURI_INTERNALS__" in window);

  const commandQuery = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const commandMatches = useMemo(
    () => commandQuery === null
      ? []
      : commands
        .filter((command) => command.name.toLowerCase().includes(commandQuery))
        // Names that start with the query come before ones that only contain it.
        .sort((left, right) => Number(!left.name.toLowerCase().startsWith(commandQuery)) - Number(!right.name.toLowerCase().startsWith(commandQuery)))
        .slice(0, MAX_COMMAND_MATCHES),
    [commandQuery, commands],
  );
  const suggestionsDismissed = suggestionsDismissedFor === text;
  const commandMenuOpen = commandMatches.length > 0 && !suggestionsDismissed;
  const activeCommand = commandMenuOpen ? commandMatches[Math.min(suggestionIndex, commandMatches.length - 1)] : undefined;
  const chooseCommand = (command: SlashCommand) => {
    setText(`/${command.name} `);
    textareaRef.current?.focus();
  };

  // An `@` at the start or after whitespace, running up to the caret, is a file mention.
  const mention = useMemo(() => {
    if (!onSearchFiles || disabled) return null;
    const match = /(^|\s)@([^\s@"]*)$/.exec(text.slice(0, caret));
    return match ? { query: match[2], start: caret - match[2].length - 1 } : null;
  }, [caret, disabled, onSearchFiles, text]);
  const mentionQuery = mention?.query ?? null;
  const mentionMenuOpen = mention !== null && !commandMenuOpen && !suggestionsDismissed;
  // The last results stay up while the next query runs, so the list does not blink per keystroke.
  const mentionEntries = fileResults?.entries ?? [];
  const mentionLoading = mentionMenuOpen && fileResults?.query !== mentionQuery;
  useSyncOnChange([mentionMenuOpen], () => {
    if (!mentionMenuOpen) setFileResults(null);
  });
  const activeEntry = mentionMenuOpen ? mentionEntries[Math.min(suggestionIndex, mentionEntries.length - 1)] : undefined;
  const searchFilesRef = useRef(onSearchFiles);
  searchFilesRef.current = onSearchFiles;
  useEffect(() => {
    if (!mentionMenuOpen || mentionQuery === null) return;
    const controller = new AbortController();
    // Listing a folder is instant; a search waits for the user to pause.
    const timer = window.setTimeout(() => {
      void (searchFilesRef.current?.(mentionQuery, controller.signal) ?? Promise.resolve([]))
        .catch((): WorkspaceDirEntry[] => [])
        .then((entries) => {
          if (!controller.signal.aborted) setFileResults({ query: mentionQuery, entries: entries.slice(0, MAX_MENTION_RESULTS) });
        });
    }, mentionQuery === "" || mentionQuery.endsWith("/") ? 0 : 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [mentionMenuOpen, mentionQuery]);

  /** Replaces the `@query` before the caret; a folder opened with Tab keeps the menu going. */
  const chooseEntry = (entry: WorkspaceDirEntry, enterFolder: boolean) => {
    if (!mention) return;
    const quoted = /\s/.test(entry.path);
    const keepBrowsing = enterFolder && entry.isDir && !quoted;
    const reference = quoted ? `@"${entry.path}"` : `@${entry.path}`;
    const inserted = keepBrowsing ? `${reference}/` : `${reference}${entry.isDir ? "/" : ""} `;
    const next = `${text.slice(0, mention.start)}${inserted}${text.slice(caret)}`;
    const nextCaret = mention.start + inserted.length;
    setText(next);
    setCaret(nextCaret);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const suggestionCount = commandMenuOpen ? commandMatches.length : mentionMenuOpen ? mentionEntries.length : 0;
  useSyncOnChange([commandQuery, mentionQuery], () => setSuggestionIndex(0));
  useEffect(() => {
    if (suggestionCount === 0) return;
    suggestionMenuRef.current
      ?.querySelector<HTMLElement>(`[data-suggestion-index="${suggestionIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [suggestionCount, suggestionIndex]);
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
  const activePermission = PERMISSION_OPTIONS.find((option) => option.value === permissionMode) ?? PERMISSION_OPTIONS[1];
  const activeStreamingBehavior = STREAMING_BEHAVIOR_OPTIONS.find((option) => option.value === streamingBehavior) ?? STREAMING_BEHAVIOR_OPTIONS[0];
  // The placeholder says what Enter will do now, and only offers @ where it works.
  const commandHint = onSearchFiles ? "用 / 调用命令，@ 引用文件…" : "用 / 调用命令…";
  const placeholder = disabled
    ? "正在准备…"
    : isStreaming
      ? streamingBehavior === "steer" ? "补充指示，会插入正在进行的任务…" : "写下一条消息，这一轮结束后发送…"
      : variant === "task-start"
        ? `描述要做的事，${commandHint}`
        : `继续对话，${commandHint}`;

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

  // Codex/Claude home: project/local chips on the soft shell.
  // Conversation: NO chips — only + / permission segments / model / send.
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
        <div className="composer-breadcrumb-trail" aria-label="项目与工作环境">
          <div className="workspace-context-wrap">
            <button
              type="button"
              className="chip chip-project"
              onClick={() => { setEnvironmentOpen(false); setActionsOpen(false); setWorkspaceOpen((v) => !v); }}
              title={isDefaultWorkspaceMode ? "默认工作区（快速对话）" : workspace}
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
                      {!isDefaultWorkspaceMode && item === workspace && <Check size={13} />}
                    </button>
                  ))}
                  {visibleWorkspaces.length === 0 && <small>没有已知项目</small>}
                </div>
                <button type="button" className="workspace-context-new" onClick={() => { setWorkspaceOpen(false); onPickWorkspace?.(); }}>
                  打开其他文件夹…
                </button>
                <button type="button" className="workspace-context-new" onClick={() => { setWorkspaceOpen(false); onQuickChat?.(); }}>
                  <span>默认工作区（快速对话）</span>
                  {isDefaultWorkspaceMode && <Check size={13} />}
                </button>
              </div>
            )}
          </div>
          {!isDefaultWorkspaceMode && (
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
          )}
          {branchLabel ? (
            <span className="chip chip-branch" title="当前分支">
              <GitBranch size={13} strokeWidth={1.75} />
              <span>{branchLabel}</span>
            </span>
          ) : null}
        </div>
      )}

      <div
        ref={cardRef}
        className={`composer-card unified ${showWorkspaceChips ? "with-chips" : "follow-up"}`}
        data-composer-card=""
        data-drag-over={dragOver ? "true" : undefined}
        onDragOver={browserDrop ? (event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragOver(true);
        } : undefined}
        onDragLeave={browserDrop ? (event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
        } : undefined}
        onDrop={browserDrop ? (event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          setDragOver(false);
          void attachImageFiles(Array.from(event.dataTransfer.files));
        } : undefined}
        data-composer-variant={isInlineVariant ? "inline" : "hero"}
        data-has-attachments={attachments.length > 0 ? "true" : undefined}
        data-dsh-claude-draft-empty={!text.trim() ? "" : undefined}
      >
        {commandMenuOpen && (
          <div className="command-menu" id={suggestionsId} role="listbox" aria-label="快捷指令" ref={suggestionMenuRef}>
            {commandMatches.map((command, index) => (
              <button
                key={`${command.source}-${command.name}`}
                id={`${suggestionsId}-${index}`}
                data-suggestion-index={index}
                type="button"
                className={`command-menu-item${command === activeCommand ? " active" : ""}`}
                role="option"
                aria-selected={command === activeCommand}
                tabIndex={-1}
                onMouseEnter={() => setSuggestionIndex(index)}
                // Keep focus in the textarea so the keys keep driving the menu.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseCommand(command)}
              >
                <span className="command-item-name">
                  /{command.name}
                  {command.argsHint ? ` ${command.argsHint}` : ""}
                </span>
                <small className="command-item-desc">{command.description || command.source}</small>
                <em className="command-item-source">
                  {command.source === "builtin"
                    ? "内置"
                    : command.source === "skill"
                      ? "技能"
                      : command.source === "mcp"
                        ? "MCP"
                        : command.source === "plugin" || command.source === "extension"
                          ? "插件"
                          : command.source}
                </em>
              </button>
            ))}
          </div>
        )}

        {mentionMenuOpen && (
          <div className="command-menu mention-menu" id={suggestionsId} role="listbox" aria-label="引用文件" ref={suggestionMenuRef}>
            <div className="mention-menu-heading" aria-hidden="true">
              {mentionQuery?.endsWith("/") ? mentionQuery : "文件与文件夹"}
            </div>
            {mentionEntries.map((entry, index) => {
              // Inside a folder the heading already names it; a search shows where each hit lives.
              const folder = !mentionQuery?.endsWith("/") && entry.path.includes("/")
                ? entry.path.slice(0, entry.path.lastIndexOf("/"))
                : "";
              return (
                <button
                  key={entry.path}
                  id={`${suggestionsId}-${index}`}
                  data-suggestion-index={index}
                  type="button"
                  className={`mention-item${entry === activeEntry ? " active" : ""}`}
                  role="option"
                  aria-selected={entry === activeEntry}
                  tabIndex={-1}
                  title={entry.path}
                  onMouseEnter={() => setSuggestionIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseEntry(entry, entry.isDir)}
                >
                  {entry.isDir ? <Folder size={14} /> : <File size={14} />}
                  <span className="mention-item-name">{entry.name}{entry.isDir ? "/" : ""}</span>
                  <small className="mention-item-path">{folder}</small>
                  {entry.isDir && <kbd className="mention-item-hint">Tab 进入</kbd>}
                </button>
              );
            })}
            {mentionEntries.length === 0 && (
              <div className="mention-menu-status">{mentionLoading ? "正在查找…" : "没有匹配的文件"}</div>
            )}
          </div>
        )}

        {!disabled && scope === "main" && contributions.composerBanners.map((banner) => (
          <div key={banner.id} className="composer-plugin-banner">
            {banner.render({ cwd: workspace, sessionFile: null })}
          </div>
        ))}

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
            // Workbench file tree actions insert file references at this textarea's caret.
            data-phase={isStreaming ? "streaming" : "idle"}
            placeholder={placeholder}
            role="combobox"
            aria-expanded={commandMenuOpen || mentionMenuOpen}
            aria-controls={commandMenuOpen || mentionMenuOpen ? suggestionsId : undefined}
            aria-activedescendant={suggestionCount > 0 ? `${suggestionsId}-${Math.min(suggestionIndex, suggestionCount - 1)}` : undefined}
            aria-autocomplete="list"
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if ((commandMenuOpen || mentionMenuOpen) && !event.nativeEvent.isComposing) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setSuggestionsDismissedFor(text);
                  return;
                }
                if (suggestionCount > 0) {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const step = event.key === "ArrowDown" ? 1 : -1;
                    setSuggestionIndex((index) => (Math.min(index, suggestionCount - 1) + step + suggestionCount) % suggestionCount);
                    return;
                  }
                  if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                    event.preventDefault();
                    if (activeCommand) chooseCommand(activeCommand);
                    else if (activeEntry) chooseEntry(activeEntry, event.key === "Tab");
                    return;
                  }
                }
              }
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
            {!disabled && scope === "main" && contributions.composerToolbar.map((action) => (
              <span key={action.id} className="composer-plugin-action">
                {action.render({ cwd: workspace, sessionFile: null })}
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
                  title={`运行中发送：${activeStreamingBehavior.label} · ${activeStreamingBehavior.description}`}
                  aria-label={`运行中发送：${activeStreamingBehavior.label}`}
                  aria-haspopup="menu"
                  aria-expanded={streamingMenuOpen}
                >
                  {streamingBehavior === "steer" ? <CornerUpRight size={13} strokeWidth={1.75} /> : <ListOrdered size={13} strokeWidth={1.75} />}
                  <span>{activeStreamingBehavior.chip}</span>
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
                          textareaRef.current?.focus();
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
            {sessionCost !== undefined && sessionCost > 0 && (
              <span
                className="composer-session-cost"
                title={sessionTokens
                  ? `会话预估成本 · 输入 ${sessionTokens.input.toLocaleString()} / 输出 ${sessionTokens.output.toLocaleString()}${sessionTokens.reasoning ? `（推理 ${sessionTokens.reasoning.toLocaleString()}）` : ""}`
                  : "会话预估成本"}
              >
                {sessionCost < 0.01 ? `$${sessionCost.toFixed(4)}` : `$${sessionCost.toFixed(2)}`}
              </span>
            )}
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
            title={queuedMessages.length > 0 ? "查看待处理消息" : "Agent 内部待处理消息"}
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
