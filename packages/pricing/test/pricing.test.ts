import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { LlmService } from "@pid/llm";
import { summarize } from "@pid/session";
import { Pricing, estimateUsageCost, lookupBuiltinPricing } from "../src/index.ts";

describe("@pid/pricing", () => {
  it("matches frontier models across vendor prefixes, date stamps, and variant suffixes", () => {
    expect(lookupBuiltinPricing("anthropic/claude-sonnet-4-5-20250929")).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
    expect(lookupBuiltinPricing("models/gemini-2.5-pro-preview-06-05")).toEqual({
      input: 1.25,
      output: 10,
      cacheRead: 0.125,
    });
    expect(lookupBuiltinPricing("gpt-5.2-high")).toEqual({
      input: 1.75,
      output: 14,
      cacheRead: 0.175,
    });
  });

  it("prioritizes custom model pricing overrides and computes multi-model session costs without double-counting reasoningTokens", async () => {
    const ctx = new Context();
    await ctx.plugin(LlmService);
    await ctx.plugin(Pricing, {
      customPricing: (provider, model) =>
        provider === "relay" && model === "custom-coder" ? { input: 2, output: 6, cacheRead: 0.2 } : undefined,
    });

    const recorded: number[] = [];
    ctx.on("pricing/recorded", (entry) => recorded.push(entry.costUsd));

    ctx.emit("llm/response", {
      provider: "relay",
      model: "custom-coder",
      usage: { inputTokens: 500_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 40_000 },
      reason: "stop",
      attempts: 1,
      durationMs: 250,
    });
    // 0.5M * $2 + 0.1M * $6 = $1.00 + $0.60 = $1.60 (reasoningTokens inside outputTokens are not billed twice)
    expect(recorded[0]).toBeCloseTo(1.6, 6);

    const summary = summarize(
      { format: "pid.session", version: 1, id: "s1", createdAt: "2026-11-04T00:00:00Z", cwd: "/repo" },
      [
        {
          seq: 1,
          ts: "2026-11-04T00:00:01Z",
          type: "user",
          data: { content: [{ type: "text", text: "hello" }] },
        },
        {
          seq: 2,
          ts: "2026-11-04T00:00:02Z",
          type: "assistant",
          data: {
            content: [{ type: "text", text: "world" }],
            model: { provider: "relay", model: "custom-coder" },
            stop: "stop",
            usage: { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 80_000 },
          },
        },
        {
          seq: 3,
          ts: "2026-11-04T00:00:03Z",
          type: "assistant",
          data: {
            content: [{ type: "text", text: "review" }],
            model: { provider: "anthropic", model: "claude-sonnet-4-5" },
            stop: "stop",
            usage: { inputTokens: 100_000, outputTokens: 50_000, cacheReadTokens: 200_000, cacheWriteTokens: 0 },
          },
        },
      ],
    );

    expect(summary.usage.reasoningTokens).toBe(80_000);
    // custom-coder: 1M * $2 + 0.2M * $6 = $3.20
    // claude-sonnet-4-5: 0.1M * $3 + 0.05M * $15 + 0.2M * $0.3 = $0.30 + $0.75 + $0.06 = $1.11
    // Total = $4.31
    expect(ctx.pricing.estimateSessionCost(summary)).toBeCloseTo(4.31, 6);
    expect(estimateUsageCost(summary.usage, undefined)).toBe(0);
    await ctx.fiber.dispose();
  });
});
