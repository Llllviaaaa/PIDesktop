import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composer, expect, test } from "./fixtures.ts";

test("install a local full-stack plugin, hot-reload its TSX UI, configure it, and uninstall", async ({ app }) => {
  const pluginDir = mkdtempSync(join(tmpdir(), "pid-e2e-ext-"));
  try {
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "e2e-fullstack-ext",
          version: "1.0.0",
          pid: {
            name: "E2E 全栈示例插件",
            description: "用于验证前端 TSX 即时编译、配置热应用与无刷新 HMR",
            host: "./host.ts",
            client: "./client.tsx",
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(pluginDir, "host.ts"),
      `
        export const inject = ["tools"];
        export function apply(ctx) {
          ctx.effect(() => ctx.tools.register({
            name: "e2e_ext_ping",
            description: "E2E dynamic tool",
            parameters: { type: "object", properties: {} },
            async execute() {
              return { content: [{ type: "text", text: "pong" }] };
            },
          }));
        }
      `,
    );
    writeFileSync(
      join(pluginDir, "client.tsx"),
      `
        import React from "react";
        export default function apply(ctx, config: { greeting?: string } = {}) {
          const badge = <span data-greeting={config.greeting ?? "default"}>v1</span>;
          ctx.effect(() => {
            document.documentElement.dataset.pidExtStatus = \`v1:\${badge.props["data-greeting"]}\`;
            return () => {
              delete document.documentElement.dataset.pidExtStatus;
            };
          });
        }
      `,
    );

    await app.getByTitle("设置与帮助").click();
    await app.getByRole("menuitem", { name: "插件扩展" }).click();

    await app.getByRole("button", { name: "安装插件" }).click();
    const dialog = app.getByRole("dialog", { name: "安装插件" });
    await dialog.getByLabel("本地插件目录路径").fill(pluginDir);
    await dialog.getByRole("button", { name: "立即安装并加载" }).click();
    await expect(dialog).toHaveCount(0);

    const card = app.locator('article[data-plugin-id="e2e-fullstack-ext"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText("E2E 全栈示例插件");
    await expect(card).toContainText("运行中");
    await expect(card).toContainText("本地链接");
    await expect(card).toContainText("后端 Host");
    await expect(card).toContainText("前端 UI");

    await expect
      .poll(() => app.evaluate(() => document.documentElement.dataset.pidExtStatus))
      .toBe("v1:default");

    // Edit JSON config and hot-apply without reloading the page.
    await card.getByRole("button", { name: "配置", exact: true }).click();
    await card.locator("textarea").fill('{"greeting": "custom"}');
    await card.getByRole("button", { name: "保存配置" }).click();
    await expect
      .poll(() => app.evaluate(() => document.documentElement.dataset.pidExtStatus))
      .toBe("v1:custom");

    // Update client.tsx on disk and trigger HMR reload.
    writeFileSync(
      join(pluginDir, "client.tsx"),
      `
        import React from "react";
        export default function apply(ctx, config: { greeting?: string } = {}) {
          const badge = <span data-greeting={config.greeting ?? "default"}>v2</span>;
          ctx.effect(() => {
            document.documentElement.dataset.pidExtStatus = \`v2:\${badge.props["data-greeting"]}\`;
            return () => {
              delete document.documentElement.dataset.pidExtStatus;
            };
          });
        }
      `,
    );
    await card.getByRole("button", { name: "热重载" }).click();
    await expect
      .poll(() => app.evaluate(() => document.documentElement.dataset.pidExtStatus))
      .toBe("v2:custom");

    // Disable plugin and verify Fiber cleanup.
    await card.getByRole("switch", { name: "停用 E2E 全栈示例插件" }).click();
    await expect(card).toContainText("已停用");
    await expect
      .poll(() => app.evaluate(() => document.documentElement.dataset.pidExtStatus))
      .toBeUndefined();

    // Remove plugin cleanly.
    await card.getByRole("button", { name: "卸载" }).click();
    await card.getByRole("button", { name: "确认卸载" }).click();
    await expect(card).toHaveCount(0);
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("gate untrusted workspace plugins behind the trust banner until approved", async ({ page, harness }) => {
  const wsPluginDir = join(harness.workspace, ".pid", "plugins", "repo-local-ui");
  mkdirSync(wsPluginDir, { recursive: true });
  writeFileSync(
    join(wsPluginDir, "package.json"),
    JSON.stringify(
      {
        name: "repo-local-ui",
        version: "0.1.0",
        pid: {
          name: "仓库内置工作台插件",
          client: "./client.tsx",
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(wsPluginDir, "client.tsx"),
    `
      export default function apply(ctx) {
        ctx.effect(() => {
          document.documentElement.dataset.repoTrustMounted = "yes";
          return () => {
            delete document.documentElement.dataset.repoTrustMounted;
          };
        });
      }
    `,
  );

  const token = (harness as unknown as { token: string }).token;
  const query = new URLSearchParams({ host: harness.host.baseUrl, token, workspace: harness.workspace });
  await page.goto(`/?${query}`);
  await expect(composer(page)).toBeEnabled();

  const banner = page.getByRole("region", { name: "工作区插件信任提示" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("repo-local-ui");

  // Untrusted workspace plugin must NOT execute before user approval.
  expect(await page.evaluate(() => document.documentElement.dataset.repoTrustMounted)).toBeUndefined();

  await banner.getByRole("button", { name: "信任并启用项目插件" }).click();
  await expect(banner).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.repoTrustMounted))
    .toBe("yes");
});
