export type SubagentRole = "explorer" | "planner" | "reviewer" | "worker";
export type SubagentPermission = "read-only" | "workspace-write";

export interface SubagentTask {
  label: string;
  task: string;
  role: SubagentRole;
}

const ROLE_PROMPTS: Record<SubagentRole, string> = {
  explorer: "Investigate the codebase and return concise findings with exact file and symbol references. Do not make changes.",
  planner: "Produce a concrete implementation plan grounded in inspected code. Include risks and verification. Do not make changes.",
  reviewer: "Review the relevant implementation for bugs, regressions, and missing tests. Lead with findings and evidence. Do not make changes.",
  worker: "Implement the delegated task completely within the workspace, then run focused verification and report changed files.",
};

export function normalizeSubagentTasks(input: Array<Partial<SubagentTask>>): SubagentTask[] {
  if (input.length === 0) throw new Error("At least one delegated task is required");
  if (input.length > 8) throw new Error("At most 8 delegated tasks may run in one call");
  return input.map((item, index) => {
    const role: SubagentRole = ["explorer", "planner", "reviewer", "worker"].includes(item.role ?? "")
      ? item.role as SubagentRole
      : "explorer";
    const task = item.task?.trim() ?? "";
    if (!task) throw new Error(`Delegated task ${index + 1} is empty`);
    return { label: item.label?.trim() || `${role}-${index + 1}`, task, role };
  });
}

export function subagentPrompt(task: SubagentTask): string {
  return `${ROLE_PROMPTS[task.role]}\n\nDelegated task:\n${task.task}`;
}
