import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agent } from "../lib/agent";
import type { SessionInfo, UsageSummary } from "../types";

const BOOKS: Array<{ tokens: number; title: string }> = [
  { tokens: 7_600, title: "《道德经》" },
  { tokens: 29_000, title: "《动物农场》" },
  { tokens: 35_000, title: "《爱丽丝漫游奇境》" },
  { tokens: 62_000, title: "《了不起的盖茨比》" },
  { tokens: 78_000, title: "《活着》" },
  { tokens: 102_000, title: "《哈利·波特与魔法石》" },
  { tokens: 118_000, title: "《一九八四》" },
  { tokens: 128_000, title: "《霍比特人》" },
  { tokens: 160_000, title: "《傲慢与偏见》" },
  { tokens: 185_000, title: "《三体》" },
  { tokens: 275_000, title: "《白鲸》" },
  { tokens: 580_000, title: "《魔戒》" },
  { tokens: 730_000, title: "《红楼梦》" },
  { tokens: 1_400_000, title: "《哈利·波特》全集" },
];

/** The activity grid's span: 26 weeks, ending on today. */
const HEAT_WEEKS = 26;

function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000_000) {
    const val = (tokens / 1_000_000_000).toFixed(1).replace(/\.0$/, "");
    return `${val}B`;
  }
  if (tokens >= 1_000_000) {
    const val = (tokens / 1_000_000).toFixed(1).replace(/\.0$/, "");
    return `${val}M`;
  }
  if (tokens >= 1_000) {
    const val = (tokens / 1_000).toFixed(1).replace(/\.0$/, "");
    return `${val}k`;
  }
  return Math.round(tokens).toLocaleString();
}

function pickFunBookLine(tokens: number): string | null {
  const firstBook = BOOKS[0];
  if (!firstBook || tokens < firstBook.tokens) return null;
  let chosen = firstBook;
  for (const book of BOOKS) {
    if (tokens >= book.tokens) chosen = book;
    else break;
  }
  const count = Math.max(1, Math.round(tokens / chosen.tokens));
  return `你的 Token 用量相当于 ${count} 本${chosen.title}。`;
}

function isoDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sessionTimestamp(session: SessionInfo): number {
  return session.updatedAt || (session.createdAt ? Date.parse(session.createdAt) : 0) || 0;
}

/**
 * The home page's usage card. It shows only what is recorded: the Host's
 * `usage.summary` totals, and the session list's own dates and counts. The
 * Host keeps no per-day or per-model token figures, so the card has none, and
 * a total it could not read shows as 「—」 rather than an estimate.
 */
export function ClaudeHomeDashboard({
  sessions,
  currentModelId,
}: {
  sessions: SessionInfo[];
  currentModelId?: string;
}) {
  const [mountedAt] = useState(() => Date.now());

  const usageQuery = useQuery<UsageSummary>({
    queryKey: ["claude-home-usage"],
    queryFn: () => agent.usageSummary(),
    staleTime: 15_000,
  });
  const usage = usageQuery.data;

  const activity = useMemo(() => {
    // Sessions by the day they were last updated: the only date a session carries.
    const sessionsByDay = new Map<string, number>();
    for (const session of sessions) {
      const timestamp = sessionTimestamp(session);
      if (timestamp <= 0) continue;
      const key = isoDateKey(timestamp);
      sessionsByDay.set(key, (sessionsByDay.get(key) ?? 0) + 1);
    }
    const today = new Date(mountedAt);
    today.setHours(0, 0, 0, 0);
    const totalCells = HEAT_WEEKS * 7;
    const busiest = Math.max(1, ...sessionsByDay.values());
    const cells: Array<{ date: string; label: string; level: number }> = [];
    let activeDays = 0;
    for (let offset = totalCells - 1; offset >= 0; offset -= 1) {
      const day = new Date(today.getTime() - offset * 86_400_000);
      const key = isoDateKey(day.getTime());
      const count = sessionsByDay.get(key) ?? 0;
      if (count > 0) activeDays += 1;
      const share = count / busiest;
      cells.push({
        date: key,
        label: `${day.getMonth() + 1}月${day.getDate()}日 — ${count > 0 ? `${count} 个会话有更新` : "没有会话更新"}`,
        level: count === 0 ? 0 : share < 0.25 ? 1 : share < 0.5 ? 2 : share < 0.8 ? 3 : 4,
      });
    }
    return { cells, activeDays };
  }, [mountedAt, sessions]);

  // A first run has nothing to show; an all-zero panel reads as unfinished.
  if (sessions.length === 0 && !usage?.messages) return null;

  const sessionCount = usage?.sessions ?? sessions.length;
  const messageCount = usage?.messages ?? sessions.reduce((sum, session) => sum + (session.messageCount || 0), 0);
  const missing = "—";
  const stats: Array<{ key: string; label: string; value: string; title?: string }> = [
    { key: "sessions", label: "会话", value: sessionCount.toLocaleString() },
    { key: "messages", label: "消息", value: messageCount.toLocaleString() },
    { key: "tokens", label: "总 Token", value: usage ? formatCompactTokens(usage.totalTokens) : missing },
    {
      key: "io",
      label: "输入 / 输出",
      value: usage ? `${formatCompactTokens(usage.inputTokens)} / ${formatCompactTokens(usage.outputTokens)}` : missing,
    },
    { key: "cache", label: "缓存读取", value: usage ? formatCompactTokens(usage.cacheReadTokens) : missing },
    { key: "model", label: "当前模型", value: currentModelId || missing, title: currentModelId },
  ];
  const funLine = usage ? pickFunBookLine(usage.totalTokens) : null;

  return (
    <div className="dsh-claude-home-panel">
      <div className="dsh-claude-home-panel-head">
        <span className="dsh-claude-home-panel-title">使用概览</span>
        {!usage && !usageQuery.isLoading && (
          <span className="dsh-claude-home-panel-note">暂时读不到 Token 用量</span>
        )}
      </div>

      <div className="dsh-claude-home-stats">
        {stats.map((stat) => (
          <div className="dsh-claude-home-stat" data-stat={stat.key} key={stat.key}>
            <span className="dsh-claude-home-stat-label">{stat.label}</span>
            <span className="dsh-claude-home-stat-value" title={stat.title}>{stat.value}</span>
          </div>
        ))}
      </div>

      <div className="dsh-claude-home-heat" aria-label={`近 ${HEAT_WEEKS} 周的会话活动`}>
        {activity.cells.map((cell, index) => {
          const col = Math.floor(index / 7);
          const edge = col < 3 ? "start" : col >= HEAT_WEEKS - 3 ? "end" : undefined;
          return (
            <span
              key={cell.date}
              className="dsh-claude-home-heat-cell"
              data-level={cell.level > 0 ? String(cell.level) : undefined}
              data-tip={cell.label}
              data-edge={edge}
              aria-label={cell.label}
            />
          );
        })}
      </div>

      <div className="dsh-claude-home-foot">
        <span>近 {HEAT_WEEKS} 周有 {activity.activeDays} 天有会话更新</span>
        {funLine && <span>{funLine}</span>}
      </div>
    </div>
  );
}
