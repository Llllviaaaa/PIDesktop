/**
 * The topbar's Git split button. Its main action follows the working tree:
 * 提交 while there are changes, then 推送 or 发布分支. The menu names the
 * branch and where it stands against its remote.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, CloudUpload, GitBranch, GitCommitHorizontal, LoaderCircle } from "lucide-react";
import { gitActionsFor, type GitPrimaryAction } from "../lib/gitActions";
import type { GitSnapshot } from "../types";

interface GitActionButtonProps {
  git: GitSnapshot | null;
  pushing: boolean;
  /** Opens the commit dialog; `push` pushes right after the commit. */
  onCommit: (push: boolean) => void;
  onPush: () => void;
}

function actionLabel(action: GitPrimaryAction): string {
  if (action.kind === "commit") return "提交";
  if (action.kind === "publish") return "发布分支";
  return "推送";
}

export function GitActionButton({ git, pushing, onCommit, onPush }: GitActionButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const state = gitActionsFor(git);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!state?.primary) return null;
  const primary = state.primary;
  // The menu's push entry: next to a commit, or the primary action itself.
  const push = primary.kind === "commit" ? state.push : primary;
  const run = (action: GitPrimaryAction, push = false) => {
    setOpen(false);
    if (action.kind === "commit") onCommit(push);
    else onPush();
  };
  const PrimaryIcon = pushing
    ? LoaderCircle
    : primary.kind === "commit" ? GitCommitHorizontal : primary.kind === "publish" ? CloudUpload : ArrowUp;
  const primaryTitle = primary.kind === "commit"
    ? `提交 ${git?.files.length ?? 0} 个文件的更改`
    : primary.kind === "publish"
      ? `把 ${state.branch} 推送到远程并跟踪它`
      : `推送 ${primary.ahead} 个提交到 ${git?.sync?.upstream ?? "远程"}`;

  return (
    <div className="topbar-menu-wrap git-action-menu" ref={wrapRef}>
      <div className={`git-action-control ${open ? "active" : ""}`}>
        <button
          type="button"
          className="git-action-main"
          title={pushing ? "正在推送…" : primaryTitle}
          disabled={pushing}
          onClick={() => run(primary)}
        >
          <PrimaryIcon size={14} strokeWidth={1.8} className={pushing ? "spin" : undefined} />
          <span>{pushing ? "推送中" : actionLabel(primary)}</span>
          {primary.kind === "push" && !pushing && <small>{primary.ahead}</small>}
        </button>
        <button
          type="button"
          className="git-action-trigger"
          title="更多 Git 操作"
          aria-label="更多 Git 操作"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronDown size={13} strokeWidth={1.75} />
        </button>
      </div>
      {open && (
        <div className="topbar-menu workspace-tools-popover git-action-popover" role="menu">
          <div className="git-action-branch">
            <GitBranch size={14} />
            <span>
              <strong title={state.branch}>{state.branch}</strong>
              <small>{state.syncLabel}</small>
            </span>
          </div>
          {state.behind > 0 && state.push?.kind === "push" && (
            <div className="git-action-note">远程有 {state.behind} 个新提交，推送前需要先拉取合并。</div>
          )}
          <div className="workspace-tools-separator" role="separator" />
          {primary.kind === "commit" && (
            <>
              <button role="menuitem" onClick={() => run(primary)}>
                <GitCommitHorizontal size={15} />
                <span>提交…</span>
              </button>
              <button role="menuitem" disabled={!state.canCommitAndPush || pushing} onClick={() => run(primary, true)}>
                <ArrowUp size={15} />
                <span>提交并推送…</span>
              </button>
            </>
          )}
          {push && (
            <button role="menuitem" disabled={pushing} onClick={() => run(push)}>
              {push.kind === "publish" ? <CloudUpload size={15} /> : <ArrowUp size={15} />}
              <span>{push.kind === "publish" ? "发布分支" : `推送 ${push.ahead} 个提交`}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
