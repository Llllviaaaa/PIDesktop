/**
 * Host entry for `session-usage` (`会话用量与上下文统计`).
 *
 * Captures real-time per-turn LLM telemetry (TTFT, generation TPS, active turn
 * duration, and exact system/tool schema token breakdown) via non-invasive
 * Cordis middleware (`llm/request`, `agent/before-start`, `agent/turn-start`,
 * `agent/turn-end`, `agent/settled`), persists compact per-turn telemetry in
 * append-only `custom` session events (`ns: "qianji-session-usage"`), and
 * exposes `sessionUsage.inspect` + `/usage`.
 */
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/agent";
import "@qianji/commands";
import type { Message, ModelInfo, ModelPricing, StreamChunk, ToolSchema, Usage } from "@qianji/llm";
import { estimateUsageCost, normalizePricingModelId } from "@qianji/pricing";
import "@qianji/rpc";
import { currentBranch, type ModelRef, type Session, type SessionEvent, type SessionSummary } from "@qianji/session";
import "@qianji/system-prompt";
import "@qianji/tools";

export const name = "session-usage";
export const inject = ["commands", "sessions", "agents", "llm", "tools", "systemPrompt", "rpc"];

export const USAGE_NAMESPACE = "qianji-session-usage";

export interface SessionUsageHostConfig {
  currency?: "CNY" | "USD";
  usdToCnyRate?: number;
  showCostInToolbar?: boolean;
  triggerMode?: "hover" | "click";
}

export interface TurnTelemetryRecord {
  v: 1;
  callUid: string;
  turn: number;
  userSeq?: number;
  assistantSeq?: number;
  turnDurationMs: number;
  llmCallDurationMs?: number;
  ttftMs?: number;
  genDurationMs?: number;
  outputTokens?: number;
}

export interface SessionUsageInspectResult {
  hasSession: boolean;
  sessionId: string | null;
  model: ModelRef | null;
  context: {
    usedTokens: number;
    contextWindow: number;
    percent: number;
    systemTokens: number;
    toolTokens: number;
    messageTokens: number;
  };
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
  };
  telemetry: {
    turnCount: number;
    activeDurationMs: number;
    isRunning: boolean;
    activeTurnStartedAt: number | null;
    avgTtftMs: number | null;
    outputTps: number | null;
    cacheHitPercent: number | null;
    costUsd: number;
    subagentCostUsd: number;
    totalCostUsd: number;
    subagentCount: number;
  };
}

interface ActiveCallState {
  callUid: string;
  startedAt: number;
  firstTokenAt?: number;
  finishedAt?: number;
  outputTokens: number;
  systemTokens: number;
  toolTokens: number;
}

interface ActiveRunState {
  runStartedAt: number;
  turnStartedAt?: number;
  currentTurnUserSeq?: number;
  currentCall?: ActiveCallState;
}

/** Supplemental USD-per-1M rates for coding models beyond `@qianji/pricing` defaults. */
const SUPPLEMENTAL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "kimi-k3-1-pro": { input: 0.8, output: 3.2, cacheRead: 0.16 },
  "kimi-k3-pro": { input: 0.8, output: 3.2, cacheRead: 0.16 },
  "kimi-k3": { input: 0.6, output: 2.5, cacheRead: 0.15 },
  "kimi-k2-5": { input: 0.6, output: 2.5, cacheRead: 0.15 },
  "kimi-k2-turbo": { input: 0.6, output: 2.5, cacheRead: 0.15 },
  "moonshot-v1-128k": { input: 0.8, output: 2.4, cacheRead: 0.16 },
  "qwen-max": { input: 1.6, output: 6.4, cacheRead: 0.32 },
  "qwen-plus": { input: 0.4, output: 1.2, cacheRead: 0.08 },
  "qwen3-max": { input: 1.2, output: 4.8, cacheRead: 0.24 },
  "qwen3-235b": { input: 0.7, output: 2.8, cacheRead: 0.14 },
  "glm-5": { input: 0.7, output: 2.8, cacheRead: 0.14 },
  "glm-4-plus": { input: 0.7, output: 2.8, cacheRead: 0.14 },
  "minimax-m2": { input: 0.5, output: 2.0, cacheRead: 0.1 },
  "doubao-seed": { input: 0.4, output: 1.6, cacheRead: 0.08 },
};

