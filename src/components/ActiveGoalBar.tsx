import { useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, Target } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { deriveActiveGoal, type ActiveGoal } from "../lib/activeGoal";
import { usePiStore } from "../store";

function formatElapsed(goal: ActiveGoal, now: number): string {
  if (goal.startedAt <= 0) return "进行中";
  const minutes = Math.max(0, Math.floor((now - goal.startedAt) / 60_000));
  if (minutes < 1) return "刚刚开始";
  if (minutes < 60) return `已运行 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `已运行 ${hours} 小时 ${remainder} 分钟` : `已运行 ${hours} 小时`;
}

export function ActiveGoalBar() {
  const goal = usePiStore(useShallow((state) => deriveActiveGoal(state.messages)));
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!goal) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [goal?.id]);

  if (!goal) return null;

  const label = goal.status === "blocked"
    ? "目标受阻"
    : goal.status === "creating"
      ? "正在设置目标"
      : "目标进行中";

  return (
    <section className={`active-goal-card status-${goal.status}`} aria-label={label}>
      <span className="active-goal-status" aria-hidden="true">
        {goal.status === "creating"
          ? <LoaderCircle className="spin" size={14} strokeWidth={1.8} />
          : goal.status === "blocked"
            ? <CircleAlert size={14} strokeWidth={1.8} />
            : <Target size={14} strokeWidth={1.8} />}
      </span>
      <span className="active-goal-copy">
        <strong>{label}</strong>
        <span title={goal.objective}>{goal.objective}</span>
      </span>
      <span className="active-goal-meta">
        {formatElapsed(goal, now)}
        {goal.tokenBudget ? ` · ${goal.tokenBudget.toLocaleString()} token 上限` : ""}
      </span>
    </section>
  );
}
