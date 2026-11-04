/**
 * RPC methods of the feature plugins (ADR 0009, 0010): `permission.get` and
 * `permission.set`, `plan.get`, `checkpoint.list`, `checkpoint.diff` and
 * `checkpoint.restore`, `mcp.status` and `usage.summary`. They live in the
 * host so the plugins stay free of the transport.
 */
import type { Context } from "@deepseek-ai/cordis";
import "@pid/agent";
import "@pid/mcp";
import { checkpointFor, checkpointsOf, diffCheckpoint, restoreCheckpoint } from "@pid/checkpoints";
import { normalizeAgentMode, normalizePermissionMode, type AgentMode, type PermissionMode } from "@pid/permissions";
import { planOf } from "@pid/plan";
import {
  ErrorCode,
  type AppendResult,
  type CheckpointDiffResult,
  type CheckpointListResult,
  type McpGetPromptResult,
  type McpPromptsResult,
  type McpReadResourceResult,
  type McpResourcesResult,
  type McpServerStatus,
  type McpStatusResult,
  type PermissionGetResult,
  type PlanGetResult,
  type UsageSummaryResult,
} from "@pid/protocol";
import type { Session } from "@pid/session";
import { RpcError } from "./rpc.ts";

export const name = "pid-features-rpc";
export const inject = ["rpc", "sessions", "agents", "permissions", "mcp"];

const PERMISSIONS: readonly PermissionMode[] = ["read-only", "ask", "workspace-write", "full-access"];
const AGENT_MODES: readonly AgentMode[] = ["agent", "plan", "ask"];