const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

/** Fast, deterministic BPE token approximation (~0.85 tok/CJK char, ~1 tok/3.8 ASCII chars). */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(CJK_CHAR_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = Math.max(0, text.length - cjkCount);
  return Math.max(1, Math.ceil(cjkCount * 0.85 + otherCount / 3.8));
}

export function estimateToolsTokens(tools: readonly ToolSchema[]): number {
  if (tools.length === 0) return 0;
  let total = 16;
  for (const tool of tools) {
    total +=
      12
      + estimateTextTokens(tool.name)
      + estimateTextTokens(tool.description)
      + estimateTextTokens(JSON.stringify(tool.parameters ?? {}));
  }
  return total;
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  if (messages.length === 0) return 0;
  let total = 0;
  for (const message of messages) {
    total += 4;
    for (const block of message.content) {
      if (block.type === "text") {
        total += estimateTextTokens(block.text);
      } else if (block.type === "thinking") {
        if (block.signature !== undefined && block.text) {
          total += estimateTextTokens(block.text);
        } else if (block.redacted !== undefined) {
          total += Math.ceil(block.redacted.length / 6);
        }
      } else if (block.type === "tool-call") {
        total += 10 + estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.arguments ?? {}));
      } else if (block.type === "image") {
        total += 768;
      }
    }
  }
  return total;
}

function estimateSingleAssistantReplyTokens(event: Extract<SessionEvent, { type: "assistant" }>): number {
  let total = 4;
  for (const block of event.data.content) {
    if (block.type === "text") total += estimateTextTokens(block.text);
    else if (block.type === "tool-call") {
      total += 10 + estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.arguments ?? {}));
    } else if (block.type === "thinking" && block.signature !== undefined && block.text) {
      total += estimateTextTokens(block.text);
    }
  }
  return total;
}

function estimateEventContentTokens(event: SessionEvent): number {
  if (event.type === "assistant") return estimateSingleAssistantReplyTokens(event);
  if (event.type === "user" || event.type === "tool-result") {
    let total = 4;
    for (const block of event.data.content) {
      if (block.type === "text") total += estimateTextTokens(block.text);
      else if (block.type === "image") total += 768;
    }
    return total;
  }
  return 0;
}

export function inferContextWindow(modelId: string | undefined): number {
  if (!modelId) return 128_000;
  const lower = modelId.trim().toLowerCase();
  if (/(?:^|[-_/:.])1m(?:$|[-_/:.])|1000k/.test(lower)) return 1_000_000;
  if (/^gemini-(?:1\.5|2\.5|2-5|3)/.test(lower) || /gemini-(?:1\.5|2\.5|2-5|3)/.test(lower)) return 1_000_000;
  if (/gpt-4[.-]1/.test(lower)) return 1_000_000;
  if (/qwen3-coder-plus/.test(lower)) return 1_000_000;
  if (/gpt-5/.test(lower)) return 400_000;
  if (/claude-/.test(lower)) return 200_000;
  if (/(?:^|\/)(?:o1|o3|o4)(?:$|[-_])/.test(lower)) return 200_000;
  if (/kimi-k[23]/.test(lower)) return 256_000;
  if (/256k/.test(lower)) return 256_000;
  if (/200k/.test(lower)) return 200_000;
  if (/64k/.test(lower)) return 64_000;
  if (/32k/.test(lower)) return 32_000;
  return 128_000;
}

