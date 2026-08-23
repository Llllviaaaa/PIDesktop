export type DesktopHookEvent =
  | "session_start"
  | "before_agent_start"
  | "agent_end"
  | "agent_settled"
  | "tool_call"
  | "tool_result";

export interface DesktopHookConfig {
  id: string;
  name: string;
  enabled: boolean;
  event: DesktopHookEvent;
  command: string;
  timeoutSeconds: number;
  blocking: boolean;
}

const EVENTS = new Set<DesktopHookEvent>([
  "session_start",
  "before_agent_start",
  "agent_end",
  "agent_settled",
  "tool_call",
  "tool_result",
]);

export function validateDesktopHooks(input: DesktopHookConfig[]): DesktopHookConfig[] {
  if (input.length > 32) throw new Error("Pi Desktop supports at most 32 hooks");
  const ids = new Set<string>();
  return input.map((hook, index) => {
    const id = hook.id.trim();
    const name = hook.name.trim() || `Hook ${index + 1}`;
    const command = hook.command.trim();
    if (!id) throw new Error(`Hook ${index + 1} requires an id`);
    if (ids.has(id)) throw new Error(`Duplicate hook id: ${id}`);
    ids.add(id);
    if (!EVENTS.has(hook.event)) throw new Error(`Invalid event for hook ${id}`);
    if (!command) throw new Error(`Hook ${name} requires a command`);
    if (command.length > 8192) throw new Error(`Hook ${name} command is too long`);
    const timeoutSeconds = Math.round(hook.timeoutSeconds);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
      throw new Error(`Hook ${name} timeout must be between 1 and 300 seconds`);
    }
    return {
      id,
      name,
      enabled: Boolean(hook.enabled),
      event: hook.event,
      command,
      timeoutSeconds,
      blocking: hook.event === "tool_call" && Boolean(hook.blocking),
    };
  });
}
