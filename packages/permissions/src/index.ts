/**
 * Permission modes, agent modes and tool rules (ADR 0009), on
 * `tools/pre-execute`. The decision logic is the Pi guard's (`rules.ts`);
 * this plugin supplies it with each session's modes and asks through `ui`
 * when a rule says to confirm. With no UI attached, a call that needs
 * confirmation is denied.
 *
 * A session's modes are `custom` events of namespace `pid-permissions`, so
 * they follow the branch and survive restarts.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import { latestCustom, type Session } from "@pid/session";
import { SectionOrder } from "@pid/system-prompt";
import "@pid/tools";
import "@pid/ui";
import {
  agentModeSystemInstructions,
  applyDesktopToolDefaults,
  evaluateToolPermission,
  normalizeAgentMode,
  normalizePermissionMode,
  parseToolRules,
  permissionForAgentMode,
  type AgentMode,
  type PermissionMode,
  type PermissionRules,
  type ToolPermissionRule,
} from "./rules.ts";

export * from "./rules.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    permissions: Permissions;
  }
}

export const NAMESPACE = "pid-permissions";

export interface SessionModes {
  permission: PermissionMode;
  agentMode: AgentMode;
  /** What tool calls are judged by: read-only unless the agent mode is `agent`. */
  effective: PermissionMode;
}

export interface Config {
  defaultPermission?: PermissionMode;
  defaultAgentMode?: AgentMode;
  /** Default true. */
  alwaysConfirmShell?: boolean;
  /** Default true. */
  blockWriteOutsideWorkspace?: boolean;
  shellAllowPrefixes?: string[];
  toolRules?: ToolPermissionRule[];
}

/** Rules from config, with the guard's defaults; tool rules go through the guard's own validation. */
export function rulesFromConfig(config: Config): PermissionRules {
  return {
    alwaysConfirmShell: config.alwaysConfirmShell !== false,
    blockWriteOutsideWorkspace: config.blockWriteOutsideWorkspace !== false,
    shellAllowPrefixes: (config.shellAllowPrefixes ?? []).map((prefix) => prefix.trim()).filter(Boolean),
    toolRules: parseToolRules(Buffer.from(JSON.stringify(config.toolRules ?? [])).toString("base64")),
  };
}

export class Permissions extends Service {
  static inject = ["sessions", "tools", "ui", "systemPrompt"];

  readonly rules: PermissionRules;

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, "permissions");
    this.rules = rulesFromConfig(config);

    ctx.on("tools/pre-execute", async (call, env) => {
      applyDesktopToolDefaults(call.name, call.args);
      const session = await ctx.sessions.get(env.sessionId);
      const mode = session === undefined ? this.defaults().effective : this.modes(session).effective;
      const decision = evaluateToolPermission({ mode, rules: this.rules, workspace: env.cwd, toolName: call.name, input: call.args });
      if (decision.action === "allow") return undefined;
      if (decision.action === "block") return { deny: true, reason: decision.reason };
      if (!ctx.ui.available) return { deny: true, reason: "Confirmation required but no UI is available" };
      const allowed = await ctx.ui.confirm(env.sessionId, decision.title, decision.message, env.signal);
      return allowed ? undefined : { deny: true, reason: `${decision.title} denied by user` };
    });

    ctx.effect(() => ctx.systemPrompt.section("agent-mode", async ({ sessionId }) => {
      const session = await ctx.sessions.get(sessionId);
      return agentModeSystemInstructions(session === undefined ? this.defaults().agentMode : this.modes(session).agentMode);
    }, { order: SectionOrder.guidelines + 10 }), "permissions: agent-mode section");
  }

  private defaults(): SessionModes {
    const permission = normalizePermissionMode(this.config.defaultPermission);
    const agentMode = normalizeAgentMode(this.config.defaultAgentMode);
    return { permission, agentMode, effective: permissionForAgentMode(agentMode, permission) };
  }

  modes(session: Session): SessionModes {
    const defaults = this.defaults();
    const stored = latestCustom<{ permission?: string; agentMode?: string }>(session.events, NAMESPACE);
    const permission = stored?.permission === undefined ? defaults.permission : normalizePermissionMode(stored.permission);
    const agentMode = stored?.agentMode === undefined ? defaults.agentMode : normalizeAgentMode(stored.agentMode);
    return { permission, agentMode, effective: permissionForAgentMode(agentMode, permission) };
  }

  /** Change a session's modes; returns the appended event's seq. */
  set(session: Session, change: { permission?: PermissionMode; agentMode?: AgentMode }): number {
    const current = this.modes(session);
    return session.append("custom", {
      ns: NAMESPACE,
      data: { permission: change.permission ?? current.permission, agentMode: change.agentMode ?? current.agentMode },
    }).seq;
  }
}