function lookupSupplementalPricing(modelId: string): ModelPricing | undefined {
  const key = normalizePricingModelId(modelId);
  if (!key) return undefined;
  const exact = SUPPLEMENTAL_PRICING[key];
  if (exact !== undefined) return exact;
  let bestKey = "";
  let bestPrice: ModelPricing | undefined;
  for (const [candidate, price] of Object.entries(SUPPLEMENTAL_PRICING)) {
    if (candidate.length > bestKey.length && (key === candidate || key.startsWith(`${candidate}-`))) {
      bestKey = candidate;
      bestPrice = price;
    }
  }
  return bestPrice;
}

function estimateSessionCostWithFallback(ctx: Context, summary: SessionSummary): number {
  const pricing = ctx.get("pricing");
  if (summary.modelUsage !== undefined && summary.modelUsage.length > 0) {
    let total = 0;
    for (const bucket of summary.modelUsage) {
      const primary = pricing !== undefined ? pricing.estimateCallCost(bucket.provider, bucket.model, bucket.usage) : 0;
      if (primary > 0) {
        total += primary;
      } else {
        total += estimateUsageCost(bucket.usage, lookupSupplementalPricing(bucket.model));
      }
    }
    return total;
  }
  return pricing !== undefined ? pricing.estimateSessionCost(summary) : 0;
}

function isTurnTelemetryRecord(value: unknown): value is TurnTelemetryRecord {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  return rec.v === 1 && typeof rec.callUid === "string" && typeof rec.turnDurationMs === "number";
}

function isContentChunk(chunk: StreamChunk): boolean {
  return (
    chunk.type === "text-delta"
    || chunk.type === "thinking-delta"
    || chunk.type === "thinking-redacted"
    || chunk.type === "tool-call-start"
    || chunk.type === "tool-call-delta"
  );
}

function formatCompactTokensMarkdown(tokens: number): string {
  if (tokens <= 0) return "0";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return Number.isInteger(Math.round(m * 10) / 10) ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return k >= 100 ? `~${Math.round(k)}K` : `~${k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return `~${tokens}`;
}

function formatWindowTokensMarkdown(tokens: number): string {
  if (tokens >= 990_000 && tokens <= 1_060_000) return "1M";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number(m.toFixed(1))}M`;
  }
  if (tokens >= 128_000 && tokens <= 132_000) return "128K";
  if (tokens >= 256_000 && tokens <= 263_000) return "256K";
  return `${Math.round(tokens / 1_000)}K`;
}

function formatDurationChinese(ms: number): string {
  if (ms <= 0) return "—";
  const totalSec = ms / 1_000;
  if (totalSec < 60) {
    return totalSec < 10 ? `${totalSec.toFixed(1)}秒` : `${Math.round(totalSec)}秒`;
  }
  const mins = Math.floor(totalSec / 60);
  const secs = Math.round(totalSec % 60);
  return `${mins}分${secs}秒`;
}

function formatCostValue(costUsd: number, currency: "CNY" | "USD", rate: number): string {
  const symbol = currency === "CNY" ? "¥" : "$";
  const val = currency === "CNY" ? costUsd * rate : costUsd;
  if (val <= 0) return `${symbol}0.00`;
  if (val >= 10) return `${symbol}${val.toFixed(1)}`;
  if (val >= 0.1) return `${symbol}${val.toFixed(2)}`;
  if (val >= 0.001) return `${symbol}${val.toFixed(3)}`;
  return `<${symbol}0.001`;
}

