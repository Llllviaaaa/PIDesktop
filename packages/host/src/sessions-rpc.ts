/**
 * The `session.*`, `model.set` and `model.setEffort` methods (ADR 0002, 0008),
 * and the per-connection `session/event` and `session/delta` notifications
 * that `session.subscribe` starts.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { AgentBusyError, NoModelError } from "@pid/agent";
import type { Effort, UserContent } from "@pid/llm";
import {
  ErrorCode,
  type AgentStatusInfo,
  type AppendResult,
  type ModelChoice,
  type PromptContent,
  type SessionDeltaNotification,
  type SessionExportResult,
  type SessionEventNotification,
  type SessionGetResult,
  type SessionListResult,
  type SessionPromptResult,
  type SessionResult,
  type SessionSubscribeResult,
} from "@pid/protocol";
import { sessionMarkdown, settledSeq, type Session } from "@pid/session";
import { RpcError, type RpcCall } from "./rpc.ts";

export const name = "pid-sessions-rpc";
export const inject = ["rpc", "sessions", "agents", "llm"];

export interface Config {
  /** The model a new session gets when `session.create` names none; a function is asked each time. */
  defaultModel?: ModelChoice | (() => ModelChoice | undefined);
}

const EFFORTS: readonly Effort[] = ["off", "low", "medium", "high"];

type Params = Record<string, unknown>;

function params(value: unknown): Params {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
  return value as Params;
}

function str(p: Params, key: string): string {
  const value = p[key];
  if (typeof value !== "string" || value === "") throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-empty string`);
  return value;
}

function optionalSeq(p: Params, key: string): number | undefined {
  const value = p[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-negative integer`);
  return value as number;
}

function effortOf(value: unknown): Effort {
  if (!EFFORTS.includes(value as Effort)) throw new RpcError(ErrorCode.InvalidParams, `effort must be one of ${EFFORTS.join(", ")}`);
  return value as Effort;
}

/** Validate prompt content; a string becomes one text block. */
export function toUserContent(value: unknown): UserContent[] {
  const content = (typeof value === "string" ? [{ type: "text", text: value }] : value) as PromptContent;
  if (!Array.isArray(content) || content.length === 0) throw new RpcError(ErrorCode.InvalidParams, "content must be a string or a non-empty list of blocks");
  return content.map((block, index): UserContent => {
    if (block?.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
    if (block?.type === "image" && typeof block.mimeType === "string" && typeof block.data === "string") {
      return { type: "image", mimeType: block.mimeType, data: block.data };
    }
    throw new RpcError(ErrorCode.InvalidParams, `content[${index}] must be a text or image block`);
  });
}

/** Run `fn`, mapping the agent's errors to protocol errors. */
async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AgentBusyError) throw new RpcError(ErrorCode.SessionBusy, error.message);
    if (error instanceof NoModelError) throw new RpcError(ErrorCode.InvalidParams, error.message);
    throw error;
  }
}

interface Subscriber {
  notify: RpcCall["notify"];
}

