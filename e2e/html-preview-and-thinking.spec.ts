import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answer, expect, send, settled, test, textReply } from "./fixtures.ts";

test("clicking generated .html in chat opens dynamic interactive HTML preview with split/code toggle, and Composer supports dynamic + custom thinking levels", async ({
  app,
  harness,
}) => {
  // 1. Prepare an interactive HTML + relative CSS asset in the workspace, then have the assistant reference `pelican-bicycle.html`.
  mkdirSync(join(harness.workspace, "assets"), { recursive: true });
  writeFileSync(
    join(harness.workspace, "assets", "ride.css"),
    "body { margin: 0; background: rgb(16, 32, 44); color: #e7f2fb; }",
    "utf8",
  );
  writeFileSync(
    join(harness.workspace, "pelican-bicycle.html"),
    `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <link rel="stylesheet" href="./assets/ride.css" />
</head>
<body>
  <h1 id="heading">鹈鹕骑自行车</h1>
  <svg id="scene" viewBox="0 0 120 60"><circle id="wheel" cx="30" cy="40" r="14" /></svg>
  <button id="toggle-btn" type="button" onclick="document.getElementById('state').textContent = 'paused'">暂停动画</button>
  <span id="state">playing</span>
</body>
</html>`,
    "utf8",
  );

  harness.provider.push(textReply("已放在 `pelican-bicycle.html`，点击即可查看动态 SVG 动画。"));
  await send(app, "建一个 HTML，内容是 SVG 绘制一个鹈鹕骑自行车的 2D 动画");
  await settled(app);

  const reply = answer(app, /pelican-bicycle\.html/);
  await expect(reply).toBeVisible();

  // Click the inline file chip in the assistant message -> Right Workbench opens in dynamic preview mode!
  await reply.getByRole("link", { name: "pelican-bicycle.html" }).click();

  const workbench = app.getByRole("complementary", { name: "右侧工作台" });
  await expect(workbench).toBeVisible();
  const previewStage = workbench.locator('[data-workbench-preview="html"]');
  await expect(previewStage).toBeVisible();

  const previewFrame = previewStage.frameLocator("iframe.pid-wb-iframe");
  await expect(previewFrame.locator("#heading")).toHaveText("鹈鹕骑自行车");
  await expect(previewFrame.locator("#state")).toHaveText("playing");

  // Relative CSS (`./assets/ride.css`) resolved over the capability-protected loopback server:
  const bg = await previewFrame.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgb(16, 32, 44)");

  // Interactive JS inside the rendered HTML runs dynamically on click:
  await previewFrame.locator("#toggle-btn").click();
  await expect(previewFrame.locator("#state")).toHaveText("paused");

  // Switch between 预览 / 分栏 / 源码 seamlessly:
  const modeGroup = workbench.getByRole("tablist", { name: "文件视图模式" });
  await modeGroup.getByRole("tab", { name: "分栏" }).click();
  await expect(workbench.locator(".pid-wb-split-view")).toBeVisible();
  await expect(workbench.locator('[data-workbench-preview="html"]')).toBeVisible();

  await modeGroup.getByRole("tab", { name: "源码" }).click();
  await expect(workbench.locator('[data-workbench-preview="html"]')).toHaveCount(0);

  // 2. Add a reasoning model (`gpt-5.4`) via Settings -> 模型, then verify expanded & custom thinking levels in Composer!
  await app.getByRole("button", { name: "设置" }).click();
  const settingsDialog = app.getByRole("dialog", { name: "设置" });
  await settingsDialog.locator(".settings-nav-scroll").getByRole("button", { name: "模型" }).click();
  await settingsDialog.getByRole("button", { name: "添加自定义提供商" }).click();

  const editor = app.getByRole("dialog", { name: "添加自定义提供商" });
  await editor.getByPlaceholder("例如 公司网关 或 本地 Ollama").fill("xAI Gateway");
  await editor.getByLabel("API 地址").fill("http://127.0.0.1:1/v1");
  await editor.getByLabel("API 密钥").fill("$PATH");
  await editor.getByPlaceholder("手动输入模型 ID，回车添加").fill("gpt-5.4");
  await editor.getByPlaceholder("手动输入模型 ID，回车添加").press("Enter");
  await editor.getByRole("button", { name: "添加", exact: true }).click();
  await expect(editor).toHaveCount(0);

  // Close settings modal
  await settingsDialog.getByRole("button", { name: "返回应用" }).click();
  await expect(settingsDialog).toHaveCount(0);

  // Open Composer's ModelPicker and select `gpt-5.4`
  const modelCombo = app.locator(".composer-card .model-combo");
  await modelCombo.click();
  const pickerMenu = app.getByRole("dialog", { name: "选择模型和思考等级" });
  await pickerMenu.getByRole("menuitemradio", { name: /gpt-5\.4/i }).click();
  await expect(modelCombo).toContainText("gpt-5.4");

  // Reopen ModelPicker -> open 思考等级 flyout -> verify extended tiers (`最少`, `极高`) and add custom tier `ultra`!
  await modelCombo.click();
  await app.locator(".model-picker-thinking-row").click();
  const levelsMenu = app.getByRole("menu", { name: "思考等级" });
  await expect(levelsMenu.getByRole("menuitemradio", { name: "最少" })).toBeVisible();
  await expect(levelsMenu.getByRole("menuitemradio", { name: "极高" })).toBeVisible();

  await levelsMenu.getByRole("button", { name: "新增思考等级…" }).click();
  await levelsMenu.getByLabel("自定义思考等级").fill("ultra");
  await levelsMenu.getByRole("button", { name: "添加", exact: true }).click();

  await expect(modelCombo.locator(".model-combo-level")).toHaveText("ultra");
});
