/**
 * Client entry for `session-usage` (`会话用量与上下文统计`).
 *
 * Renders the DSH-style live session & context usage status cluster in the
 * Composer bottom-right toolbar + floating telemetry popover card:
 * - Toolbar left of ModelPicker (`before-model`): Session cumulative cost pill
 *   (e.g. `¥190.2`, including child subagents when present).
 * - Toolbar right of ModelPicker (`after-model`): Circular progress arc + context
 *   window percentage pill (e.g. `[ring] 15%`).
 * - Floating popover card:
 *   1. Context header (`上下文已用 15%` · `~155K / 1M`)
 *   2. 3-segment proportional progress bar + legend (`系统提示词` / `工具定义` / `对话消息`)
 *   3. 2-column telemetry grid (`总用时` live-ticking, `首 token 平均 (TTFT)`,
 *      `输出速度 (TPS)`, `费用` with 1-click `¥`/`$` toggle, `缓存命中`).
 * - `/usage` slash interceptor to pin/toggle the popover card (`print` arg falls
 *   through to the Host command to emit a Markdown summary into chat).
 */
import { useEffect, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  callHostRpc,
  getActiveSessionSnapshot,
  subscribeSessionActivity,
  useActiveSession,
  type SessionStats,
  type WorkbenchSlotContext,
} from "@qianji/client";

export const name = "session-usage-client";
export const inject = ["contributions", "styles"];

export type UsageCurrency = "CNY" | "USD";

export interface SessionUsageClientConfig {
  currency?: UsageCurrency;
  usdToCnyRate?: number;
  showCostInToolbar?: boolean;
  triggerMode?: "hover" | "click";
}

