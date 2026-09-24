import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Activity,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  FileDiff,
  FileText,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  Globe2,
  Laptop,
  ListChecks,
  ListTree,
  LoaderCircle,
  MessageSquarePlus,
  MonitorCog,
  RefreshCw,
  ScrollText,
  Search,
  Square,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import {
  deriveEnvSources,
  deriveSubagentActivities,
  deriveTaskOutputs,
  deriveTaskPlan,
  summarizeSubagents,
  type EnvSourceItem,
  type SubagentStatus,
  type TaskPlanStatus,
} from "../lib/envSources";
import { aggregateDiffStats } from "../lib/gitDiffStats";
import { pi } from "../lib/pi";
import { subscribeTerminalTabs, terminalTabsFor, terminalTabsSnapshot } from "../lib/terminalTabs";
import type {
  AgentBrowserState,
  ComputerState,
  GitBranchInfo,
  GitSnapshot,
  SessionTreeNodeView,
  UiMessage,
  WorktreeInfo,
} from "../types";
import type { ReviewFilter } from "./ReviewPanel";

/**
 * Sub-views of the task summary. Diffs are not one of them: changes, the last
 * turn and branch comparisons all open in the review pane, which can act on
 * them (stage, discard, comment). The terminal lives in the bottom panel.
 */
export type InspectorTab = "plan" | "outputs" | "sources" | "processes" | "agents" | "tree" | "browser" | "computer" | "logs";

type MenuKind = "local" | "branch" | null;

function AgentMarks({ running, completed }: { running: number; completed: number }) {
  const count = Math.min(2, Math.max(running > 0 ? 1 : 0, completed > 0 ? 1 : 0) + (running > 1 || completed > 1 ? 1 : 0));
  if (count === 0) return <span className="env-agent-marks empty" aria-hidden />;
  return (
    <span className="env-agent-marks" aria-hidden>
      <span className="env-agent-mark tone-orange" />
      {count > 1 && <span className="env-agent-mark tone-purple" />}
    </span>
  );
}

const VIEW_TITLES: Record<InspectorTab, string> = {
  plan: "计划",
  outputs: "产出",
  sources: "来源",
  processes: "终端与进程",
  agents: "子智能体",
  tree: "会话树",
  browser: "Agent 浏览器",
  computer: "计算机",
  logs: "诊断日志",
};

