import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answer, composer, expect, send, settled, test, textReply, toolReply } from "./fixtures.ts";

test("save native Gemini provider with custom pricing, edit dual-layer memory with diff approval, and manage skills", async ({
  app,
  harness,
}) => {
  // 1. Native Gemini adapter + custom model pricing without requiring baseUrl.
  await app.getByTitle("设置与帮助").click();
  await app.getByRole("menuitem", { name: "模型与连接" }).click();
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

  // 2. Dual-layer Memory 2.0: edit & save both Global and Project memory in Settings.
  await app.locator(".settings-navigation").getByRole("button", { name: "外观与体验" }).click();
  const globalTextarea = app.getByLabel("全局记忆内容");
  await expect(globalTextarea).toBeVisible();
  await globalTextarea.fill("全局偏好：优先运行单测");
  await app.getByRole("button", { name: "保存记忆" }).click();
  await expect.poll(() => readFileSync(join(harness.dataDir, "memory.md"), "utf8")).toContain("全局偏好：优先运行单测");

  await app.getByRole("tab", { name: /当前项目记忆/ }).click();
  const projectTextarea = app.getByLabel("当前项目记忆内容");
  await expect(projectTextarea).toBeVisible();
  await projectTextarea.fill("项目规范：禁止跳过 lint");
  await app.getByRole("button", { name: "保存记忆" }).click();
  await expect
    .poll(() => readFileSync(join(harness.workspace, ".pid", "memory.md"), "utf8"))
    .toContain("项目规范：禁止跳过 lint");

  // 3. Skills Center: create a project skill from template and verify live `/skill:<name>` sync.
  await app.locator(".settings-navigation").getByRole("button", { name: "能力扩展" }).click();
  await app.getByRole("tab", { name: "技能", exact: true }).click();
  await app.getByRole("button", { name: "新建技能" }).click();
  await app.getByPlaceholder("例如：fix-ci").fill("fix-ci");
  await app.getByPlaceholder(/简述何时使用此技能/).fill("排查并修复 CI 与单测失败");
  await app.getByRole("button", { name: "创建并打开编辑" }).click();

  await expect(app.getByLabel("编辑 fix-ci SKILL.md")).toContainText("name: fix-ci");
  await app.getByRole("button", { name: "返回应用" }).click();

  // Typing `/skill:` in the Composer immediately shows `/skill:fix-ci`.
  await composer(app).fill("/skill:");
  const suggestionMenu = app.getByRole("listbox", { name: "快捷指令" });
  await expect(suggestionMenu).toBeVisible();
  await expect(suggestionMenu).toContainText("/skill:fix-ci");

  // Disable the skill in Settings and verify `/skill:fix-ci` disappears from Composer.
  await composer(app).fill("");
  await app.getByTitle("设置与帮助").click();
  await app.getByRole("menuitem", { name: "插件扩展" }).click();
  await app.getByRole("tab", { name: "技能", exact: true }).click();
  await app.getByRole("switch", { name: "启用技能 fix-ci" }).click();
  await expect(app.locator(".skill-disabled-badge")).toBeVisible();
  await app.getByRole("button", { name: "返回应用" }).click();

  await composer(app).fill("/skill:fix-ci");
  await expect(suggestionMenu).toHaveCount(0);
  await composer(app).fill("");

  // 4. Unified Diff approval when Agent writes to project memory via `desktop_memory`.
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
  await expect(diffPreview.locator(".diff-meta").first()).toContainText("--- a/.pid/memory.md");
  await expect(diffPreview.locator(".diff-add", { hasText: "+新增约定：使用 Vitest" })).toBeVisible();

  await diffDialog.getByRole("button", { name: "允许一次" }).click();
  await settled(app);
  await expect(answer(app, "已写入项目记忆。")).toBeVisible();

  const updatedProjectMemory = readFileSync(join(harness.workspace, ".pid", "memory.md"), "utf8");
  expect(updatedProjectMemory).toContain("项目规范：禁止跳过 lint");
  expect(updatedProjectMemory).toContain("新增约定：使用 Vitest");
});
