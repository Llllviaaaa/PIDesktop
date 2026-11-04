/**
 * A full unified-diff document (one changed file, or every file of a commit
 * patch): collapsible per-file headers — source files open by default, tests
 * / docs / generated files stay folded — each expanded file rendering through
 * the shared {@link DiffRows} (so git diffs get the same rewrite tinting,
 * intra-line highlights, syntax colors and hunk folds as session-op diffs).
 * Untracked files produce no `git diff` output; the caller passes their
 * content to render as a full-file addition instead.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { isZh, t } from '../locales.ts'
import { diffStats, displayPath, parseUnifiedDiff, unifiedSegments, untrackedFile, type DiffFile, type DiffRow, type FoldSegment } from './rows.ts'
import { langOfPath } from './highlight.ts'
import { DiffRows } from './DiffRows.tsx'
import css from './diff.module.css'

const TEST_PATH = /(^|\/)(?:__tests__|tests?|specs?|fixtures?|mocks?|snapshots?)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i
const DOC_PATH = /(^|\/)(?:docs?|documentation)(?:\/|$)|(^|\/)(?:readme|changelog|contributing|license|authors|notice)(\.[^/]*)?$/i
const GENERATED_PATH = /(^|\/)(?:dist|build|coverage|generated|vendor|node_modules)(?:\/|$)|(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|composer\.lock|cargo\.lock|poetry\.lock)$/i
const SOURCE_PATH = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyw|rb|php|java|kt|kts|scala|go|rs|swift|c|h|cc|cpp|cxx|hpp|hh|hxx|cs|fs|fsx|vb|dart|lua|r|ex|exs|erl|hrl|clj|cljs|cljc|groovy|sh|bash|zsh|fish|ps1|sql|vue|svelte|astro|html|htm|css|scss|sass|less)$/i

export const OVERSIZED_DIFF_THRESHOLD = 800

function countFileChangedLines(file: DiffFile): number {
  let count = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add' || line.kind === 'del') count += 1
    }
  }
  return count
}

/** Source files open by default; tests, docs, generated files, oversized diffs and unknown types stay folded. */
function defaultExpandedFiles(files: readonly DiffFile[]): Set<number> {
  const expanded = new Set<number>()
  files.forEach((file, index) => {
    const path = displayPath(file.newPath === '/dev/null' ? file.oldPath : file.newPath)
    if (!file.binary && file.hunks.length > 0
      && countFileChangedLines(file) < OVERSIZED_DIFF_THRESHOLD
      && !TEST_PATH.test(path) && !DOC_PATH.test(path) && !GENERATED_PATH.test(path)
      && SOURCE_PATH.test(path)) {
      expanded.add(index)
    }
  })
  return expanded
}

/** The file header badge: added / deleted / renamed / binary ('' for a plain edit). */
function fileTag(file: DiffFile): string | null {
  if (file.binary) return t('diffBinary')
  if (file.oldPath === '/dev/null') return t('diffAdded')
  if (file.newPath === '/dev/null') return t('diffDeleted')
  const oldPath = displayPath(file.oldPath)
  const newPath = displayPath(file.newPath)
  if (oldPath !== newPath) return t('diffRenamed')
  return null
}

export interface DiffFilesProps {
  /** Unified diff text (`git.diff` or `git.commit-diff` payloads). */
  diff: string
  /** Untracked-file content: when present, renders as a full-file addition instead of parsing. */
  untrackedPath?: string
  untrackedContent?: string
  /** Fetch a git gap fold's hidden rows on demand (both sides' contents by
   *  the fold's line ranges); forwarded to every file's DiffRows. Absent
   *  folds without `rows` stay non-expandable (session-op diffs and
   *  untracked additions always carry theirs). */
  resolveFold?: (file: DiffFile, segment: FoldSegment) => Promise<readonly DiffRow[]>
}

