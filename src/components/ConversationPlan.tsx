import { Check, Circle, ListChecks, LoaderCircle } from "lucide-react";
import type { TaskPlanSummary, TaskPlanStatus } from "../lib/envSources";

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

export function ConversationPlan({
  plan,
  compact = false,
  onOpen,
}: {
  plan: TaskPlanSummary;
  compact?: boolean;
  onOpen?: () => void;
}) {
  return (
    <section className={`conversation-plan-card${compact ? " is-compact" : ""}`} aria-label="当前计划">
      <button
        type="button"
        className="conversation-plan-open"
        onClick={onOpen}
        disabled={!onOpen}
        title="查看计划"
      >
        <span className="conversation-plan-icon" aria-hidden="true"><ListChecks size={15} strokeWidth={1.7} /></span>
        <div>
          <strong>计划 {plan.completed}/{plan.steps.length}</strong>
          {plan.explanation && <span>{plan.explanation}</span>}
        </div>
      </button>
      {!compact && (
        <ol className="conversation-plan-steps">
          {plan.steps.map((step) => (
            <li key={step.id} className={`conversation-plan-step is-${step.status}`}>
              <StatusIcon status={step.status} />
              <span>{step.text}</span>
              <em>{statusLabel(step.status)}</em>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
