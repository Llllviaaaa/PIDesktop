import { useId, useState } from "react";
import { Check, ChevronRight, Circle, CircleCheck, ListChecks, LoaderCircle, PanelRightOpen } from "lucide-react";
import type { TaskPlanStep, TaskPlanStatus, TaskPlanSummary } from "../lib/envSources";

function statusLabel(status: TaskPlanStatus): string {
  if (status === "completed") return "完成";
  if (status === "in_progress") return "进行中";
  return "待处理";
}

function StatusIcon({ status }: { status: TaskPlanStatus }) {
  if (status === "completed") return <Check size={13} strokeWidth={2} />;
  if (status === "in_progress") return <LoaderCircle className="spin" size={13} strokeWidth={2} />;
  return <Circle size={13} strokeWidth={1.8} />;
}

export function PlanSteps({ id, steps }: { id?: string; steps: TaskPlanStep[] }) {
  return (
    <ol id={id} className="plan-steps">
      {steps.map((step) => (
        <li key={step.id} className={`plan-step is-${step.status}`}>
          <StatusIcon status={step.status} />
          <span>{step.text}</span>
          <em>{statusLabel(step.status)}</em>
        </li>
      ))}
    </ol>
  );
}

/** Donut showing how much of a plan is done. */
export function PlanProgressRing({ completed, total }: { completed: number; total: number }) {
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  const done = total > 0 ? Math.min(1, completed / total) : 0;
  return (
    <svg className="plan-progress-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r={radius} fill="none" strokeWidth="2" className="plan-progress-track" />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${circumference * done} ${circumference}`}
        transform="rotate(-90 7 7)"
        className="plan-progress-value"
      />
    </svg>
  );
}

/** A finished turn's plan: one quiet row that expands in place. */
export function ConversationPlan({
  plan,
  onOpenPlan,
}: {
  plan: TaskPlanSummary;
  /** Only the turn holding the latest plan offers the side panel, which always shows that plan. */
  onOpenPlan?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const stepsId = useId();
  const total = plan.steps.length;
  const finished = plan.completed === total;
  const toggleLabel = expanded ? "收起计划" : "展开计划";

  return (
    <section className={`turn-plan${expanded ? " is-expanded" : ""}`} aria-label="本轮计划">
      <div className="turn-plan-row">
        <button
          type="button"
          className="turn-plan-toggle"
          title={toggleLabel}
          aria-expanded={expanded}
          aria-controls={stepsId}
          onClick={() => setExpanded((value) => !value)}
        >
          {finished
            ? <CircleCheck className="turn-plan-icon is-finished" size={14} strokeWidth={1.8} aria-hidden="true" />
            : <ListChecks className="turn-plan-icon" size={14} strokeWidth={1.8} aria-hidden="true" />}
          <strong>{finished ? `计划 ${total}/${total} 已完成` : `计划 ${plan.completed}/${total}`}</strong>
          {plan.explanation && <span className="turn-plan-note">{plan.explanation}</span>}
          <ChevronRight className={expanded ? "open" : undefined} size={13} strokeWidth={1.8} aria-hidden="true" />
        </button>
        {onOpenPlan && (
          <button type="button" className="turn-plan-panel" title="在侧栏查看计划" aria-label="在侧栏查看计划" onClick={onOpenPlan}>
            <PanelRightOpen size={13} strokeWidth={1.8} />
          </button>
        )}
      </div>
      {expanded && <PlanSteps id={stepsId} steps={plan.steps} />}
    </section>
  );
}
