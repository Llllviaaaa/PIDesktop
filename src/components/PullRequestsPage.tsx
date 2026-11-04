import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clock,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  MessageSquareText,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { agent } from "../lib/agent";
import { describeError } from "../lib/errors";
import { findGitWorkspace, uniqueWorkspacePaths } from "../lib/pullRequests";
import { queryKeys } from "../lib/queries";
import type {
  PullRequestCheck,
  PullRequestCollection,
  PullRequestComment,
  PullRequestCreated,
  PullRequestDetail,
  PullRequestInfo,
} from "../types";

interface PullRequestsPageProps {
  cwd: string;
  workspaceOptions: string[];
  initialCreateOpen?: boolean;
  onClearInitialCreate?: () => void;
  onOpenUrl: (url: string) => void;
  onCheckout: (pullRequest: PullRequestInfo, repositoryRoot: string) => Promise<void>;
  onReview: (pullRequest: PullRequestInfo, repositoryRoot: string) => void;
  onSendToChat?: (prompt: string, repositoryRoot: string) => void;
}

function updatedLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (!timestamp) return "";
  const hours = Math.floor((Date.now() - timestamp) / 3_600_000);
  if (hours < 1) return "刚刚更新";
  if (hours < 24) return `${hours} 小时前更新`;
  const days = Math.floor(hours / 24);
  return `${days} 天前更新`;
}

function isCheckFailed(check: PullRequestCheck): boolean {
  const conclusion = check.conclusion.toUpperCase();
  return (
    conclusion === "FAILURE" ||
    conclusion === "ERROR" ||
    conclusion === "TIMED_OUT" ||
    conclusion === "CANCELLED" ||
    conclusion === "ACTION_REQUIRED"
  );
}

function isCheckSuccess(check: PullRequestCheck): boolean {
  const conclusion = check.conclusion.toUpperCase();
  return conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED";
}

function reviewStateLabel(state?: string | null): string {
  switch ((state ?? "").toUpperCase()) {
    case "CHANGES_REQUESTED":
      return "请求修改";
    case "APPROVED":
      return "已批准";
    case "COMMENTED":
      return "审查评论";
    default:
      return "评论";
  }
}

