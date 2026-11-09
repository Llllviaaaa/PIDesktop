import { describe, expect, it } from "vitest";
import {
  buildSandboxedWidgetHtml,
  deriveSessionIntelligentUis,
  evaluateFormula,
  formatStatValue,
  interpolateTemplate,
} from "../src/lib/intelligentUi";
import { presentToolCall } from "../src/lib/toolPresentation";
import type { UiMessage } from "../src/types";

describe("Intelligent UI frontend engine", () => {
  it("evaluates CSP-safe arithmetic, comparisons, ternaries, and Math functions without eval", () => {
    const state = { principal: 100, rate: 6, years: 10, compound: true };
    const finalAmount = evaluateFormula("principal * Math.pow(1 + rate / 100, years)", state);
    expect(Number(finalAmount)).toBeCloseTo(179.0847, 3);

    expect(evaluateFormula("compound ? round(principal * 1.5) : principal", state)).toBe(150);
    expect(evaluateFormula("years >= 10 && rate > 5 ? '长期优选' : '常规'", state)).toBe("长期优选");
    expect(evaluateFormula("clamp(rate * 20, 0, 100)", state)).toBe(100);
    expect(Number.isNaN(Number(evaluateFormula("unknownFunc((", state)))).toBe(true);
  });

  it("formats stats and interpolates {key} and {=formula} templates", () => {
    const state = { qps: 1200, latencyMs: 18.4 };
    expect(
      formatStatValue(
        { formula: "qps * 86400 * 30 / 1000000", suffix: " M", decimals: 2 },
        state,
      ),
    ).toBe("3,110.40 M");

    expect(
      interpolateTemplate("在 {qps} QPS 下，预计吞吐评分为 {=round(qps / latencyMs)} 分", state),
    ).toBe("在 1200 QPS 下，预计吞吐评分为 65 分");
  });

  it("derives multi-turn widget version history from render_ui, update_ui, and intelligent-ui fences", () => {
    const messages: UiMessage[] = [
      {
        id: "u1",
        role: "user",
        content: "做一个收益计算器",
        timestamp: 1000,
      },
      {
        id: "a1",
        role: "assistant",
        content: "已为您创建初版计算器。",
        timestamp: 2000,
        toolCalls: [
          {
            id: "tc-1",
            name: "render_ui",
            args: {
              id: "ROI Sim",
              title: "ROI 收益模拟器",
              engine: "declarative",
              spec: {
                state: { capital: 50, rate: 8 },
                blocks: [
                  { type: "stats", items: [{ label: "年收益", formula: "capital * rate / 100" }] },
                ],
              },
            },
            running: false,
          },
          {
            id: "tc-err",
            name: "update_ui",
            args: { id: "roi-sim", state: { rate: 999 } },
            isError: true,
            running: false,
          },
        ],
      },
      {
        id: "a2",
        role: "assistant",
        content: "已将默认年化调整为 12%，并附带一个沙箱预览：\n\n```intelligent-ui\n{\"id\":\"mini-badge\",\"title\":\"状态徽章\",\"engine\":\"html\",\"html\":\"<div>OK</div>\"}\n```",
        timestamp: 3000,
        toolCalls: [
          {
            id: "tc-2",
            name: "update_ui",
            args: {
              id: "roi-sim",
              subtitle: "默认年化已上调至 12%",
              state: { rate: 12 },
            },
            running: false,
          },
        ],
      },
    ];

    const summary = deriveSessionIntelligentUis(messages);
    expect(summary.orderedGroups.map((g) => g.id)).toEqual(["roi-sim", "mini-badge"]);

    const roiGroup = summary.groupsById.get("roi-sim");
    expect(roiGroup?.versions).toHaveLength(2);
    expect(roiGroup?.versions[0]?.spec?.state).toEqual({ capital: 50, rate: 8 });
    expect(roiGroup?.versions[1]?.spec?.state).toEqual({ capital: 50, rate: 12 });
    expect(roiGroup?.latest.subtitle).toBe("默认年化已上调至 12%");

    expect(summary.turnWidgetsByMessageId.get("a1")).toEqual([
      { id: "roi-sim", version: 1, action: "render" },
    ]);
    expect(summary.turnWidgetsByMessageId.get("a2")).toEqual([
      { id: "roi-sim", version: 2, action: "update" },
    ]);
  });

  it("presents render_ui and update_ui tool calls as compact non-expanding UI rows", () => {
    const renderPresentation = presentToolCall({
      id: "c1",
      name: "render_ui",
      args: { id: "calc", title: "定投计算器" },
      result: "Rendered interactive UI",
      running: false,
    });
    expect(renderPresentation.kind).toBe("ui");
    expect(renderPresentation.heading).toBe("渲染交互组件 · 定投计算器");
    expect(renderPresentation.expandable).toBe(false);

    const updatePresentation = presentToolCall({
      id: "c2",
      name: "update_ui",
      args: { id: "calc", title: "定投计算器 v2" },
      result: "Updated interactive UI",
      running: false,
    });
    expect(updatePresentation.kind).toBe("ui");
    expect(updatePresentation.heading).toBe("更新交互组件 · 定投计算器 v2");
  });

  it("builds sandboxed HTML with strict connect-src 'none' CSP and Cool-Gray Minimalist tokens", () => {
    const darkHtml = buildSandboxedWidgetHtml({
      html: "<button data-pi-prompt='继续分析'>提交</button>",
      widgetId: "sandbox-1",
      title: "沙箱测试",
      isDark: true,
    });
    expect(darkHtml).toContain("connect-src 'none'");
    expect(darkHtml).toContain("--pi-accent: #6687a8;");
    expect(darkHtml).toContain("window.piUI");

    const lightHtml = buildSandboxedWidgetHtml({
      html: "<p>Light</p>",
      widgetId: "sandbox-1",
      title: "沙箱测试",
      isDark: false,
    });
    expect(lightHtml).toContain("--pi-accent: #4c6a88;");
  });
});
