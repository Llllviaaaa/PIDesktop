import { useId, useMemo, useState } from "react";
import { ChevronUp } from "lucide-react";
import { currentPlanStepIndex, deriveLiveTaskPlan } from "../lib/envSources";
import { useAppStore } from "../store";
import { PlanProgressRing, PlanSteps } from "./ConversationPlan";

/** The running turn's plan, pinned above the composer only while the turn is live. */
export function LivePlanBar() {
  const messages = useAppStore((state) => state.messages);
  const isStreaming = useAppStore((state) => state.isStreaming);
  const plan = useMemo(() => (isStreaming ? deriveLiveTaskPlan(messages) : null), [isStreaming, messages]);
  const [expanded, setExpanded] = useState(false);
  const stepsId = useId();

  if (!plan) return null;

  const total = plan.steps.length;
  const finished = plan.completed === total;
  const stepIndex = currentPlanStepIndex(plan);
  const label = finished ? `计划 ${total}/${total} 已完成` : `第 ${stepIndex + 1}/${total} 步`;
  const detail = finished ? plan.explanation : plan.steps[stepIndex].text;
  const toggleLabel = expanded ? "收起计划" : "展开计划";

  return (
    <section className={`live-plan${expanded ? " is-expanded" : ""}`} aria-label="当前计划进度">
      {expanded && <PlanSteps id={stepsId} steps={plan.steps} />}
      <button
        type="button"
        className="live-plan-toggle"
        title={toggleLabel}
        aria-expanded={expanded}
        aria-controls={stepsId}
        onClick={() => setExpanded((value) => !value)}
      >
        <PlanProgressRing completed={plan.completed} total={total} />
        <strong>{label}</strong>
        {detail && <span title={detail}>{detail}</span>}
        <ChevronUp className={expanded ? "open" : undefined} size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </section>
  );
}