export interface SessionUsageInspectResult {
  hasSession: boolean;
  sessionId: string | null;
  model: { provider: string; model: string } | null;
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

const CURRENCY_OVERRIDE_KEY = "qianji-plugin:session-usage:currency";
const HOVER_LEAVE_DELAY_MS = 180;

interface NormalizedClientConfig {
  currency: UsageCurrency;
  usdToCnyRate: number;
  showCostInToolbar: boolean;
  triggerMode: "hover" | "click";
}

interface SessionUsageStoreState {
  config: NormalizedClientConfig;
  currencyOverride: UsageCurrency | null;
  variant: "task-start" | "follow-up";
  slotCwd: string;
  hovered: boolean;
  pinned: boolean;
  nowMs: number;
  data: SessionUsageInspectResult | null;
  lastFetchedAt: number;
}

function readCurrencyOverride(): UsageCurrency | null {
  try {
    const raw = window.localStorage.getItem(CURRENCY_OVERRIDE_KEY);
    if (raw === "CNY" || raw === "USD") return raw;
    return null;
  } catch {
    return null;
  }
}

function writeCurrencyOverride(next: UsageCurrency | null): void {
  try {
    if (next === null) {
      window.localStorage.removeItem(CURRENCY_OVERRIDE_KEY);
    } else {
      window.localStorage.setItem(CURRENCY_OVERRIDE_KEY, next);
    }
  } catch {
    // Ignore restricted webview storage errors.
  }
}

function normalizeConfig(raw: SessionUsageClientConfig = {}): NormalizedClientConfig {
  const rate = typeof raw.usdToCnyRate === "number" && Number.isFinite(raw.usdToCnyRate) && raw.usdToCnyRate > 0
    ? raw.usdToCnyRate
    : 7.25;
  return {
    currency: raw.currency === "USD" ? "USD" : "CNY",
    usdToCnyRate: rate,
    showCostInToolbar: raw.showCostInToolbar !== false,
    triggerMode: raw.triggerMode === "click" ? "click" : "hover",
  };
}

export function formatApproxTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `~${Number(m.toFixed(1))}M`;
  }
  if (tokens >= 99_950) {
    return `~${Math.round(tokens / 1_000)}K`;
  }
  if (tokens >= 1_000) {
    return `~${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return `~${Math.round(tokens)}`;
}

export function formatContextCapacity(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "128K";
  if (tokens >= 990_000 && tokens <= 1_060_000) return "1M";
  if (tokens >= 1_980_000 && tokens <= 2_120_000) return "2M";
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 128_000 && tokens <= 132_000) return "128K";
  if (tokens >= 196_000 && tokens <= 205_000) return "200K";
  if (tokens >= 256_000 && tokens <= 263_000) return "256K";
  return `${Math.round(tokens / 1_000)}K`;
}

export function formatDuration(ms: number, liveTicking: boolean): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const totalSec = ms / 1_000;
  if (totalSec < 60) {
    if (liveTicking) {
      return `${Math.max(1, Math.floor(totalSec))}秒`;
    }
    return totalSec < 10 ? `${totalSec.toFixed(1)}秒` : `${Math.round(totalSec)}秒`;
  }
  const mins = Math.floor(totalSec / 60);
  const secs = liveTicking ? Math.floor(totalSec % 60) : Math.round(totalSec % 60);
  if (secs === 60) {
    return `${mins + 1}分0秒`;
  }
  return `${mins}分${secs}秒`;
}

export function formatTtft(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 100) return `${Math.max(1, Math.round(ms))}ms`;
  return `${(ms / 1_000).toFixed(1)}秒`;
}

export function formatTps(tps: number | null): string {
  if (tps === null || !Number.isFinite(tps) || tps <= 0) return "—";
  return tps >= 10 ? `${Math.round(tps)} tok/s` : `${tps.toFixed(1)} tok/s`;
}

export function formatCurrencyAmount(costUsd: number, currency: UsageCurrency, usdToCnyRate: number): string {
  const symbol = currency === "CNY" ? "¥" : "$";
  const amount = currency === "CNY" ? costUsd * usdToCnyRate : costUsd;
  if (!Number.isFinite(amount) || amount <= 0) return `${symbol}0.00`;
  if (amount >= 10) return `${symbol}${amount.toFixed(1)}`;
  if (amount >= 0.1) return `${symbol}${amount.toFixed(2)}`;
  if (amount >= 0.001) return `${symbol}${amount.toFixed(3)}`;
  return `<${symbol}0.001`;
}

class SessionUsageUiStore {
  private state: SessionUsageStoreState;
  private readonly listeners = new Set<() => void>();
  private hoverCloseTimer: number | null = null;
  private refreshTimer: number | null = null;
  private tickTimer: number | null = null;
  private fetchSeq = 0;
  private disposed = false;

  constructor(initialConfig: SessionUsageClientConfig) {
    this.state = {
      config: normalizeConfig(initialConfig),
      currencyOverride: readCurrencyOverride(),
      variant: "follow-up",
      slotCwd: "",
      hovered: false,
      pinned: false,
      nowMs: Date.now(),
      data: null,
      lastFetchedAt: 0,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SessionUsageStoreState => this.state;

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  effectiveCurrency(): UsageCurrency {
    return this.state.currencyOverride ?? this.state.config.currency;
  }

  toggleCurrency(): void {
    const current = this.effectiveCurrency();
    const next: UsageCurrency = current === "CNY" ? "USD" : "CNY";
    const nextOverride = next === this.state.config.currency ? null : next;
    writeCurrencyOverride(nextOverride);
    this.state = { ...this.state, currencyOverride: nextOverride };
    this.emit();
  }

  setSlotContext(variant: "task-start" | "follow-up", cwd: string): void {
    if (this.state.variant === variant && this.state.slotCwd === cwd) return;
    this.state = {
      ...this.state,
      variant,
      slotCwd: cwd,
    };
    this.emit();
    this.scheduleRefresh(20);
  }

  onSurfaceEnter = (): void => {
    if (this.hoverCloseTimer !== null) {
      window.clearTimeout(this.hoverCloseTimer);
      this.hoverCloseTimer = null;
    }
    if (this.state.config.triggerMode !== "hover") return;
    if (!this.state.hovered) {
      this.state = { ...this.state, hovered: true, nowMs: Date.now() };
      this.emit();
    }
    if (Date.now() - this.state.lastFetchedAt > 1_500) {
      this.scheduleRefresh(0);
    }
  };

  onSurfaceLeave = (): void => {
    if (this.hoverCloseTimer !== null) {
      window.clearTimeout(this.hoverCloseTimer);
    }
    this.hoverCloseTimer = window.setTimeout(() => {
      this.hoverCloseTimer = null;
      if (this.state.hovered) {
        this.state = { ...this.state, hovered: false };
        this.emit();
      }
    }, HOVER_LEAVE_DELAY_MS);
  };

  togglePinned = (): void => {
    const nextPinned = !this.state.pinned;
    this.state = {
      ...this.state,
      pinned: nextPinned,
      hovered: nextPinned ? this.state.hovered : false,
      nowMs: Date.now(),
    };
    this.emit();
    if (nextPinned) {
      this.scheduleRefresh(0);
    }
  };

  pinOpen = (): void => {
    this.state = {
      ...this.state,
      pinned: true,
      nowMs: Date.now(),
    };
    this.emit();
    this.scheduleRefresh(0);
  };

  closeAll = (): void => {
    if (!this.state.pinned && !this.state.hovered) return;
    this.state = {
      ...this.state,
      pinned: false,
      hovered: false,
    };
    this.emit();
  };

  syncLiveTicker(appStreaming: boolean): void {
    const shouldTick = appStreaming || Boolean(this.state.data?.telemetry.isRunning);
    if (shouldTick && this.tickTimer === null && !this.disposed) {
      this.tickTimer = window.setInterval(() => {
        this.state = { ...this.state, nowMs: Date.now() };
        this.emit();
      }, 1_000);
    } else if (!shouldTick && this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  scheduleRefresh(delayMs = 80): void {
    if (this.disposed) return;
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshNow();
    }, Math.max(0, delayMs));
  }

  async refreshNow(): Promise<void> {
    if (this.disposed) return;
    const seq = ++this.fetchSeq;
    const app = getActiveSessionSnapshot();
    const isTaskStart = this.state.variant === "task-start";
    const effectiveSessionId = isTaskStart ? undefined : (app.sessionId ?? undefined);
    const effectiveCwd = (isTaskStart ? (this.state.slotCwd || app.cwd) : (app.cwd || this.state.slotCwd)) || undefined;
    const model = app.model;

    try {
      const result = await callHostRpc<SessionUsageInspectResult>("sessionUsage.inspect", {
        ...(effectiveSessionId ? { sessionId: effectiveSessionId } : {}),
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        ...(model?.provider ? { provider: model.provider } : {}),
        ...(model?.id ? { model: model.id } : {}),
        ...(typeof model?.contextWindow === "number" && model.contextWindow > 0
          ? { contextWindowHint: model.contextWindow }
          : {}),
      });
      if (this.disposed || seq !== this.fetchSeq) return;
      this.state = {
        ...this.state,
        data: result,
        nowMs: Date.now(),
        lastFetchedAt: Date.now(),
      };
      this.syncLiveTicker(getActiveSessionSnapshot().isStreaming);
      this.emit();
    } catch {
      // Host may still be booting or reconnecting; keep existing snapshot gracefully.
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.hoverCloseTimer !== null) {
      window.clearTimeout(this.hoverCloseTimer);
      this.hoverCloseTimer = null;
    }
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.listeners.clear();
  }
}

const SESSION_USAGE_CSS = `
.composer-plugin-status {
  display: inline-flex;
  align-items: center;
  position: relative;
}

.su-cost-pill {
  height: 26px;
  padding: 0 7px;
  border: 0;
  border-radius: var(--qj-radius-sm, 7px);
  background: transparent;
  color: var(--qj-text-primary, var(--text));
  font-family: var(--qj-font-sans, var(--font-ui));
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}

.su-cost-pill:hover,
.su-cost-pill.active {
  background: var(--qj-bg-hover, rgba(0, 0, 0, 0.055));
}

.su-ring-anchor {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.su-ring-pill {
  height: 26px;
  padding: 0 8px 0 7px;
  border: 0;
  border-radius: 8px;
  background: var(--qj-bg-hover, rgba(15, 23, 42, 0.045));
  color: var(--qj-text-secondary, var(--text-2));
  font-family: var(--qj-font-sans, var(--font-ui));
  font-size: 12px;
  font-weight: 540;
  font-variant-numeric: tabular-nums;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}

.su-ring-pill:hover,
.su-ring-pill.active {
  background: var(--qj-bg-active, rgba(15, 23, 42, 0.085));
  color: var(--qj-text-primary, var(--text));
}

.su-ring-svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  display: block;
}

.su-popover {
  position: absolute;
  bottom: calc(100% + 10px);
  right: 0;
  z-index: 160;
  width: 296px;
  padding: 15px 16px;
  border-radius: 15px;
  border: 1px solid var(--qj-border-default, color-mix(in srgb, var(--qj-text-primary, #111112) 9%, transparent));
  background: var(--qj-bg-surface, #ffffff);
  color: var(--qj-text-primary, var(--text));
  font-family: var(--qj-font-sans, var(--font-ui));
  box-shadow: var(--muse-elevation-popover, 0 14px 40px rgba(15, 23, 42, 0.14), 0 2px 8px rgba(15, 23, 42, 0.05));
  display: flex;
  flex-direction: column;
  gap: 12px;
  text-align: left;
  user-select: none;
  animation: su-popover-in 120ms cubic-bezier(0.16, 1, 0.3, 1);
}

.su-popover.su-popover-down {
  bottom: auto;
  top: calc(100% + 10px);
}

@keyframes su-popover-in {
  from {
    opacity: 0;
    transform: translateY(4px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.su-ctx-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.3;
}

.su-ctx-title {
  color: var(--qj-text-secondary, var(--text-2));
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
}

.su-ctx-title strong {
  color: var(--qj-text-primary, var(--text));
  font-size: 13px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.su-ctx-cap {
  color: var(--qj-text-secondary, var(--text-2));
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}

.su-seg-bar {
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--qj-text-primary, #111112) 8%, transparent);
  overflow: hidden;
  display: flex;
  align-items: stretch;
  gap: 1px;
}

.su-seg-piece {
  height: 100%;
  min-width: 2px;
  transition: width 220ms ease;
}

.su-seg-piece.system {
  background: #94a3b8;
}

.su-seg-piece.tools {
  background: #8b5cf6;
}

.su-seg-piece.messages {
  background: var(--qj-brand-primary, #3b82f6);
}

.su-legend {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.su-legend-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.3;
}

.su-legend-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--qj-text-secondary, var(--text-2));
}

.su-legend-dot {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  flex-shrink: 0;
}

.su-legend-dot.system {
  background: #94a3b8;
}

.su-legend-dot.tools {
  background: #8b5cf6;
}

.su-legend-dot.messages {
  background: var(--qj-brand-primary, #3b82f6);
}

.su-legend-val {
  color: var(--qj-text-primary, var(--text));
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.su-divider {
  height: 1px;
  width: 100%;
  background: var(--qj-border-default, color-mix(in srgb, var(--qj-text-primary, #111112) 8%, transparent));
}

.su-metrics-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  column-gap: 14px;
  row-gap: 11px;
}

.su-metric-cell {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.su-metric-label {
  font-size: 11.5px;
  line-height: 1.25;
  color: var(--qj-text-muted, var(--text-3));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.su-metric-value {
  font-size: 14px;
  line-height: 1.3;
  font-weight: 650;
  color: var(--qj-text-primary, var(--text));
  font-variant-numeric: tabular-nums;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.su-metric-cost-btn {
  padding: 0;
  margin: 0;
  border: 0;
  background: transparent;
  color: var(--qj-text-primary, var(--text));
  font-family: var(--qj-font-sans, var(--font-ui));
  font-size: 14px;
  line-height: 1.3;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  text-align: left;
  cursor: pointer;
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  border-radius: 5px;
  width: fit-content;
  transition: color 120ms ease;
}

.su-metric-cost-btn:hover {
  color: var(--qj-brand-primary, #006ee4);
}

.su-subagent-tag {
  font-size: 11px;
  font-weight: 500;
  color: var(--qj-text-muted, var(--text-3));
}

.su-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--qj-status-success, #10b981);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--qj-status-success, #10b981) 20%, transparent);
  flex-shrink: 0;
}
`;

function resolveDisplayData(
  snapshot: SessionUsageStoreState,
  variant: "task-start" | "follow-up",
  appSessionId: string | null,
  appModelContextWindow: number | undefined,
  appStats: SessionStats | null,
): SessionUsageInspectResult {
  const inspected = snapshot.data;
  const matchesContext = variant === "task-start"
    ? inspected !== null && !inspected.hasSession
    : inspected !== null && (appSessionId === null ? !inspected.hasSession : inspected.sessionId === appSessionId);

  if (matchesContext && inspected !== null) {
    return inspected;
  }

  // Instant zero-latency fallback from active session snapshot while RPC is in-flight
  const contextWindow = (variant === "follow-up" && appStats?.contextUsage?.contextWindow)
    || appModelContextWindow
    || inspected?.context.contextWindow
    || 128_000;
  const usedTokens = variant === "follow-up"
    ? Math.max(0, appStats?.contextUsage?.tokens ?? 0)
    : 0;
  const percent = variant === "follow-up" && typeof appStats?.contextUsage?.percent === "number"
    ? Math.min(100, Math.max(0, Math.round(appStats.contextUsage.percent)))
    : (contextWindow > 0 ? Math.min(100, Math.max(0, Math.round((usedTokens / contextWindow) * 100))) : 0);
  const fallbackCost = variant === "follow-up" ? Math.max(0, appStats?.cost ?? 0) : 0;

  return {
    hasSession: variant === "follow-up" && Boolean(appSessionId),
    sessionId: variant === "follow-up" ? appSessionId : null,
    model: null,
    context: {
      usedTokens,
      contextWindow,
      percent,
      systemTokens: 0,
      toolTokens: 0,
      messageTokens: usedTokens,
    },
    tokens: {
      inputTokens: variant === "follow-up" ? (appStats?.tokens.input ?? 0) : 0,
      outputTokens: variant === "follow-up" ? (appStats?.tokens.output ?? 0) : 0,
      cacheReadTokens: variant === "follow-up" ? (appStats?.tokens.cacheRead ?? 0) : 0,
      cacheWriteTokens: variant === "follow-up" ? (appStats?.tokens.cacheWrite ?? 0) : 0,
      reasoningTokens: variant === "follow-up" ? (appStats?.tokens.reasoning ?? 0) : 0,
    },
    telemetry: {
      turnCount: 0,
      activeDurationMs: 0,
      isRunning: false,
      activeTurnStartedAt: null,
      avgTtftMs: null,
      outputTps: null,
      cacheHitPercent: null,
      costUsd: fallbackCost,
      subagentCostUsd: 0,
      totalCostUsd: fallbackCost,
      subagentCount: 0,
    },
  };
}

function CostToolbarPill({
  store,
  slotContext,
}: {
  store: SessionUsageUiStore;
  slotContext: WorkbenchSlotContext;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const activeSession = useActiveSession();
  const appSessionId = activeSession.sessionId;
  const appModelWindow = activeSession.model?.contextWindow;
  const appStats = activeSession.stats;

  const variant = slotContext.variant ?? "follow-up";
  if (!snapshot.config.showCostInToolbar || variant === "task-start") {
    return null;
  }

  const data = resolveDisplayData(snapshot, variant, appSessionId, appModelWindow, appStats);
  const totalCostUsd = data.telemetry.totalCostUsd;
  if (totalCostUsd <= 0) {
    return null;
  }

  const currency = store.effectiveCurrency();
  const rate = snapshot.config.usdToCnyRate;
  const formattedTotal = formatCurrencyAmount(totalCostUsd, currency, rate);
  const formattedMain = formatCurrencyAmount(data.telemetry.costUsd, currency, rate);
  const isOpen = snapshot.hovered || snapshot.pinned;

  const title = data.telemetry.subagentCount > 0
    ? `会话总费用 ${formattedTotal}（主会话 ${formattedMain} + ${data.telemetry.subagentCount} 个子代理）`
    : `会话累计费用 ${formattedTotal}`;

  return (
    <button
      type="button"
      className={`su-cost-pill${isOpen ? " active" : ""}`}
      data-session-usage-root=""
      data-session-usage-cost=""
      title={title}
      onMouseEnter={store.onSurfaceEnter}
      onMouseLeave={store.onSurfaceLeave}
      onClick={store.togglePinned}
    >
      {formattedTotal}
    </button>
  );
}

function RingAndPopoverStatus({
  store,
  slotContext,
}: {
  store: SessionUsageUiStore;
  slotContext: WorkbenchSlotContext;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const activeSession = useActiveSession();
  const appSessionId = activeSession.sessionId;
  const appModelWindow = activeSession.model?.contextWindow;
  const appStats = activeSession.stats;
  const isStreaming = activeSession.isStreaming;

  const variant = slotContext.variant ?? "follow-up";

  useEffect(() => {
    store.setSlotContext(variant, slotContext.cwd);
  }, [slotContext.cwd, store, variant]);

  const isOpen = snapshot.hovered || snapshot.pinned;

  useEffect(() => {
    if (!isOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target && target.closest("[data-session-usage-root]")) return;
      store.closeAll();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        store.closeAll();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isOpen, store]);

  const data = resolveDisplayData(snapshot, variant, appSessionId, appModelWindow, appStats);
  const { context, telemetry } = data;
  const percent = Math.min(100, Math.max(0, Math.round(context.percent)));
  const ratio = context.contextWindow > 0
    ? Math.min(1, Math.max(0, context.usedTokens / context.contextWindow))
    : percent / 100;

  const radius = 5.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - ratio);
  const ringStroke = percent >= 90 ? "#ef4444" : percent >= 75 ? "#f59e0b" : "#64748b";

  // Segment widths proportional to contextWindow (capped cleanly at 100% total)
  const denom = Math.max(context.contextWindow, context.usedTokens, 1);
  const sysWidthPct = context.systemTokens > 0 ? Math.max(0.6, (context.systemTokens / denom) * 100) : 0;
  const toolWidthPct = context.toolTokens > 0 ? Math.max(0.6, (context.toolTokens / denom) * 100) : 0;
  const msgWidthPct = context.messageTokens > 0 ? Math.max(0.6, (context.messageTokens / denom) * 100) : 0;

  // Live active duration calculation
  const liveTicking = isStreaming || telemetry.isRunning;
  const liveTurnExtraMs = liveTicking && telemetry.activeTurnStartedAt !== null
    ? Math.max(0, snapshot.nowMs - telemetry.activeTurnStartedAt)
    : 0;
  const totalActiveMs = telemetry.activeDurationMs + liveTurnExtraMs;

  const currency = store.effectiveCurrency();
  const rate = snapshot.config.usdToCnyRate;
  const mainCostLabel = data.hasSession || telemetry.costUsd > 0
    ? formatCurrencyAmount(telemetry.costUsd, currency, rate)
    : "—";
  const totalCostLabel = formatCurrencyAmount(telemetry.totalCostUsd, currency, rate);
  const costTooltip = telemetry.subagentCount > 0
    ? `主会话 ${mainCostLabel} · 含 ${telemetry.subagentCount} 个子代理合计 ${totalCostLabel}（点击切换 ¥ / $）`
    : `点击切换币种（¥ / $）· 输入 ${data.tokens.inputTokens.toLocaleString()} / 缓存读取 ${data.tokens.cacheReadTokens.toLocaleString()} / 输出 ${data.tokens.outputTokens.toLocaleString()}`;

  return (
    <span
      className="su-ring-anchor"
      data-session-usage-root=""
      onMouseEnter={store.onSurfaceEnter}
      onMouseLeave={store.onSurfaceLeave}
    >
      <button
        type="button"
        className={`su-ring-pill${isOpen ? " active" : ""}`}
        data-session-usage-ring=""
        aria-label={`上下文已用 ${percent}%`}
        aria-expanded={isOpen}
        onClick={store.togglePinned}
      >
        <svg className="su-ring-svg" viewBox="0 0 16 16" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.2}
            strokeWidth={2}
          />
          {ratio > 0 && (
            <circle
              cx="8"
              cy="8"
              r={radius}
              fill="none"
              stroke={ringStroke}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              transform="rotate(-90 8 8)"
            />
          )}
        </svg>
        <span>{percent}%</span>
      </button>

      {isOpen && (
        <div
          className={`su-popover${variant === "task-start" ? " su-popover-down" : ""}`}
          role="dialog"
          aria-label="会话用量与上下文统计"
          data-escape-layer=""
          data-session-usage-popover=""
        >
          <div className="su-ctx-header">
            <span className="su-ctx-title">
              <span>上下文已用</span>
              <strong>{percent}%</strong>
            </span>
            <span className="su-ctx-cap">
              {formatApproxTokens(context.usedTokens)} / {formatContextCapacity(context.contextWindow)}
            </span>
          </div>

          <div className="su-seg-bar" aria-hidden="true">
            {sysWidthPct > 0 && (
              <span className="su-seg-piece system" style={{ width: `${sysWidthPct.toFixed(2)}%` }} />
            )}
            {toolWidthPct > 0 && (
              <span className="su-seg-piece tools" style={{ width: `${toolWidthPct.toFixed(2)}%` }} />
            )}
            {msgWidthPct > 0 && (
              <span className="su-seg-piece messages" style={{ width: `${msgWidthPct.toFixed(2)}%` }} />
            )}
          </div>

          <div className="su-legend">
            <div className="su-legend-row">
              <span className="su-legend-label">
                <span className="su-legend-dot system" />
                <span>系统提示词</span>
              </span>
              <span className="su-legend-val">{formatApproxTokens(context.systemTokens)}</span>
            </div>
            <div className="su-legend-row">
              <span className="su-legend-label">
                <span className="su-legend-dot tools" />
                <span>工具定义</span>
              </span>
              <span className="su-legend-val">{formatApproxTokens(context.toolTokens)}</span>
            </div>
            <div className="su-legend-row">
              <span className="su-legend-label">
                <span className="su-legend-dot messages" />
                <span>对话消息</span>
              </span>
              <span className="su-legend-val">{formatApproxTokens(context.messageTokens)}</span>
            </div>
          </div>

          <div className="su-divider" />

          <div className="su-metrics-grid">
            <div className="su-metric-cell">
              <span className="su-metric-label">总用时</span>
              <span className="su-metric-value">
                {liveTicking && <span className="su-live-dot" title="正在执行" />}
                <span>{formatDuration(totalActiveMs, liveTicking)}</span>
              </span>
            </div>

            <div className="su-metric-cell">
              <span className="su-metric-label" title="首 token 平均 (TTFT)">
                首 token 平均 (TTFT)
              </span>
              <span className="su-metric-value">{formatTtft(telemetry.avgTtftMs)}</span>
            </div>

            <div className="su-metric-cell">
              <span className="su-metric-label" title="输出速度 (TPS)">
                输出速度 (TPS)
              </span>
              <span className="su-metric-value">{formatTps(telemetry.outputTps)}</span>
            </div>

            <div className="su-metric-cell">
              <span className="su-metric-label">费用</span>
              <button
                type="button"
                className="su-metric-cost-btn"
                title={costTooltip}
                onClick={() => store.toggleCurrency()}
              >
                <span>{mainCostLabel}</span>
                {telemetry.subagentCount > 0 && (
                  <span className="su-subagent-tag">+{telemetry.subagentCount}子代理</span>
                )}
              </button>
            </div>

            <div className="su-metric-cell">
              <span className="su-metric-label">缓存命中</span>
              <span className="su-metric-value">
                {telemetry.cacheHitPercent !== null ? `${telemetry.cacheHitPercent}%` : "—"}
              </span>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}

export function apply(ctx: Context, rawConfig: SessionUsageClientConfig = {}): void {
  const uiStore = new SessionUsageUiStore(rawConfig);
  ctx.styles.inject(SESSION_USAGE_CSS, "session-usage");

  ctx.effect(() => {
    const offActivity = subscribeSessionActivity((session) => {
      uiStore.syncLiveTicker(session.isStreaming);
      uiStore.scheduleRefresh(session.isStreaming ? 140 : 50);
    });

    uiStore.syncLiveTicker(getActiveSessionSnapshot().isStreaming);
    uiStore.scheduleRefresh(30);

    return () => {
      offActivity();
      uiStore.dispose();
    };
  });

  ctx.contributions.registerComposerStatus({
    id: "session-usage:cost",
    position: "before-model",
    order: 20,
    render: (slotContext) => <CostToolbarPill store={uiStore} slotContext={slotContext} />,
  });

  ctx.contributions.registerComposerStatus({
    id: "session-usage:ring",
    position: "after-model",
    order: 20,
    render: (slotContext) => <RingAndPopoverStatus store={uiStore} slotContext={slotContext} />,
  });

  ctx.contributions.registerSlashInterceptor({
    id: "session-usage:slash",
    order: 20,
    onSlashCommand: (cmdName, rawArgs) => {
      const lower = cmdName.toLowerCase();
      if (lower !== "usage" && lower !== "session-usage") return false;
      if (rawArgs.trim().toLowerCase() === "print") {
        // Fall through to Host `/usage` command so it prints Markdown into the chat transcript.
        return false;
      }
      uiStore.pinOpen();
      return true;
    },
  });
}

export default {
  name,
  inject,
  apply,
};