export function apply(ctx: Context, config: Config = {}): void {
  /** sessionId → subscribers; a connection is identified by its close signal. */
  const subscribers = new Map<string, Map<AbortSignal, Subscriber>>();

  ctx.on("session/event", (session, event) => {
    const notification: SessionEventNotification = { sessionId: session.id, seq: event.seq, event };
    for (const subscriber of subscribers.get(session.id)?.values() ?? []) subscriber.notify("session/event", notification);
  });
  ctx.on("session/delta", (session, liveSeq, delta) => {
    const notification: SessionDeltaNotification = { sessionId: session.id, liveSeq, delta };
    for (const subscriber of subscribers.get(session.id)?.values() ?? []) subscriber.notify("session/delta", notification);
  });

  const unsubscribe = (sessionId: string, signal: AbortSignal) => {
    const forSession = subscribers.get(sessionId);
    forSession?.delete(signal);
    if (forSession?.size === 0) subscribers.delete(sessionId);
  };

  const session = async (p: Params): Promise<Session> => {
    const id = str(p, "sessionId");
    const found = await ctx.sessions.get(id);
    if (found === undefined) throw new RpcError(ErrorCode.SessionNotFound, `No session ${id}`);
    return found;
  };

  const idle = (target: Session) => {
    if (ctx.agents.status(target.id).running) throw new RpcError(ErrorCode.SessionBusy, `Session ${target.id} is running`);
  };

  const model = (p: Params): ModelChoice => {
    const choice = { provider: str(p, "provider"), model: str(p, "model") };
    if (!ctx.llm.listProviders().some((provider) => provider.id === choice.provider)) {
      throw new RpcError(ErrorCode.InvalidParams, `Unknown provider ${choice.provider}`);
    }
    return choice;
  };

  const status = (id: string): AgentStatusInfo => ctx.agents.status(id);

  const methods: Record<string, (p: Params, call: RpcCall) => unknown> = {
    "session.create": (p): SessionResult => {
      const cwd = str(p, "cwd");
      if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
        throw new RpcError(ErrorCode.InvalidParams, "cwd must be the absolute path of an existing directory");
      }
      const fallback = config.defaultModel;
      const chosen = p.model === undefined ? (typeof fallback === "function" ? fallback() : fallback) : model(params(p.model));
      const created = ctx.sessions.create({ cwd });
      if (chosen !== undefined) created.append("model", chosen);
      if (p.effort !== undefined) created.append("effort", { effort: effortOf(p.effort) });
      return { session: created.summary() };
    },

    "session.list": async (): Promise<SessionListResult> => ({ sessions: await ctx.sessions.list() }),

    "session.get": async (p): Promise<SessionGetResult> => {
      const target = await session(p);
      const state = target.state();
      return {
        session: target.summary(),
        ...(state.model === undefined ? {} : { model: state.model }),
        ...(state.effort === undefined ? {} : { effort: state.effort }),
        status: status(target.id),
      };
    },

    "session.subscribe": async (p, call): Promise<SessionSubscribeResult> => {
      const target = await session(p);
      const afterSeq = optionalSeq(p, "afterSeq") ?? 0;
      let forSession = subscribers.get(target.id);
      if (forSession === undefined) {
        forSession = new Map();
        subscribers.set(target.id, forSession);
      }
      if (!forSession.has(call.signal)) {
        forSession.set(call.signal, { notify: call.notify });
        call.signal.addEventListener("abort", () => unsubscribe(target.id, call.signal), { once: true });
      }
      return {
        events: target.events.filter((event) => event.seq > afterSeq),
        status: status(target.id),
        liveSeq: target.currentLiveSeq,
      };
    },

    "session.unsubscribe": (p, call) => {
      unsubscribe(str(p, "sessionId"), call.signal);
      return {};
    },

    "session.prompt": async (p): Promise<SessionPromptResult> => {
      const target = await session(p);
      const content = toUserContent(p.content);
      return { seq: (await guarded(() => ctx.agents.prompt(target, content))).seq };
    },

    "session.steer": async (p): Promise<SessionPromptResult> => {
      const target = await session(p);
      const content = toUserContent(p.content);
      const event = await guarded(() => ctx.agents.steer(target, content));
      return event === undefined ? {} : { seq: event.seq };
    },

    "session.followUp": async (p): Promise<SessionPromptResult> => {
      const target = await session(p);
      const content = toUserContent(p.content);
      const event = await guarded(() => ctx.agents.followUp(target, content));
      return event === undefined ? {} : { seq: event.seq };
    },

    "session.abort": async (p) => {
      const target = await session(p);
      await ctx.agents.abort(target.id);
      return {};
    },

    "session.fork": async (p): Promise<SessionResult> => {
      const source = await session(p);
      const seq = optionalSeq(p, "seq") ?? source.lastSeq;
      if (seq > source.lastSeq) throw new RpcError(ErrorCode.InvalidParams, `seq ${seq} is past the end (${source.lastSeq})`);
      // A side chat may start while its source runs: it copies up to the last settled point.
      if (p.side === true) return { session: ctx.sessions.fork(source, settledSeq(source.events, seq), { side: true }).summary() };
      return { session: ctx.sessions.fork(source, seq).summary() };
    },

    "session.rewind": async (p): Promise<AppendResult> => {
      const target = await session(p);
      idle(target);
      const toSeq = optionalSeq(p, "toSeq");
      if (toSeq === undefined || toSeq > target.lastSeq) throw new RpcError(ErrorCode.InvalidParams, "toSeq must be a seq of this session");
      const reason = typeof p.reason === "string" ? p.reason : undefined;
      return { seq: target.append("rewind", reason === undefined ? { toSeq } : { toSeq, reason }).seq };
    },

    "session.compact": async (p, call): Promise<Partial<AppendResult>> => {
      const target = await session(p);
      const event = await guarded(() => ctx.agents.compact(target, call.signal));
      return event === undefined ? {} : { seq: event.seq };
    },

    "session.rename": async (p): Promise<AppendResult> => {
      const target = await session(p);
      return { seq: target.append("label", { title: str(p, "title") }).seq };
    },

    "session.archive": async (p): Promise<AppendResult> => {
      const target = await session(p);
      return { seq: target.append("label", { archived: p.archived !== false }).seq };
    },

    "session.delete": async (p) => {
      const target = await session(p);
      idle(target);
      await ctx.sessions.delete(target.id);
      subscribers.delete(target.id);
      return {};
    },

    "session.export": async (p): Promise<SessionExportResult> => {
      const target = await session(p);
      const destination = str(p, "destination");
      if (!isAbsolute(destination)) throw new RpcError(ErrorCode.InvalidParams, "destination must be an absolute path");
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, sessionMarkdown(target.events));
      return { path: destination };
    },

    "model.set": async (p): Promise<AppendResult> => {
      const target = await session(p);
      return { seq: target.append("model", model(p)).seq };
    },

    "model.setEffort": async (p): Promise<AppendResult> => {
      const target = await session(p);
      return { seq: target.append("effort", { effort: effortOf(p.effort) }).seq };
    },
  };

  for (const [method, handler] of Object.entries(methods)) {
    ctx.effect(() => ctx.rpc.method(method, (raw, call) => handler(params(raw ?? {}), call)), `${name}: ${method}`);
  }
}
