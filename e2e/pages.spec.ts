import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_MODEL } from "../packages/host/test/e2e-host.ts";
import { expect, test, textReply } from "./fixtures.ts";

test("run a scheduled task now", async ({ app, harness }) => {
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

test("save a custom provider", async ({ app, harness }) => {
  await app.getByTitle("账户与设置").click();
  await app.getByRole("button", { name: "设置" }).click();
  await app.getByRole("button", { name: /模型与连接/ }).click();
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