/** The task summary docked in the right sidebar: where the task stands, and a way into each part of it. */
export function InspectorPanel({
  openView = null,
  git,
  cwd,
  messages,
  environment,
  terminal,
  agentBrowser,
  computer,
  logs,
  sessionTree,
  sessionTreeLoading,
  sessionTreeError,
  sessionTreeLeafId,
  isStreaming,
  onRefreshGit,
  onCommitOrPush,
  onEnvironmentChange,
  onSwitchWorkspace,
  onAbortCommand,
  onRefreshTree,
  onContinueFromNode,
  onOpenReview,
  onOpenTerminal,
  onOpenBrowser,
  sideChats = [],
  onOpenSideChat,
  onOpenFile,
  onError,
}: {
  /** Open this sub-view instead of the summary home. */
  openView?: InspectorTab | null;
  onError?: (message: string) => void;
  git: GitSnapshot | null;
  cwd: string;
  messages: UiMessage[];
  environment: "local" | "worktree";
  /** The agent's own shell command (not the integrated terminal). */
  terminal: {
    running: boolean;
    command: string;
    output: string;
    exitCode?: number;
    history: Array<{ command: string; output: string; exitCode?: number }>;
  };
  agentBrowser: AgentBrowserState | null;
  computer: ComputerState | null;
  logs: string[];
  sessionTree: SessionTreeNodeView[];
  sessionTreeLoading: boolean;
  sessionTreeError: string | null;
  sessionTreeLeafId: string | null;
  isStreaming: boolean;
  onRefreshGit: () => void;
  onCommitOrPush: () => void;
  onEnvironmentChange: (environment: "local" | "worktree") => void;
  onSwitchWorkspace: (path: string) => void;
  onAbortCommand: () => void;
  onRefreshTree: () => void;
  onContinueFromNode: (entryId: string) => void;
  onOpenReview: (filter?: ReviewFilter) => void;
  onOpenTerminal: () => void;
  onOpenBrowser: (url?: string) => void;
  sideChats?: Array<{
    id: string;
    title: string;
    phase: "starting" | "ready" | "error" | "expired";
    isStreaming: boolean;
  }>;
  onOpenSideChat?: (id: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const [view, setView] = useState<InspectorTab | null>(openView);
  const [menu, setMenu] = useState<MenuKind>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [branchBusy, setBranchBusy] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const terminalTabs = useSyncExternalStore(subscribeTerminalTabs, terminalTabsSnapshot);
  const workspaceTerminals = useMemo(() => (cwd ? terminalTabsFor(terminalTabs, cwd) : []), [cwd, terminalTabs]);

  // A request for a specific sub-view (from the plan card or the Help menu) wins.
  const [shownOpenView, setShownOpenView] = useState(openView);
  if (shownOpenView !== openView) {
    setShownOpenView(openView);
    setView(openView);
    setMenu(null);
  }

  useEffect(() => {
    if (view === "tree") onRefreshTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tab entry only
  }, [view]);

  const requestedGitCwd = useRef("");
  useEffect(() => {
    if (git || !cwd || requestedGitCwd.current === cwd) return;
    requestedGitCwd.current = cwd;
    onRefreshGit();
  }, [cwd, git, onRefreshGit]);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    void pi.listWorktrees(cwd).then((list) => {
      if (!cancelled) setWorktrees(list);
    }).catch(() => {
      if (!cancelled) setWorktrees([]);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => {
    if (!menu) return;
    const onDoc = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menu]);

  const diffStats = useMemo(() => aggregateDiffStats(git?.diff), [git?.diff]);
  const branch = git?.isRepository ? (git.branch || "游离 HEAD") : "非 Git 仓库";
  const changedFiles = git?.files ?? [];
  const hasChanges = changedFiles.length > 0;
  const sources = useMemo(() => deriveEnvSources(messages, 80), [messages]);
  const outputs = useMemo(() => deriveTaskOutputs(messages), [messages]);
  const plan = useMemo(() => deriveTaskPlan(messages), [messages]);
  const subagents = useMemo(() => deriveSubagentActivities(messages), [messages]);
  const agents = useMemo(() => summarizeSubagents(subagents), [subagents]);
  const isWorktreeCwd = useMemo(
    () => worktrees.some((item) => !item.isMain && samePath(item.path, cwd)),
    [worktrees, cwd],
  );
  const envLabel = environment === "worktree" || isWorktreeCwd ? "Worktree" : "本地";
  const runningTerminals = workspaceTerminals.filter((tab) => tab.status === "running" || tab.status === "starting");

  const openLocalMenu = async () => {
    if (cwd) {
      try { setWorktrees(await pi.listWorktrees(cwd)); } catch { /* ignore */ }
    }
    setMenu((current) => (current === "local" ? null : "local"));
  };

  const openBranchMenu = async () => {
    if (!git?.isRepository || !cwd) return;
    try {
      setBranches(await pi.gitListBranches(cwd));
    } catch {
      setBranches([]);
    }
    setMenu((current) => (current === "branch" ? null : "branch"));
  };

  const switchBranch = async (name: string) => {
    if (!cwd || branchBusy) return;
    setBranchBusy(true);
    try {
      await pi.gitCheckoutBranch(cwd, name);
      setMenu(null);
      onRefreshGit();
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      setBranchBusy(false);
    }
  };

  const chooseLocal = () => {
    setMenu(null);
    onEnvironmentChange("local");
    const main = worktrees.find((item) => item.isMain);
    if (main && !samePath(main.path, cwd)) onSwitchWorkspace(main.path);
  };

  const chooseWorktree = async () => {
    setMenu(null);
    onEnvironmentChange("worktree");
    const existing = worktrees.find((item) => !item.isMain);
    if (existing) {
      onSwitchWorkspace(existing.path);
      return;
    }
    if (!cwd) return;
    try {
      const created = await pi.createWorktree(cwd, git?.branch);
      onSwitchWorkspace(created.path);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    }
  };

  const openSource = (source: EnvSourceItem) => {
    if (source.kind === "file" && source.detail && onOpenFile) {
      onOpenFile(source.detail);
      return;
    }
    if (source.kind === "agent-browser") {
      onOpenBrowser(agentBrowser?.url);
      return;
    }
    setView("sources");
  };

  return (
    <aside
      className="inspector-panel env-panel workspace-dock-panel summary-dock-panel"
      ref={menuRef}
      aria-label="任务摘要"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !menu) return;
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
      }}
    >
      <header className="inspector-header env-header">
        <div className="env-header-left">
          {view !== null && (
            <button type="button" className="icon-button env-back" onClick={() => setView(null)} title="返回任务摘要">
              <ChevronLeft size={16} strokeWidth={1.75} />
            </button>
          )}
          <strong className="env-title">{view === null ? "任务摘要" : VIEW_TITLES[view]}</strong>
        </div>
        {view === "tree" && (
          <div className="env-header-actions">
            <button className="icon-button" onClick={onRefreshTree} title="刷新会话树"><RefreshCw size={14} /></button>
          </div>
        )}
      </header>

      {view === null && (
        <div className="inspector-content env-home">
          <section className="env-section">
            <div className="env-section-label">环境</div>
            <button type="button" className="env-row" onClick={() => onOpenReview("uncommitted")} title="在审查中查看未提交更改">
              <FileDiff size={16} strokeWidth={1.7} />
              <span className="env-row-label">变更</span>
              <span className="env-row-meta">
                {hasChanges ? (
                  diffStats.add > 0 || diffStats.del > 0 ? (
                    <>
                      {diffStats.add > 0 && <em className="diff-add-stat">+{diffStats.add.toLocaleString()}</em>}
                      {diffStats.del > 0 && <em className="diff-del-stat">-{diffStats.del.toLocaleString()}</em>}
                    </>
                  ) : (
                    <em className="muted">{changedFiles.length} 文件</em>
                  )
                ) : (
                  <em className="muted">无</em>
                )}
                <ChevronRight size={14} strokeWidth={1.7} className="env-chevron" />
              </span>
            </button>
            <button type="button" className="env-row" disabled={!git?.isRepository} onClick={() => onOpenReview("turn")} title="只看最近一轮 Agent 回合改了什么">
              <Bot size={16} strokeWidth={1.7} />
              <span className="env-row-label">上一轮 Agent 改动</span>
              <span className="env-row-meta"><ChevronRight size={14} strokeWidth={1.7} className="env-chevron" /></span>
            </button>

            <div className="env-menu-anchor">
              <button type="button" className="env-row" onClick={() => void openLocalMenu()} title={cwd || "本地工作区"}>
                <Laptop size={16} strokeWidth={1.7} />
                <span className="env-row-label">{envLabel}</span>
                <span className="env-row-meta">
                  <ChevronDown size={14} strokeWidth={1.7} className="env-chevron" />
                </span>
              </button>
              {menu === "local" && (
                <div className="env-menu">
                  <button type="button" className="env-menu-item" onClick={chooseLocal}>
                    <Laptop size={15} />
                    <span>本地</span>
                    {envLabel === "本地" && <Check size={14} className="env-menu-check" />}
                  </button>
                  <button type="button" className="env-menu-item" onClick={() => void chooseWorktree()}>
                    <GitBranch size={15} />
                    <span>Worktree</span>
                    {envLabel === "Worktree" && <Check size={14} className="env-menu-check" />}
                  </button>
                </div>
              )}
            </div>

            <div className="env-menu-anchor">
              <button
                type="button"
                className="env-row"
                disabled={!git?.isRepository}
                onClick={() => void openBranchMenu()}
                title={branch}
              >
                <GitBranch size={16} strokeWidth={1.7} />
                <span className="env-row-label">{branch}</span>
                <span className="env-row-meta">
                  <ChevronDown size={14} strokeWidth={1.7} className="env-chevron" />
                </span>
              </button>
              {menu === "branch" && (
                <div className="env-menu env-menu-scroll">
                  {branches.length === 0 ? (
                    <div className="env-menu-empty">没有本地分支</div>
                  ) : branches.map((item) => (
                    <button
                      key={item.name}
                      type="button"
                      className="env-menu-item"
                      disabled={branchBusy || item.current}
                      onClick={() => void switchBranch(item.name)}
                    >
                      <GitBranch size={15} />
                      <span>{item.name}</span>
                      {item.current && <Check size={14} className="env-menu-check" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              className="env-row"
              disabled={!git?.isRepository}
              onClick={() => onOpenReview("branch")}
              title="在审查中与基线分支比较"
            >
              <GitCompareArrows size={16} strokeWidth={1.7} />
              <span className="env-row-label">比较分支</span>
              <span className="env-row-meta"><ChevronRight size={14} strokeWidth={1.7} className="env-chevron" /></span>
            </button>

            <button
              type="button"
              className="env-row"
              disabled={!git?.files.length}
              onClick={onCommitOrPush}
              title="选择文件并提交，可以让 Pi 生成提交说明"
            >
              <GitCommitHorizontal size={16} strokeWidth={1.7} />
              <span className="env-row-label">提交…</span>
            </button>
          </section>

          {plan && (
            <section className="env-section">
              <div className="env-section-label">计划</div>
              <button type="button" className="env-row" onClick={() => setView("plan")}>
                <ListChecks size={16} strokeWidth={1.7} />
                <span className="env-row-label">{plan.steps.find((step) => step.status === "in_progress")?.text || "计划已完成"}</span>
                <span className="env-row-meta"><em className="muted">{plan.completed}/{plan.steps.length}</em></span>
              </button>
            </section>
          )}

          {outputs.length > 0 && (
            <section className="env-section">
              <div className="env-section-label">产出</div>
              {outputs.slice(0, 3).map((output) => (
                <button key={output.id} type="button" className="env-row" onClick={() => onOpenFile ? onOpenFile(output.path) : setView("outputs")} title={output.path}>
                  <FileText size={16} strokeWidth={1.7} />
                  <span className="env-row-label">{output.label}</span>
                  <span className="env-row-meta"><em className="muted">{output.running ? "写入中" : outputActivityLabel(output.activity)}</em></span>
                </button>
              ))}
              {outputs.length > 3 && (
                <button type="button" className="env-row quiet-link" onClick={() => setView("outputs")}>
                  <FolderOpen size={16} strokeWidth={1.7} />
                  <span className="env-row-label">查看全部</span>
                  <span className="env-row-meta"><em className="muted">{outputs.length}</em></span>
                </button>
              )}
            </section>
          )}

          {agents.total > 0 && (
            <section className="env-section">
              <div className="env-section-label">子智能体</div>
              <button type="button" className="env-row" onClick={() => setView("agents")}>
                <AgentMarks running={agents.running} completed={agents.completed + agents.failed} />
                <span className="env-row-label">
                  {agents.running > 0 ? `${agents.running} 个运行中` : agents.queued > 0 ? `${agents.queued} 个等待中` : "无运行中"}
                </span>
                <span className="env-row-meta">
                  <em className="muted">{agents.completed} 完成{agents.failed > 0 ? ` · ${agents.failed} 失败` : ""}</em>
                </span>
              </button>
            </section>
          )}

          {sideChats.length > 0 && (
            <section className="env-section">
              <div className="env-section-label">侧边聊天</div>
              {sideChats.map((chat) => (
                <button
                  key={chat.id}
                  type="button"
                  className="env-row"
                  onClick={() => onOpenSideChat?.(chat.id)}
                  title={chat.title}
                >
                  {chat.isStreaming || chat.phase === "starting"
                    ? <LoaderCircle size={16} strokeWidth={1.7} className="spin env-agent-live" />
                    : <MessageSquarePlus size={16} strokeWidth={1.7} />}
                  <span className="env-row-label">{chat.title}</span>
                  <span className="env-row-meta">
                    <em className="muted">
                      {chat.isStreaming
                        ? "运行中"
                        : chat.phase === "starting"
                          ? "正在创建"
                          : chat.phase === "error"
                            ? "创建失败"
                            : chat.phase === "expired"
                              ? "已过期"
                              : "临时"}
                    </em>
                  </span>
                </button>
              ))}
            </section>
          )}

          <section className="env-section">
            <div className="env-section-label">终端与进程</div>
            {terminal.running && (
              <button type="button" className="env-row" onClick={() => setView("processes")} title={terminal.command}>
                <Activity size={16} strokeWidth={1.7} className="env-agent-live" />
                <span className="env-row-label">Agent 命令 · {terminal.command || "运行中"}</span>
                <span className="env-row-meta"><em className="muted">运行中</em></span>
              </button>
            )}
            <button type="button" className="env-row" onClick={onOpenTerminal} title="打开底部终端 (Ctrl+J)">
              <SquareTerminal size={16} strokeWidth={1.7} />
              <span className="env-row-label">
                {workspaceTerminals.length === 0
                  ? "打开终端"
                  : `${workspaceTerminals.length} 个终端${runningTerminals.length < workspaceTerminals.length ? ` · ${workspaceTerminals.length - runningTerminals.length} 个已退出` : ""}`}
              </span>
              <span className="env-row-meta"><em className="muted">Ctrl+J</em></span>
            </button>
          </section>

          {(sources.length > 0 || agentBrowser || computer) && (
            <section className="env-section">
              <div className="env-section-label">来源</div>
              {sources.slice(0, 3).map((source) => (
                <button key={source.id} type="button" className="env-row" onClick={() => openSource(source)} title={source.detail || source.label}>
                  <SourceIcon source={source} />
                  <span className={`env-row-label ${source.kind === "search" ? "brand" : ""}`}>{source.label}</span>
                  <span className="env-row-meta"><em className="muted">{sourceActivityLabel(source.activity)}{source.count > 1 ? ` · ${source.count}` : ""}</em></span>
                </button>
              ))}
              {sources.length > 3 && (
                <button type="button" className="env-row quiet-link" onClick={() => setView("sources")}>
                  <FileText size={16} strokeWidth={1.7} />
                  <span className="env-row-label">查看全部</span>
                  <span className="env-row-meta"><em className="muted">{sources.length}</em></span>
                </button>
              )}
              {agentBrowser && (
                <button type="button" className="env-row" onClick={() => setView("browser")} title={agentBrowser.url}>
                  <Globe2 size={16} strokeWidth={1.7} />
                  <span className="env-row-label">Agent 浏览器 · {agentBrowser.title || agentBrowser.url}</span>
                </button>
              )}
              {computer && (
                <button type="button" className="env-row" onClick={() => setView("computer")}>
                  <MonitorCog size={16} strokeWidth={1.7} />
                  <span className="env-row-label">桌面 {computer.width}×{computer.height}</span>
                </button>
              )}
            </section>
          )}

          <section className="env-section">
            <div className="env-section-label">会话</div>
            <button type="button" className="env-row" onClick={() => setView("tree")}>
              <ListTree size={16} strokeWidth={1.7} />
              <span className="env-row-label">会话树 · 从任意节点分叉</span>
              <span className="env-row-meta"><ChevronRight size={14} strokeWidth={1.7} className="env-chevron" /></span>
            </button>
            <button type="button" className="env-row" onClick={() => setView("logs")}>
              <ScrollText size={16} strokeWidth={1.7} />
              <span className="env-row-label">诊断日志</span>
              <span className="env-row-meta"><em className="muted">{logs.length}</em></span>
            </button>
          </section>
        </div>
      )}

      {view === "plan" && (
        <div className="inspector-content env-detail-panel">
          <div className="changes-summary">
            <span><ListChecks size={15} /> {plan ? `${plan.completed}/${plan.steps.length} 已完成` : "无计划"}</span>
          </div>
          {plan ? (
            <>
              {plan.explanation && <p className="env-detail-note">{plan.explanation}</p>}
              <div className="env-detail-list">
                {plan.steps.map((step) => (
                  <div key={step.id} className={`env-detail-item plan-${step.status}`}>
                    <PlanStatusIcon status={step.status} />
                    <span>{step.text}</span>
                    <em>{planStatusLabel(step.status)}</em>
                  </div>
                ))}
              </div>
            </>
          ) : <div className="panel-empty">当前任务没有计划记录。</div>}
        </div>
      )}

      {view === "outputs" && (
        <div className="inspector-content env-detail-panel">
          <div className="changes-summary"><span><FolderOpen size={15} /> {outputs.length} 个文件产出</span></div>
          {outputs.length === 0 ? <div className="panel-empty">当前任务没有文件产出。</div> : (
            <div className="env-detail-list">
              {outputs.map((output) => (
                <button key={output.id} type="button" className="env-detail-item actionable" onClick={() => onOpenFile?.(output.path)} disabled={!onOpenFile} title={output.path}>
                  <FileText size={15} />
                  <span><strong>{output.label}</strong><small>{output.path}</small></span>
                  <em>{output.running ? "写入中" : outputActivityLabel(output.activity)}{output.count > 1 ? ` · ${output.count}` : ""}</em>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "sources" && (
        <div className="inspector-content env-detail-panel">
          <div className="changes-summary"><span><FileText size={15} /> {sources.length} 个来源</span></div>
          {sources.length === 0 ? <div className="panel-empty">当前任务没有可追溯的来源。</div> : (
            <div className="env-detail-list">
              {sources.map((source) => (
                <button key={source.id} type="button" className="env-detail-item actionable" onClick={() => openSource(source)} title={source.detail || source.label}>
                  <SourceIcon source={source} />
                  <span><strong>{source.label}</strong>{source.detail && <small>{source.detail}</small>}</span>
                  <em>{source.running ? "使用中" : source.failed ? "失败" : sourceActivityLabel(source.activity)}{source.count > 1 ? ` · ${source.count}` : ""}</em>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "processes" && (
        <div className="inspector-content env-detail-panel">
          <div className="changes-summary">
            <span><Activity size={15} /> {terminal.running ? "Agent 命令运行中" : "Agent 没有运行中的命令"}</span>
            {terminal.running && <button type="button" className="secondary-button compact" onClick={onAbortCommand}><Square size={11} fill="currentColor" />停止</button>}
          </div>
          {terminal.running && (
            <div className="env-detail-list">
              <div className="env-detail-item">
                <Activity size={15} />
                <span><strong>{terminal.command || "终端命令"}</strong><small>{cwd}</small></span>
                <em>运行中</em>
              </div>
            </div>
          )}
          <div className="changes-summary"><span><SquareTerminal size={15} /> 集成终端</span></div>
          <div className="env-detail-list">
            {workspaceTerminals.length === 0 && <div className="panel-empty">这个项目还没有打开终端。</div>}
            {workspaceTerminals.map((tab) => (
              <button key={tab.id} type="button" className="env-detail-item actionable" onClick={onOpenTerminal} title={tab.cwd}>
                <SquareTerminal size={15} />
                <span><strong>{tab.title}</strong><small>{tab.shell}</small></span>
                <em>{tab.status === "running" ? "运行中" : tab.status === "exited" ? "已退出" : tab.status === "error" ? "启动失败" : "启动中"}</em>
              </button>
            ))}
          </div>
        </div>
      )}

      {view === "agents" && (
        <div className="inspector-content session-tree-panel">
          <div className="changes-summary">
            <span>
              <AgentMarks running={agents.running} completed={agents.completed + agents.failed} />
              {agents.running} 运行中 · {agents.queued} 等待 · {agents.completed} 完成 · {agents.failed} 失败
            </span>
          </div>
          {subagents.length === 0 ? (
            <div className="panel-empty">当前会话没有调用子智能体。</div>
          ) : (
            <div className="session-tree-list">
              {subagents.slice(-40).reverse().map((agent) => (
                <button
                  type="button"
                  key={agent.id}
                  className={`session-tree-node env-agent-item ${agent.status === "running" ? "leaf" : ""}`}
                  onClick={() => setSelectedAgent((current) => current === agent.id ? null : agent.id)}
                  aria-expanded={selectedAgent === agent.id}
                >
                  <div className="session-tree-meta">
                    <code><Bot size={12} />{agent.label} · {subagentRoleLabel(agent.role)}</code>
                    <span className={`tree-leaf-badge status-${agent.status}`}>{subagentStatusLabel(agent.status)}</span>
                  </div>
                  <p title={agent.task}>{agent.task}</p>
                  {selectedAgent === agent.id && (agent.output || agent.error) && (
                    <pre className={agent.error ? "env-agent-result error" : "env-agent-result"}>{agent.error || agent.output}</pre>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "tree" && (
        <div className="inspector-content session-tree-panel">
          {sessionTreeLoading ? (
            <div className="panel-empty"><LoaderCircle className="spin" size={16} /> 正在加载会话树…</div>
          ) : sessionTreeError ? (
            <div className="panel-empty session-tree-error">{sessionTreeError}</div>
          ) : sessionTree.length === 0 ? (
            <div className="panel-empty">当前会话还没有树节点。发送消息后可在此查看并从此处分叉继续。</div>
          ) : (
            <div className="session-tree-list">
              {sessionTree.map((node) => (
                <div
                  key={node.entryId}
                  className={`session-tree-node ${node.isLeaf || node.entryId === sessionTreeLeafId ? "leaf" : ""}`}
                  style={{ paddingLeft: 10 + node.depth * 14 }}
                >
                  <div className="session-tree-meta">
                    <code>{node.role}</code>
                    {node.entryId === sessionTreeLeafId && <span className="tree-leaf-badge">当前</span>}
                  </div>
                  <p title={node.summary}>{node.summary}</p>
                  <button
                    className="secondary-button compact"
                    disabled={isStreaming}
                    onClick={() => onContinueFromNode(node.entryId)}
                    title="从此节点分叉并继续（Pi fork）"
                  >
                    从此继续
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "browser" && (
        <div className="inspector-content browser-panel">
          <div className="browser-frame">
            <div className="browser-chrome">
              <Globe2 size={14} strokeWidth={1.7} />
              <div className="browser-address" title={agentBrowser?.url || agentBrowser?.title || ""}>
                {agentBrowser?.url || agentBrowser?.title || "about:blank"}
              </div>
              {agentBrowser?.url && (
                <button type="button" className="icon-button" title="在内置浏览器中打开" onClick={() => onOpenBrowser(agentBrowser.url)}>
                  <ChevronRight size={14} />
                </button>
              )}
            </div>
            <div className="browser-viewport">
              {agentBrowser?.screenshot ? (
                <img src={`data:${agentBrowser.screenshot.mimeType};base64,${agentBrowser.screenshot.data}`} alt={agentBrowser.title || "页面"} />
              ) : (
                <div className="panel-empty browser-empty">
                  <Globe2 size={22} strokeWidth={1.5} />
                  <span>{agentBrowser ? "此页暂无预览" : "Agent 尚未打开页面"}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {view === "computer" && (
        <div className="inspector-content browser-panel computer-panel">
          {computer ? <>
            <div className="browser-panel-heading">
              <MonitorCog size={15} />
              <span>
                <strong>{computer.windowTitle || "Windows 桌面"}</strong>
                <small>
                  {computer.width}×{computer.height} · 原点 ({computer.left}, {computer.top}) · {computer.captureBackend || "capture"} · {computer.stable === false ? "仍在变化" : "稳定帧"} · {computer.action}
                </small>
              </span>
            </div>
            {computer.screenshot
              ? <img src={`data:${computer.screenshot.mimeType};base64,${computer.screenshot.data}`} alt="Windows 桌面截图" />
              : <div className="panel-empty">最近一次操作没有返回桌面截图。</div>}
            {computer.observationError && <div className="computer-observation-error">UI Automation：{computer.observationError}</div>}
            {computer.elements && computer.elements.length > 0 && <div className="computer-elements">
              <div className="computer-elements-heading">可操作元素 <span>{computer.elements.length}</span></div>
              {computer.elements.slice(0, 80).map((element) => <div className="computer-element" key={element.ref}>
                <span className="computer-element-role">{element.role}</span>
                <span className="computer-element-name">{element.name || element.value || "未命名"}</span>
                <code>{element.ref}</code>
              </div>)}
            </div>}
          </> : <div className="panel-empty browser-empty"><MonitorCog size={24} />让 Pi 使用 computer_start 后截图；最新桌面画面会显示在这里。</div>}
        </div>
      )}

      {view === "logs" && (
        <div className="inspector-content logs-panel">
          <pre>{logs.length ? logs.join("\n") : "暂无 Pi 进程日志。"}</pre>
        </div>
      )}
    </aside>
  );
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

function subagentRoleLabel(role: "explorer" | "planner" | "reviewer" | "worker"): string {
  if (role === "planner") return "规划";
  if (role === "reviewer") return "审查";
  if (role === "worker") return "执行";
  return "探索";
}

function subagentStatusLabel(status: SubagentStatus): string {
  if (status === "queued") return "等待";
  if (status === "running") return "运行中";
  if (status === "failed") return "失败";
  return "完成";
}

function sourceActivityLabel(activity: EnvSourceItem["activity"]): string {
  if (activity === "read") return "已读取";
  if (activity === "searched") return "已搜索";
  if (activity === "opened") return "已打开";
  if (activity === "written") return "已写入";
  if (activity === "updated") return "已更新";
  return "已使用";
}

function outputActivityLabel(activity: "written" | "updated"): string {
  return activity === "written" ? "已写入" : "已更新";
}

function planStatusLabel(status: TaskPlanStatus): string {
  if (status === "completed") return "完成";
  if (status === "in_progress") return "进行中";
  return "待处理";
}

function PlanStatusIcon({ status }: { status: TaskPlanStatus }) {
  if (status === "completed") return <CheckCircle2 size={15} />;
  if (status === "in_progress") return <LoaderCircle className="spin" size={15} />;
  return <Circle size={15} />;
}

function SourceIcon({ source }: { source: EnvSourceItem }) {
  if (source.kind === "file") return <FileText size={16} strokeWidth={1.7} />;
  if (source.kind === "agent-browser") return <Globe2 size={16} strokeWidth={1.7} />;
  if (source.kind === "web-search" || source.kind === "search") return <Search size={16} strokeWidth={1.7} />;
  return <Wrench size={16} strokeWidth={1.7} />;
}
