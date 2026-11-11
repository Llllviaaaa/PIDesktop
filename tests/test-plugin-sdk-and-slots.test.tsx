import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import * as qianjiClient from "@qianji/client";
import { PluginSlot } from "../src/components/common/PluginSlot";
import {
  hasRenderableConfigSchema,
  PluginConfigSchemaForm,
} from "../src/components/plugins/PluginConfigSchemaForm";
import { ToolCall } from "../src/components/ToolCall";
import { CodeEditorTab } from "../src/components/workbench/CodeEditorTab";
import {
  ClientContributionService,
  ClientStylesService,
  clientContributions,
  matchFileViewer,
  matchToolRenderer,
} from "../src/lib/clientContributions";
import { BetterSidebarCompatService } from "../src/lib/clientPluginBootstrap";
import { tagFiberPluginId, wrapPluginScopedCss } from "../src/lib/clientPluginRuntime";
import { useWorkbenchStore } from "../src/stores/workbenchStore";
import { generatePluginTypes } from "../scripts/generate-plugin-types.mjs";

interface MockStyleNode {
  tagName: string;
  textContent: string;
  isConnected: boolean;
  attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  remove(): void;
}

function installMockStyleDom() {
  const headChildren: MockStyleNode[] = [];
  const head = {
    children: headChildren,
    appendChild(node: MockStyleNode) {
      if (!headChildren.includes(node)) headChildren.push(node);
      node.isConnected = true;
      return node;
    },
    querySelector(selector: string): MockStyleNode | null {
      const attrMatch = /^style\[data-qj-plugin-style="([^"]+)"\]$/.exec(selector);
      if (!attrMatch) return null;
      return headChildren.find((item) => item.attributes.get("data-qj-plugin-style") === attrMatch[1]) ?? null;
    },
  };
  const mockDoc = {
    head,
    createElement(tag: string): MockStyleNode {
      const attrs = new Map<string, string>();
      const node: MockStyleNode = {
        tagName: tag.toUpperCase(),
        textContent: "",
        isConnected: false,
        attributes: attrs,
        setAttribute(name: string, value: string) {
          attrs.set(name, value);
        },
        getAttribute(name: string) {
          return attrs.get(name) ?? null;
        },
        remove() {
          node.isConnected = false;
          const idx = headChildren.indexOf(node);
          if (idx >= 0) headChildren.splice(idx, 1);
        },
      };
      return node;
    },
    querySelectorAll(selector: string): MockStyleNode[] {
      const found = head.querySelector(selector);
      return found ? [found] : [];
    },
  };

  const prevDocument = globalThis.document;
  (globalThis as Record<string, unknown>).document = mockDoc;

  return {
    head,
    restore() {
      if (prevDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        globalThis.document = prevDocument;
      }
    },
  };
}

function findElementById(node: ReactNode, targetId: string): { type: unknown; props: Record<string, unknown> } | undefined {
  if (!isValidElement(node)) return undefined;
  const props = node.props as Record<string, unknown>;
  if (props.id === targetId) {
    return { type: node.type, props };
  }
  const children = props.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const match = findElementById(child as ReactNode, targetId);
      if (match !== undefined) return match;
    }
    return undefined;
  }
  if (children !== undefined && children !== null) {
    return findElementById(children as ReactNode, targetId);
  }
  return undefined;
}