function buildCheckFixPrompt(detail: PullRequestDetail, check: PullRequestCheck): string {
  return [
    `拉取请求 #${detail.number}（${detail.title}，分支 ${detail.headRefName} → ${detail.baseRefName}）的 CI 检查「${check.name}」未通过（结果：${check.conclusion || check.status}）。`,
    check.detailsUrl ? `检查日志链接：${check.detailsUrl}` : "",
    "请在本地重现并定位失败原因，完成代码修复并运行对应的本地验证命令。",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCommentFixPrompt(detail: PullRequestDetail, comment: PullRequestComment): string {
  const quoted = comment.body
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return [
    `请处理拉取请求 #${detail.number}（${detail.title}，分支 ${detail.headRefName} → ${detail.baseRefName}）中来自 @${comment.author} 的${reviewStateLabel(comment.reviewState)}：`,
    "",
    quoted,
    "",
    "请定位相关代码，评估并落实修改，必要时补充单元测试。",
  ].join("\n");
}

function buildBatchFixPrompt(detail: PullRequestDetail): string {
  const failedChecks = detail.checks.filter(isCheckFailed);
  const parts: string[] = [
    `请协助处理拉取请求 #${detail.number}（${detail.title}，分支 ${detail.headRefName} → ${detail.baseRefName}）中的待修复反馈：`,
  ];
  if (failedChecks.length > 0) {
    parts.push("\n### 未通过的 CI 检查");
    for (const check of failedChecks) {
      parts.push(`- **${check.name}**（${check.conclusion || check.status}）${check.detailsUrl ? `：${check.detailsUrl}` : ""}`);
    }
  }
  if (detail.comments.length > 0) {
    parts.push("\n### 审查与讨论意见");
    for (const comment of detail.comments) {
      parts.push(`- **@${comment.author}**（${reviewStateLabel(comment.reviewState)}）：${comment.body.replace(/\s+/g, " ").trim()}`);
    }
  }
  parts.push("\n请逐项排查并修复上述问题，完成后运行相关测试验证。");
  return parts.join("\n");
}

export function PullRequestsPage({
  cwd,
  workspaceOptions,
  initialCreateOpen = false,
  onClearInitialCreate,
  onOpenUrl,
  onCheckout,
  onReview,
  onSendToChat,
}: PullRequestsPageProps) {
  const queryClient = useQueryClient();
  const [checkingOut, setCheckingOut] = useState<number | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState(cwd);
  const [selectionTouched, setSelectionTouched] = useState(false);
  const [expandedNumber, setExpandedNumber] = useState<number | null>(null);

  const [createOpen, setCreateOpen] = useState(initialCreateOpen);
  const [prevInitialCreate, setPrevInitialCreate] = useState(initialCreateOpen);
  if (prevInitialCreate !== initialCreateOpen) {
    setPrevInitialCreate(initialCreateOpen);
    if (initialCreateOpen) setCreateOpen(true);
  }

  const [baseBranch, setBaseBranch] = useState("main");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [isDraft, setIsDraft] = useState(false);
  const [pushBeforeCreate, setPushBeforeCreate] = useState(false);
  const [draftMeta, setDraftMeta] = useState<{ headBranch: string; baseBranch: string; commitCount: number } | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [submittingPr, setSubmittingPr] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createdBanner, setCreatedBanner] = useState<PullRequestCreated | null>(null);

  const availableWorkspaces = useMemo(
    () => uniqueWorkspacePaths([cwd, ...workspaceOptions]),
    [cwd, workspaceOptions],
  );

  // Switching project resets the picker to that project.
  const [followedCwd, setFollowedCwd] = useState(cwd);
  if (followedCwd !== cwd) {
    setFollowedCwd(cwd);
    setSelectedWorkspace(cwd);
    setSelectionTouched(false);
    setExpandedNumber(null);
  }

  const requested = selectedWorkspace || cwd;
  const pullRequests = useQuery({
    queryKey: queryKeys.pullRequests(requested, availableWorkspaces, selectionTouched),
    queryFn: async () => {
      const resolved = await findGitWorkspace(requested, availableWorkspaces, agent.gitRepositoryRoot, !selectionTouched);
      if (!resolved) {
        throw new Error(
          selectionTouched
            ? "所选工作区不是 Git 仓库，请切换到其他项目。"
            : "没有找到可用的 Git 项目，请先打开或注册一个 Git 仓库。",
        );
      }
      const collection = await agent.listPullRequests(resolved.repositoryRoot);
      return { ...resolved, collection };
    },
    enabled: availableWorkspaces.length > 0,
  });

  const loaded = pullRequests.isError ? undefined : pullRequests.data;
  const collection: PullRequestCollection | null = loaded?.collection ?? null;
  const repositoryRoot = loaded?.repositoryRoot ?? (requested || cwd);
  const shownWorkspace = loaded?.workspace ?? selectedWorkspace;
  const loading = pullRequests.isFetching;
  const error =
    availableWorkspaces.length === 0
      ? "先打开一个 Git 项目，再查看拉取请求。"
      : pullRequests.error
        ? describeError(pullRequests.error)
        : "";
  const load = () => void pullRequests.refetch();

  const detailQuery = useQuery({
    queryKey: queryKeys.pullRequestDetail(repositoryRoot, expandedNumber ?? 0),
    queryFn: () => agent.getPullRequestDetail(repositoryRoot, expandedNumber ?? 0),
    enabled: Boolean(repositoryRoot) && expandedNumber !== null,
  });

  const checkout = async (pullRequest: PullRequestInfo) => {
    if (!repositoryRoot) return;
    setCheckingOut(pullRequest.number);
    try {
      await onCheckout(pullRequest, repositoryRoot);
    } finally {
      setCheckingOut(null);
    }
  };

  const closeCreateModal = () => {
    setCreateOpen(false);
    setCreateError("");
    onClearInitialCreate?.();
  };

  const openCreateModal = () => {
    setCreateError("");
    setCreateOpen(true);
  };

  const handleGenerateDraft = async () => {
    if (!repositoryRoot) return;
    setDrafting(true);
    setCreateError("");
    try {
      const generated = await agent.generatePullRequestDraft(repositoryRoot, {
        base: baseBranch.trim() || undefined,
      });
      setPrTitle(generated.title);
      setPrBody(generated.body);
      setBaseBranch(generated.baseBranch);
      setDraftMeta({
        headBranch: generated.headBranch,
        baseBranch: generated.baseBranch,
        commitCount: generated.commitCount,
      });
    } catch (draftErr) {
      setCreateError(describeError(draftErr));
    } finally {
      setDrafting(false);
    }
  };

  const handleCreatePr = async () => {
    if (!repositoryRoot) return;
    if (!prTitle.trim()) {
      setCreateError("请填写拉取请求标题");
      return;
    }
    setSubmittingPr(true);
    setCreateError("");
    try {
      if (pushBeforeCreate) {
        await agent.gitPush(repositoryRoot);
      }
      const created = await agent.createPullRequest(repositoryRoot, {
        title: prTitle.trim(),
        body: prBody,
        base: baseBranch.trim() || undefined,
        draft: isDraft,
      });
      setCreatedBanner(created);
      setPrTitle("");
      setPrBody("");
      setDraftMeta(null);
      closeCreateModal();
      await queryClient.invalidateQueries({ queryKey: ["pull-requests"] });
    } catch (submitErr) {
      setCreateError(describeError(submitErr));
    } finally {
      setSubmittingPr(false);
    }
  };

  const sendPromptToChat = (prompt: string) => {
    if (!repositoryRoot) return;
    onSendToChat?.(prompt, repositoryRoot);
  };

  return (
    <section className="pull-requests-page">
      <header className="work-center-header">
        <div>
          <span className="work-center-icon">
            <GitPullRequest size={20} />
          </span>
          <span>
            <h1>拉取请求</h1>
            <p>创建、查看、检出 GitHub 拉取请求，并将审查评论或 CI 失败一键送入对话修复。</p>
          </span>
        </div>
        <div className="work-center-header-actions">
          {availableWorkspaces.length > 1 && (
            <label className="repository-picker">
              <span>仓库</span>
              <select
                value={shownWorkspace}
                onChange={(event) => {
                  setSelectionTouched(true);
                  setSelectedWorkspace(event.target.value);
                  setExpandedNumber(null);
                }}
                disabled={loading}
              >
                {availableWorkspaces.map((workspace) => (
                  <option value={workspace} key={workspace}>
                    {workspace.split(/[\\/]/).filter(Boolean).pop() || workspace}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="primary-button"
            onClick={openCreateModal}
            disabled={!repositoryRoot}
            data-testid="open-create-pr-button"
          >
            <Plus size={15} />
            创建 PR
          </button>
          <button type="button" className="icon-button" title="刷新拉取请求" onClick={load} disabled={loading}>
            <RefreshCw size={16} className={loading ? "spinner-icon" : ""} />
          </button>
        </div>
      </header>

      {createdBanner && (
        <div className="pr-created-banner" data-testid="pr-created-banner">
          <CheckCircle2 size={16} />
          <span>
            已创建拉取请求{createdBanner.number ? ` #${createdBanner.number}` : ""}（{createdBanner.headRefName} →{" "}
            {createdBanner.baseRefName}）
          </span>
          {createdBanner.url && (
            <button type="button" className="secondary-button compact" onClick={() => onOpenUrl(createdBanner.url)}>
              <ExternalLink size={13} />在 GitHub 打开
            </button>
          )}
        </div>
      )}

      {loading && !collection ? (
        <div className="work-center-empty">
          <LoaderCircle className="spinner-icon" size={21} />
          <strong>正在读取 GitHub 拉取请求</strong>
        </div>
      ) : error ? (
        <div className="work-center-error">
          <TriangleAlert size={20} />
          <span>
            <strong>无法加载拉取请求</strong>
            <small>{error}</small>
          </span>
          <button type="button" className="secondary-button" onClick={() => onOpenUrl("https://cli.github.com/")}>
            GitHub CLI
          </button>
        </div>
      ) : collection ? (
        <>
          <div className="repository-strip">
            <GitBranch size={16} />
            <span>
              <strong>{collection.repository}</strong>
              <small>{collection.remoteUrl || cwd}</small>
            </span>
            <em>{collection.items.length} 个打开的 PR</em>
          </div>
          {collection.items.length === 0 ? (
            <div className="work-center-empty">
              <GitPullRequest size={22} />
              <strong>当前没有打开的拉取请求</strong>
            </div>
          ) : (
            <div className="pull-request-list">
              {collection.items.map((pullRequest) => {
                const isExpanded = expandedNumber === pullRequest.number;
                const detail = isExpanded ? detailQuery.data : undefined;
                const failedChecksCount = detail ? detail.checks.filter(isCheckFailed).length : 0;
                return (
                  <article className="pull-request-card" key={pullRequest.number}>
                    <div className="pull-request-row">
                      <div className="pull-request-number">#{pullRequest.number}</div>
                      <div className="pull-request-copy">
                        <div>
                          <strong>{pullRequest.title}</strong>
                          {pullRequest.isDraft && <span className="status-chip">草稿</span>}
                          {pullRequest.reviewDecision === "CHANGES_REQUESTED" && (
                            <span className="status-chip warning">请求修改</span>
                          )}
                          {pullRequest.reviewDecision === "APPROVED" && (
                            <span className="status-chip success">已批准</span>
                          )}
                        </div>
                        <small>
                          {pullRequest.author || "未知作者"} · {pullRequest.headRefName} → {pullRequest.baseRefName}
                          {updatedLabel(pullRequest.updatedAt) && ` · ${updatedLabel(pullRequest.updatedAt)}`}
                        </small>
                      </div>
                      <div className="pull-request-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          aria-expanded={isExpanded}
                          onClick={() => setExpandedNumber(isExpanded ? null : pullRequest.number)}
                          data-testid={`pr-toggle-detail-${pullRequest.number}`}
                        >
                          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          评论与 CI
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          title="在 GitHub 打开"
                          onClick={() => onOpenUrl(pullRequest.url)}
                        >
                          <ExternalLink size={15} />
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => void checkout(pullRequest)}
                          disabled={checkingOut !== null}
                        >
                          {checkingOut === pullRequest.number ? (
                            <LoaderCircle size={14} className="spinner-icon" />
                          ) : (
                            <GitBranch size={14} />
                          )}
                          检出
                        </button>
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => onReview(pullRequest, repositoryRoot)}
                        >
                          <MessageSquareText size={14} />
                          交给 Agent 审查
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="pull-request-detail" data-testid={`pr-detail-${pullRequest.number}`}>
                        {detailQuery.isFetching && !detail ? (
                          <div className="pr-detail-loading">
                            <LoaderCircle size={15} className="spinner-icon" />
                            <span>正在加载评论与 CI 检查状态…</span>
                          </div>
                        ) : detailQuery.isError ? (
                          <div className="inline-error">{describeError(detailQuery.error)}</div>
                        ) : detail ? (
                          <>
                            {onSendToChat && (failedChecksCount > 0 || detail.comments.length > 0) && (
                              <div className="pr-detail-toolbar">
                                <span>
                                  共 {detail.checks.length} 项检查（{failedChecksCount} 项失败）· {detail.comments.length} 条评论
                                </span>
                                <button
                                  type="button"
                                  className="secondary-button compact"
                                  onClick={() => sendPromptToChat(buildBatchFixPrompt(detail))}
                                >
                                  <Send size={13} />
                                  汇总全部反馈到对话
                                </button>
                              </div>
                            )}

                            <div className="pr-detail-section">
                              <h4>CI 状态检查</h4>
                              {detail.checks.length === 0 ? (
                                <p className="pr-detail-empty">暂无状态检查记录</p>
                              ) : (
                                <div className="pr-check-list">
                                  {detail.checks.map((check, index) => {
                                    const failed = isCheckFailed(check);
                                    const ok = isCheckSuccess(check);
                                    return (
                                      <div className="pr-check-item" key={`${check.name}-${index}`}>
                                        <span className={`pr-check-status ${failed ? "failed" : ok ? "ok" : "pending"}`}>
                                          {failed ? (
                                            <CircleAlert size={14} />
                                          ) : ok ? (
                                            <CheckCircle2 size={14} />
                                          ) : (
                                            <Clock size={14} />
                                          )}
                                          <strong>{check.name}</strong>
                                          <small>{check.conclusion || check.status || "PENDING"}</small>
                                        </span>
                                        <span className="pr-check-actions">
                                          {check.detailsUrl && (
                                            <button
                                              type="button"
                                              className="icon-button"
                                              title="查看检查详情"
                                              onClick={() => onOpenUrl(check.detailsUrl)}
                                            >
                                              <ExternalLink size={13} />
                                            </button>
                                          )}
                                          {failed && onSendToChat && (
                                            <button
                                              type="button"
                                              className="secondary-button compact"
                                              onClick={() => sendPromptToChat(buildCheckFixPrompt(detail, check))}
                                              data-testid={`pr-send-check-${index}`}
                                            >
                                              <Send size={12} />
                                              发送到对话修复
                                            </button>
                                          )}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>

                            <div className="pr-detail-section">
                              <h4>审查与讨论意见</h4>
                              {detail.comments.length === 0 ? (
                                <p className="pr-detail-empty">暂无审查或讨论评论</p>
                              ) : (
                                <div className="pr-comment-list">
                                  {detail.comments.map((comment) => (
                                    <div className="pr-comment-item" key={comment.id}>
                                      <header>
                                        <span>
                                          <strong>@{comment.author}</strong>
                                          <span className="status-chip">{reviewStateLabel(comment.reviewState)}</span>
                                        </span>
                                        {onSendToChat && (
                                          <button
                                            type="button"
                                            className="secondary-button compact"
                                            onClick={() => sendPromptToChat(buildCommentFixPrompt(detail, comment))}
                                            data-testid={`pr-send-comment-${comment.id}`}
                                          >
                                            <Send size={12} />
                                            发送到对话处理
                                          </button>
                                        )}
                                      </header>
                                      <p>{comment.body}</p>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </>
                        ) : null}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </>
      ) : null}

      {createOpen && (
        <div className="modal-backdrop" role="presentation" onClick={closeCreateModal}>
          <div
            className="modal-panel pr-create-modal"
            role="dialog"
            aria-modal="true"
            aria-label="创建拉取请求"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="pr-create-header">
              <div>
                <h2>创建拉取请求</h2>
                <small>{collection?.repository || repositoryRoot}</small>
              </div>
              <button type="button" className="icon-button" aria-label="关闭" onClick={closeCreateModal}>
                <X size={16} />
              </button>
            </header>

            <div className="pr-create-body">
              <div className="pr-create-row">
                <label className="stacked-setting">
                  <span>目标基线分支</span>
                  <input
                    aria-label="目标基线分支"
                    value={baseBranch}
                    onChange={(event) => setBaseBranch(event.target.value)}
                    placeholder="main"
                  />
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleGenerateDraft()}
                  disabled={drafting || submittingPr}
                  data-testid="pr-ai-draft-button"
                >
                  {drafting ? <LoaderCircle size={14} className="spinner-icon" /> : <Sparkles size={14} />}
                  AI 生成标题与描述
                </button>
              </div>

              {draftMeta && (
                <div className="pr-draft-meta">
                  已基于 <code>{draftMeta.headBranch}</code> → <code>{draftMeta.baseBranch}</code>（{draftMeta.commitCount} 个提交）生成草稿
                </div>
              )}

              <label className="stacked-setting">
                <span>标题</span>
                <input
                  aria-label="拉取请求标题"
                  value={prTitle}
                  onChange={(event) => setPrTitle(event.target.value)}
                  placeholder="简明概括本次拉取请求的目的"
                />
              </label>

              <label className="stacked-setting">
                <span>描述（Markdown）</span>
                <textarea
                  aria-label="拉取请求描述"
                  rows={8}
                  value={prBody}
                  onChange={(event) => setPrBody(event.target.value)}
                  placeholder="## 改动摘要&#10;- ...&#10;&#10;## 验证方式&#10;- ..."
                />
              </label>

              <div className="pr-create-options">
                <label className="checkbox-inline">
                  <input type="checkbox" checked={isDraft} onChange={(event) => setIsDraft(event.target.checked)} />
                  <span>作为草稿（Draft）创建</span>
                </label>
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={pushBeforeCreate}
                    onChange={(event) => setPushBeforeCreate(event.target.checked)}
                  />
                  <span>创建前自动推送当前分支</span>
                </label>
              </div>

              {createError && <div className="inline-error">{createError}</div>}
            </div>

            <footer className="pr-create-footer">
              <button type="button" className="secondary-button" onClick={closeCreateModal} disabled={submittingPr}>
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleCreatePr()}
                disabled={submittingPr}
                data-testid="pr-submit-create-button"
              >
                {submittingPr ? <LoaderCircle size={14} className="spinner-icon" /> : <GitPullRequest size={14} />}
                创建拉取请求
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
