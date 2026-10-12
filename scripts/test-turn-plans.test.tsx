import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationPlan } from "../src/components/ConversationPlan";
import { Message } from "../src/components/Message";
import {
  currentPlanStepIndex,
  deriveLiveTaskPlan,
  deriveTaskPlan,
  deriveTurnPlans,
  type TaskPlanStatus,
} from "../src/lib/envSources";
import type { UiMessage } from "../src/types";
import { test } from "vitest";

const planCall = (id: string, statuses: TaskPlanStatus[], explanation = "") => ({
  id,
  name: "update_plan",
  args: {
    explanation,
    items: statuses.map((status, index) => ({ id: `step-${index + 1}`, text: `Step ${index + 1}`, status })),
  },
  running: false,
});

const user = (id: string): UiMessage => ({ id, role: "user", content: "Do the work.", timestamp: 1 });

const assistant = (id: string, toolCalls: UiMessage["toolCalls"] = [], content = "Done."): UiMessage => ({
  id,
  role: "assistant",
  content,
  timestamp: 2,
  toolCalls,
});

const planOf = (statuses: TaskPlanStatus[], explanation = "") => {
  const plan = deriveTaskPlan([assistant("plan-owner", [planCall("plan", statuses, explanation)])]);
  assert.ok(plan);
  return plan;
};

test("turn plans", () => {
  const transcript: UiMessage[] = [
    user("u1"),
    assistant("a1", [planCall("p1", ["in_progress", "pending"]), planCall("p2", ["completed", "completed"], "Shipped")]),
    user("u2"),
    assistant("a2"),
  ];

  // A turn without update_plan carries no plan; the finished plan stays with its own turn.
  const plans = deriveTurnPlans(transcript);
  assert.deepEqual([...plans.keys()], ["a1"]);
  assert.equal(plans.get("a1")?.completed, 2);
  assert.equal(plans.get("a1")?.explanation, "Shipped");
  assert.equal(plans.has("a2"), false);
  assert.equal(deriveLiveTaskPlan(transcript), null);
  assert.equal(deriveTaskPlan(transcript)?.explanation, "Shipped", "the side panel still shows the newest plan");

  // When a notice splits one turn, only the last plan in that turn is shown.
  const split = deriveTurnPlans([
    user("u1"),
    assistant("a1", [planCall("p1", ["in_progress", "pending"])]),
    { id: "n1", role: "notice", noticeKind: "compaction", content: "Context compacted", timestamp: 3 },
    assistant("a2", [planCall("p2", ["completed", "in_progress"])]),
  ]);
  assert.deepEqual([...split.keys()], ["a2"]);

  // While the open turn streams, its plan moves to the composer and leaves the transcript.
  const streaming: UiMessage[] = [
    user("u1"),
    assistant("a1", [planCall("p1", ["completed", "completed"])]),
    user("u2"),
    assistant("a2", [planCall("p2", ["completed", "in_progress", "pending"])], ""),
  ];
  assert.deepEqual([...deriveTurnPlans(streaming, true).keys()], ["a1"]);
  assert.deepEqual([...deriveTurnPlans(streaming).keys()], ["a1", "a2"]);
  const live = deriveLiveTaskPlan(streaming);
  assert.equal(live?.steps.length, 3);
  assert.equal(live && currentPlanStepIndex(live), 1);

  // A new turn that has not planned yet shows no live plan, even if an earlier turn did.
  assert.equal(deriveLiveTaskPlan([...streaming.slice(0, 2), user("u2")]), null);

  assert.equal(currentPlanStepIndex(planOf(["completed", "pending", "pending"])), 1);
  assert.equal(currentPlanStepIndex(planOf(["completed", "completed"])), 1);
});

test("turn plan rendering", () => {
  const plan = planOf(["completed", "completed"], "Shipped the dashboard");

  // Collapsed by default: one row, no step list.
  const row = renderToStaticMarkup(createElement(ConversationPlan, { plan }));
  assert.match(row, /计划 2\/2 已完成/);
  assert.match(row, /Shipped the dashboard/);
  assert.match(row, /aria-expanded="false"/);
  assert.doesNotMatch(row, /class="plan-steps"/);
  assert.doesNotMatch(row, /在侧栏查看计划/);
  assert.match(renderToStaticMarkup(createElement(ConversationPlan, { plan, onOpenPlan: () => undefined })), /在侧栏查看计划/);

  const message = assistant("a1", [planCall("p1", ["completed", "completed"])]);
  assert.match(renderToStaticMarkup(createElement(Message, { message, plan })), /class="turn-plan"/);

  // The working turn leaves its plan to the composer.
  const working = renderToStaticMarkup(createElement(Message, {
    message: { ...message, content: "" },
    plan,
    isLastAssistant: true,
    globalStreaming: true,
  }));
  assert.doesNotMatch(working, /class="turn-plan"/);
});