describe("Phase 2: @qianji/client SDK, CSS @scope sandbox, PluginSlot & 6 business extension points", () => {
  afterEach(() => {
    clientContributions.clear();
    useWorkbenchStore.getState().resetForTest();
  });

  it("locks the public @qianji/client SDK export surface and slot catalog", () => {
    const publicKeys = Object.keys(qianjiClient.qianjiClientSdk).sort();
    expect(publicKeys).toEqual([
      "CLIENT_SLOT_CATALOG",
      "agent",
      "callHostRpc",
      "clientContributions",
      "getActiveSessionSnapshot",
      "harnessRuntimes",
      "messageImagesToAttachments",
      "openWorkbenchTab",
      "openWorkspaceFile",
      "rewindController",
      "sendChatPrompt",
      "showToast",
      "subscribeSessionActivity",
      "useActiveSession",
      "useActiveWorkspace",
      "useAppStore",
      "useAppearanceTheme",
      "useClientContributions",
      "useHostRpcQuery",
      "usePluginConfig",
      "useWorkbenchStore",
    ]);

    const slotNames = qianjiClient.CLIENT_SLOT_CATALOG.map((item) => item.name);
    expect(slotNames).toContain("message.actions");
    expect(slotNames).toContain("message.toolRenderer");
    expect(slotNames).toContain("file.viewer");
    expect(slotNames).toContain("status.bar");
    expect(slotNames).toContain("home.quickActions");
  });

  it("enforces @layer ordering and proves in real Chromium CSS engine that plugin `button { background: red }` never leaks to host buttons", async () => {
    const indexCss = readFileSync(resolve(import.meta.dirname, "../src/styles/index.css"), "utf8");
    const layerLine = indexCss
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith("@layer ") && line.includes("plugin-ui"));
    expect(layerLine).toBeDefined();
    const layers = (layerLine ?? "")
      .replace(/^@layer\s+/, "")
      .replace(/;$/, "")
      .split(",")
      .map((part) => part.trim());
    expect(layers.indexOf("plugin-ui")).toBeGreaterThan(layers.indexOf("base"));
    expect(layers.indexOf("plugin-ui")).toBeLessThan(layers.indexOf("components"));

    const env = installMockStyleDom();
    let wrappedPluginCss: string;
    try {
      const root = new Context();
      await root.plugin(ClientContributionService, clientContributions);
      await root.plugin(ClientStylesService);

      let tagNextPlugin = false;
      root.on("internal/plugin", (createdFiber: object) => {
        if (tagNextPlugin) {
          tagFiberPluginId(createdFiber, "red-btn-plugin");
        }
      });

      const pluginApply = {
        name: "red-btn-plugin",
        inject: ["contributions", "styles"],
        apply(ctx: Context) {
          ctx.styles.inject("button { background: rgb(255, 0, 0); }", "btn-override");
          ctx.contributions.registerStatusBarItem({
            id: "red-btn-status",
            render: () => createElement("button", { className: "plugin-btn" }, "Plugin Button"),
          });
        },
      };

      tagNextPlugin = true;
      const fiber = await root.plugin(pluginApply);
      tagNextPlugin = false;

      const styleEl = env.head.querySelector('style[data-qj-plugin-style="red-btn-plugin"]');
      expect(styleEl).not.toBeNull();
      wrappedPluginCss = styleEl?.textContent ?? wrapPluginScopedCss("red-btn-plugin", "button { background: rgb(255, 0, 0); }");
      expect(wrappedPluginCss).toContain("@layer plugin-ui");
      expect(wrappedPluginCss).toContain('@scope ([data-qj-plugin="red-btn-plugin"])');
      expect(wrappedPluginCss).toContain("button { background: rgb(255, 0, 0); }");

      // Disposing the plugin fiber removes the scoped <style> tag automatically
      await fiber.dispose();
      expect(env.head.querySelector('style[data-qj-plugin-style="red-btn-plugin"]')).toBeNull();
    } finally {
      env.restore();
    }

    // Verify real browser CSS @layer + @scope cascade isolation (including breakout attempts & :root scoping) using Chromium / Edge
    const layerEscapeAttempt = wrapPluginScopedCss(
      "evil-layer-escape",
      "@layer plugin-ui {} button { background: rgb(255, 0, 0) !important; }",
    );
    const braceEscapeAttempt = wrapPluginScopedCss(
      "evil-brace-escape",
      "}} button { background: rgb(255, 0, 0) !important; } /* unclosed",
    );
    const scopedRootVarsCss = wrapPluginScopedCss(
      "red-btn-plugin",
      ':root { --plugin-pill-bg: rgb(12, 34, 56); } .var-pill { background: var(--plugin-pill-bg); } .var-pill::after { content: ":root }"; }',
    );

    let browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch {
      browser = await chromium.launch({ channel: "msedge", headless: true });
    }
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html>
<html>
  <head>
    <style>${layerLine}</style>
    <style>
      @layer base {
        button { background: rgb(240, 240, 240); }
      }
      @layer components {
        .host-primary-btn { background: rgb(37, 99, 235); }
      }
    </style>
    <style>${wrappedPluginCss}</style>
    <style>${layerEscapeAttempt}</style>
    <style>${braceEscapeAttempt}</style>
    <style>${scopedRootVarsCss}</style>
  </head>
  <body>
    <button id="host-bare-btn">Host Bare Button</button>
    <button id="host-comp-btn" class="host-primary-btn">Host Component Button</button>
    <div data-qj-plugin="other-plugin">
      <button id="other-plugin-btn">Other Plugin Button</button>
    </div>
    <div data-qj-plugin="red-btn-plugin">
      <button id="red-plugin-btn">Red Plugin Button</button>
      <button id="red-plugin-host-class" class="host-primary-btn">Host Class Inside Plugin</button>
      <div id="plugin-var-pill" class="var-pill">Scoped Root Var</div>
    </div>
  </body>
</html>`);

      const colors = await page.evaluate(() => ({
        hostBare: getComputedStyle(document.getElementById("host-bare-btn") as HTMLElement).backgroundColor,
        hostComp: getComputedStyle(document.getElementById("host-comp-btn") as HTMLElement).backgroundColor,
        otherPlugin: getComputedStyle(document.getElementById("other-plugin-btn") as HTMLElement).backgroundColor,
        redPlugin: getComputedStyle(document.getElementById("red-plugin-btn") as HTMLElement).backgroundColor,
        hostClassWinsLayer: getComputedStyle(document.getElementById("red-plugin-host-class") as HTMLElement).backgroundColor,
        pluginVarPill: getComputedStyle(document.getElementById("plugin-var-pill") as HTMLElement).backgroundColor,
        pluginVarAfterContent: getComputedStyle(document.getElementById("plugin-var-pill") as HTMLElement, "::after").content,
        leakedHtmlVar: getComputedStyle(document.documentElement).getPropertyValue("--plugin-pill-bg").trim(),
      }));

      // Host buttons & sibling plugins are 100% immune to `button { background: red }` AND `@layer` / `}}` breakout payloads
      expect(colors.hostBare).toBe("rgb(240, 240, 240)");
      expect(colors.hostComp).toBe("rgb(37, 99, 235)");
      expect(colors.otherPlugin).toBe("rgb(240, 240, 240)");
      // Own plugin button receives red background
      expect(colors.redPlugin).toBe("rgb(255, 0, 0)");
      // `@layer components` still beats `@layer plugin-ui` when host component classes are used
      expect(colors.hostClassWinsLayer).toBe("rgb(37, 99, 235)");
      // `:root { --plugin-pill-bg: ... }` is rewritten to `:scope` so variables work inside the plugin without leaking to <html>, and string literals `:root }` stay untouched
      expect(colors.pluginVarPill).toBe("rgb(12, 34, 56)");
      expect(colors.pluginVarAfterContent).toBe('":root }"');
      expect(colors.leakedHtmlVar).toBe("");
    } finally {
      await browser.close();
    }
  });

  it("renders graphical controls from configSchema and emits typed updates", () => {
    const schema = {
      type: "object",
      properties: {
        autoSync: { type: "boolean", title: "自动同步", default: true },
        mode: { type: "string", title: "运行模式", enum: ["fast", "accurate"], default: "fast" },
        maxRows: { type: "integer", title: "最大行数", default: 100, minimum: 10, maximum: 1000 },
        endpoint: { type: "string", title: "接口地址", default: "https://example.com" },
      },
    };
    expect(hasRenderableConfigSchema(schema)).toBe(true);
    expect(hasRenderableConfigSchema({})).toBe(false);

    const updates: Array<Record<string, unknown>> = [];
    const formProps = {
      pluginId: "demo-plugin",
      schema,
      value: { mode: "accurate" },
      onChange: (next: Record<string, unknown>) => updates.push(next),
    };

    const html = renderToStaticMarkup(createElement(PluginConfigSchemaForm, formProps));
    expect(html).toContain('id="plugin-schema-demo-plugin-autoSync"');
    expect(html).toContain('id="plugin-schema-demo-plugin-mode"');
    expect(html).toContain('id="plugin-schema-demo-plugin-maxRows"');
    expect(html).toContain('id="plugin-schema-demo-plugin-endpoint"');
    expect(html).toContain('value="https://example.com"');

    // Execute component directly to verify each field's typed onChange wiring
    const tree = PluginConfigSchemaForm(formProps);
    const checkbox = findElementById(tree, "plugin-schema-demo-plugin-autoSync");
    const select = findElementById(tree, "plugin-schema-demo-plugin-mode");
    const numberInput = findElementById(tree, "plugin-schema-demo-plugin-maxRows");
    const textInput = findElementById(tree, "plugin-schema-demo-plugin-endpoint");

    expect(checkbox?.props.checked).toBe(true);
    expect(select?.props.value).toBe("1");
    expect(numberInput?.props.value).toBe("100");
    expect(textInput?.props.value).toBe("https://example.com");

    (checkbox?.props.onChange as (e: unknown) => void)({ target: { checked: false } });
    expect(updates.at(-1)).toEqual({ mode: "accurate", autoSync: false });

    (select?.props.onChange as (e: unknown) => void)({ target: { value: "0" } });
    expect(updates.at(-1)).toEqual({ mode: "fast" });

    (numberInput?.props.onChange as (e: unknown) => void)({ target: { value: "250" } });
    expect(updates.at(-1)).toEqual({ mode: "accurate", maxRows: 250 });

    (textInput?.props.onChange as (e: unknown) => void)({ target: { value: "https://api.qianji.dev" } });
    expect(updates.at(-1)).toEqual({ mode: "accurate", endpoint: "https://api.qianji.dev" });
  });

  it("mounts message.actions, status.bar, message.toolRenderer, and file.viewer (including BetterSidebarCompatService)", async () => {
    // 1. message.actions & status.bar via <PluginSlot>
    clientContributions.registerMessageAction({
      id: "export-note",
      pluginId: "notes-plugin",
      role: "assistant",
      render: ({ contentText }) => createElement("span", { "data-testid": "note-action" }, `导出:${contentText}`),
    });
    clientContributions.registerStatusBarItem({
      id: "branch-health",
      pluginId: "health-plugin",
      align: "right",
      render: ({ cwd }) => createElement("span", null, `状态:${cwd}`),
    });

    const assistantActionsHtml = renderToStaticMarkup(
      createElement(PluginSlot, {
        name: "message.actions",
        messageRole: "assistant",
        context: {
          cwd: "/repo",
          sessionFile: null,
          message: { id: "m1", role: "assistant", content: "答案正文", timestamp: 1 },
          contentText: "答案正文",
        },
      }),
    );
    expect(assistantActionsHtml).toContain("导出:答案正文");
    expect(assistantActionsHtml).toContain('data-qj-plugin="notes-plugin"');

    const userActionsHtml = renderToStaticMarkup(
      createElement(PluginSlot, {
        name: "message.actions",
        messageRole: "user",
        context: {
          cwd: "/repo",
          sessionFile: null,
          message: { id: "m0", role: "user", content: "提问", timestamp: 0 },
          contentText: "提问",
        },
      }),
    );
    expect(userActionsHtml).toBe("");

    const statusBarHtml = renderToStaticMarkup(
      createElement(PluginSlot, {
        name: "status.bar",
        align: "right",
        context: { cwd: "/workspace/demo", sessionFile: null },
      }),
    );
    expect(statusBarHtml).toContain("状态:/workspace/demo");

    // 2. message.toolRenderer via <ToolCall>
    clientContributions.registerToolRenderer({
      id: "sqlite-card",
      pluginId: "sqlite-plugin",
      toolNames: ["sqlite_*"],
      render: ({ call, state }) =>
        createElement("div", { className: "custom-sqlite-card" }, `${call.name}:${state}:${String(call.args.sql)}`),
    });
    expect(matchToolRenderer(clientContributions.getSnapshot().toolRenderers, "sqlite_query")?.id).toBe("sqlite-card");
    expect(matchToolRenderer(clientContributions.getSnapshot().toolRenderers, "bash")).toBeUndefined();

    const customToolHtml = renderToStaticMarkup(
      createElement(ToolCall, {
        call: {
          id: "tc1",
          name: "sqlite_query",
          args: { sql: "SELECT 42" },
          running: false,
        },
      }),
    );
    expect(customToolHtml).toContain("sqlite_query:ok:SELECT 42");
    expect(customToolHtml).toContain('data-qj-plugin="sqlite-plugin"');

    // 3. file.viewer via BetterSidebarCompatService & <CodeEditorTab>
    const root = new Context();
    await root.plugin(BetterSidebarCompatService, clientContributions);
    root.on("internal/plugin", (createdFiber: object) => {
      tagFiberPluginId(createdFiber, "sqlite-viewer-plugin");
    });
    const viewerFiber = await root.plugin({
      name: "sqlite-viewer-plugin",
      inject: ["betterSidebar"],
      apply(ctx: Context) {
        ctx.betterSidebar.registerFileViewer({
          id: "sqlite-viewer",
          title: "SQLite 预览",
          extensions: [".sqlite", ".db"],
          render: (props) =>
            createElement("div", { className: "sqlite-preview-view" }, `SQLite:${String(props.path)}:${String(props.size)}`),
        });
      },
    });

    expect(
      matchFileViewer(clientContributions.getSnapshot().fileViewers, { path: "data/app.sqlite" })?.id,
    ).toBe("sqlite-viewer");

    useWorkbenchStore.setState({
      openFiles: [
        {
          path: "data/app.sqlite",
          content: "",
          savedContent: "",
          isBinary: true,
          size: 4096,
          truncated: false,
          loading: false,
        },
      ],
      activeFilePath: "data/app.sqlite",
    });

    const initSnap = useWorkbenchStore.getInitialState();
    const prevInitOpenFiles = initSnap.openFiles;
    const prevInitActive = initSnap.activeFilePath;
    Object.assign(initSnap, {
      openFiles: useWorkbenchStore.getState().openFiles,
      activeFilePath: "data/app.sqlite",
    });
    let editorHtml: string;
    try {
      editorHtml = renderToStaticMarkup(createElement(CodeEditorTab, { cwd: "/workspace" }));
    } finally {
      Object.assign(initSnap, { openFiles: prevInitOpenFiles, activeFilePath: prevInitActive });
    }
    expect(editorHtml).toContain("SQLite:data/app.sqlite:4096");
    expect(editorHtml).toContain('data-qj-plugin="sqlite-viewer-plugin"');

    await viewerFiber.dispose();
    expect(matchFileViewer(clientContributions.getSnapshot().fileViewers, { path: "data/app.sqlite" })).toBeUndefined();
  });

  it("generates zero-dependency offline plugin-types that pass tsc --noEmit in an isolated external directory", () => {
    const tempBase = mkdtempSync(join(tmpdir(), "qj-plugin-types-"));
    const typesDir = join(tempBase, "plugin-types");
    const extPluginDir = join(tempBase, "my-external-plugin");
    try {
      generatePluginTypes({ targetDir: typesDir });

      const relTypes = relative(extPluginDir, typesDir).replace(/\\/g, "/");
      rmSync(extPluginDir, { recursive: true, force: true });
      mkdirSync(extPluginDir, { recursive: true });

      writeFileSync(
        join(extPluginDir, "tsconfig.json"),
        JSON.stringify(
          {
            extends: `${relTypes}/tsconfig.plugin.json`,
            compilerOptions: {
              baseUrl: ".",
              paths: {
                "react/jsx-runtime": [`${relTypes}/react/jsx-runtime.d.ts`],
                "react/jsx-dev-runtime": [`${relTypes}/react/jsx-dev-runtime.d.ts`],
                "*": [`${relTypes}/*/index.d.ts`, `${relTypes}/*`],
              },
            },
            include: ["index.ts", "client.tsx"],
          },
          null,
          2,
        ),
        "utf8",
      );

      writeFileSync(
        join(extPluginDir, "index.ts"),
        `import type { Context } from "@deepseek-ai/cordis";
import { textOutput } from "@qianji/tools";
export const name = "demo-ext";
export const inject = ["tools", "rpc"];
export function apply(ctx: Context) {
  ctx.tools.register({
    name: "demo_ping",
    description: "Ping",
    readOnly: true,
    parameters: { type: "object", properties: {} },
    async execute() {
      return textOutput("pong");
    },
  });
  ctx.rpc.method("demo.ping", () => ({ ok: true }));
}
`,
        "utf8",
      );

      writeFileSync(
        join(extPluginDir, "client.tsx"),
        `import { useState } from "react";
import type { Context } from "@deepseek-ai/cordis";
import { Sparkles } from "lucide-react";
import { useActiveSession, callHostRpc, showToast } from "@qianji/client";

function DemoWidget() {
  const session = useActiveSession();
  const [count, setCount] = useState(0);
  return (
    <button
      type="button"
      onClick={() => {
        setCount((c) => c + 1);
        void callHostRpc("demo.ping").then(() => showToast("OK"));
      }}
    >
      <Sparkles size={12} />
      <span>{session.cwd}:{count}</span>
    </button>
  );
}

export const name = "demo-ext-client";
export const inject = ["contributions", "styles"];
export function apply(ctx: Context) {
  ctx.styles.inject(".demo { color: var(--qj-text-primary); }");
  ctx.contributions.registerStatusBarItem({
    id: "demo-status",
    align: "right",
    render: () => <DemoWidget />,
  });
}
`,
        "utf8",
      );

      const configPath = join(extPluginDir, "tsconfig.json");
      const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
      expect(configFile.error).toBeUndefined();
      const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, extPluginDir);
      const program = ts.createProgram(parsed.fileNames, parsed.options);
      const diagnostics = ts.getPreEmitDiagnostics(program);
      const formatted = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(formatted).toEqual([]);
    } finally {
      rmSync(tempBase, { recursive: true, force: true });
    }
  });
});
