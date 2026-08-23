export type PlanItemStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  id: string;
  text: string;
  status: PlanItemStatus;
}

export interface PlanState {
  explanation: string;
  items: PlanItem[];
}

export function validatePlanState(input: PlanState): PlanState {
  if (input.items.length > 50) throw new Error("A plan cannot contain more than 50 steps");
  const ids = new Set<string>();
  let active = 0;
  const items = input.items.map((item, index) => {
    const id = item.id.trim();
    const text = item.text.trim();
    if (!id) throw new Error(`Plan step ${index + 1} requires an id`);
    if (!text) throw new Error(`Plan step ${index + 1} requires text`);
    if (ids.has(id)) throw new Error(`Duplicate plan step id: ${id}`);
    ids.add(id);
    if (!(["pending", "in_progress", "completed"] as string[]).includes(item.status)) {
      throw new Error(`Invalid status for plan step ${id}`);
    }
    if (item.status === "in_progress") active += 1;
    return { id, text, status: item.status };
  });
  if (active > 1) throw new Error("Only one plan step can be in progress");
  return { explanation: input.explanation.trim(), items };
}

export function planWidgetLines(state: PlanState): string[] {
  if (state.items.length === 0) return [];
  const completed = state.items.filter((item) => item.status === "completed").length;
  return [
    `计划 ${completed}/${state.items.length}`,
    ...state.items.map((item) => {
      const marker = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]";
      return `${marker} ${item.text}`;
    }),
  ];
}
