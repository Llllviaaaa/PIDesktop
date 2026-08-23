import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { pi } from "../lib/pi";
import { findGitWorkspace, uniqueWorkspacePaths } from "../lib/pullRequests";
import type { PullRequestCollection, PullRequestInfo } from "../types";

interface PullRequestsPageProps {
  cwd: string;
  workspaceOptions: string[];
  onOpenUrl: (url: string) => void;
  onCheckout: (pullRequest: PullRequestInfo, repositoryRoot: string) => Promise<void>;
  onReview: (pullRequest: PullRequestInfo, repositoryRoot: string) => void;
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

export function PullRequestsPage({ cwd, workspaceOptions, onOpenUrl, onCheckout, onReview }: PullRequestsPageProps) {
  const [collection, setCollection] = useState<PullRequestCollection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [checkingOut, setCheckingOut] = useState<number | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState(cwd);
  const [repositoryRoot, setRepositoryRoot] = useState("");
  const [selectionTouched, setSelectionTouched] = useState(false);
  const availableWorkspaces = useMemo(
    () => uniqueWorkspacePaths([cwd, ...workspaceOptions]),
    [cwd, workspaceOptions],
  );

  useEffect(() => {
    setSelectedWorkspace(cwd);
    setSelectionTouched(false);
  }, [cwd]);

  const load = useCallback(async () => {
    if (availableWorkspaces.length === 0) {
      setCollection(null);
      setError("先打开一个 Git 项目，再查看拉取请求。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const resolved = await findGitWorkspace(
        selectedWorkspace || cwd,
        availableWorkspaces,
        pi.gitRepositoryRoot,
        !selectionTouched,
      );
      if (!resolved) {
        setCollection(null);
        setRepositoryRoot("");
        setError(selectionTouched
          ? "所选工作区不是 Git 仓库，请切换到其他项目。"
          : "没有找到可用的 Git 项目，请先打开或注册一个 Git 仓库。");
        return;
      }
      const nextCollection = await pi.listPullRequests(resolved.repositoryRoot);
      setSelectedWorkspace(resolved.workspace);
      setRepositoryRoot(resolved.repositoryRoot);
      setCollection(nextCollection);
    } catch (loadError) {
      setCollection(null);
      setRepositoryRoot("");
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [availableWorkspaces, cwd, selectedWorkspace, selectionTouched]);

  useEffect(() => {
    void load();
  }, [load]);

  const checkout = async (pullRequest: PullRequestInfo) => {
    if (!repositoryRoot) return;
    setCheckingOut(pullRequest.number);
    try {
      await onCheckout(pullRequest, repositoryRoot);
    } finally {
      setCheckingOut(null);
    }
  };

  return (
    <section className="pull-requests-page">
      <header className="work-center-header">
        <div>
          <span className="work-center-icon"><GitPullRequest size={20} /></span>
          <span>
            <h1>拉取请求</h1>
            <p>查看、检出并让 Pi 审查当前项目的 GitHub 拉取请求。</p>
          </span>
        </div>
        <div className="work-center-header-actions">
          {availableWorkspaces.length > 1 && (
            <label className="repository-picker">
              <span>仓库</span>
              <select
                value={selectedWorkspace}
                onChange={(event) => {
                  setSelectionTouched(true);
                  setSelectedWorkspace(event.target.value);
                }}
                disabled={loading}
              >
                {availableWorkspaces.map((workspace) => (
                  <option value={workspace} key={workspace}>{workspace.split(/[\\/]/).filter(Boolean).pop() || workspace}</option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="icon-button" title="刷新拉取请求" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={16} className={loading ? "spinner-icon" : ""} />
          </button>
        </div>
      </header>

      {loading && !collection ? (
        <div className="work-center-empty"><LoaderCircle className="spinner-icon" size={21} /><strong>正在读取 GitHub 拉取请求</strong></div>
      ) : error ? (
        <div className="work-center-error">
          <TriangleAlert size={20} />
          <span><strong>无法加载拉取请求</strong><small>{error}</small></span>
          <button type="button" className="secondary-button" onClick={() => onOpenUrl("https://cli.github.com/")}>GitHub CLI</button>
        </div>
      ) : collection ? (
        <>
          <div className="repository-strip">
            <GitBranch size={16} />
            <span><strong>{collection.repository}</strong><small>{collection.remoteUrl || cwd}</small></span>
            <em>{collection.items.length} 个打开的 PR</em>
          </div>
          {collection.items.length === 0 ? (
            <div className="work-center-empty"><GitPullRequest size={22} /><strong>当前没有打开的拉取请求</strong></div>
          ) : (
            <div className="pull-request-list">
              {collection.items.map((pullRequest) => (
                <article className="pull-request-row" key={pullRequest.number}>
                  <div className="pull-request-number">#{pullRequest.number}</div>
                  <div className="pull-request-copy">
                    <div><strong>{pullRequest.title}</strong>{pullRequest.isDraft && <span className="status-chip">草稿</span>}</div>
                    <small>
                      {pullRequest.author || "未知作者"} · {pullRequest.headRefName} → {pullRequest.baseRefName}
                      {updatedLabel(pullRequest.updatedAt) && ` · ${updatedLabel(pullRequest.updatedAt)}`}
                    </small>
                  </div>
                  <div className="pull-request-actions">
                    <button type="button" className="icon-button" title="在 GitHub 打开" onClick={() => onOpenUrl(pullRequest.url)}><ExternalLink size={15} /></button>
                    <button type="button" className="secondary-button" onClick={() => void checkout(pullRequest)} disabled={checkingOut !== null}>
                      {checkingOut === pullRequest.number ? <LoaderCircle size={14} className="spinner-icon" /> : <GitBranch size={14} />}检出
                    </button>
                    <button type="button" className="primary-button" onClick={() => onReview(pullRequest, repositoryRoot)}><MessageSquareText size={14} />交给 Pi 审查</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
