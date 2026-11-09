import { expect, send, settled, test, textReply, toolReply, userBubble } from "./fixtures.ts";

test("renders interactive declarative widgets inline with live formulas, version history, canvas view, and prompt round-trip", async ({
  app,
  harness,
}) => {
  // Turn 1: Agent creates v1 of an interactive calculator via `render_ui`
  harness.provider.push(
    toolReply([
      {
        id: "call-render-v1",
        name: "render_ui",
        args: {
          id: "roi-simulator",
          title: "复利收益模拟器",
          subtitle: "拖动滑块实时预览期末资产",
          engine: "declarative",
          spec: {
            state: { principal: 100, rate: 5, years: 10 },
            blocks: [
              {
                type: "controls",
                items: [
                  { key: "rate", label: "预期年化", kind: "slider", min: 1, max: 20, step: 1, unit: "%" },
                ],
              },
              {
                type: "stats",
                items: [
                  {
                    label: "十年后总资产",
                    formula: "round(principal * Math.pow(1 + rate / 100, years), 1)",
                    suffix: " 万",
                    decimals: 1,
                    tone: "accent",
                  },
                ],
              },
              {
                type: "chart",
                title: "里程碑对比",
                kind: "bar",
                unit: "万",
                series: [
                  { label: "投入本金", formula: "principal", tone: "muted" },
                  { label: "期末本息", formula: "round(principal * Math.pow(1 + rate / 100, years), 1)", tone: "accent" },
                ],
              },
              {
                type: "form",
                submitLabel: "按此参数生成配置方案",
                promptTemplate: "请按年化 {rate}%、本金 {principal} 万生成资产配置方案",
              },
            ],
          },
        },
      },
    ]),
    textReply("我已经为您生成了交互式复利模拟器，可以直接调节年化收益率滑块。"),
  );

  await send(app, "帮我做一个复利收益模拟器");
  await settled(app);

  // Even after the turn settles and ProcessGroup folds, the interactive widget card remains visible inline!
  const inlineCard = app.locator('.pi-iui-card-inline[data-widget-id="roi-simulator"]');
  await expect(inlineCard).toBeVisible();
  await expect(inlineCard.locator(".pi-iui-title")).toHaveText("复利收益模拟器");
  // 100 * (1.05)^10 = 162.9
  await expect(inlineCard.locator(".pi-iui-stat-value")).toContainText("162.9 万");

  // Adjust slider to 10% -> live formula updates immediately to 100 * (1.10)^10 = 259.4 万!
  const slider = inlineCard.getByRole("slider", { name: "预期年化" });
  await slider.fill("10");
  await expect(inlineCard.locator(".pi-iui-stat-value")).toContainText("259.4 万");

  // Turn 2: Clicking the widget's form submit button sends the interpolated prompt back into the conversation,
  // and the agent updates the widget to v2 via `update_ui`!
  harness.provider.push(
    toolReply([
      {
        id: "call-update-v2",
        name: "update_ui",
        args: {
          id: "roi-simulator",
          subtitle: "v2：期限已扩展为 20 年长期测算",
          state: { rate: 10, years: 20 },
        },
      },
    ]),
    textReply("已将测算周期扩展到 20 年并同步生成了 v2 版本。"),
  );

  await inlineCard.getByRole("button", { name: "按此参数生成配置方案" }).click();
  await expect(userBubble(app, "请按年化 10%、本金 100 万生成资产配置方案")).toBeVisible();
  await settled(app);

  // Latest turn displays v2 (100 * 1.1^20 = 672.7 万) and exposes v1 / v2 version switcher pills!
  const latestInlineCard = app.locator('.pi-iui-card-inline[data-widget-id="roi-simulator"]').last();
  await expect(latestInlineCard).toContainText("v2：期限已扩展为 20 年长期测算");
  await expect(latestInlineCard.locator(".pi-iui-stat-value")).toContainText("672.7 万");

  // Switch back to v1 via version history pill and verify historical state is preserved
  await latestInlineCard.getByRole("button", { name: "v1" }).click();
  await expect(latestInlineCard).toContainText("拖动滑块实时预览期末资产");
  await latestInlineCard.getByRole("button", { name: "v2" }).click();

  // Switch to source view and back to preview
  await latestInlineCard.getByRole("button", { name: "源码", exact: true }).click();
  await expect(latestInlineCard.locator(".pi-iui-source-view")).toContainText('"id": "roi-simulator"');
  await latestInlineCard.getByRole("button", { name: "预览", exact: true }).click();

  // Expand into the Right Workbench `画布` tab
  await latestInlineCard.getByRole("button", { name: "画布", exact: true }).click();
  const canvasCard = app.locator('.pi-iui-card-canvas[data-widget-id="roi-simulator"]');
  await expect(canvasCard).toBeVisible();
  await expect(canvasCard.locator(".pi-iui-title")).toHaveText("复利收益模拟器");
});

test("manages built-in intelligent-ui toggle in Settings -> Plugins and supports sandboxed HTML widgets", async ({
  app,
  harness,
}) => {
  // Composer shows the `交互组件` quick action chip by default
  const composerChips = app.locator(".pi-iui-composer-chip");
  await expect(composerChips.first()).toBeVisible();

  // Open Settings -> Plugins and verify built-in `intelligent-ui` card is active
  await app.getByRole("button", { name: "设置" }).click();
  await app.locator(".settings-nav-scroll").getByRole("button", { name: "插件" }).click();

  const pluginCard = app.locator('article[data-plugin-id="intelligent-ui"]');
  await expect(pluginCard).toBeVisible();
  await expect(pluginCard).toContainText("Intelligent UI 交互式界面");
  await expect(pluginCard).toContainText("运行中");

  // Disable `intelligent-ui` -> Composer chip unmounts cleanly
  await pluginCard.getByRole("switch").click();
  await expect(pluginCard).toContainText("已停用");
  await expect(composerChips).toHaveCount(0);

  // Re-enable `intelligent-ui` -> Composer chip mounts back immediately
  await pluginCard.getByRole("switch").click();
  await expect(pluginCard).toContainText("运行中");
  await app.keyboard.press("Escape");
  await expect(composerChips.first()).toBeVisible();

  // Render a sandboxed HTML widget and verify isolated script execution + prompt bridge
  harness.provider.push(
    toolReply([
      {
        id: "call-html-1",
        name: "render_ui",
        args: {
          id: "wave-sandbox",
          title: "HTML 交互沙箱",
          engine: "html",
          html: `
            <div>
              <p id="status">沙箱就绪</p>
              <button type="button" class="primary" data-pi-prompt="从 HTML 沙箱触发追问">发送沙箱结果</button>
            </div>
          `,
        },
      },
    ]),
    textReply("已渲染 HTML 交互沙箱。"),
  );

  await send(app, "渲染一个 HTML 交互沙箱");
  await settled(app);

  const htmlCard = app.locator('.pi-iui-card-inline[data-widget-id="wave-sandbox"]');
  await expect(htmlCard).toBeVisible();
  const frame = htmlCard.frameLocator("iframe.pi-iui-html-frame");
  await expect(frame.locator("#status")).toHaveText("沙箱就绪");

  harness.provider.push(textReply("收到来自 HTML 沙箱的追问！"));
  await frame.getByRole("button", { name: "发送沙箱结果" }).click();
  await expect(userBubble(app, "从 HTML 沙箱触发追问")).toBeVisible();
  await settled(app);
});
