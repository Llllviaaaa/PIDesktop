import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { composer, expect, test, textReply } from "./fixtures.ts";

test("configure PR instructions & sandbox templates, create PR with AI draft, and send PR CI/review feedback to chat", async ({
  app,
  harness,
}) => {
  // 1. Configure `pullRequestInstructions`, `terminalShellArgs`, and Windows Sandbox / Dev Container configs in Settings.
  await app.getByTitle("设置与帮助").click();
  await app.getByRole("menuitem", { name: "模型与连接" }).click();

  // General settings (stacked Environment section) -> custom shell startup arguments.
  await app.locator(".settings-navigation").getByRole("button", { name: "通用设置" }).click();
  await app.getByLabel("Shell 启动参数").fill("-NoLogo -NoProfile");

  // Git & Engineering -> Pull Request instructions.
  await app.locator(".settings-navigation").getByRole("button", { name: "Git 与工程" }).click();
  await app.getByLabel("拉取请求说明").fill("必须附带回滚步骤与风险等级");

  // Agent & Safety -> enable lightweight sandbox + generate `.wsb` and `devcontainer.json`.
  await app.locator(".settings-navigation").getByRole("button", { name: "Agent 与安全" }).click();
  await app.getByRole("switch", { name: "启用 Windows 轻量沙箱（实验性）" }).click();

  await app.getByRole("button", { name: "生成 Windows Sandbox (.wsb)" }).click();
  const generatedBox = app.getByTestId("sandbox-generated-result");
  await expect(generatedBox).toBeVisible();
  await expect(generatedBox).toContainText("sandbox.wsb");
  const wsbPath = join(harness.workspace, ".pid", "sandbox.wsb");
  expect(existsSync(wsbPath)).toBe(true);
  expect(readFileSync(wsbPath, "utf8")).toContain("<ProtectedClient>Enable</ProtectedClient>");

  await app.getByRole("button", { name: "生成 Dev Container 配置" }).click();
  await expect(generatedBox).toContainText("devcontainer.json");
  const devcontainerPath = join(harness.workspace, ".devcontainer", "devcontainer.json");
  expect(existsSync(devcontainerPath)).toBe(true);
  expect(readFileSync(devcontainerPath, "utf8")).toContain("devcontainers/base:ubuntu");

  await app.getByRole("button", { name: "返回应用" }).click();

  // Verify Tauri `set_settings` received `sandboxEnabled`, `terminalShellArgs`, and `pullRequestInstructions`.
  await expect
    .poll(() =>
      app.evaluate(() => {
        const calls = (window as unknown as { __E2E_TAURI_CALLS__: Array<{ command: string; args?: Record<string, unknown> }> })
          .__E2E_TAURI_CALLS__;
        const saved = calls.filter((c) => c.command === "set_settings").at(-1)?.args?.settings as Record<string, unknown> | undefined;
        return saved
          ? {
              sandboxEnabled: saved.sandboxEnabled,
              terminalShellArgs: saved.terminalShellArgs,
              pullRequestInstructions: saved.pullRequestInstructions,
            }
          : null;
      }),
    )
    .toEqual({
      sandboxEnabled: true,
      terminalShellArgs: "-NoLogo -NoProfile",
      pullRequestInstructions: "必须附带回滚步骤与风险等级",
    });

  // 2. Seed PR stub data on window, open Pull Requests hub, generate AI PR draft, and submit `create_pull_request`.
  await app.evaluate((ws) => {
    Object.assign(window, {
      __E2E_GIT_REPO_ROOT__: ws,
      __E2E_PR_COLLECTION__: {
        repository: "PI-Desktop",
        remoteUrl: "https://github.com/example/PI-Desktop",
        items: [
          {
            number: 42,
            title: "feat: add M4 workbench loop",
            state: "OPEN",
            isDraft: false,
            headRefName: "feat/m4",
            baseRefName: "main",
            updatedAt: new Date().toISOString(),
            url: "https://github.com/example/PI-Desktop/pull/42",
            author: "alice",
            reviewDecision: "CHANGES_REQUESTED",
          },
        ],
      },
      __E2E_PR_DETAIL__: {
        42: {
          number: 42,
          title: "feat: add M4 workbench loop",
          body: "## Summary\nInitial implementation",
          url: "https://github.com/example/PI-Desktop/pull/42",
          state: "OPEN",
          isDraft: false,
          baseRefName: "main",
          headRefName: "feat/m4",
          author: "alice",
          reviewDecision: "CHANGES_REQUESTED",
          checks: [
            {
              name: "ci / unit-tests",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/example/PI-Desktop/actions/runs/101",
            },
          ],
          comments: [
            {
              id: "PRR_9",
              author: "reviewer-bob",
              body: "请在沙箱模式下补充 PATH 边界测试。",
              createdAt: "2026-11-04T10:00:00Z",
              kind: "review",
              reviewState: "CHANGES_REQUESTED",
            },
          ],
        },
      },
    });
  }, harness.workspace);

  await app.getByRole("button", { name: "拉取请求" }).click();
  await expect(app.getByRole("heading", { name: "拉取请求" })).toBeVisible();
  await expect(app.locator(".pull-request-card")).toContainText("#42");

  // Open Create PR modal and trigger AI draft generation via real `llm.complete`.
  harness.provider.push(
    textReply(
      JSON.stringify({
        title: "feat(m4): complete PR workbench and lightweight sandbox",
        body: "## 改动摘要\n- 新增桌面端 PR 创建闭环\n\n## 回滚步骤\n- git revert HEAD（风险等级：低）",
      }),
    ),
  );

  await app.getByTestId("open-create-pr-button").click();
  const createDialog = app.getByRole("dialog", { name: "创建拉取请求" });
  await expect(createDialog).toBeVisible();

  await createDialog.getByTestId("pr-ai-draft-button").click();
  await expect(createDialog.getByLabel("拉取请求标题")).toHaveValue(
    "feat(m4): complete PR workbench and lightweight sandbox",
  );
  await expect(createDialog.getByLabel("拉取请求描述")).toContainText("风险等级：低");

  // Confirm the user's `pullRequestInstructions` was passed into the model prompt!
  const lastRequest = harness.provider.requests.at(-1);
  expect(JSON.stringify(lastRequest?.messages ?? [])).toContain("必须附带回滚步骤与风险等级");

  await createDialog.getByTestId("pr-submit-create-button").click();
  await expect(createDialog).toHaveCount(0);
  await expect(app.getByTestId("pr-created-banner")).toContainText("#99");

  // 3. Expand PR #42 detail panel and send CI failure / review comment directly into Composer!
  await app.getByTestId("pr-toggle-detail-42").click();
  const detailPanel = app.getByTestId("pr-detail-42");
  await expect(detailPanel).toBeVisible();
  await expect(detailPanel).toContainText("ci / unit-tests");
  await expect(detailPanel).toContainText("@reviewer-bob");

  await detailPanel.getByTestId("pr-send-comment-PRR_9").click();
  await expect(composer(app)).toBeVisible();
  await expect(composer(app)).toHaveValue(/请在沙箱模式下补充 PATH 边界测试/);
});
