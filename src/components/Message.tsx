import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowUp, ChevronDown, ChevronUp, Info, Link2, LoaderCircle, Pencil, RotateCcw, Share2, Terminal } from "lucide-react";
import { useSyncOnChange } from "../hooks/useSyncOnChange";
import type { UiMessage, UiToolCall, WorkStep } from "../types";
import type { TaskPlanSummary } from "../lib/envSources";
import { foldThinking } from "../lib/thinkingDisplay";
import { normalizeTranscriptDensity, type TranscriptDensity } from "../lib/transcriptDensity";
import { presentToolCall, type ToolDiffLine, type ToolKind } from "../lib/toolPresentation";
import { usePiStore } from "../store";
import { isGoalToolCall } from "../lib/activeGoal";
import { ConversationPlan } from "./ConversationPlan";
import { Markdown } from "./Markdown";
import { ToolCall } from "./ToolCall";
import { DisclosureRow, TextShimmer } from "./TranscriptPrimitives";
import {
  IconApi,
  IconBrowse,
  IconCheck,
  IconChecklist,
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconEdit,
  IconGlobe,
  IconSearch,
  IconSparkle,
  IconThink,
  StateSpinner,
} from "./DshIcons";

/*
 * The transcript as DeepSeek Harness draws it under dsh-claude-style
 * (dsh-client-ui-chat, MIT): a right-aligned plain-text bubble with a leading
 * clock, a settled turn's "已完成，用时 N秒" divider over its folded process
 * group, 24px reasoning and tool disclosure rows, the answer in the prose
 * face, the live running line, and the turn's tail actions with a trailing
 * clock.
 */

export const USER_MESSAGE_COLLAPSED_LINES = 6;

/** A user message younger than this at mount was just sent, so its bubble animates in. */
const USER_MESSAGE_ENTRY_WINDOW_MS = 1_500;
const USER_BUBBLE_HIDDEN = { opacity: 0, scale: 0.82, x: 14, y: 12 };
const USER_BUBBLE_VISIBLE = { opacity: 1, scale: 1, x: 0, y: 0 };
const USER_BUBBLE_SPRING = { type: "spring", stiffness: 520, damping: 24, mass: 0.8 } as const;

/**
 * The host's work-details policies (presentation-policy.js) under Pi's density
 * names: 摘要 is DSH's 简洁, 普通 its 标准, 详细 its 详细. Each folds a settled
 * turn; they differ in whether a working turn's calls sit under group headers
 * and whether a stopped reasoning row keeps its one-line preview.
 */
const TRANSCRIPT_POLICIES: Record<TranscriptDensity, { liveGrouping: boolean; settledReasoningPreview: boolean }> = {
  summary: { liveGrouping: true, settledReasoningPreview: false },
  normal: { liveGrouping: true, settledReasoningPreview: true },
  verbose: { liveGrouping: false, settledReasoningPreview: true },
};

/** After this long without new output the running line adds 「暂未响应」 (dsh-claude-style wait-state). */
const WAIT_OVERTIME_MS = 10_000;

export function isUserMessageOverLineLimit(contentHeight: number, lineHeight: number): boolean {
  if (!Number.isFinite(contentHeight) || !Number.isFinite(lineHeight) || contentHeight <= 0 || lineHeight <= 0) {
    return false;
  }
  return contentHeight > lineHeight * USER_MESSAGE_COLLAPSED_LINES + 2;
}

/** True while the agent is still thinking or running tools, before the answer (or after a new tool starts). */
export function isLiveAssistantWork(
  working: boolean,
  content: string | undefined,
  toolCalls: Array<{ running?: boolean }> | undefined,
): boolean {
  if (!working) return false;
  if (toolCalls?.some((call) => call.running)) return true;
  return !(content ?? "").trim();
}