export function apply(ctx: Context): void {
  const session = async (params: unknown): Promise<{ target: Session; p: Record<string, unknown> }> => {
    const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
    if (typeof p.sessionId !== "string") throw new RpcError(ErrorCode.InvalidParams, "sessionId must be a string");
    const target = await ctx.sessions.get(p.sessionId);
    if (target === undefined) throw new RpcError(ErrorCode.SessionNotFound, `No session ${p.sessionId}`);
    return { target, p };
  };
  const userSeq = (p: Record<string, unknown>): number => {
    if (!Number.isInteger(p.userSeq)) throw new RpcError(ErrorCode.InvalidParams, "userSeq must be the seq of a user message");
    return p.userSeq as number;
  };
  const recordOf = (params: unknown): Record<string, unknown> => {
    if (params === undefined || params === null) return {};
    if (typeof params !== "object" || Array.isArray(params)) {
      throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
    }
    return params as Record<string, unknown>;
  };
  const optionalStr = (p: Record<string, unknown>, key: string): string | undefined => {
    const raw = p[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string") throw new RpcError(ErrorCode.InvalidParams, `${key} must be a string`);
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  };
  const requiredStr = (p: Record<string, unknown>, key: string): string => {
    const value = optionalStr(p, key);
    if (value === undefined) throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-empty string`);
    return value;
  };
  const formatMcpStatuses = (): McpServerStatus[] =>
    ctx.mcp.statuses().map(({ config, connected, toolCount, protocolVersion, hasResources, hasPrompts, error }) => ({
      id: config.id,
      name: config.name || config.id,
      transport: config.transport,
      connected,
      toolCount,
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
      resources: hasResources === true,
      prompts: hasPrompts === true,
      ...(error === undefined ? {} : { error }),
    }));

  ctx.on("mcp/changed", () => {
    ctx.rpc.broadcast("mcp/changed", { servers: formatMcpStatuses() });
  });
  void ctx.mcp.ready.then(() => {
    ctx.rpc.broadcast("mcp/changed", { servers: formatMcpStatuses() });
  });

  const methods: Record<string, (params: unknown) => unknown> = {
    "permission.get": async (params): Promise<PermissionGetResult> => ctx.permissions.modes((await session(params)).target),

    "permission.set": async (params): Promise<AppendResult> => {
      const { target, p } = await session(params);
      if (p.permission !== undefined && !PERMISSIONS.includes(p.permission as PermissionMode)) {
        throw new RpcError(ErrorCode.InvalidParams, `permission must be one of ${PERMISSIONS.join(", ")}`);
      }
      if (p.agentMode !== undefined && !AGENT_MODES.includes(p.agentMode as AgentMode)) {
        throw new RpcError(ErrorCode.InvalidParams, `agentMode must be one of ${AGENT_MODES.join(", ")}`);
      }
      return {
        seq: ctx.permissions.set(target, {
          ...(p.permission === undefined ? {} : { permission: normalizePermissionMode(p.permission as string) }),
          ...(p.agentMode === undefined ? {} : { agentMode: normalizeAgentMode(p.agentMode as string) }),
        }),
      };
    },

    "plan.get": async (params): Promise<PlanGetResult> => ({ plan: planOf((await session(params)).target) }),

    "checkpoint.list": async (params): Promise<CheckpointListResult> => ({
      checkpoints: checkpointsOf((await session(params)).target).map(({ userSeq, checkpoint }) => ({ userSeq, root: checkpoint.root, createdAt: checkpoint.createdAt })),
    }),

    "checkpoint.diff": async (params): Promise<CheckpointDiffResult> => {
      const { target, p } = await session(params);
      const record = checkpointFor(target, userSeq(p));
      if (record === undefined) throw new RpcError(ErrorCode.InvalidParams, "No checkpoint for that message");
      return diffCheckpoint(record);
    },

    "checkpoint.restore": async (params): Promise<CheckpointDiffResult> => {
      const { target, p } = await session(params);
      if (ctx.agents.status(target.id).running) throw new RpcError(ErrorCode.SessionBusy, `Session ${target.id} is running`);
      const record = checkpointFor(target, userSeq(p));
      if (record === undefined) throw new RpcError(ErrorCode.InvalidParams, "No checkpoint for that message");
      return restoreCheckpoint(record);
    },

    "mcp.status": async (): Promise<McpStatusResult> => {
      await ctx.mcp.ready;
      return { servers: formatMcpStatuses() };
    },

    "mcp.reconnect": async (params): Promise<McpStatusResult> => {
      const p = recordOf(params);
      const serverId = optionalStr(p, "serverId");
      try {
        await ctx.mcp.reconnect(serverId);
      } catch (error) {
        throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
      }
      return { servers: formatMcpStatuses() };
    },

    "mcp.resources": async (params): Promise<McpResourcesResult> => {
      const p = recordOf(params);
      const serverId = optionalStr(p, "serverId");
      try {
        const resources = await ctx.mcp.listAllResources(serverId);
        return { resources };
      } catch (error) {
        throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
      }
    },

    "mcp.readResource": async (params): Promise<McpReadResourceResult> => {
      const p = recordOf(params);
      const serverId = optionalStr(p, "serverId");
      const uri = requiredStr(p, "uri");
      try {
        return await ctx.mcp.readServerResource(serverId, uri);
      } catch (error) {
        throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
      }
    },

    "mcp.prompts": async (params): Promise<McpPromptsResult> => {
      const p = recordOf(params);
      const serverId = optionalStr(p, "serverId");
      try {
        const prompts = await ctx.mcp.listAllPrompts(serverId);
        return { prompts };
      } catch (error) {
        throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
      }
    },

    "mcp.getPrompt": async (params): Promise<McpGetPromptResult> => {
      const p = recordOf(params);
      const serverId = optionalStr(p, "serverId");
      const name = requiredStr(p, "name");
      const rawArgs = p.arguments;
      const args: Record<string, string> = {};
      if (rawArgs !== undefined) {
        if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
          throw new RpcError(ErrorCode.InvalidParams, "arguments must be a string map");
        }
        for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
          if (typeof value === "string") args[key] = value;
        }
      }
      try {
        return await ctx.mcp.getServerPrompt(serverId, name, args);
      } catch (error) {
        throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
      }
    },

    "usage.summary": async (): Promise<UsageSummaryResult> => {
      const sessions = await ctx.sessions.list();
      const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      let messages = 0;
      for (const session of sessions) {
        messages += session.messageCount;
        for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += session.usage[key];
      }
      return { sessions: sessions.length, messages, usage: total };
    },
  };

  for (const [method, handler] of Object.entries(methods)) {
    ctx.effect(() => ctx.rpc.method(method, handler), `${name}: ${method}`);
  }
}
