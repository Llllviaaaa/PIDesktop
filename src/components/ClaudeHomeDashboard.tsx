import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { pi } from "../lib/pi";
import type { SessionInfo, UsageSummary } from "../types";

type HomeRange = "all" | "30d" | "7d";
type HomeTab = "overview" | "models";

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

function formatHour(hour: number): string {
  if (hour === 0) return "上午 12 点";
  if (hour < 12) return `上午 ${hour} 点`;
  if (hour === 12) return "下午 12 点";
  return `下午 ${hour - 12} 点`;
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

export function ClaudeHomeDashboard({
  sessions,
  currentModelId,
}: {
  sessions: SessionInfo[];
  currentModelId?: string;
}) {
  const [tab, setTab] = useState<HomeTab>("overview");
  const [range, setRange] = useState<HomeRange>("all");
  const [mountedAt] = useState(() => Date.now());

  const usageQuery = useQuery<UsageSummary>({
    queryKey: ["claude-home-usage"],
    queryFn: () => pi.usageSummary(),
    staleTime: 15_000,
  });

  const stats = useMemo(() => {
    const now = mountedAt;
    const cutoff = range === "7d"
      ? now - 7 * 86_400_000
      : range === "30d"
        ? now - 30 * 86_400_000
        : 0;

    const filteredSessions = sessions.filter((session) => {
      const ts = session.updatedAt || (session.createdAt ? Date.parse(session.createdAt) : 0);
      return cutoff === 0 || ts >= cutoff;
    });

    const dayMessages = new Map<string, number>();
    const hourCounts = new Array<number>(24).fill(0);
    let totalMessagesFromSessions = 0;

    for (const session of filteredSessions) {
      const ts = session.updatedAt || (session.createdAt ? Date.parse(session.createdAt) : 0);
      const count = Math.max(1, session.messageCount || 1);
      totalMessagesFromSessions += count;
      if (ts > 0) {
        const key = isoDateKey(ts);
        dayMessages.set(key, (dayMessages.get(key) ?? 0) + count);
        const h = new Date(ts).getHours();
        hourCounts[h] = (hourCounts[h] ?? 0) + count;
      }
    }

    let peakHourIndex = -1;
    let peakHourMax = 0;
    hourCounts.forEach((val, idx) => {
      if (val > peakHourMax) {
        peakHourMax = val;
        peakHourIndex = idx;
      }
    });

    const usage = usageQuery.data;
    const totalSessionCount = Math.max(1, sessions.length);
    const ratio = range === "all" ? 1 : filteredSessions.length / totalSessionCount;
    const totalTokens = usage
      ? Math.round(usage.totalTokens * (range === "all" ? 1 : Math.max(0.05, ratio)))
      : totalMessagesFromSessions * 1_450;
    const sessionCount = range === "all" && usage ? Math.max(usage.sessions, filteredSessions.length) : filteredSessions.length;
    const messageCount = range === "all" && usage ? Math.max(usage.messages, totalMessagesFromSessions) : totalMessagesFromSessions;

    // 26 weeks (182 days) heat grid aligned to end on the current week
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const totalCells = 26 * 7;
    const maxDayMsg = Math.max(1, ...dayMessages.values());
    const avgTokensPerMsg = messageCount > 0 ? totalTokens / messageCount : 1_200;

    const cells: Array<{ date: string; label: string; tokens: number; level: number }> = [];
    for (let i = totalCells - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86_400_000);
      const key = isoDateKey(d.getTime());
      const msgCount = dayMessages.get(key) ?? 0;
      const dayTokens = Math.round(msgCount * avgTokensPerMsg);
      const share = msgCount / maxDayMsg;
      const level = msgCount === 0 ? 0 : share < 0.25 ? 1 : share < 0.5 ? 2 : share < 0.8 ? 3 : 4;
      const shortDate = `${d.getMonth() + 1}月${d.getDate()}日`;
      cells.push({
        date: key,
        label: `${shortDate} — ${formatCompactTokens(dayTokens)} Token`,
        tokens: dayTokens,
        level,
      });
    }

    return {
      sessions: sessionCount,
      messages: messageCount,
      tokens: totalTokens,
      inputTokens: usage?.inputTokens ?? Math.round(totalTokens * 0.72),
      outputTokens: usage?.outputTokens ?? Math.round(totalTokens * 0.28),
      activeDays: dayMessages.size,
      peakHour: peakHourIndex >= 0 ? formatHour(peakHourIndex) : "—",
      topModel: currentModelId || "claude-sonnet-4-5",
      cells,
      funLine: pickFunBookLine(totalTokens),
    };
  }, [currentModelId, mountedAt, range, sessions, usageQuery.data]);

  const totalColumns = 26;

  return (
    <div className="dsh-claude-home-panel">
      <div className="dsh-claude-home-panel-head">
        <div className="dsh-claude-home-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            className="dsh-claude-home-tab"
            data-active={tab === "overview" ? "" : undefined}
            aria-selected={tab === "overview"}
            onClick={() => setTab("overview")}
          >
            概览
          </button>
          <button
            type="button"
            role="tab"
            className="dsh-claude-home-tab"
            data-active={tab === "models" ? "" : undefined}
            aria-selected={tab === "models"}
            onClick={() => setTab("models")}
          >
            模型
          </button>
        </div>
        <div className="dsh-claude-home-ranges" role="group" aria-label="统计时间范围">
          {([
            ["all", "全部"],
            ["30d", "30 天"],
            ["7d", "7 天"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="dsh-claude-home-range"
              data-active={range === key ? "" : undefined}
              onClick={() => setRange(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "overview" ? (
        <>
          <div className="dsh-claude-home-stats">
            <div className="dsh-claude-home-stat" data-stat="sessions">
              <span className="dsh-claude-home-stat-label">会话</span>
              <span className="dsh-claude-home-stat-value">{stats.sessions.toLocaleString()}</span>
            </div>
            <div className="dsh-claude-home-stat" data-stat="calls">
              <span className="dsh-claude-home-stat-label">消息</span>
              <span className="dsh-claude-home-stat-value">{stats.messages.toLocaleString()}</span>
            </div>
            <div className="dsh-claude-home-stat" data-stat="tokens">
              <span className="dsh-claude-home-stat-label">总 Token</span>
              <span className="dsh-claude-home-stat-value">{formatCompactTokens(stats.tokens)}</span>
            </div>
            <div className="dsh-claude-home-stat" data-stat="days">
              <span className="dsh-claude-home-stat-label">活跃天数</span>
              <span className="dsh-claude-home-stat-value">{stats.activeDays.toLocaleString()}</span>
            </div>
            <div className="dsh-claude-home-stat" data-stat="peak">
              <span className="dsh-claude-home-stat-label">高峰时段</span>
              <span className="dsh-claude-home-stat-value">{stats.peakHour}</span>
            </div>
            <div className="dsh-claude-home-stat" data-stat="model">
              <span className="dsh-claude-home-stat-label">最常用模型</span>
              <span className="dsh-claude-home-stat-value" title={stats.topModel}>{stats.topModel}</span>
            </div>
          </div>

          <div className="dsh-claude-home-heat">
            {stats.cells.map((cell, index) => {
              const col = Math.floor(index / 7);
              const edge = col < 3 ? "start" : col >= totalColumns - 3 ? "end" : undefined;
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

          {stats.funLine && (
            <span className="dsh-claude-home-fun">{stats.funLine}</span>
          )}
        </>
      ) : (
        <div className="dsh-claude-home-models">
          <div className="dsh-claude-home-model">
            <span className="dsh-claude-home-model-swatch" data-rank="0" />
            <span className="dsh-claude-home-model-name">{stats.topModel}</span>
            <span className="dsh-claude-home-model-split">
              入 {formatCompactTokens(stats.inputTokens)} · 出 {formatCompactTokens(stats.outputTokens)}
            </span>
            <span className="dsh-claude-home-model-share">100%</span>
          </div>
        </div>
      )}
    </div>
  );
}