/** Codex/Claude fold rows stay short; drop the app-level "Pi 正在工作…" status prefix. */
export function foldWorkingLabel(workingLabel: string | undefined): string {
  const label = workingLabel?.trim();
  if (!label || /正在工作/.test(label)) return "正在工作…";
  return label;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** The host's message clock: HH:MM today, with the date before it on other days. */
export function formatMessageClock(time: number, now = Date.now()): string {
  const date = new Date(time);
  const today = new Date(now);
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()) {
    return clock;
  }
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear() === today.getFullYear() ? monthDay : `${date.getFullYear()}年${monthDay}`} ${clock}`;
}

export interface DurationPart {
  text: string;
  numeric: boolean;
}

/** The host's run duration, split so the numbers can take the tabular code face. */
export function formatRunDuration(durationMs: number): DurationPart[] {
  const total = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  const parts: DurationPart[] = [];
  if (hours > 0) parts.push({ text: String(hours), numeric: true }, { text: "小时", numeric: false });
  if (total >= 60) parts.push({ text: String(minutes), numeric: true }, { text: "分", numeric: false });
  parts.push({ text: String(seconds), numeric: true }, { text: "秒", numeric: false });
  return parts;
}

function durationText(durationMs: number): string {
  return formatRunDuration(durationMs).map((part) => part.text).join("");
}

function workDurationMs(toolCalls: UiToolCall[]): number | null {
  let start: number | null = null;
  let end: number | null = null;
  for (const call of toolCalls) {
    if (typeof call.startedAt === "number") start = start === null ? call.startedAt : Math.min(start, call.startedAt);
    if (typeof call.finishedAt === "number") end = end === null ? call.finishedAt : Math.max(end, call.finishedAt);
  }
  if (start === null || end === null || end <= start) return null;
  return end - start;
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return (newline === -1 ? text : text.slice(0, newline)).trim();
}

/** The host's streaming preview: the first line of the newest paragraph that has finished its first line. */
function latestCompletedParagraphFirstLine(text: string): string {
  let summary = "";
  let paragraphStart = 0;
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
  for (;;) {
    const nextParagraph = separator.exec(text);
    const paragraphEnd = nextParagraph === null ? text.length : nextParagraph.index + nextParagraph[0].indexOf("\n");
    const newline = text.indexOf("\n", paragraphStart);
    if (newline !== -1 && newline <= paragraphEnd) {
      const candidate = text.slice(paragraphStart, newline).trim();
      if (candidate !== "") summary = candidate;
    }
    if (nextParagraph === null) return summary;
    paragraphStart = nextParagraph.index + nextParagraph[0].length;
  }
}

/** dsh-claude-style's process summary: what one group holds, 「执行 2 次思考，调用 1 次工具」. */
export function buildProcessSummary(thinking: number, outputs: number, tools: number): string {
  const parts: string[] = [];
  if (thinking > 0) parts.push(`执行 ${thinking} 次思考`);
  if (outputs > 0) parts.push(`输出 ${outputs} 次`);
  if (tools > 0) parts.push(`调用 ${tools} 次工具`);
  return parts.join("，") || "执行 1 次思考";
}

export type ProcessSegment =
  | { kind: "text"; key: string; text: string }
  | {
    kind: "group";
    key: string;
    members: Array<{ step: WorkStep; index: number }>;
    thinking: number;
    tools: number;
    /** What the group's header glyph shows: its first member's activity. */
    activity: ToolKind | "thinking";
  };

/**
 * The host's turn grouping (process-groups.js): reasoning and tool calls gather
 * into one process group until a narration closes it, and each narration
 * stands on its own between the groups.
 */
export function processSegments(steps: WorkStep[]): ProcessSegment[] {
  const segments: ProcessSegment[] = [];
  let pending: Array<{ step: WorkStep; index: number }> = [];
  const flush = () => {
    const first = pending[0];
    if (!first) return;
    segments.push({
      kind: "group",
      key: `group-${first.index}`,
      members: pending,
      thinking: pending.filter(({ step }) => step.kind === "thinking").length,
      tools: pending.filter(({ step }) => step.kind === "tool").length,
      activity: first.step.kind === "tool" ? presentToolCall(first.step.call).kind : "thinking",
    });
    pending = [];
  };
  steps.forEach((step, index) => {
    if (step.kind === "note") {
      flush();
      segments.push({ kind: "text", key: `text-${index}`, text: step.text });
      return;
    }
    pending.push({ step, index });
  });
  flush();
  return segments;
}

/** dsh-claude-style's running line: what the turn is doing right now. */
function liveActivityLabel(
  workingLabel: string | undefined,
  hasRunningTool: boolean,
  reasoning: boolean,
  writing: boolean,
): string {
  const explicit = workingLabel?.trim();
  if (explicit && !/正在工作/.test(explicit)) return explicit;
  if (hasRunningTool) return "正在调用工具";
  if (writing) return "正在写回答";
  if (reasoning) return "正在思考";
  return "正在工作…";
}

function ProcessActivityIcon({ kind }: { kind: ToolKind | "thinking" }) {
  switch (kind) {
    case "thinking":
      return <IconThink />;
    case "read":
      return <IconBrowse />;
    case "write":
    case "edit":
      return <IconEdit />;
    case "shell":
      return <IconApi />;
    case "search":
      return <IconSearch />;
    case "web-search":
      return <IconGlobe />;
    case "browser":
      return <IconBrowse />;
    case "plan":
      return <IconChecklist />;
    default:
      return <IconSparkle />;
  }
}

interface MergedFileToolMeta {
  headId: string;
  count: number;
  added: number;
  removed: number;
  diff: ToolDiffLine[];
}

/** Merge multiple edit/write tool calls targeting the same file within a single turn (dsh-claude-style D62). */
function computeMergedFileTools(calls: UiToolCall[]): Map<string, MergedFileToolMeta> {
  const byPath = new Map<string, Array<{ call: UiToolCall; presented: ReturnType<typeof presentToolCall> }>>();
  for (const call of calls) {
    if (call.isError) continue;
    const presented = presentToolCall(call);
    if ((presented.kind !== "edit" && presented.kind !== "write") || !presented.path || !presented.diff?.length) {
      continue;
    }
    const key = presented.path.replace(/\\/g, "/").toLowerCase();
    const list = byPath.get(key) ?? [];
    list.push({ call, presented });
    byPath.set(key, list);
  }
  const result = new Map<string, MergedFileToolMeta>();
  for (const group of byPath.values()) {
    if (group.length <= 1) continue;
    const headId = group[0].call.id;
    let added = 0;
    let removed = 0;
    const diff: ToolDiffLine[] = [];
    for (const item of group) {
      added += item.presented.added ?? 0;
      removed += item.presented.removed ?? 0;
      if (item.presented.diff) diff.push(...item.presented.diff);
    }
    for (const item of group) {
      result.set(item.call.id, { headId, count: group.length, added, removed, diff });
    }
  }
  return result;
}

/** Copy, the caller's own actions, and the message clock: the host's `MessageIconActions` row. */
function MessageIconActions({
  text,
  time,
  clock,
  copyTitle = "复制",
  className,
  extraActions,
}: {
  text: string;
  time?: number;
  clock: "start" | "end";
  copyTitle?: string;
  className?: string;
  extraActions?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);
  const onCopy = () => {
    if (copied) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        setCopied(false);
      }, 1000);
    }).catch(() => undefined);
  };
  const clockEl = typeof time === "number" && time > 0
    ? <span className={clock === "start" ? "dshc-time-start" : "dshc-time-end"}>{formatMessageClock(time)}</span>
    : null;
  return (
    <div className={`dshc-actions${className ? ` ${className}` : ""}`} data-clock={clock}>
      {clock === "start" ? clockEl : null}
      <button
        type="button"
        className="dshc-action"
        title={copied ? "已复制" : copyTitle}
        aria-label={copied ? "已复制" : "复制"}
        onClick={onCopy}
      >
        {copied ? <IconCheck /> : <IconCopy />}
      </button>
      {extraActions}
      {clock === "end" && clockEl ? <span className="dshc-end-info">{clockEl}</span> : null}
    </div>
  );
}

/** One reasoning block as the Think disclosure row; open while the model reasons, folded once it stops. */
function ReasoningRow({
  text,
  running,
  settledPreview,
}: {
  text: string;
  running: boolean;
  settledPreview: boolean;
}) {
  // The reader's own toggle holds only for the phase it happened in (dsh-claude-style reasoning-fold).
  const [touched, setTouched] = useState<{ running: boolean; expanded: boolean } | null>(null);
  const expanded = touched && touched.running === running ? touched.expanded : running;
  const summary = (running ? latestCompletedParagraphFirstLine(text) : firstLine(text)).replace(/\*\*/g, "");
  const preview = !expanded && summary !== "" && (running || settledPreview);
  const windowRef = useRef<HTMLDivElement>(null);

  // The live reasoning window grows with the text up to its cap, then follows the newest line.
  useLayoutEffect(() => {
    const node = windowRef.current;
    if (!node || !running) return;
    const capped = node.scrollHeight > node.clientHeight + 1;
    if (capped) node.setAttribute("data-dsh-claude-reason-capped", "");
    else node.removeAttribute("data-dsh-claude-reason-capped");
    node.scrollTop = node.scrollHeight;
  }, [running, text, expanded]);

  return (
    <div
      className="dshc-reasoning"
      data-variant="think"
      data-state={running ? "running" : "ok"}
      data-expanded={expanded || undefined}
      data-preview={preview || undefined}
    >
      {running && <span className="dshc-visually-hidden">运行中</span>}
      <DisclosureRow
        rowClassName="dshc-reasoning-row"
        icon={<IconThink />}
        title="思考"
        running={running}
        open={expanded}
        expandable
        onToggle={() => setTouched({ running, expanded: !expanded })}
        collapsedContent={(
          <>
            <span className="dshc-sep dshc-reasoning-sep" data-shimmer-decoration="" aria-hidden="true" />
            <span className="dshc-reasoning-summary" data-streaming={running || undefined}>
              <span className="dshc-reasoning-summary-text">{summary}</span>
            </span>
          </>
        )}
      >
        <div
          ref={windowRef}
          className="dshc-think-body"
          data-dsh-claude-reason-window={running ? "" : undefined}
          role="log"
          aria-label="思考过程"
        >
          <div className="dshc-md dshc-md-compact" data-markdown-variant="compact">
            <Markdown content={text} />
          </div>
        </div>
      </DisclosureRow>
    </div>
  );
}

/** The process container (`ChatGroupSeat`): a folded header over a capped, scrollable body once settled. */
function ProcessGroup({
  grouped,
  live,
  autoOpen = false,
  summary,
  activity,
  children,
}: {
  grouped: boolean;
  live: boolean;
  /** Open while the group is still gathering calls, folded once a narration closes it (dsh-claude-style process-fold). */
  autoOpen?: boolean;
  summary: string;
  activity: ToolKind | "thinking";
  children: ReactNode;
}) {
  // The reader's own toggle holds only for the phase it happened in.
  const [touched, setTouched] = useState<{ autoOpen: boolean; open: boolean } | null>(null);
  const open = touched && touched.autoOpen === autoOpen ? touched.open : autoOpen;
  const setOpen = (next: (value: boolean) => boolean) => setTouched({ autoOpen, open: next(open) });
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ up: false, down: false });

  const measureEdges = () => {
    const node = bodyRef.current;
    if (!node) return;
    const up = node.scrollTop > 0;
    const down = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
    setEdges((current) => current.up === up && current.down === down ? current : { up, down });
  };

  useLayoutEffect(() => {
    if (!grouped || !open) return;
    measureEdges();
  }, [grouped, open, children]);

  if (!grouped) {
    return (
      <div className="dshc-group" data-step-process="" data-group-expanded-mode="">
        <div className="dshc-group-body is-expanded" data-step-process-body="">
          <div className="dshc-group-content" data-step-process-content="" data-chat-flow="">{children}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="dshc-group" data-step-process="" data-open={open || undefined}>
      <button
        type="button"
        className="dshc-group-title"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={summary}
        data-process-activity={activity}
        onClick={(event) => {
          event.currentTarget.focus();
          setOpen((value) => !value);
        }}
      >
        <span className="dshc-group-leading" aria-hidden="true">
          <span className="dshc-group-activity" data-step-process-icon="">
            <ProcessActivityIcon kind={activity} />
          </span>
          <span className="dshc-group-chevron" data-step-process-chevron="">
            {open ? <IconChevronUp /> : <IconChevronDown />}
          </span>
        </span>
        <TextShimmer active={live}>
          <span className="dshc-group-label dsh-claude-process-summary">{summary}</span>
        </TextShimmer>
      </button>
      {open && (
        <div
          ref={bodyRef}
          id={bodyId}
          className={`dshc-group-body${edges.up ? " is-fade-top" : ""}${edges.down ? " is-fade-bottom" : ""}`}
          data-step-process-body=""
          onScroll={measureEdges}
        >
          <div className="dshc-group-content" data-step-process-content="" data-chat-flow="">{children}</div>
        </div>
      )}
    </div>
  );
}

/** The live turn's running line: what the turn is doing, its clock, and 「暂未响应」 after ten silent seconds. */
function RunningRow({
  label,
  startTime,
  activityKey,
  divider,
  overtimeAllowed,
}: {
  label: string;
  startTime: number;
  activityKey: string;
  divider: boolean;
  overtimeAllowed: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [lastActivity, setLastActivity] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useSyncOnChange([activityKey], () => {
    setLastActivity(Date.now());
  });

  const base = startTime > 0 ? startTime : now;
  const elapsed = Math.max(1000, now - base);
  const overtime = overtimeAllowed && now - lastActivity >= WAIT_OVERTIME_MS;

  return (
    <div className="dshc-running" data-chat-running="" data-dsh-claude-wait="">
      <span className="dshc-visually-hidden" role="status" aria-live="polite" aria-atomic="true">正在工作</span>
      {divider && <span className="dshc-running-divider" aria-hidden="true" />}
      <span className="dshc-running-content">
        <span className="dshc-running-icon" aria-hidden="true"><StateSpinner size={14} /></span>
        <span className="dsh-claude-chat-wait">
          <span className="dsh-claude-chat-wait-label" data-text={label}>{label}</span>
          <span className="dsh-claude-chat-wait-clock">{durationText(elapsed)}</span>
          {overtime && <span className="dsh-claude-chat-wait-badge">暂未响应</span>}
        </span>
      </span>
    </div>
  );
}

export const Message = memo(function Message({
  message,
  showThinking = true,
  expectVisibleThinking = false,
  isLastAssistant = false,
  globalStreaming = false,
  workingLabel,
  turnStartedAt,
  allowRichContent = false,
  summaryMode = false,
  density = "normal",
  editing = false,
  plan,
  onOpenPlan,
  onEdit,
  onRewind,
  onCancelEdit,
  onSubmitEdit,
}: {
  message: UiMessage;
  showThinking?: boolean;
  /** The selected runtime requested reasoning, so an empty stream should be explained. */
  expectVisibleThinking?: boolean;
  /** True when this is the newest assistant reply of the current turn. */
  isLastAssistant?: boolean;
  /** App-level streaming flag; message.isStreaming is false during reasoning/tool phases. */
  globalStreaming?: boolean;
  /** Current runtime status, rendered with the active assistant reply instead of above the thread. */
  workingLabel?: string;
  /** When the turn this reply answers began, for the running line's clock. */
  turnStartedAt?: number;
  /** Enable the controlled rich-content protocol for completed assistant replies. */
  allowRichContent?: boolean;
  /** Codex 摘要：收起工具轨迹，不展开工作日志。 */
  summaryMode?: boolean;
  /** Conversation density; summaryMode still wins when both are set. */
  density?: TranscriptDensity;
  editing?: boolean;
  /** The plan this turn finished with; hidden while the turn works, when the composer shows it. */
  plan?: TaskPlanSummary;
  onOpenPlan?: () => void;
  onEdit?: (message: UiMessage) => void;
  onRewind?: (message: UiMessage) => Promise<boolean>;
  onCancelEdit?: () => void;
  onSubmitEdit?: (message: UiMessage, text: string) => Promise<boolean>;
}) {
  const [editDraft, setEditDraft] = useState(message.content);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const [userMessageCollapsible, setUserMessageCollapsible] = useState(false);
  const [userMessageExpanded, setUserMessageExpanded] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const [userBubbleEntering] = useState(
    () => message.role === "user" && Date.now() - message.timestamp < USER_MESSAGE_ENTRY_WINDOW_MS,
  );
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const userMessageTextRef = useRef<HTMLDivElement>(null);
  const transcriptDensity = summaryMode ? "summary" : normalizeTranscriptDensity(density);
  const policy = TRANSCRIPT_POLICIES[transcriptDensity];

  useSyncOnChange([editing, message.content], () => {
    if (!editing) {
      setSubmittingEdit(false);
      return;
    }
    setEditDraft(message.content);
  });

  useEffect(() => {
    if (!editing) return;
    const frame = window.requestAnimationFrame(() => {
      const textarea = editTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(220, Math.max(44, textarea.scrollHeight))}px`;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing, message.content]);

  useSyncOnChange([message.id], () => {
    setUserMessageExpanded(false);
  });

  useSyncOnChange([editing, message.content, message.role], () => {
    if (message.role !== "user" || editing || !message.content) {
      setUserMessageCollapsible(false);
    }
  });

  useEffect(() => {
    if (message.role !== "user" || editing || !message.content) {
      return;
    }
    const node = userMessageTextRef.current;
    if (!node || node.closest(".side-chat-messages")) {
      return;
    }

    const measure = () => {
      const styles = window.getComputedStyle(node);
      const measuredLineHeight = Number.parseFloat(styles.lineHeight);
      const fontSize = Number.parseFloat(styles.fontSize);
      const lineHeight = Number.isFinite(measuredLineHeight)
        ? measuredLineHeight
        : (Number.isFinite(fontSize) ? fontSize * 1.5 : 22);
      node.style.setProperty("--user-message-collapsed-height", `${lineHeight * USER_MESSAGE_COLLAPSED_LINES}px`);
      node.style.setProperty("--user-message-full-height", `${node.scrollHeight}px`);
      const next = isUserMessageOverLineLimit(node.scrollHeight, lineHeight);
      setUserMessageCollapsible((current) => current === next ? current : next);
    };

    const frame = window.requestAnimationFrame(measure);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [editing, message.content, message.role]);

  const resizeEditTextarea = () => {
    const textarea = editTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(220, Math.max(44, textarea.scrollHeight))}px`;
  };

  const submitEdit = async () => {
    if (submittingEdit || !editDraft.trim() || !onSubmitEdit) return;
    setSubmittingEdit(true);
    const sent = await onSubmitEdit(message, editDraft);
    if (!sent) setSubmittingEdit(false);
  };

  const rewindMessage = async () => {
    if (rewinding || !onRewind) return;
    setRewinding(true);
    try {
      await onRewind(message);
    } finally {
      setRewinding(false);
    }
  };

  if (message.role === "user") {
    if (editing) {
      return (
        <article className="dshc-flow dshc-user-row is-editing" data-chat-flow-kind="user" id={`message-${message.id}`}>
          <div className="message-edit-card">
            {message.images && message.images.length > 0 && (
              <div className="dshc-attachment-row">
                {message.images.map((image, index) => (
                  <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`附件 ${index + 1}`} />
                ))}
              </div>
            )}
            <textarea
              ref={editTextareaRef}
              className="message-edit-input"
              aria-label="编辑消息"
              rows={1}
              value={editDraft}
              disabled={submittingEdit}
              onChange={(event) => {
                setEditDraft(event.target.value);
                window.requestAnimationFrame(resizeEditTextarea);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onCancelEdit?.();
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submitEdit();
                }
              }}
            />
            <div className="message-edit-actions">
              <button type="button" className="message-edit-cancel" disabled={submittingEdit} onClick={onCancelEdit}>
                取消
              </button>
              <button
                type="button"
                className="message-edit-submit"
                disabled={submittingEdit || !editDraft.trim()}
                onClick={() => void submitEdit()}
                title="从此消息重新发送"
              >
                <ArrowUp size={14} strokeWidth={2} />
                <span>{submittingEdit ? "发送中" : "发送"}</span>
              </button>
            </div>
          </div>
        </article>
      );
    }
    const userMessageCollapsed = userMessageCollapsible && !userMessageExpanded;
    const expandLabel = userMessageExpanded ? "收起消息" : "展开完整消息";
    const contentId = `message-${message.id}-content`;
    const summaryId = `message-${message.id}-collapsed-summary`;
    const accessibleSummary = message.content.length > 240
      ? `${message.content.slice(0, 240)}…`
      : message.content;
    return (
      <article className="dshc-flow dshc-user-row" data-chat-flow-kind="user" id={`message-${message.id}`}>
        <motion.div
          className="dshc-user-stack"
          initial={userBubbleEntering && !reduceMotion ? USER_BUBBLE_HIDDEN : false}
          animate={USER_BUBBLE_VISIBLE}
          transition={USER_BUBBLE_SPRING}
          style={{ originX: 1, originY: 1 }}
        >
          {message.images && message.images.length > 0 && (
            <div className="dshc-attachment-row" data-message-attachments="">
              {message.images.map((image, index) => (
                <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`附件 ${index + 1}`} />
              ))}
            </div>
          )}
          {message.content && (
            <div className={`dshc-bubble${userMessageCollapsible ? userMessageExpanded ? " is-collapsible is-expanded" : " is-collapsible is-collapsed" : ""}`}>
              <div
                ref={userMessageTextRef}
                id={contentId}
                className="dshc-bubble-text"
                aria-hidden={userMessageCollapsed || undefined}
                inert={userMessageCollapsed || undefined}
              >
                {message.content}
              </div>
              {userMessageCollapsed && (
                <span id={summaryId} className="dshc-visually-hidden">
                  消息预览：{accessibleSummary}，其余内容已折叠。
                </span>
              )}
              {userMessageCollapsible && (
                <button
                  type="button"
                  className="dshc-bubble-expand"
                  title={expandLabel}
                  aria-label={expandLabel}
                  aria-controls={contentId}
                  aria-describedby={userMessageCollapsed ? summaryId : undefined}
                  aria-expanded={userMessageExpanded}
                  onClick={() => setUserMessageExpanded((value) => !value)}
                >
                  {userMessageExpanded
                    ? <ChevronUp size={14} strokeWidth={1.6} />
                    : <ChevronDown size={14} strokeWidth={1.6} />}
                </button>
              )}
            </div>
          )}
        </motion.div>
        {message.content && (
          <MessageIconActions
            text={message.content}
            time={message.timestamp}
            clock="start"
            className="dshc-user-actions"
            extraActions={(
              <>
                {onEdit && (
                  <button type="button" className="dshc-action" title="编辑消息" aria-label="编辑消息" disabled={rewinding} onClick={() => onEdit(message)}>
                    <Pencil size={15} strokeWidth={1.25} />
                  </button>
                )}
                {onRewind && (
                  <button
                    type="button"
                    className="dshc-action"
                    title="回退消息和改动"
                    aria-label="回退消息和改动"
                    disabled={rewinding}
                    onClick={() => void rewindMessage()}
                  >
                    {rewinding ? <LoaderCircle className="spin" size={15} strokeWidth={1.25} /> : <RotateCcw size={15} strokeWidth={1.25} />}
                  </button>
                )}
              </>
            )}
          />
        )}
      </article>
    );
  }

  if (message.role === "terminal") {
    return (
      <article className={`dshc-flow message-row terminal-message ${message.isError ? "error" : ""}`} id={`message-${message.id}`}>
        <div className="notice-heading"><Terminal size={14} /> 终端</div>
        <pre>{message.content}</pre>
      </article>
    );
  }

  if (message.role === "notice") {
    if (message.noticeKind === "compaction" || message.noticeKind === "branch") {
      const label = message.noticeKind === "compaction" ? "上下文已压缩" : "会话已分叉";
      const detail = message.content.replace(/^(Context compacted|Branch summary)\s*/i, "").trim();
      return (
        <div className={`dshc-flow compaction-divider is-${message.noticeKind}`} role="separator" id={`message-${message.id}`}>
          <span>{label}</span>
          {detail && transcriptDensity === "verbose" && <small>{detail}</small>}
        </div>
      );
    }
    return (
      <article className="dshc-flow message-row notice-message" id={`message-${message.id}`}>
        <Info size={14} strokeWidth={1.75} aria-hidden="true" />
        <div className="notice-content"><Markdown content={message.content} /></div>
      </article>
    );
  }

  const working = message.role === "assistant"
    && (message.isStreaming || (isLastAssistant && globalStreaming));
  const toolCalls = (message.toolCalls ?? []).filter((call) => !isGoalToolCall(call));
  const thinkingText = showThinking ? foldThinking(message.thinking, message.content) : "";
  // Ordered process rows: the turn's own steps, or its thinking then its tools for an older message.
  const steps: WorkStep[] = message.workSteps
    ? message.workSteps.filter((step) => (step.kind === "tool" ? !isGoalToolCall(step.call) : step.kind !== "thinking" || showThinking))
    : [
      ...(thinkingText ? [{ kind: "thinking" as const, text: thinkingText }] : []),
      ...toolCalls.map((call) => ({ kind: "tool" as const, call })),
    ];
  const hasProcess = steps.length > 0;
  const hasContent = Boolean(message.content.trim());
  const hasRunningTool = toolCalls.some((call) => call.running);
  const lastStep = steps[steps.length - 1];
  const reasoningLive = working && !hasContent && lastStep?.kind === "thinking";
  const thinkingCount = steps.filter((step) => step.kind === "thinking").length;
  const segments = processSegments(steps);
  const mergedFileTools = computeMergedFileTools(steps.flatMap((step) => step.kind === "tool" ? [step.call] : []));
  const reasoningUnavailable = showThinking
    && expectVisibleThinking
    && isLastAssistant
    && !working
    && thinkingCount === 0
    && hasContent
    && !message.isError;
  const durationMs = message.durationMs !== undefined && message.durationMs > 0 ? message.durationMs : workDurationMs(toolCalls);

  if (!hasContent && !working && !hasProcess && !reasoningUnavailable) return null;

  const usage = message.usage;
  const copyTitle = usage
    ? `复制回复${message.model ? ` · ${message.model}` : ""} · ${(usage.totalTokens ?? usage.input + usage.output).toLocaleString()} 个 token`
    : "复制回复";

  const shareContent = () => {
    const text = message.content;
    const share = (navigator as Navigator & { share?: (data: ShareData) => Promise<void> }).share;
    if (typeof share === "function") {
      void share({ text }).catch(() => {
        void navigator.clipboard.writeText(text).then(() => usePiStore.getState().showToast("已复制回复，可粘贴分享", "info"));
      });
      return;
    }
    void navigator.clipboard.writeText(text).then(() => {
      usePiStore.getState().showToast("已复制回复，可粘贴分享", "info");
    }).catch(() => undefined);
  };

  const anchorMessage = () => {
    const node = document.getElementById(`message-${message.id}`);
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
    const url = `${window.location.href.split("#")[0]}#message-${message.id}`;
    void navigator.clipboard.writeText(url).then(() => {
      usePiStore.getState().showToast("已复制消息定位", "info");
    }).catch(() => undefined);
  };

  const renderStep = (step: WorkStep, index: number) => {
    if (step.kind === "thinking") {
      return (
        <ReasoningRow
          key={`thinking-${index}`}
          text={step.text}
          running={reasoningLive && index === steps.length - 1}
          settledPreview={policy.settledReasoningPreview}
        />
      );
    }
    if (step.kind === "note") return null;
    const mergeMeta = mergedFileTools.get(step.call.id);
    const head = mergeMeta?.headId === step.call.id;
    return (
      <ToolCall
        call={step.call}
        key={step.call.id}
        mergedCount={head ? mergeMeta.count : undefined}
        mergedAdded={head ? mergeMeta.added : undefined}
        mergedRemoved={head ? mergeMeta.removed : undefined}
        mergedDiff={head ? mergeMeta.diff : undefined}
        mergedHidden={mergeMeta !== undefined && !head}
      />
    );
  };

  // The turn's process in the host's order: each narration on its own, each run of reasoning and calls in its own group.
  // While the turn works, the group still gathering calls (the last segment) stays open and sweeps its header.
  const renderProcess = (grouped: boolean) => segments.map((segment, position) => {
    if (segment.kind === "text") {
      return (
        <div key={segment.key} className="dshc-process-text dshc-md dshc-md-prose" data-chat-group-part="response">
          <Markdown content={segment.text} />
        </div>
      );
    }
    // An answer streaming below the last group closes it, unless that answer was narration for a call still running.
    const active = working && position === segments.length - 1 && (!hasContent || hasRunningTool);
    return (
      <ProcessGroup
        key={segment.key}
        grouped={grouped}
        live={active}
        autoOpen={active}
        summary={buildProcessSummary(segment.thinking, 0, segment.tools)}
        activity={segment.activity}
      >
        {segment.members.map(({ step, index }) => renderStep(step, index))}
      </ProcessGroup>
    );
  });

  // Every mode folds a settled turn behind its duration divider, leaving the answer; the divider opens it again.
  const canCollapse = hasProcess;
  const settledProcessVisible = hasProcess && processOpen;
  const showTurnProcess = !working && (hasProcess || durationMs !== null || reasoningUnavailable);
  const turnProcessLabel = message.isError
    ? "处理失败"
    : durationMs !== null
      ? "已完成，用时 "
      : "已完成";
  const durationParts = !message.isError && durationMs !== null ? formatRunDuration(Math.max(1000, durationMs)) : [];
  const liveProcessVisible = working && hasProcess;
  const liveLabel = liveActivityLabel(workingLabel, hasRunningTool, reasoningLive, working && hasContent);
  const activityKey = `${message.content.length}:${(message.thinking ?? "").length}:${toolCalls.length}:${toolCalls.filter((call) => call.running).length}`;

  return (
    <article
      className={`dshc-flow dshc-turn${message.isError ? " is-error" : ""}`}
      data-chat-flow-kind="assistant"
      data-turn-open={working || undefined}
      data-actions-reveal={isLastAssistant ? "always" : "hover"}
      id={`message-${message.id}`}
    >
      {showTurnProcess && (
        <button
          type="button"
          className="dshc-turn-process"
          data-open={(canCollapse && processOpen) || undefined}
          disabled={!canCollapse}
          aria-expanded={canCollapse ? processOpen : undefined}
          aria-label={canCollapse ? (processOpen ? "收起工作过程" : "展开工作过程") : undefined}
          onClick={(event) => {
            event.currentTarget.focus();
            setProcessOpen((value) => !value);
          }}
        >
          <span className="dshc-turn-process-label">
            {turnProcessLabel}
            {durationParts.map((part, index) => (
              <span key={index} className={part.numeric ? "dshc-duration-number" : undefined}>{part.text}</span>
            ))}
          </span>
          {canCollapse && <IconChevronDown className="dshc-turn-process-chevron" />}
        </button>
      )}
      {reasoningUnavailable && !hasProcess && <div className="dshc-hint">模型未返回可见推理</div>}
      {settledProcessVisible && !working && renderProcess(true)}
      {liveProcessVisible && renderProcess(policy.liveGrouping)}
      {plan && !working && <ConversationPlan plan={plan} onOpenPlan={onOpenPlan} />}
      {hasContent && (message.isError
        ? (
          <div className="dshc-turn-error" role="status">
            <span className="dshc-state-dot" data-state="error" aria-hidden="true" />
            <div className="dshc-turn-error-copy">
              <span className="dshc-turn-error-title">本轮出错</span>
              <span className="dshc-turn-error-message">{message.content}</span>
            </div>
          </div>
        )
        : (
          <div className="dshc-answer" data-streaming={working || undefined}>
            <div className="dshc-md dshc-md-prose">
              <Markdown content={message.content} allowRichContent={allowRichContent && !working} />
            </div>
          </div>
        ))}
      {working && (
        <RunningRow
          label={liveLabel}
          startTime={turnStartedAt ?? message.timestamp}
          activityKey={activityKey}
          divider={hasProcess || hasContent}
          overtimeAllowed={!hasRunningTool}
        />
      )}
      {hasContent && !working && (
        <MessageIconActions
          text={message.content}
          time={message.timestamp}
          clock="end"
          copyTitle={copyTitle}
          className="dshc-turn-actions"
          extraActions={(
            <>
              <button type="button" className="dshc-action" title="分享" aria-label="分享" onClick={shareContent}>
                <Share2 size={15} strokeWidth={1.25} />
              </button>
              <button type="button" className="dshc-action" title="定位此消息" aria-label="定位此消息" onClick={anchorMessage}>
                <Link2 size={15} strokeWidth={1.25} />
              </button>
            </>
          )}
        />
      )}
    </article>
  );
});
