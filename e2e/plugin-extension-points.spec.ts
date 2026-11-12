import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, send, settled, test, textReply } from "./fixtures.ts";

/**
 * One client plugin reaching every host surface that used to be closed to plugins:
 * Settings pages/sections, the window menubar, the thread "…" menu, the session and
 * file right-click menus, global keybindings, and Markdown fence renderers.
 */
const CLIENT_SOURCE = `
import type { Context } from "@deepseek-ai/cordis";
import { openSettingsPage } from "@qianji/client";

const mark = (key: string, value: string) => {
  document.documentElement.dataset[key] = value;
};

export const name = "e2e-ext-points-client";
export const inject = ["contributions"];
export function apply(ctx: Context) {
  ctx.contributions.registerSettingsPage({
    id: "ext-points",
    label: "扩展点演示",
    subtitle: "插件贡献的设置页",
    render: ({ page }) => <div data-testid="ext-settings-page">设置页内容@{page}</div>,
  });
  ctx.contributions.registerSettingsSection({
    id: "ext-general-card",
    page: "general",
    title: "扩展点卡片",
    render: () => <p data-testid="ext-general-section">通用页插件卡片</p>,
  });
  ctx.contributions.registerMenuItem({
    id: "ext-tools",
    location: "menubar.tools",
    label: "演示工具项",
    onSelect: () => mark("extTool", "ran"),
  });
  ctx.contributions.registerMenuItem({
    id: "ext-help",
    location: "menubar.help",
    label: "打开扩展点设置",
    onSelect: () => { openSettingsPage("ext-points"); },
  });
  ctx.contributions.registerMenuItem({
    id: "ext-thread",
    location: "thread.more",
    label: "插件线程项",
    onSelect: ({ sessionFile }) => mark("extThread", sessionFile ?? "none"),
  });
  ctx.contributions.registerMenuItem({
    id: "ext-session",
    location: "sidebar.thread",
    label: "插件会话项",
    onSelect: ({ title }) => mark("extSession", title),
  });
  ctx.contributions.registerMenuItem({
    id: "ext-file",
    location: "file.context",
    label: "插件文件项",
    onSelect: ({ path }) => mark("extFile", path),
  });
  ctx.contributions.registerKeybinding({
    id: "ext-key",
    key: "Ctrl+Alt+Y",
    run: () => mark("extKey", "pressed"),
  });
  ctx.contributions.registerCodeBlockRenderer({
    id: "ext-fence",
    languages: ["extchart"],
    render: ({ code }) => <div data-testid="ext-fence">图表:{code}</div>,
  });
}
`;

const dataset = (app: Page, key: string) => app.evaluate((name) => document.documentElement.dataset[name], key);

async function installPlugin(app: Page, pluginDir: string): Promise<void> {
  await app.getByRole("button", { name: "设置" }).click();
  await app.locator(".settings-nav-scroll").getByRole("button", { name: "插件" }).click();
  await app.getByRole("button", { name: "安装插件" }).click();
  const dialog = app.getByRole("dialog", { name: "安装插件" });
  await dialog.getByLabel("本地插件目录路径").fill(pluginDir);
  await dialog.getByRole("button", { name: "立即安装并加载" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(app.locator('article[data-plugin-id="e2e-ext-points"]')).toContainText("运行中");
}

test("a client plugin extends settings, menus, keybindings, file and session menus, and Markdown fences", async ({ app, harness }) => {
  const pluginDir = mkdtempSync(join(tmpdir(), "qj-e2e-ext-points-"));
  try {
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({
      name: "e2e-ext-points",
      version: "1.0.0",
      qianji: { name: "E2E 扩展点插件", client: "./client.tsx" },
    }, null, 2));
    writeFileSync(join(pluginDir, "client.tsx"), CLIENT_SOURCE);
    await installPlugin(app, pluginDir);

    // Settings: an 扩展 group with the plugin page, and a card on the built-in General page.
    const nav = app.locator(".settings-nav-scroll");
    await expect(nav.locator(".settings-nav-group-label")).toHaveText("扩展");
    await nav.getByRole("button", { name: "扩展点演示" }).click();
    await expect(app.getByTestId("ext-settings-page")).toHaveText("设置页内容@plugin:ext-points");
    await expect(app.locator(".settings-header-sub")).toHaveText("插件贡献的设置页");
    await nav.getByRole("button", { name: "通用" }).click();
    await expect(app.locator(".settings-plugin-section h2")).toHaveText("扩展点卡片");
    await expect(app.getByTestId("ext-general-section")).toBeVisible();
    await app.getByRole("button", { name: "返回应用" }).first().click();
    await expect(nav).toHaveCount(0);

    // Menubar: the 工具 menu appears for plugin items; a 帮助 item opens the plugin settings page.
    const menubar = app.locator(".app-menu-bar");
    await menubar.getByRole("button", { name: "工具" }).click();
    await app.locator(".app-menu-dropdown").getByRole("menuitem", { name: "演示工具项" }).click();
    await expect.poll(() => dataset(app, "extTool")).toBe("ran");
    await menubar.getByRole("button", { name: "帮助" }).click();
    await app.locator(".app-menu-dropdown").getByRole("menuitem", { name: "打开扩展点设置" }).click();
    await expect(app.getByTestId("ext-settings-page")).toBeVisible();
    await app.getByRole("button", { name: "返回应用" }).first().click();

    // Keybinding: fires outside text fields.
    await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await app.keyboard.press("Control+Alt+KeyY");
    await expect.poll(() => dataset(app, "extKey")).toBe("pressed");

    // Workbench file tree: right-click shows plugin file items.
    await app.getByRole("button", { name: "切换右侧工作台 (Ctrl+Alt+B)" }).click();
    await app.locator('[data-wb-tab="files"]').click();
    await app.locator(".pid-wb-tree-row", { hasText: "notes.txt" }).click({ button: "right" });
    await app.locator(".file-context-menu").getByRole("menuitem", { name: "插件文件项" }).click();
    await expect.poll(() => dataset(app, "extFile")).toContain("notes.txt");

    // Markdown: a fence in a reply is rendered by the plugin.
    harness.provider.push(textReply("Here is the chart:\n\n```extchart\n1 2 3\n```"));
    await send(app, "画一个图");
    await settled(app);
    await expect(app.getByTestId("ext-fence")).toHaveText("图表:1 2 3");

    // Thread "…" menu in the top bar.
    await app.getByTitle("线程操作").click();
    await app.locator(".title-menu").getByRole("menuitem", { name: "插件线程项" }).click();
    await expect.poll(() => dataset(app, "extThread")).toMatch(/\S/);
    expect(await dataset(app, "extThread")).not.toBe("none");

    // Session row right-click: built-in pin/archive plus the plugin item.
    await app.locator(".thread-row-shell").first().click({ button: "right" });
    const sessionMenu = app.locator(".thread-context-menu");
    await expect(sessionMenu.getByRole("menuitem", { name: "置顶对话" })).toBeVisible();
    await expect(sessionMenu.getByRole("menuitem", { name: "归档对话" })).toBeVisible();
    await sessionMenu.getByRole("menuitem", { name: "插件会话项" }).click();
    await expect(sessionMenu).toHaveCount(0);
    await expect.poll(() => dataset(app, "extSession")).toMatch(/\S/);
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
});
