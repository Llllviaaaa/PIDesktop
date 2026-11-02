import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { test } from "vitest";
import { ClaudeHomeDashboard } from "../src/components/ClaudeHomeDashboard";
import type { SessionInfo, UsageSummary } from "../src/types";

/** The visible words of a rendering, tags removed. */
function words(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function render(sessions: SessionInfo[], usage?: UsageSummary): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (usage) client.setQueryData(["claude-home-usage"], usage);
  return renderToStaticMarkup(createElement(
    QueryClientProvider,
    { client },
    createElement(ClaudeHomeDashboard, { sessions, currentModelId: "glm-5.3" }),
  ));
}

const now = Date.now();
const sessions: SessionInfo[] = [
  { file: "a.jsonl", sessionId: "a", cwd: "D:/p", messageCount: 4, updatedAt: now },
  { file: "b.jsonl", sessionId: "b", cwd: "D:/p", messageCount: 6, updatedAt: now - 2 * 86_400_000 },
];

test("home dashboard shows recorded figures only", () => {
  const usage: UsageSummary = {
    sessions: 12,
    messages: 340,
    inputTokens: 1_200_000,
    outputTokens: 300_000,
    reasoningTokens: 0,
    cacheReadTokens: 80_000,
    cacheWriteTokens: 0,
    totalTokens: 1_580_000,
    totalCost: 0,
  };
  const withUsage = words(render(sessions, usage));
  assert.match(withUsage, /会话 12/);
  assert.match(withUsage, /消息 340/);
  assert.match(withUsage, /总 Token 1\.6M/);
  assert.match(withUsage, /输入 \/ 输出 1\.2M \/ 300k/);
  assert.match(withUsage, /缓存读取 80k/);
  assert.match(withUsage, /当前模型 glm-5\.3/);
  // Activity counts the days sessions were updated, not estimated tokens.
  assert.match(withUsage, /近 26 周有 2 天有会话更新/);
  assert.match(withUsage, /相当于/);
  // The card no longer offers ranges or a per-model split it has no data for.
  assert.doesNotMatch(withUsage, /30 天|7 天|模型 100%/);

  // Without the Host's totals, token figures are blank, never estimated from messages.
  const withoutUsage = words(render(sessions));
  assert.match(withoutUsage, /会话 2/);
  assert.match(withoutUsage, /消息 10/);
  assert.match(withoutUsage, /总 Token —/);
  assert.match(withoutUsage, /输入 \/ 输出 —/);
  assert.doesNotMatch(withoutUsage, /相当于/);

  // A first run with nothing recorded shows no card at all.
  assert.equal(render([]), "");
});