export function DiffFiles({ diff, untrackedPath, untrackedContent, resolveFold }: DiffFilesProps) {
  const parsed = useMemo(() => {
    if (untrackedPath !== undefined) {
      return { files: [untrackedFile(untrackedPath, untrackedContent ?? '')] }
    }
    return parseUnifiedDiff(diff)
  }, [diff, untrackedPath, untrackedContent])
  const [expandedFiles, setExpandedFiles] = useState<Set<number>>(() => defaultExpandedFiles(parsed.files))
  useEffect(() => { setExpandedFiles(defaultExpandedFiles(parsed.files)) }, [parsed])

  // One in-flight/resolved promise per file+fold key, so a fold re-clicked
  // after a remount (file header collapsed and re-expanded) resolves without
  // a second fetch and concurrent clicks join the same request. The cache
  // dies with `parsed` (a new diff text); rejected promises are dropped so a
  // later retry can go through.
  const foldCache = useRef(new Map<string, Promise<readonly DiffRow[]>>())
  useEffect(() => { foldCache.current = new Map() }, [parsed])
  const loadFold = (file: DiffFile, segment: FoldSegment): Promise<readonly DiffRow[]> => {
    if (resolveFold === undefined) return Promise.resolve([])
    const path = displayPath(file.newPath === '/dev/null' ? file.oldPath : file.newPath)
    const key = `${path}|${String(segment.oldStart)}|${String(segment.newStart)}`
    let promise = foldCache.current.get(key)
    if (promise === undefined) {
      promise = resolveFold(file, segment)
      foldCache.current.set(key, promise)
      promise.catch(() => { foldCache.current.delete(key) })
    }
    return promise
  }

  // Segments and header stats computed once per file.
  const files = useMemo(
    () => parsed.files.map((file) => {
      const segments = unifiedSegments(file)
      return { file, segments, stats: diffStats(segments) }
    }),
    [parsed],
  )

  const renderFile = (entry: (typeof files)[number], fileIndex: number): ReactNode => {
    const { file, segments, stats } = entry
    const tag = fileTag(file)
    const from = displayPath(file.oldPath)
    const to = displayPath(file.newPath)
    const expandable = !file.binary && file.hunks.length > 0
    const fileExpanded = expandedFiles.has(fileIndex)
    const isPureRename = !file.binary && from !== to && file.hunks.length === 0
    const isOversized = expandable && (stats.added + stats.deleted) >= OVERSIZED_DIFF_THRESHOLD
    const zhMode = isZh()
    return (
      <div key={`file-${String(fileIndex)}`} className={css.fileBlock}>
        <button
          type="button"
          className={css.file}
          disabled={!expandable}
          aria-expanded={expandable ? fileExpanded : undefined}
          onClick={() => {
            setExpandedFiles(current => {
              const next = new Set(current)
              if (next.has(fileIndex)) next.delete(fileIndex)
              else next.add(fileIndex)
              return next
            })
          }}
        >
          {expandable && <span aria-hidden="true" className={clsx(css.fileChevron, fileExpanded && css.fileChevronExpanded)}>›</span>}
          <span className={css.filePath}>{to}</span>
          {from !== to && <span className={css.fileOld}>← {from}</span>}
          {tag !== null && <span className={css.fileTag}>{tag}</span>}
          {expandable && (stats.added > 0 || stats.deleted > 0) && (
            <span className={css.fileStats}>
              {stats.added > 0 && <span className={css.statAdd}>+{String(stats.added)}</span>}
              {stats.deleted > 0 && <span className={css.statDel}>−{String(stats.deleted)}</span>}
            </span>
          )}
        </button>
        {file.binary && (
          <div className={css.stateCard} data-testid="diff-state-binary">
            <span>{zhMode ? '二进制文件已变更，无法直接预览文本差异。' : 'Binary file changed; text diff preview is unavailable.'}</span>
          </div>
        )}
        {isPureRename && (
          <div className={css.stateCard} data-testid="diff-state-rename">
            <span>{zhMode ? '文件已重命名，内容无增删改动。' : 'File renamed without content changes.'}</span>
          </div>
        )}
        {isOversized && !fileExpanded && (
          <div className={css.stateCard} data-testid="diff-state-oversized">
            <span>
              {zhMode
                ? `差异较大（+${String(stats.added)} / −${String(stats.deleted)} 行），已默认折叠以保持流畅。`
                : `Large diff (+${String(stats.added)} / −${String(stats.deleted)} lines); collapsed by default to keep scrolling smooth.`}
            </span>
            <button
              type="button"
              className={css.stateAction}
              data-testid="diff-expand-oversized"
              onClick={() => {
                setExpandedFiles(current => {
                  const next = new Set(current)
                  next.add(fileIndex)
                  return next
                })
              }}
            >
              {zhMode ? '仍要展开差异' : 'Expand full diff'}
            </button>
          </div>
        )}
        {expandable && fileExpanded && (
          <DiffRows segments={segments} lang={langOfPath(to)} resolveFold={resolveFold !== undefined ? (segment) => loadFold(file, segment) : undefined} />
        )}
      </div>
    )
  }

  if (parsed.files.length === 0) return null
  return (
    <div className={css.files}>
      {files.map(renderFile)}
    </div>
  )
}
