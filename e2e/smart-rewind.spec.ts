import { join, resolve } from "node:path";
import { answer, composer, expect, send, settled, test, textReply, userBubble, userRow } from "./fixtures.ts";

const SMART_REWIND_PLUGIN_DIR = resolve(process.cwd(), "plugins", "smart-rewind");
const SHOTS_DIR = process.env.PID_CAPTURE_REWIND_SHOTS_DIR;

test.use({ deviceScaleFactor: 2 });

test("smart-rewind plugin refills rewound message into Composer, protects unsent drafts, supports undo, and opens Esc Esc timeline", async ({ app, harness }) => {
  // 1. Install `plugins/smart-rewind` from the Settings -> Plugins UI.
  await app.getByRole("button", { name: "设置" }).click();
  await app.locator(".settings-nav-scroll").getByRole("button", { name: "插件" }).click();

  await app.getByRole("button", { name: "安装插件" }).click();
  const installDialog = app.getByRole("dialog", { name: "安装插件" });
  await installDialog.getByLabel("本地插件目录路径").fill(SMART_REWIND_PLUGIN_DIR);
  await installDialog.getByRole("button", { name: "立即安装并加载" }).click();
  await expect(installDialog).toHaveCount(0);

  const card = app.locator('article[data-plugin-id="smart-rewind"]');
  await expect(card).toBeVisible();
  await expect(card).toContainText("智能检查点回退");
  await expect(card).toContainText("运行中");
  await expect(card).toContainText("后端 Host");
  await expect(card).toContainText("前端 UI");

  if (SHOTS_DIR) {
    await app.screenshot({ path: join(SHOTS_DIR, "v6-smart-rewind-plugin-card.png") });
  }

  await app.getByRole("button", { name: "返回应用" }).click();

  // 2. Send two turns in the conversation.
  harness.provider.push(
    textReply("已完成登录表单初版设计。"),
    textReply("已补充图形验证码校验逻辑。"),
  );

  const firstPrompt = "帮我设计一个简洁的登录接口与表单";
  const secondPrompt = "再补充图形验证码与限流策略";

  await send(app, firstPrompt);
  await expect(answer(app, "已完成登录表单初版设计。")).toBeVisible();
  await settled(app);

  await send(app, secondPrompt);
  await expect(answer(app, "已补充图形验证码校验逻辑。")).toBeVisible();
  await settled(app);

  // 3. Type an unsent draft in the Composer before clicking Rewind on Turn 2.
  const unsentDraft = "这是我刚写了一半还没发送的草稿";
  await composer(app).fill(unsentDraft);

  await userRow(app, secondPrompt).hover();
  await userRow(app, secondPrompt).getByRole("button", { name: "回退消息和改动" }).click();

  // 4. Verify the competitor-style Smart Rewind Sheet opens with mode options & draft protection hint.
  const rewindSheet = app.locator("[data-smart-rewind-dialog]");
  await expect(rewindSheet).toBeVisible();
  await expect(rewindSheet).toContainText("智能检查点回退");
  await expect(rewindSheet).toContainText("回退对话与代码改动");
  await expect(rewindSheet).toContainText("仅回退对话（保留当前代码）");
  await expect(rewindSheet).toContainText("检测到输入框内已有未发送草稿");

  if (SHOTS_DIR) {
    await app.screenshot({ path: join(SHOTS_DIR, "v6-smart-rewind-sheet.png") });
  }

  await rewindSheet.getByRole("button", { name: "回退并放回输入框" }).click();
  await expect(rewindSheet).toHaveCount(0);

  // 5. Turn 2 disappears AND the rewound user prompt is placed right into the Composer input bar!
  await expect(userBubble(app, secondPrompt)).toHaveCount(0);
  await expect(answer(app, "已补充图形验证码校验逻辑。")).toHaveCount(0);
  await expect(composer(app)).toHaveValue(secondPrompt);

  // 6. Verify Composer Rewind Banner supports swapping stashed draft <-> rewound prompt AND Undo Rewind!
  const banner = app.locator("[data-smart-rewind-banner]");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("已回退至第 2 轮并回填原消息");

  if (SHOTS_DIR) {
    await app.screenshot({ path: join(SHOTS_DIR, "v6-smart-rewind-composer-banner.png") });
  }

  await banner.getByRole("button", { name: "恢复原草稿" }).click();
  await expect(composer(app)).toHaveValue(unsentDraft);

  await banner.getByRole("button", { name: "切回回退消息" }).click();
  await expect(composer(app)).toHaveValue(secondPrompt);

  // Click Undo Rewind (`撤销回退`) and verify Turn 2 and its answer come back!
  await banner.getByRole("button", { name: "撤销回退" }).click();
  await expect(banner).toHaveCount(0);
  await expect(userBubble(app, secondPrompt)).toBeVisible();
  await expect(answer(app, "已补充图形验证码校验逻辑。")).toBeVisible();
  await expect(composer(app)).toHaveValue(unsentDraft);

  // 7. Clear Composer and press `Esc` twice (`Esc Esc`) to open the Checkpoint Time-Machine!
  await composer(app).fill("");
  await app.keyboard.press("Escape");
  await app.keyboard.press("Escape");

  const timelineSheet = app.locator("[data-smart-rewind-dialog]");
  await expect(timelineSheet).toBeVisible();
  await expect(timelineSheet).toContainText("会话检查点时光机");
  await expect(timelineSheet).toContainText("#1");
  await expect(timelineSheet).toContainText("#2");

  if (SHOTS_DIR) {
    await app.screenshot({ path: join(SHOTS_DIR, "v6-smart-rewind-timeline.png") });
  }

  await timelineSheet.getByRole("button", { name: "取消" }).click();
  await expect(timelineSheet).toHaveCount(0);
});
