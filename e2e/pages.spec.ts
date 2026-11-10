import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_MODEL } from "../packages/host/test/e2e-host.ts";
import { expect, test, textReply } from "./fixtures.ts";

test("run a scheduled task now", async ({ app, harness }) => {
  await expect(app.getByRole("button", { name: "拉取请求" })).toHaveCount(0);
  harness.host.host.ctx.schedule.save({
    name: "Nightly notes",
    prompt: "Summarize notes.txt",
    cwd: harness.workspace,
    frequency: "daily",
    hour: 3,
    minute: 0,
    permissionMode: "read-only",
    model: E2E_MODEL,
    enabled: true,
  });
  harness.provider.push(textReply("Notes summarized."));
  await app.getByRole("button", { name: "定时任务" }).click();
  await expect(app.getByText("Nightly notes")).toBeVisible();
  await app.getByRole("button", { name: "立即运行" }).click();
  await expect(app.getByText("上次成功")).toBeVisible();
  expect(harness.provider.requests).toHaveLength(1);
});

test("long text scheduled task does not overflow row or page layout", async ({ app, harness }) => {
  const longName = "每日全量代码审查与安全漏洞扫描以及依赖更新检查和性能基准测试自动汇总报告生成任务-超长标题测试".repeat(3);
  const longPrompt = "请仔细检查当前工作区中的所有最近提交记录、未提交的变更、依赖项更新情况、单元测试覆盖率、构建产物大小变化以及潜在的性能退化问题，然后生成一份详细的中文分析报告，包含关键风险点、修复建议、负责人模块划分以及后续跟进计划。".repeat(6);
  harness.host.host.ctx.schedule.save({
    name: longName,
    prompt: longPrompt,
    cwd: harness.workspace,
    frequency: "daily",
    hour: 9,
    minute: 30,
    permissionMode: "read-only",
    model: E2E_MODEL,
    enabled: true,
  });
  await app.getByRole("button", { name: "定时任务" }).click();
  await expect(app.locator(".scheduled-task-row")).toHaveCount(1);

  const metrics = await app.evaluate(() => {
    const page = document.querySelector(".scheduled-tasks-page") as HTMLElement;
    const list = document.querySelector(".scheduled-task-list") as HTMLElement;
    const row = document.querySelector(".scheduled-task-row") as HTMLElement;
    return {
      pageClientWidth: page.clientWidth,
      pageScrollWidth: page.scrollWidth,
      listWidth: list.getBoundingClientRect().width,
      rowClientWidth: row.clientWidth,
      rowScrollWidth: row.scrollWidth,
      rowWidth: row.getBoundingClientRect().width,
    };
  });
  expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.pageClientWidth);
  expect(metrics.rowScrollWidth).toBeLessThanOrEqual(metrics.rowClientWidth);
  expect(metrics.rowWidth).toBeLessThanOrEqual(metrics.listWidth + 1);
});

test("save a custom provider in minimalist 4-module settings", async ({ app, harness }) => {
  await app.getByRole("button", { name: "设置" }).click();
  const nav = app.locator(".settings-nav-scroll");
  await expect(nav.locator("button")).toHaveText(["通用", "外观", "模型", "插件"]);
  await nav.getByRole("button", { name: "模型" }).click();

  await app.getByRole("button", { name: "添加自定义提供商" }).click();
  const editor = app.getByRole("dialog", { name: "添加自定义提供商" });
  await editor.getByPlaceholder("例如 公司网关 或 本地 Ollama").fill("Local Gateway");
  await editor.getByPlaceholder("https://api.example.com/v1").fill("http://127.0.0.1:9/v1");
  await editor.getByPlaceholder("手动输入模型 ID，回车添加").fill("gateway-model");
  await editor.getByPlaceholder("手动输入模型 ID，回车添加").press("Enter");
  await editor.getByRole("button", { name: "添加", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect.poll(() => readFileSync(join(harness.dataDir, "providers.json"), "utf8")).toContain("gateway-model");
});

test("switch settings between standalone page and centered modal", async ({ app }) => {
  await app.getByRole("button", { name: "设置" }).click();

  // Defaults to standalone full-window page mode
  const pageRegion = app.getByRole("region", { name: "设置" });
  await expect(pageRegion).toHaveAttribute("data-settings-mode", "page");
  await expect(pageRegion.locator(".settings-back-btn")).toBeVisible();

  // Switch live to centered modal via the header quick-toggle button
  await pageRegion.getByRole("button", { name: "切换为居中弹窗" }).click();
  const modalDialog = app.getByRole("dialog", { name: "设置" });
  await expect(modalDialog).toHaveAttribute("data-settings-mode", "modal");
  await expect(modalDialog.locator(".settings-close-circle")).toBeVisible();

  // Close and reopen: choice persists in settings
  await modalDialog.getByRole("button", { name: "返回应用" }).click();
  await expect(modalDialog).toHaveCount(0);
  await app.getByRole("button", { name: "设置" }).click();
  await expect(app.getByRole("dialog", { name: "设置" })).toHaveAttribute("data-settings-mode", "modal");

  // Switch back to standalone page from Appearance -> 设置页面展示方式
  await app.locator(".settings-nav-scroll").getByRole("button", { name: "外观" }).click();
  const modeGroup = app.getByRole("radiogroup", { name: "设置页面展示方式" });
  await expect(modeGroup.getByRole("radio", { name: "居中弹窗" })).toHaveAttribute("aria-checked", "true");
  await modeGroup.getByRole("radio", { name: "独立页面" }).click();
  await expect(app.getByRole("region", { name: "设置" })).toHaveAttribute("data-settings-mode", "page");
});
