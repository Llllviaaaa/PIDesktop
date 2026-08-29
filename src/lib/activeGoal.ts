import type { UiMessage, UiToolCall } from "../types";

export type GoalToolKind = "create" | "get" | "update";

export interface ActiveGoal {
  id: string;
  objective: string;
  status: "creating" | "active" | "blocked";
  startedAt: number;
  tokenBudget?: number;
}

function normalizedToolName(name: string): string {
  const snakeCase = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  const segments = snakeCase.split(/__|[.:/]/).filter(Boolean);
  return segments[segments.length - 1] ?? snakeCase;
}

export function goalToolKind(name: string): GoalToolKind | null {
  switch (normalizedToolName(name)) {
    case "create_goal": return "create";
    case "get_goal": return "get";
    case "update_goal": return "update";
    default: return null;
  }
}

export function isGoalToolCall(call: Pick<UiToolCall, "name">): boolean {
  return goalToolKind(call.name) !== null;
}

function stringArg(call: UiToolCall, key: string): string | null {
  const value = call.args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberArg(call: UiToolCall, key: string): number | undefined {
  const value = call.args[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function deriveActiveGoal(messages: UiMessage[]): ActiveGoal | null {
  let terminalStatus: ActiveGoal["status"] | null = null;

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    const toolCalls = message.toolCalls ?? [];
    for (let callIndex = toolCalls.length - 1; callIndex >= 0; callIndex -= 1) {
      const call = toolCalls[callIndex];
      const kind = goalToolKind(call.name);
      if (!kind || call.isError) continue;

      if (kind === "create") {
        return {
          id: call.id,
          objective: stringArg(call, "objective") ?? stringArg(call, "goal") ?? "正在创建目标",
          status: terminalStatus ?? (call.running ? "creating" : "active"),
          startedAt: call.startedAt ?? message.timestamp ?? call.finishedAt ?? 0,
          tokenBudget: numberArg(call, "token_budget") ?? numberArg(call, "tokenBudget"),
        };
      }

      if (kind !== "update") continue;
      const status = stringArg(call, "status")?.toLowerCase();
      if (status === "complete" && !call.running) {
        return null;
      } else if (status === "blocked" && !call.running) {
        terminalStatus = "blocked";
      }
    }
  }

  return null;
}
