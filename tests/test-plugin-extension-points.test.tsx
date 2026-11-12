/**
 * Extension points that let plugins reach host chrome that used to be closed:
 * Settings pages and sections, host menus, global keybindings, Markdown code
 * block renderers, and the SDK actions that navigate to plugin pages.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import * as qianjiClient from "@qianji/client";
import { CLIENT_SLOT_CATALOG } from "@qianji/protocol";
import { PluginMenuItems, hasMenuItems, visibleMenuItems } from "../src/components/common/PluginMenuItems";
import { Markdown } from "../src/components/Markdown";
import { SidebarThreadMenu } from "../src/components/sidebar/SidebarThreadMenu";
import { SidebarThreadRow } from "../src/components/sidebar/SidebarThreadRow";
import { SettingsModal } from "../src/components/SettingsModal";
import {
  PluginSettingsContent,
  pluginSettingsNavItems,
  sectionsForSettingsPage,
} from "../src/components/settings/settingsNavigation";
import {
  ClientContributionService,
  clientContributions,
  matchCodeBlockRenderer,
} from "../src/lib/clientContributions";
import { clearClientRenderError, getClientRenderErrors, tagFiberPluginId } from "../src/lib/clientPluginRuntime";
import {
  findKeybinding,
  installPluginKeybindings,
  keyChordFromEvent,
  normalizeKeyChord,
  runPluginCallback,
} from "../src/lib/pluginKeybindings";
import {
  bindShellNavigation,
  requestOpenHubPage,
  requestOpenSettings,
  resolveSettingsPageId,
} from "../src/lib/shellBridge";
import { generatePluginTypes } from "../scripts/generate-plugin-types.mjs";
import { withQueryClient } from "./support/withQueryClient";

const FILE_CONTEXT = {
  cwd: "/repo",
  sessionFile: null,
  path: "src/a.ts",
  absolutePath: "/repo/src/a.ts",
  line: 3,
};

function keydown(init: { key: string; code?: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }): Event {
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, code: "", ...init });
  return event;
}

afterEach(() => {
  clientContributions.clear();
  for (const id of Object.keys(getClientRenderErrors())) clearClientRenderError(id, false);
});

describe("contribution registry", () => {
  it("registers every new kind, sorts by order, and disposes only the exact entry", () => {
    const disposeB = clientContributions.registerSettingsPage({ id: "b", label: "B", order: 20, render: () => null });
    clientContributions.registerSettingsPage({ id: "a", label: "A", order: 10, render: () => null });
    clientContributions.registerSettingsSection({ id: "s", page: "general", render: () => null });
    clientContributions.registerMenuItem({ id: "m", location: "menubar.tools", label: "M", onSelect: () => undefined });
    clientContributions.registerKeybinding({ id: "k", key: "Ctrl+Shift+K", run: () => undefined });
    clientContributions.registerCodeBlockRenderer({ id: "c", languages: ["PlantUML"], render: () => null });

    const snapshot = clientContributions.getSnapshot();
    expect(snapshot.settingsPages.map((page) => page.id)).toEqual(["a", "b"]);
    expect(snapshot.settingsSections).toHaveLength(1);
    expect(snapshot.menuItems).toHaveLength(1);
    expect(snapshot.keybindings).toHaveLength(1);
    expect(snapshot.codeBlockRenderers).toHaveLength(1);

    // Re-registering the same id replaces it; the stale disposer must not remove the replacement.
    clientContributions.registerSettingsPage({ id: "b", label: "B2", render: () => null });
    disposeB();
    expect(clientContributions.getSnapshot().settingsPages.map((page) => page.label)).toEqual(["A", "B2"]);
  });

  it("documents every ClientContributionService register method in CLIENT_SLOT_CATALOG", () => {
    const serviceMethods = Object.getOwnPropertyNames(ClientContributionService.prototype)
      .filter((name) => name.startsWith("register"))
      .sort();
    const catalogMethods = CLIENT_SLOT_CATALOG.map((slot) => slot.method.replace("ctx.contributions.", "")).sort();
    expect(catalogMethods).toEqual(serviceMethods);
  });

  it("tags contributions with the plugin id and drops them when the plugin fiber disposes", async () => {
    const root = new Context();
    await root.plugin(ClientContributionService, clientContributions);
    root.on("internal/plugin", (fiber: object) => tagFiberPluginId(fiber, "ext-plugin"));
    const fiber = await root.plugin({
      name: "ext-plugin",
      inject: ["contributions"],
      apply(ctx: Context) {
        ctx.contributions.registerSettingsPage({ id: "ext", label: "Ext", render: () => null });
        ctx.contributions.registerMenuItem({ id: "ext-file", location: "file.context", label: "Ext", onSelect: () => undefined });
        ctx.contributions.registerKeybinding({ id: "ext-key", key: "F6", run: () => undefined });
      },
    });
    const snapshot = clientContributions.getSnapshot();
    expect(snapshot.settingsPages[0]?.pluginId).toBe("ext-plugin");
    expect(snapshot.menuItems[0]?.pluginId).toBe("ext-plugin");
    expect(snapshot.keybindings[0]?.pluginId).toBe("ext-plugin");

    await fiber.dispose();
    const after = clientContributions.getSnapshot();
    expect([after.settingsPages, after.menuItems, after.keybindings].every((list) => list.length === 0)).toBe(true);
  });
});

describe("menus", () => {
  it("renders items for one location only, honours when/disabled, and contains throwing predicates", () => {
    expect(renderToStaticMarkup(createElement(PluginMenuItems<"file.context">, {
      location: "file.context",
      context: FILE_CONTEXT,
      onClose: () => undefined,
      separatorClassName: "sep",
    }))).toBe("");

    clientContributions.registerMenuItem({
      id: "open-in-tool",
      pluginId: "tool-plugin",
      location: "file.context",
      label: "在工具中打开",
      shortcut: "Ctrl+Alt+T",
      onSelect: () => undefined,
    });
    clientContributions.registerMenuItem({
      id: "only-md",
      location: "file.context",
      label: "仅 Markdown",
      when: (ctx) => ctx.path.endsWith(".md"),
      onSelect: () => undefined,
    });
    clientContributions.registerMenuItem({
      id: "greyed",
      location: "file.context",
      label: "灰色",
      disabled: () => true,
      onSelect: () => undefined,
    });
    clientContributions.registerMenuItem({
      id: "broken-when",
      pluginId: "broken-plugin",
      location: "file.context",
      label: "坏掉的",
      when: () => {
        throw new Error("when exploded");
      },
      onSelect: () => undefined,
    });
    clientContributions.registerMenuItem({ id: "elsewhere", location: "thread.more", label: "别处", onSelect: () => undefined });

    const html = renderToStaticMarkup(createElement(PluginMenuItems<"file.context">, {
      location: "file.context",
      context: FILE_CONTEXT,
      onClose: () => undefined,
      separatorClassName: "sep",
    }));
    expect(html).toContain('<div class="sep" role="separator"></div>');
    expect(html).toContain("在工具中打开");
    expect(html).toContain('<kbd class="qj-plugin-menu-shortcut">Ctrl+Alt+T</kbd>');
    expect(html).toContain('data-qj-contributed-by="tool-plugin"');
    expect(html).not.toContain("data-qj-plugin=");
    expect(html).not.toContain("仅 Markdown");
    expect(html).not.toContain("坏掉的");
    expect(html).not.toContain("别处");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-qj-menu-item="greyed"/);
    expect(getClientRenderErrors()["broken-plugin"]?.failedSlots["menu:broken-when"]).toBe("when exploded");

    const items = clientContributions.getSnapshot().menuItems;
    expect(visibleMenuItems(items, "file.context", { ...FILE_CONTEXT, path: "README.md" }).map((item) => item.id))
      .toContain("only-md");
    expect(hasMenuItems(items, "menubar.tools")).toBe(false);
    expect(hasMenuItems(items, "thread.more")).toBe(true);
  });

  it("adds a session right-click menu with built-in pin/archive and sidebar.thread plugin items", () => {
    const session = { file: "/sessions/a.jsonl", sessionId: "a", cwd: "/work/app", name: "修复登录", messageCount: 4 };
    const menuProps = {
      menu: { session, top: 120 },
      pinned: true,
      onClose: () => undefined,
      onTogglePinned: () => undefined,
      onArchive: () => undefined,
    };
    const builtinOnly = renderToStaticMarkup(createElement(SidebarThreadMenu, menuProps));
    expect(builtinOnly).toContain("取消置顶对话");
    expect(builtinOnly).toContain("归档对话");
    expect(builtinOnly).not.toContain("sidebar-popover-separator");

    const seen: unknown[] = [];
    clientContributions.registerMenuItem({
      id: "export-session",
      location: "sidebar.thread",
      label: "导出会话",
      when: (ctx) => {
        seen.push(ctx);
        return true;
      },
      onSelect: () => undefined,
    });
    clientContributions.registerMenuItem({ id: "project-only", location: "sidebar.project", label: "项目项", onSelect: () => undefined });
    const withPlugin = renderToStaticMarkup(createElement(SidebarThreadMenu, menuProps));
    expect(withPlugin).toContain('<div class="sidebar-popover-separator" role="separator"></div>');
    expect(withPlugin).toContain("导出会话");
    expect(withPlugin).not.toContain("项目项");
    expect(seen).toEqual([{ cwd: "/work/app", sessionFile: "/sessions/a.jsonl", title: "修复登录" }]);

    // The row hands right-clicks to the menu opener.
    const onContextMenu = vi.fn();
    const row = SidebarThreadRow({
      session,
      active: false,
      running: false,
      approval: false,
      pinned: false,
      onOpen: () => undefined,
      onTogglePinned: () => undefined,
      onArchive: () => undefined,
      onShowPreview: () => undefined,
      onHidePreview: () => undefined,
      onContextMenu,
    });
    expect(row.props.onContextMenu).toBe(onContextMenu);
  });

  it("runs plugin callbacks without letting sync throws or rejections escape", async () => {
    expect(() => runPluginCallback("cb-plugin", "menu:sync", () => {
      throw new Error("sync boom");
    })).not.toThrow();
    runPluginCallback("cb-plugin", "menu:async", () => Promise.reject(new Error("async boom")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = getClientRenderErrors()["cb-plugin"]?.failedSlots;
    expect(failed?.["menu:sync"]).toBe("sync boom");
    expect(failed?.["menu:async"]).toBe("async boom");
  });
});

describe("keybindings", () => {
  it("normalizes chord strings and keyboard events to the same canonical form", () => {
    expect(normalizeKeyChord("Cmd+Shift+K")).toBe("ctrl+shift+k");
    expect(normalizeKeyChord(" shift + ctrl + k ")).toBe("ctrl+shift+k");
    expect(normalizeKeyChord("Option+F2")).toBe("alt+f2");
    expect(normalizeKeyChord("Ctrl++")).toBe("ctrl++");
    expect(normalizeKeyChord("Ctrl+Space")).toBe("ctrl+space");
    expect(normalizeKeyChord("Ctrl+Shift")).toBe("");

    expect(keyChordFromEvent({ key: "K", code: "KeyK", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true })).toBe("ctrl+shift+k");
    expect(keyChordFromEvent({ key: "!", code: "Digit1", ctrlKey: false, metaKey: false, altKey: false, shiftKey: true })).toBe("shift+1");
    expect(keyChordFromEvent({ key: "k", code: "KeyK", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBe("ctrl+k");
    expect(keyChordFromEvent({ key: " ", code: "Space", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false })).toBe("ctrl+space");
    expect(keyChordFromEvent({ key: "Shift", code: "ShiftLeft", ctrlKey: false, metaKey: false, altKey: false, shiftKey: true })).toBeNull();
  });

  it("skips bindings in editable targets unless they opt in", () => {
    const plain = { id: "plain", key: "Ctrl+Shift+P", run: () => undefined };
    const editable = { id: "editable", key: "Ctrl+Shift+P", allowInEditable: true, order: 200, run: () => undefined };
    expect(findKeybinding([plain, editable], "ctrl+shift+p", false)?.id).toBe("plain");
    expect(findKeybinding([plain, editable], "ctrl+shift+p", true)?.id).toBe("editable");
    expect(findKeybinding([plain], "ctrl+shift+p", true)).toBeUndefined();
  });

  it("dispatches matching keys, yields to handled events, and isolates failing handlers", () => {
    const target = new EventTarget();
    const run = vi.fn();
    clientContributions.registerKeybinding({ id: "go", pluginId: "keys-plugin", key: "Ctrl+Shift+G", run });
    clientContributions.registerKeybinding({
      id: "boom",
      pluginId: "keys-plugin",
      key: "F7",
      run: () => {
        throw new Error("key boom");
      },
    });
    const dispose = installPluginKeybindings({
      getKeybindings: () => clientContributions.getSnapshot().keybindings,
      getContext: () => ({ cwd: "/repo", sessionFile: "s.jsonl" }),
    }, target as unknown as Window);

    const matching = keydown({ key: "G", code: "KeyG", ctrlKey: true, shiftKey: true });
    target.dispatchEvent(matching);
    expect(run).toHaveBeenCalledWith({ cwd: "/repo", sessionFile: "s.jsonl" });
    expect(matching.defaultPrevented).toBe(true);

    // A built-in shortcut that already handled the key wins.
    const handled = keydown({ key: "G", code: "KeyG", ctrlKey: true, shiftKey: true });
    handled.preventDefault();
    target.dispatchEvent(handled);
    expect(run).toHaveBeenCalledTimes(1);

    const unrelated = keydown({ key: "x", code: "KeyX", ctrlKey: true });
    target.dispatchEvent(unrelated);
    expect(unrelated.defaultPrevented).toBe(false);

    expect(() => target.dispatchEvent(keydown({ key: "F7" }))).not.toThrow();
    expect(getClientRenderErrors()["keys-plugin"]?.failedSlots["keybinding:boom"]).toBe("key boom");

    dispose();
    target.dispatchEvent(keydown({ key: "G", code: "KeyG", ctrlKey: true, shiftKey: true }));
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("settings pages and sections", () => {
  it("maps plugin pages to plugin:<id> nav entries and routes sections to their page", () => {
    clientContributions.registerSettingsPage({ id: "sync", label: "同步", subtitle: "云同步", wide: true, render: () => null });
    const [nav] = pluginSettingsNavItems(clientContributions.getSnapshot().settingsPages);
    expect(nav).toMatchObject({ id: "plugin:sync", label: "同步", heading: "同步", subtitle: "云同步", wide: true });

    const sections = [
      { id: "on-general", page: "general", render: () => null },
      { id: "on-sync", page: "sync", render: () => null },
      { id: "on-sync-prefixed", page: "plugin:sync", render: () => null },
    ];
    expect(sectionsForSettingsPage(sections, "general").map((s) => s.id)).toEqual(["on-general"]);
    expect(sectionsForSettingsPage(sections, "plugin:sync").map((s) => s.id)).toEqual(["on-sync", "on-sync-prefixed"]);
    expect(sectionsForSettingsPage(sections, "appearance")).toEqual([]);
  });

  it("renders plugin section cards inside isolated slot hosts", () => {
    const html = renderToStaticMarkup(createElement(PluginSettingsContent, {
      page: { id: "general", label: "通用", heading: "通用", subtitle: "", icon: null, wide: false },
      sections: [{
        id: "backup",
        pluginId: "backup-plugin",
        page: "general",
        title: "自动备份",
        render: ({ page }) => createElement("p", null, `备份设置@${page}`),
      }],
      context: { cwd: "/repo", sessionFile: null, page: "general", closeSettings: () => undefined },
    }));
    expect(html).toContain("<h2>自动备份</h2>");
    expect(html).toContain("备份设置@general");
    expect(html).toContain('data-qj-plugin="backup-plugin"');
    expect(html).toContain('data-qj-slot="settings.sections"');
  });

  it("adds an 扩展 group to the Settings sidebar and opens a plugin page with its sections", () => {
    clientContributions.registerSettingsPage({
      id: "sync",
      pluginId: "sync-plugin",
      label: "云同步",
      subtitle: "跨设备同步会话",
      render: ({ cwd }) => createElement("div", { className: "sync-body" }, `同步页@${cwd}`),
    });
    clientContributions.registerSettingsSection({
      id: "sync-extra",
      pluginId: "sync-plugin",
      page: "sync",
      title: "高级",
      render: () => createElement("span", null, "高级同步选项"),
    });
    const html = renderToStaticMarkup(withQueryClient(createElement(SettingsModal, {
      settings: null,
      cwd: "/repo",
      initialPage: "plugin:sync",
      onSave: () => undefined,
      onClose: () => undefined,
    })));
    expect(html).toContain('class="settings-nav-group-label">扩展</div>');
    expect(html).toContain("云同步");
    expect(html).toContain("跨设备同步会话");
    expect(html).toContain("同步页@/repo");
    expect(html).toContain("高级同步选项");
    expect(html).toMatch(/<button[^>]*class="active"[^>]*data-qj-contributed-by="sync-plugin"/);
  });

  it("falls back to the general page when the requested plugin page is not registered", () => {
    const html = renderToStaticMarkup(withQueryClient(createElement(SettingsModal, {
      settings: null,
      cwd: "/repo",
      initialPage: "plugin:missing",
      onSave: () => undefined,
      onClose: () => undefined,
    })));
    expect(html).not.toContain("settings-nav-group-label");
    expect(html).toContain("对话与输入");
  });
});

describe("markdown code block renderers", () => {
  it("matches fence languages case-insensitively", () => {
    const renderers = [{ id: "puml", languages: ["PlantUML", " puml "], render: () => null }];
    expect(matchCodeBlockRenderer(renderers, "plantuml")?.id).toBe("puml");
    expect(matchCodeBlockRenderer(renderers, "PUML")?.id).toBe("puml");
    expect(matchCodeBlockRenderer(renderers, "")).toBeUndefined();
    expect(matchCodeBlockRenderer(renderers, "mermaid")).toBeUndefined();
  });

  it("hands registered fences to the plugin and leaves the rest to the built-in renderers", () => {
    clientContributions.registerCodeBlockRenderer({
      id: "chart-fence",
      pluginId: "chart-plugin",
      languages: ["chart", "plantuml"],
      render: ({ language, code }) => createElement("figure", { className: "plugin-chart" }, `${language}:${code}`),
    });
    const chart = renderToStaticMarkup(withQueryClient(createElement(Markdown, {
      content: "```chart\nbar 1 2 3\n```",
    })));
    expect(chart).toContain('<figure class="plugin-chart">chart:bar 1 2 3</figure>');
    expect(chart).toContain('data-qj-slot="markdown.codeBlock"');
    expect(chart).toContain('data-qj-plugin="chart-plugin"');

    // Plugins may replace a built-in diagram renderer.
    const plantUml = renderToStaticMarkup(withQueryClient(createElement(Markdown, {
      content: "```plantuml\n@startuml\nA -> B\n@enduml\n```",
    })));
    expect(plantUml).toContain("plantuml:@startuml");
    expect(plantUml).not.toContain("PlantUML 图形");

    const typescript = renderToStaticMarkup(withQueryClient(createElement(Markdown, {
      content: "```ts\nconst value = 1;\n```",
    })));
    expect(typescript).toContain('class="markdown-code"');
    expect(typescript).not.toContain("plugin-chart");
  });
});

describe("shell navigation bridge", () => {
  it("resolves settings page ids", () => {
    expect(resolveSettingsPageId()).toBe("general");
    expect(resolveSettingsPageId(" appearance ")).toBe("appearance");
    expect(resolveSettingsPageId("sync")).toBe("plugin:sync");
    expect(resolveSettingsPageId("plugin:sync")).toBe("plugin:sync");
  });

  it("routes SDK navigation through the bound shell and reports when nothing is bound", () => {
    expect(qianjiClient.openSettingsPage("sync")).toBe(false);
    expect(requestOpenHubPage("board")).toBe(false);

    const openSettings = vi.fn();
    const openHubPage = vi.fn();
    const unbind = bindShellNavigation({ openSettings, openHubPage });
    expect(qianjiClient.openSettingsPage("sync")).toBe(true);
    expect(qianjiClient.openSettingsPage()).toBe(true);
    expect(openSettings.mock.calls).toEqual([["plugin:sync"], ["general"]]);
    expect(qianjiClient.openPluginPage("plugin:board")).toBe(true);
    expect(qianjiClient.openPluginPage("  ")).toBe(false);
    expect(openHubPage.mock.calls).toEqual([["board"]]);

    // A stale unbind must not detach a newer binding.
    const rebound = vi.fn();
    const unbindNewer = bindShellNavigation({ openSettings: rebound, openHubPage });
    unbind();
    expect(requestOpenSettings("plugins")).toBe(true);
    expect(rebound).toHaveBeenCalledWith("plugins");
    unbindNewer();
    expect(requestOpenSettings("plugins")).toBe(false);
  });
});

describe("offline plugin types", () => {
  it("type-check a plugin that uses every new extension point", () => {
    const tempBase = mkdtempSync(join(tmpdir(), "qj-plugin-ext-types-"));
    const typesDir = join(tempBase, "plugin-types");
    const pluginDir = join(tempBase, "ext-plugin");
    try {
      generatePluginTypes({ targetDir: typesDir });
      mkdirSync(pluginDir, { recursive: true });
      const relTypes = relative(pluginDir, typesDir).replace(/\\/g, "/");
      writeFileSync(join(pluginDir, "tsconfig.json"), JSON.stringify({
        extends: `${relTypes}/tsconfig.plugin.json`,
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "react/jsx-runtime": [`${relTypes}/react/jsx-runtime.d.ts`],
            "react/jsx-dev-runtime": [`${relTypes}/react/jsx-dev-runtime.d.ts`],
            "*": [`${relTypes}/*/index.d.ts`, `${relTypes}/*`],
          },
        },
        include: ["client.tsx"],
      }), "utf8");
      writeFileSync(join(pluginDir, "client.tsx"), `import type { Context } from "@deepseek-ai/cordis";
import { Sparkles } from "lucide-react";
import { openPluginPage, openSettingsPage, openWorkspaceFile, showToast } from "@qianji/client";

export const name = "ext-client";
export const inject = ["contributions"];
export function apply(ctx: Context) {
  ctx.contributions.registerSettingsPage({
    id: "cloud-sync",
    label: "云同步",
    icon: <Sparkles size={15} />,
    render: ({ page, closeSettings }) => <button type="button" onClick={closeSettings}>{page}</button>,
  });
  ctx.contributions.registerSettingsSection({
    id: "cloud-sync-general",
    page: "general",
    title: "云同步",
    render: () => <button type="button" onClick={() => openSettingsPage("cloud-sync")}>打开</button>,
  });
  ctx.contributions.registerMenuItem({
    id: "open-file-line",
    location: "file.context",
    label: "跳到该行",
    when: ({ line }) => line !== undefined,
    onSelect: ({ path, line }) => openWorkspaceFile(path, line),
  });
  ctx.contributions.registerMenuItem({
    id: "project-count",
    location: "sidebar.project",
    label: "统计对话",
    onSelect: ({ workspace, sessionFiles }) => showToast(workspace + ":" + sessionFiles.length),
  });
  ctx.contributions.registerMenuItem({
    id: "session-title",
    location: "sidebar.thread",
    label: "复制标题",
    onSelect: ({ title, sessionFile }) => showToast(title + sessionFile),
  });
  ctx.contributions.registerMenuItem({
    id: "tools-board",
    location: "menubar.tools",
    label: "看板",
    shortcut: "Ctrl+Alt+K",
    onSelect: () => { openPluginPage("board"); },
  });
  ctx.contributions.registerKeybinding({
    id: "board-key",
    key: "Ctrl+Alt+K",
    run: ({ cwd }) => showToast(cwd),
  });
  ctx.contributions.registerCodeBlockRenderer({
    id: "chart",
    languages: ["chart"],
    render: ({ language, code }) => <pre data-lang={language}>{code}</pre>,
  });
}
`, "utf8");
      const configPath = join(pluginDir, "tsconfig.json");
      const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, pluginDir);
      const program = ts.createProgram(parsed.fileNames, parsed.options);
      const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(diagnostics).toEqual([]);
    } finally {
      rmSync(tempBase, { recursive: true, force: true });
    }
  }, 30_000);
});
