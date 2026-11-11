import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useSyncOnChange } from "../../hooks/useSyncOnChange";
import type { ToolKind } from "../../lib/toolPresentation";
import {
  IconApi,
  IconBrowse,
  IconChecklist,
  IconChevronDown,
  IconChevronUp,
  IconEdit,
  IconGlobe,
  IconSearch,
  IconSparkle,
  IconThink,
  StateSpinner,
} from "../DshIcons";
import { Markdown } from "../Markdown";
import { DisclosureRow, TextShimmer } from "../TranscriptPrimitives";
import {
  durationText,
  firstLine,
  latestCompletedParagraphFirstLine,
  WAIT_OVERTIME_MS,
} from "./messageHelpers";

export function ProcessActivityIcon({ kind }: { kind: ToolKind | "thinking" }) {
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

export function ReasoningRow({
  text,
  running,
  settledPreview,
}: {
  text: string;
  running: boolean;
  settledPreview: boolean;
}) {
  const [touched, setTouched] = useState<{ running: boolean; expanded: boolean } | null>(null);
  const expanded = touched && touched.running === running ? touched.expanded : running;
  const summary = (running ? latestCompletedParagraphFirstLine(text) : firstLine(text)).replace(/\*\*/g, "");
  const preview = !expanded && summary !== "" && (running || settledPreview);
  const windowRef = useRef<HTMLDivElement>(null);

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

export function ProcessGroup({
  grouped,
  live,
  autoOpen = false,
  summary,
  activity,
  children,
}: {
  grouped: boolean;
  live: boolean;
  autoOpen?: boolean;
  summary: string;
  activity: ToolKind | "thinking";
  children: ReactNode;
}) {
  const [touched, setTouched] = useState<{ autoOpen: boolean; open: boolean } | null>(null);
  const open = touched && touched.autoOpen === autoOpen ? touched.open : autoOpen;
  const setOpen = (next: (value: boolean) => boolean) => setTouched({ autoOpen, open: next(open) });
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ scrollable: false, up: false, down: false });

  const measureEdges = () => {
    const node = bodyRef.current;
    if (!node) return;
    const scrollable = node.scrollHeight > node.clientHeight + 2;
    const up = scrollable && node.scrollTop > 0;
    const down = scrollable && node.scrollTop + node.clientHeight < node.scrollHeight - 1;
    setEdges((current) =>
      current.scrollable === scrollable && current.up === up && current.down === down
        ? current
        : { scrollable, up, down },
    );
  };

  useLayoutEffect(() => {
    if (!grouped || !open) return;
    measureEdges();
    const node = bodyRef.current;
    const content = contentRef.current;
    if (!node || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => measureEdges());
    observer.observe(node);
    if (content) observer.observe(content);
    return () => observer.disconnect();
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
          event.currentTarget.focus({ preventScroll: true });
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
          className={`dshc-group-body${edges.scrollable ? " is-scrollable" : ""}${edges.up ? " is-fade-top" : ""}${edges.down ? " is-fade-bottom" : ""}`}
          data-step-process-body=""
          onScroll={measureEdges}
        >
          <div ref={contentRef} className="dshc-group-content" data-step-process-content="" data-chat-flow="">{children}</div>
        </div>
      )}
    </div>
  );
}

export function RunningRow({
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
