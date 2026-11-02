import { useState } from "react";
import { ChevronDown, FileDiff } from "lucide-react";
import type { GitFileChange } from "../types";

/** Rows the file list shows before "再显示 N 个文件". */
const VISIBLE_FILES = 4;

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function folderOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "";
}

function DiffStat({ add, del }: { add: number; del: number }) {
  return (
    <span className="conversation-change-stat">
      {add > 0 && <em>+{add}</em>}
      {add > 0 && del > 0 && " "}
      {del > 0 && <b>-{del}</b>}
    </span>
  );
}

/**
 * What this session changed, closing its last turn as Codex's 「已编辑 N 个文件」 card does:
 * the heading folds a per-file list with each file's +/-, and a file opens on click.
 */
export function SessionChangeCard({
  files,
  stats,
  onOpenFile,
  onRestore,
  onReview,
}: {
  files: GitFileChange[];
  /** Per-file line counts keyed by `/`-separated path. */
  stats: Map<string, { add: number; del: number }>;
  onOpenFile: (path: string) => void;
  onRestore: () => void;
  onReview: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const statFor = (path: string) => stats.get(path.replace(/\\/g, "/")) ?? { add: 0, del: 0 };
  const total = files.reduce(
    (sum, file) => {
      const stat = statFor(file.path);
      return { add: sum.add + stat.add, del: sum.del + stat.del };
    },
    { add: 0, del: 0 },
  );
  const single = files.length === 1;
  const visible = showAll ? files : files.slice(0, VISIBLE_FILES);

  return (
    <section className="conversation-change-card" aria-label="本任务的变更" data-open={!single && open ? "" : undefined}>
      <div className="conversation-change-heading">
        <button
          type="button"
          className="conversation-change-open"
          // One file has nothing to list, so its heading opens the file instead.
          onClick={() => (single ? onOpenFile(files[0].path) : setOpen((value) => !value))}
          title={single ? files[0].path : open ? "收起文件列表" : "展开文件列表"}
          aria-expanded={single ? undefined : open}
        >
          <span className="conversation-change-icon"><FileDiff size={15} strokeWidth={1.7} /></span>
          <div>
            <strong>{single ? `已编辑 ${fileName(files[0].path)}` : `已编辑 ${files.length} 个文件`}</strong>
            <DiffStat add={total.add} del={total.del} />
          </div>
          {!single && <ChevronDown className="conversation-change-chevron" size={14} strokeWidth={1.8} aria-hidden="true" />}
        </button>
        <button type="button" className="change-card-secondary" onClick={onRestore}>撤销</button>
        <button type="button" onClick={onReview}>审核</button>
      </div>
      {!single && open && (
        <ul className="conversation-change-files">
          {visible.map((file) => {
            const stat = statFor(file.path);
            const folder = folderOf(file.path);
            return (
              <li key={file.path}>
                <button type="button" onClick={() => onOpenFile(file.path)} title={file.path}>
                  <span className="conversation-change-file-name">{fileName(file.path)}</span>
                  {folder && <span className="conversation-change-file-folder">{folder}</span>}
                  <DiffStat add={stat.add} del={stat.del} />
                </button>
              </li>
            );
          })}
          {files.length > VISIBLE_FILES && (
            <li>
              <button type="button" className="conversation-change-more" onClick={() => setShowAll((value) => !value)}>
                {showAll ? "收起" : `再显示 ${files.length - VISIBLE_FILES} 个文件`}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
