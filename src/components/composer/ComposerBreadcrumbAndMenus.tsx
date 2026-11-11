import {
  Check,
  ChevronDown,
  ChevronUp,
  CornerUpRight,
  File,
  Folder,
  GitBranch,
  Image as ImageIcon,
  ListOrdered,
  Monitor,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type {
  AttachmentPayload,
  ManagedQueuedMessage,
  SlashCommand,
  WorkspaceDirEntry,
} from "../../types";

export function ComposerBreadcrumbTrail({
  workspace,
  workspaceName,
  isDefaultWorkspaceMode,
  visibleWorkspaces,
  workspaceOpen,
  setWorkspaceOpen,
  workspaceQuery,
  setWorkspaceQuery,
  environment,
  environmentOpen,
  setEnvironmentOpen,
  setActionsOpen,
  branchLabel,
  onWorkspaceSelect,
  onPickWorkspace,
  onQuickChat,
  onEnvironmentChange,
}: {
  workspace: string;
  workspaceName: string;
  isDefaultWorkspaceMode: boolean;
  visibleWorkspaces: string[];
  workspaceOpen: boolean;
  setWorkspaceOpen: React.Dispatch<React.SetStateAction<boolean>>;
  workspaceQuery: string;
  setWorkspaceQuery: (next: string) => void;
  environment: "local" | "worktree";
  environmentOpen: boolean;
  setEnvironmentOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setActionsOpen: (next: boolean) => void;
  branchLabel: string;
  onWorkspaceSelect?: (workspace: string) => void;
  onPickWorkspace?: () => void;
  onQuickChat?: () => void;
  onEnvironmentChange?: (environment: "local" | "worktree") => void;
}) {
  return (
    <div className="composer-breadcrumb-trail" aria-label="项目与工作环境">
      <div className="workspace-context-wrap">
        <button
          type="button"
          className="chip chip-project"
          onClick={() => {
            setEnvironmentOpen(false);
            setActionsOpen(false);
            setWorkspaceOpen((v) => !v);
          }}
          title={isDefaultWorkspaceMode ? "默认工作区（快速对话）" : workspace}
        >
          <Folder size={13} strokeWidth={1.75} />
          <span>{workspaceName}</span>
          <ChevronDown size={11} strokeWidth={1.75} />
        </button>
        {workspaceOpen && (
          <div className="workspace-context-menu">
            <label>
              <Search size={13} />
              <input
                autoFocus
                value={workspaceQuery}
                onChange={(e) => setWorkspaceQuery(e.target.value)}
                placeholder="搜索项目"
              />
            </label>
            <div className="workspace-context-list">
              {visibleWorkspaces.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => {
                    onWorkspaceSelect?.(item);
                    setWorkspaceOpen(false);
                    setWorkspaceQuery("");
                  }}
                  title={item}
                >
                  <span>{item.split(/[\\/]/).filter(Boolean).pop()}</span>
                  {!isDefaultWorkspaceMode && item === workspace && <Check size={13} />}
                </button>
              ))}
              {visibleWorkspaces.length === 0 && <small>没有已知项目</small>}
            </div>
            <button
              type="button"
              className="workspace-context-new"
              onClick={() => {
                setWorkspaceOpen(false);
                onPickWorkspace?.();
              }}
            >
              打开其他文件夹…
            </button>
            <button
              type="button"
              className="workspace-context-new"
              onClick={() => {
                setWorkspaceOpen(false);
                onQuickChat?.();
              }}
            >
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
            onClick={() => {
              setWorkspaceOpen(false);
              setActionsOpen(false);
              setEnvironmentOpen((value) => !value);
            }}
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
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onEnvironmentChange?.("local");
                    setEnvironmentOpen(false);
                  }}
                >
                  <Monitor size={13} />
                  <span>本地</span>
                  {environment === "local" && <Check size={13} />}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onEnvironmentChange?.("worktree");
                    setEnvironmentOpen(false);
                  }}
                >
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
  );
}

export function ComposerSuggestionMenus({
  commandMenuOpen,
  commandMatches,
  activeCommand,
  chooseCommand,
  mentionMenuOpen,
  mentionQuery,
  mentionEntries,
  mentionLoading,
  activeEntry,
  chooseEntry,
  suggestionsId,
  suggestionMenuRef,
  setSuggestionIndex,
}: {
  commandMenuOpen: boolean;
  commandMatches: SlashCommand[];
  activeCommand: SlashCommand | undefined;
  chooseCommand: (command: SlashCommand) => void;
  mentionMenuOpen: boolean;
  mentionQuery: string | null;
  mentionEntries: WorkspaceDirEntry[];
  mentionLoading: boolean;
  activeEntry: WorkspaceDirEntry | undefined;
  chooseEntry: (entry: WorkspaceDirEntry, enterFolder: boolean) => void;
  suggestionsId: string;
  suggestionMenuRef: React.RefObject<HTMLDivElement | null>;
  setSuggestionIndex: (next: number) => void;
}) {
  return (
    <>
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
    </>
  );
}

export function ComposerAttachmentStrip({
  attachments,
  onRemoveAttachment,
}: {
  attachments: AttachmentPayload[];
  onRemoveAttachment: (path: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
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
  );
}

export function ComposerQueuedDrawer({
  pendingCount,
  queuedMessages,
  queueOpen,
  setQueueOpen,
  onMoveQueuedMessage,
  onSteerQueuedMessage,
  onRemoveQueuedMessage,
}: {
  pendingCount: number;
  queuedMessages: ManagedQueuedMessage[];
  queueOpen: boolean;
  setQueueOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onMoveQueuedMessage?: (id: string, direction: -1 | 1) => void;
  onSteerQueuedMessage?: (id: string) => void | Promise<void>;
  onRemoveQueuedMessage?: (id: string) => void;
}) {
  if (pendingCount <= 0) return null;
  return (
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
  );
}