export function apply(ctx: Context, rawConfig: SessionUsageHostConfig = {}): void {
  const activeRuns = new Map<string, ActiveRunState>();
  const latestPromptBreakdown = new Map<string, { provider: string; model: string; systemTokens: number; toolTokens: number }>();
  const modelCatalogCache = new Map<string, { at: number; models: ModelInfo[] }>();
  let uidCounter = 0;

  const resolveModelInfo = async (provider: string, modelId: string): Promise<ModelInfo | undefined> => {
    const cached = modelCatalogCache.get(provider);
    if (cached !== undefined && Date.now() - cached.at < 60_000) {
      return cached.models.find((item) => item.id === modelId);
    }
    try {
      const models = await ctx.llm.listModels(provider);
      modelCatalogCache.set(provider, { at: Date.now(), models });
      return models.find((item) => item.id === modelId);
    } catch {
      return cached?.models.find((item) => item.id === modelId);
    }
  };

  // 1. Measure TTFT, generation window, output tokens, and exact system/tool tokens per LLM call.
  ctx.on("llm/request", (request, next) => {
    const sessionId = request.sessionId;
    if (!sessionId) return next();

    const systemTokens = request.system ? estimateTextTokens(request.system) : 0;
    const toolTokens = request.tools ? estimateToolsTokens(request.tools) : 0;
    latestPromptBreakdown.set(sessionId, {
      provider: request.provider,
      model: request.model,
      systemTokens,
      toolTokens,
    });

    uidCounter += 1;
    const callState: ActiveCallState = {
      callUid: `${Date.now().toString(36)}-${uidCounter}`,
      startedAt: Date.now(),
      outputTokens: 0,
      systemTokens,
      toolTokens,
    };

    const runState = activeRuns.get(sessionId);
    if (runState !== undefined) {
      runState.currentCall = callState;
    }

    const inner = next();
    return (async function* (): AsyncGenerator<StreamChunk> {
      try {
        for await (const chunk of inner) {
          if (chunk.type === "retry") {
            callState.startedAt = Date.now();
            callState.firstTokenAt = undefined;
            callState.outputTokens = 0;
          } else if (chunk.type === "usage") {
            const out = (chunk.usage as Partial<Usage>).outputTokens;
            if (typeof out === "number" && out >= 0) {
              callState.outputTokens = out;
            }
          } else if (isContentChunk(chunk) && callState.firstTokenAt === undefined) {
            callState.firstTokenAt = Date.now();
          }
          yield chunk;
        }
      } finally {
        callState.finishedAt = Date.now();
      }
    })();
  });

  // 2. Track active turn boundaries and persist per-turn telemetry records.
  ctx.on("agent/before-start", (session) => {
    activeRuns.set(session.id, { runStartedAt: Date.now() });
  });

  ctx.on("agent/turn-start", (session) => {
    const now = Date.now();
    let run = activeRuns.get(session.id);
    if (run === undefined) {
      run = { runStartedAt: now };
      activeRuns.set(session.id, run);
    }
    run.turnStartedAt = now;
    const lastUser = session.events.findLast((ev) => ev.type === "user");
    run.currentTurnUserSeq = lastUser?.seq;
    run.currentCall = undefined;
  });

  ctx.on("agent/turn-end", (session, turn) => {
    const now = Date.now();
    const run = activeRuns.get(session.id);
    if (run === undefined) return;

    const turnStarted = run.turnStartedAt ?? run.runStartedAt;
    const turnDurationMs = Math.max(1, now - turnStarted);
    const call = run.currentCall;
    const lastAssistant = session.events.findLast((ev) => ev.type === "assistant");

    uidCounter += 1;
    const callUid = call?.callUid ?? `${now.toString(36)}-${uidCounter}`;
    const ttftMs = call?.firstTokenAt !== undefined
      ? Math.max(1, call.firstTokenAt - call.startedAt)
      : undefined;
    const callFinishedAt = call?.finishedAt ?? now;
    const llmCallDurationMs = call !== undefined ? Math.max(1, callFinishedAt - call.startedAt) : undefined;
    const genDurationMs = call !== undefined
      ? Math.max(1, callFinishedAt - (call.firstTokenAt ?? call.startedAt))
      : undefined;
    const outputTokens = lastAssistant?.type === "assistant"
      ? lastAssistant.data.usage.outputTokens
      : call?.outputTokens;

    const record: TurnTelemetryRecord = {
      v: 1,
      callUid,
      turn,
      ...(run.currentTurnUserSeq === undefined ? {} : { userSeq: run.currentTurnUserSeq }),
      ...(lastAssistant === undefined ? {} : { assistantSeq: lastAssistant.seq }),
      turnDurationMs,
      ...(llmCallDurationMs === undefined ? {} : { llmCallDurationMs }),
      ...(ttftMs === undefined ? {} : { ttftMs }),
      ...(genDurationMs === undefined ? {} : { genDurationMs }),
      ...(typeof outputTokens === "number" && outputTokens > 0 ? { outputTokens } : {}),
    };

    session.append("custom", { ns: USAGE_NAMESPACE, data: record });
    run.turnStartedAt = undefined;
    run.currentCall = undefined;
  });

  ctx.on("agent/settled", async (session) => {
    activeRuns.delete(session.id);
  });

  const inspectUsage = async (params: {
    sessionId?: string;
    cwd?: string;
    provider?: string;
    model?: string;
    contextWindowHint?: number;
  }): Promise<SessionUsageInspectResult> => {
    const sessionId = typeof params.sessionId === "string" && params.sessionId.trim() !== ""
      ? params.sessionId.trim()
      : undefined;
    const targetSession: Session | undefined = sessionId !== undefined
      ? await ctx.sessions.get(sessionId)
      : undefined;

    const sessionState = targetSession?.state();
    const resolvedModel: ModelRef | null = sessionState?.model
      ?? (params.provider && params.model ? { provider: params.provider, model: params.model } : null);
    const effectiveCwd = targetSession?.header.cwd ?? params.cwd ?? process.cwd();

    // Context window capacity
    let contextWindow = 0;
    if (resolvedModel !== null) {
      const discovered = await resolveModelInfo(resolvedModel.provider, resolvedModel.model);
      if (discovered?.contextWindow && discovered.contextWindow > 0) {
        contextWindow = discovered.contextWindow;
      }
    }
    if (contextWindow <= 0 && typeof params.contextWindowHint === "number" && params.contextWindowHint > 0) {
      contextWindow = params.contextWindowHint;
    }
    if (contextWindow <= 0) {
      contextWindow = inferContextWindow(resolvedModel?.model);
    }

    // System prompt & Tool definitions token breakdown
    const effectiveSessionKey = targetSession?.id ?? "";
    const tools = ctx.tools.schemas(effectiveSessionKey);
    let toolTokens = estimateToolsTokens(tools);
    let systemTokens = 0;

    const cachedPrompt = targetSession ? latestPromptBreakdown.get(targetSession.id) : undefined;
    if (
      cachedPrompt !== undefined
      && resolvedModel !== null
      && cachedPrompt.provider === resolvedModel.provider
      && cachedPrompt.model === resolvedModel.model
    ) {
      systemTokens = cachedPrompt.systemTokens;
      toolTokens = cachedPrompt.toolTokens;
    } else if (resolvedModel !== null) {
      try {
        const systemText = await ctx.systemPrompt.build({
          sessionId: effectiveSessionKey,
          cwd: effectiveCwd,
          model: resolvedModel,
          tools,
        });
        systemTokens = estimateTextTokens(systemText);
      } catch {
        systemTokens = 0;
      }
    }

    if (!targetSession || !sessionState) {
      const usedTokens = systemTokens + toolTokens;
      const percent = contextWindow > 0
        ? Math.min(100, Math.max(0, Math.round((usedTokens / contextWindow) * 100)))
        : 0;
      return {
        hasSession: false,
        sessionId: null,
        model: resolvedModel,
        context: {
          usedTokens,
          contextWindow,
          percent,
          systemTokens,
          toolTokens,
          messageTokens: 0,
        },
        tokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
        telemetry: {
          turnCount: 0,
          activeDurationMs: 0,
          isRunning: false,
          activeTurnStartedAt: null,
          avgTtftMs: null,
          outputTps: null,
          cacheHitPercent: null,
          costUsd: 0,
          subagentCostUsd: 0,
          totalCostUsd: 0,
          subagentCount: 0,
        },
      };
    }

    // Calibrate active branch context usage
    const branch = currentBranch(targetSession.events);
    const compactedSeq = sessionState.compactedThrough ?? 0;
    const activeBranchAfterCompaction = branch.filter((ev) => ev.seq > compactedSeq);
    const lastAssistantIdx = activeBranchAfterCompaction.findLastIndex(
      (ev) =>
        ev.type === "assistant"
        && (ev.data.usage.inputTokens + ev.data.usage.cacheReadTokens + ev.data.usage.cacheWriteTokens) > 0,
    );

    const estimatedMsgTokens = estimateMessagesTokens(sessionState.messages);
    let messageTokens = estimatedMsgTokens;
    let usedTokens = systemTokens + toolTokens + messageTokens;

    if (lastAssistantIdx >= 0) {
      const lastAssistant = activeBranchAfterCompaction[lastAssistantIdx];
      if (lastAssistant && lastAssistant.type === "assistant") {
        const u = lastAssistant.data.usage;
        const reportedPromptTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
        let postAssistantTokens = estimateSingleAssistantReplyTokens(lastAssistant);
        for (let i = lastAssistantIdx + 1; i < activeBranchAfterCompaction.length; i += 1) {
          const ev = activeBranchAfterCompaction[i];
          if (ev) postAssistantTokens += estimateEventContentTokens(ev);
        }
        const calibratedTotal = reportedPromptTokens + postAssistantTokens;
        const baseOverhead = systemTokens + toolTokens;
        if (calibratedTotal >= baseOverhead) {
          usedTokens = calibratedTotal;
          messageTokens = calibratedTotal - baseOverhead;
        } else if (calibratedTotal > 0 && baseOverhead > 0) {
          // Small mock/synthetic responses where reported prompt is smaller than estimated overhead:
          // preserve calibrated total and scale components proportionally so sum === usedTokens.
          usedTokens = calibratedTotal;
          const totalEst = baseOverhead + Math.max(1, estimatedMsgTokens);
          systemTokens = Math.round((systemTokens / totalEst) * calibratedTotal);
          toolTokens = Math.round((toolTokens / totalEst) * calibratedTotal);
          messageTokens = Math.max(0, calibratedTotal - systemTokens - toolTokens);
        }
      }
    }

    const percent = contextWindow > 0
      ? Math.min(100, Math.max(0, Math.round((usedTokens / contextWindow) * 100)))
      : 0;

    // Cumulative session usage & cost + subagents
    const summary = targetSession.summary();
    const costUsd = estimateSessionCostWithFallback(ctx, summary);

    let subagentCostUsd = 0;
    let subagentCount = 0;
    try {
      const allSessions = await ctx.sessions.list();
      for (const item of allSessions) {
        if (item.parent?.sessionId === targetSession.id) {
          subagentCount += 1;
          subagentCostUsd += estimateSessionCostWithFallback(ctx, item);
        }
      }
    } catch {
      // Ignore transient list errors.
    }
    const totalCostUsd = costUsd + subagentCostUsd;

    const totalPromptTokens =
      summary.usage.inputTokens
      + summary.usage.cacheReadTokens
      + summary.usage.cacheWriteTokens;
    const cacheHitPercent = totalPromptTokens > 0
      ? Math.min(100, Math.max(0, Math.round((summary.usage.cacheReadTokens / totalPromptTokens) * 100)))
      : null;

    // Aggregate persisted per-turn telemetry + fallback historical spans
    const seenCallUids = new Set<string>();
    const recordedUserSeqs = new Set<number>();
    let activeDurationMs = 0;
    let ttftSumMs = 0;
    let ttftCount = 0;
    let timedOutputTokens = 0;
    let timedGenDurationMs = 0;
    let assistantTurnCount = 0;

    for (const ev of targetSession.events) {
      if (ev.type === "assistant") {
        assistantTurnCount += 1;
      } else if (ev.type === "custom" && ev.data.ns === USAGE_NAMESPACE && isTurnTelemetryRecord(ev.data.data)) {
        const rec = ev.data.data;
        if (seenCallUids.has(rec.callUid)) continue;
        seenCallUids.add(rec.callUid);
        if (rec.userSeq !== undefined) recordedUserSeqs.add(rec.userSeq);
        activeDurationMs += Math.max(0, rec.turnDurationMs);
        if (typeof rec.ttftMs === "number" && rec.ttftMs > 0) {
          ttftSumMs += rec.ttftMs;
          ttftCount += 1;
        }
        if (
          typeof rec.outputTokens === "number"
          && rec.outputTokens > 0
          && typeof rec.genDurationMs === "number"
          && rec.genDurationMs > 0
        ) {
          timedOutputTokens += rec.outputTokens;
          timedGenDurationMs += rec.genDurationMs;
        }
      }
    }

    // Fallback active duration from event timestamps for historical turns predating this plugin
    const liveRun = activeRuns.get(targetSession.id);
    let spanUserSeq: number | undefined;
    let spanStartMs: number | undefined;
    let spanEndMs: number | undefined;
    const flushHistoricalSpan = () => {
      if (
        spanUserSeq !== undefined
        && !recordedUserSeqs.has(spanUserSeq)
        && spanUserSeq !== liveRun?.currentTurnUserSeq
        && spanStartMs !== undefined
        && spanEndMs !== undefined
        && spanEndMs > spanStartMs
      ) {
        activeDurationMs += spanEndMs - spanStartMs;
      }
      spanUserSeq = undefined;
      spanStartMs = undefined;
      spanEndMs = undefined;
    };

    for (const ev of targetSession.events) {
      if (ev.type === "user") {
        flushHistoricalSpan();
        const parsed = Date.parse(ev.ts);
        if (Number.isFinite(parsed)) {
          spanUserSeq = ev.seq;
          spanStartMs = parsed;
        }
      } else if (ev.type === "assistant" || ev.type === "tool-result") {
        const parsed = Date.parse(ev.ts);
        if (Number.isFinite(parsed)) {
          spanEndMs = parsed;
        }
      }
    }
    flushHistoricalSpan();

    // Include live in-flight TTFT if the current LLM stream already received its first token
    if (liveRun?.currentCall?.firstTokenAt !== undefined) {
      ttftSumMs += Math.max(1, liveRun.currentCall.firstTokenAt - liveRun.currentCall.startedAt);
      ttftCount += 1;
    }

    const isRunning = ctx.agents.status(targetSession.id).running || liveRun !== undefined;
    const activeTurnStartedAt = isRunning
      ? (liveRun?.turnStartedAt ?? liveRun?.runStartedAt ?? null)
      : null;

    const avgTtftMs = ttftCount > 0 ? Math.round(ttftSumMs / ttftCount) : null;
    const outputTps = timedGenDurationMs > 0 && timedOutputTokens > 0
      ? Math.round((timedOutputTokens / (timedGenDurationMs / 1_000)) * 10) / 10
      : null;

    return {
      hasSession: true,
      sessionId: targetSession.id,
      model: resolvedModel,
      context: {
        usedTokens,
        contextWindow,
        percent,
        systemTokens,
        toolTokens,
        messageTokens,
      },
      tokens: {
        inputTokens: summary.usage.inputTokens,
        outputTokens: summary.usage.outputTokens,
        cacheReadTokens: summary.usage.cacheReadTokens,
        cacheWriteTokens: summary.usage.cacheWriteTokens,
        reasoningTokens: summary.usage.reasoningTokens ?? 0,
      },
      telemetry: {
        turnCount: assistantTurnCount,
        activeDurationMs,
        isRunning,
        activeTurnStartedAt,
        avgTtftMs,
        outputTps,
        cacheHitPercent,
        costUsd,
        subagentCostUsd,
        totalCostUsd,
        subagentCount,
      },
    };
  };

  ctx.effect(
    () =>
      ctx.rpc.method("sessionUsage.inspect", async (rawParams) => {
        const p = (typeof rawParams === "object" && rawParams !== null ? rawParams : {}) as Record<string, unknown>;
        return inspectUsage({
          ...(typeof p.sessionId === "string" ? { sessionId: p.sessionId } : {}),
          ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
          ...(typeof p.provider === "string" ? { provider: p.provider } : {}),
          ...(typeof p.model === "string" ? { model: p.model } : {}),
          ...(typeof p.contextWindowHint === "number" ? { contextWindowHint: p.contextWindowHint } : {}),
        });
      }),
    "session-usage: sessionUsage.inspect",
  );

  const executeUsageCommand: Parameters<typeof ctx.commands.register>[0]["execute"] = async (_rawArgs, env) => {
    const currency: "CNY" | "USD" = rawConfig.currency === "USD" ? "USD" : "CNY";
    const rate = typeof rawConfig.usdToCnyRate === "number" && rawConfig.usdToCnyRate > 0
      ? rawConfig.usdToCnyRate
      : 7.25;
    const snap = await inspectUsage({
      ...(env.sessionId ? { sessionId: env.sessionId } : {}),
      cwd: env.cwd,
    });
    const liveExtra = snap.telemetry.activeTurnStartedAt !== null
      ? Math.max(0, Date.now() - snap.telemetry.activeTurnStartedAt)
      : 0;
    const durationStr = formatDurationChinese(snap.telemetry.activeDurationMs + liveExtra);
    const ttftStr = snap.telemetry.avgTtftMs !== null
      ? `${(snap.telemetry.avgTtftMs / 1_000).toFixed(1)}秒`
      : "—";
    const tpsStr = snap.telemetry.outputTps !== null
      ? `${snap.telemetry.outputTps >= 10 ? Math.round(snap.telemetry.outputTps) : snap.telemetry.outputTps.toFixed(1)} tok/s`
      : "—";
    const costStr = formatCostValue(snap.telemetry.costUsd, currency, rate);
    const totalCostStr = formatCostValue(snap.telemetry.totalCostUsd, currency, rate);
    const cacheStr = snap.telemetry.cacheHitPercent !== null ? `${snap.telemetry.cacheHitPercent}%` : "—";

    const lines = [
      `### 会话用量与上下文统计`,
      ``,
      `- **上下文已用**：**${snap.context.percent}%**（${formatCompactTokensMarkdown(snap.context.usedTokens)} / ${formatWindowTokensMarkdown(snap.context.contextWindow)}）`,
      `  - 系统提示词：\`${formatCompactTokensMarkdown(snap.context.systemTokens)}\``,
      `  - 工具定义：\`${formatCompactTokensMarkdown(snap.context.toolTokens)}\``,
      `  - 对话消息：\`${formatCompactTokensMarkdown(snap.context.messageTokens)}\``,
      `- **总用时**：${durationStr}`,
      `- **首 token 平均 (TTFT)**：${ttftStr}`,
      `- **输出速度 (TPS)**：${tpsStr}`,
      `- **费用**：${costStr}${snap.telemetry.subagentCount > 0 ? `（含 ${snap.telemetry.subagentCount} 个子代理合计 ${totalCostStr}）` : ""}`,
      `- **缓存命中**：${cacheStr}`,
    ];
    return { output: lines.join("\n") };
  };

  ctx.effect(() => {
    const desc = "查看当前会话上下文占比、Token 构成（系统提示词 / 工具 / 对话）、耗时、TTFT、TPS 与费用";
    try {
      return ctx.commands.register({
        name: "usage",
        argsHint: "[print]",
        description: desc,
        source: "plugin",
        execute: executeUsageCommand,
      });
    } catch {
      try {
        return ctx.commands.register({
          name: "session-usage",
          argsHint: "[print]",
          description: desc,
          source: "plugin",
          execute: executeUsageCommand,
        });
      } catch {
        return () => {};
      }
    }
  }, "session-usage: /usage command");
}
