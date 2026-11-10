import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answer, expect, send, settled, test, textReply, toolReply } from "./fixtures.ts";

test("save native Gemini provider with custom pricing and approve desktop_memory diff", async ({
  app,
  harness,
}) => {
  // 1. Native Gemini adapter + custom model pricing without requiring baseUrl.
  await app.getByRole("button", { name: "设置" }).click();
  await app.locator(".settings-nav-scroll").getByRole("button", { name: "模型" }).click();
  await app.getByRole("button", { name: "添加自定义提供商" }).click();

  const editor = app.getByRole("dialog", { name: "添加自定义提供商" });
  await editor.getByPlaceholder("例如 公司网关 或 本地 Ollama").fill("Google Gemini Direct");
  await editor.getByLabel("接口协议").selectOption("google-generative-ai");
  await editor.getByPlaceholder("手动输入模型 ID，回车添加").fill("gemini-2.5-pro");
  await editor.getByPlaceholder("手动输入模型 ID，回车添加").press("Enter");
  await editor.getByRole("button", { name: "详情" }).click();
  await editor.getByLabel("输入单价 ($/M)").fill("1.5");
  await editor.getByLabel("输出单价 ($/M)").fill("12");
  await editor.getByRole("button", { name: "添加", exact: true }).click();
  await expect(editor).toHaveCount(0);

  await expect.poll(() => readFileSync(join(harness.dataDir, "providers.json"), "utf8")).toContain('"api": "gemini"');
  expect(readFileSync(join(harness.dataDir, "providers.json"), "utf8")).toContain('"input": 1.5');

  await app.getByRole("button", { name: "返回应用" }).click();

  // 2. Unified Diff approval when Agent writes to project memory via `desktop_memory`.
  harness.provider.push(
    toolReply([
      {
        id: "call-mem-1",
        name: "desktop_memory",
        args: { action: "append", scope: "project", content: "新增约定：使用 Vitest" },
      },
    ]),
    textReply("已写入项目记忆。", { inputTokens: 120, outputTokens: 45, reasoningTokens: 18 }),
  );

  await send(app, "请把使用 Vitest 记录到项目记忆中");
  const diffDialog = app.getByRole("dialog", { name: /项目记忆/ });
  await expect(diffDialog).toBeVisible();
  const diffPreview = diffDialog.locator(".question-diff-preview");
  await expect(diffPreview).toBeVisible();
  await expect(diffPreview.locator(".diff-meta").first()).toContainText("--- a/.qianji/memory.md");
  await expect(diffPreview.locator(".diff-add", { hasText: "+新增约定：使用 Vitest" })).toBeVisible();

  await diffDialog.getByRole("button", { name: "允许一次" }).click();
  await settled(app);
  await expect(answer(app, "已写入项目记忆。")).toBeVisible();

  const updatedProjectMemory = readFileSync(join(harness.workspace, ".qianji", "memory.md"), "utf8");
  expect(updatedProjectMemory).toContain("新增约定：使用 Vitest");
});
