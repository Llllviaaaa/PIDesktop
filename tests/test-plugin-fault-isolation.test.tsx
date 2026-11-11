import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Context } from "@deepseek-ai/cordis";
import type {
  PluginChangedNotification,
  PluginClientBundleResult,
  PluginInfo,
  PluginReportClientErrorParams,
} from "@qianji/protocol";
import { describe, expect, it } from "vitest";
import { Composer } from "../src/components/Composer";
import {
  RegionErrorBoundary,
  SlotEntryHost,
  SlotErrorBoundary,
} from "../src/components/common/ErrorBoundary";
import {
  clientContributions,
  ClientContributionRegistry,
  ClientContributionService,
  type WorkbenchSlotContext,
} from "../src/lib/clientContributions";
import {
  clearClientRenderError,
  createClientPluginRuntime,
  getClientPluginErrors,
  getClientSlotLockout,
  recordClientRenderError,
  type ModuleLoaderGlobal,
} from "../src/lib/clientPluginRuntime";

describe("Frontend plugin fault isolation & Fiber boundaries (Phase 1)", () => {
  it("stamps pluginId across top-level and async child Fibers, locks out crashed slots without reconcile loops, and unlocks on HMR/config/reload", async () => {
    const root = new Context();
    const registry = new ClientContributionRegistry();
    await root.plugin(ClientContributionService, registry);

    const targetGlobal: { __ModuleLoader__?: ModuleLoaderGlobal } = {};
    const reportedErrors: PluginReportClientErrorParams[] = [];
    const clearedIds: string[] = [];
    const changeListeners = new Set<(payload?: PluginChangedNotification) => void>();

    let plugins: PluginInfo[] = [
      {
        id: "rogue-ui",
        name: "Rogue UI",
        version: "1.0.0",
        tier: "user",
        enabled: true,
        status: "active",
        overridesBuiltin: false,
        removable: true,
        watch: true,
        hasHost: false,
        hasClient: true,
        clientEtag: "etag-1",
        config: { mode: "broken" },
      },
    ];

    const bundleCode = `
      window.__ModuleLoader__.load({
        id: "rogue-ui",
        factory() {
          return {
            inject: ["contributions"],
            apply(ctx) {
              mountCountRef.count += 1;
              ctx.contributions.registerTopbarAction({
                id: "rogue-btn",
                render() {
                  throw new Error("boom in render");
                },
              });
              // Async nested child plugin must also inherit pluginId via fiber ancestry
              Promise.resolve().then(() => {
                ctx.plugin({
                  inject: ["contributions"],
                  apply(subCtx) {
                    subCtx.contributions.registerLeftSidebar({
                      id: "rogue-nested-section",
                      render: () => "nested-ok",
                    });
                  },
                });
              });
            },
          };
        },
      });
    `;

    const mountCountRef = { count: 0 };
    const runtime = createClientPluginRuntime(root, {
      targetGlobal,
      executeScript: async (code) => {
        const fn = new Function("window", "mountCountRef", code);
        fn(targetGlobal, mountCountRef);
      },
      modules: {},
      transport: {
        list: async () => plugins,
        clientBundle: async (): Promise<PluginClientBundleResult> => ({
          notModified: false,
          etag: plugins[0]?.clientEtag ?? "etag-1",
          code: bundleCode,
        }),
        reportClientError: async (params) => {
          reportedErrors.push(params);
          // Simulate Host broadcasting plugin/changed with reason: "clientError"
          for (const listener of changeListeners) {
            listener({ reason: "clientError", changedIds: [params.id], plugins });
          }
        },
        clearClientError: async (params) => {
          clearedIds.push(params.id);
        },
        onChanged: (listener) => {
          changeListeners.add(listener);
          return () => changeListeners.delete(listener);
        },
        onTrustChanged: () => () => undefined,
      },
    });

    await runtime.sync();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mountCountRef.count).toBe(1);

    const snap = registry.getSnapshot();
    expect(snap.topbarActions[0]?.pluginId).toBe("rogue-ui");
    expect(snap.leftSidebar[0]?.pluginId).toBe("rogue-ui");

    // Simulate SlotErrorBoundary catching synchronous render error from rogue-btn
    const topbarEntry = snap.topbarActions[0];
    if (!topbarEntry) throw new Error("expected topbarEntry");

    const boundary = new SlotErrorBoundary({
      pluginId: topbarEntry.pluginId,
      entryId: topbarEntry.id,
      slotName: "topbarActions",
      slotKey: "topbarActions:rogue-btn",
      compact: true,
      children: null,
    });
    const renderErr = new Error("boom in render");
    boundary.state = SlotErrorBoundary.getDerivedStateFromError(renderErr);
    boundary.componentDidCatch(renderErr, { componentStack: "\n    at SlotRenderBody" });

    // Wait a tick to ensure reason: "clientError" notification did NOT trigger reconcile loops
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(mountCountRef.count).toBe(1);
    expect(reportedErrors).toHaveLength(1);
    expect(reportedErrors[0]).toMatchObject({
      id: "rogue-ui",
      phase: "render",
      etag: "etag-1",
    });
    expect(getClientPluginErrors()["rogue-ui"]).toContain("boom in render");
    expect(getClientSlotLockout("rogue-ui", "topbarActions:rogue-btn").locked).toBe(true);

    // Remounting <SlotEntryHost> on the same (etag, configKey, reloadEpoch) stays locked out
    // and renders fallback UI WITHOUT calling topbarEntry.render()!
    let renderAttemptsAfterCrash = 0;
    const lockedMarkup = renderToStaticMarkup(
      <SlotEntryHost
        entry={{
          id: "rogue-btn",
          pluginId: "rogue-ui",
          render: () => {
            renderAttemptsAfterCrash += 1;
            throw new Error("should not execute while locked out");
          },
        }}
        context={{ cwd: "D:/ws", sessionFile: null }}
        slotName="topbarActions"
        compact
      />,
    );
    expect(renderAttemptsAfterCrash).toBe(0);
    expect(lockedMarkup).toContain("data-qj-plugin=\"rogue-ui\"");
    expect(lockedMarkup).toContain("重载插件");
    expect(lockedMarkup).toContain("停用插件");

    // Sibling slot of the same plugin that didn't crash remains healthy
    const healthyNestedMarkup = renderToStaticMarkup(
      <SlotEntryHost
        entry={snap.leftSidebar[0] ?? { id: "missing", render: () => null }}
        context={{ cwd: "D:/ws", sessionFile: null }}
        slotName="leftSidebar"
      />,
    );
    expect(healthyNestedMarkup).toContain("nested-ok");

    // Manual "Reload" button (`clearClientRenderError(id, true)`) bumps reloadEpoch and unlocks slot
    clearClientRenderError("rogue-ui", true);
    expect(getClientSlotLockout("rogue-ui", "topbarActions:rogue-btn").locked).toBe(false);
    expect(clearedIds).toContain("rogue-ui");

    // Re-lock and verify that an HMR ETag bump from Host automatically unlocks the slot
    recordClientRenderError("rogue-ui", "topbarActions:rogue-btn", new Error("boom v1"));
    expect(getClientSlotLockout("rogue-ui", "topbarActions:rogue-btn").locked).toBe(true);

    plugins = plugins.map((item) => ({ ...item, clientEtag: "etag-2-fixed" }));
    await runtime.sync();
    expect(getClientSlotLockout("rogue-ui", "topbarActions:rogue-btn").locked).toBe(false);

    await runtime.dispose();
  });

  it("executes dynamic React Hooks inside <SlotRenderBody> child Fiber without corrupting parent component Hooks", () => {
    const entries = [
      {
        id: "hook-widget-a",
        pluginId: "plugin-a",
        render: (ctx: WorkbenchSlotContext) => {
          const [count] = useState(42);
          const [label] = useState("alpha");
          return createElement("span", null, `${label}:${count}:${ctx.cwd}`);
        },
      },
      {
        id: "stateless-widget-b",
        pluginId: "plugin-b",
        render: (ctx: WorkbenchSlotContext) => createElement("em", null, `beta:${ctx.sessionFile ?? "none"}`),
      },
    ];

    function HostToolbar({ reverse }: { reverse: boolean }) {
      const [hostState] = useState("host-intact");
      const ordered = reverse ? [...entries].reverse() : entries;
      return (
        <div data-host={hostState}>
          {ordered.map((entry) => (
            <SlotEntryHost
              key={entry.id}
              entry={entry}
              context={{ cwd: "/repo", sessionFile: "/repo/s1.jsonl" }}
              slotName="topbarActions"
            />
          ))}
        </div>
      );
    }

    const forwardHtml = renderToStaticMarkup(createElement(HostToolbar, { reverse: false }));
    const reverseHtml = renderToStaticMarkup(createElement(HostToolbar, { reverse: true }));
    expect(forwardHtml).toContain("data-host=\"host-intact\"");
    expect(forwardHtml).toContain("alpha:42:/repo");
    expect(forwardHtml).toContain("beta:/repo/s1.jsonl");
    expect(reverseHtml).toContain("data-host=\"host-intact\"");
    expect(reverseHtml).toContain("alpha:42:/repo");
  });

  it("isolates crashes in rewindHandlers and slashInterceptors so subsequent healthy plugins still execute", async () => {
    const registry = new ClientContributionRegistry();
    const executed: string[] = [];

    registry.registerRewindHandler({
      id: "broken-rewind",
      pluginId: "bad-rewind-plugin",
      order: 1,
      onRewindMessage: () => {
        throw new Error("rewind handler exploded");
      },
    });
    registry.registerRewindHandler({
      id: "healthy-rewind",
      pluginId: "good-rewind-plugin",
      order: 2,
      onRewindMessage: () => {
        executed.push("rewind-handled");
        return true;
      },
    });

    const rewindResult = await registry.tryHandleRewind({
      id: "m1",
      role: "user",
      content: "hello",
      timestamp: 1,
    });
    expect(rewindResult).toBe(true);
    expect(executed).toEqual(["rewind-handled"]);
    expect(getClientPluginErrors()["bad-rewind-plugin"]).toContain("rewind handler exploded");
    clearClientRenderError("bad-rewind-plugin", false);

    registry.registerSlashInterceptor({
      id: "broken-slash",
      pluginId: "bad-slash-plugin",
      order: 1,
      onSlashCommand: async () => {
        throw new Error("slash interceptor rejected");
      },
    });
    registry.registerSlashInterceptor({
      id: "healthy-slash",
      pluginId: "good-slash-plugin",
      order: 2,
      onSlashCommand: async (name, rawArgs) => {
        executed.push(`slash:${name}:${rawArgs}`);
        return true;
      },
    });

    const slashResult = await registry.tryHandleSlashCommand("deploy", "--prod", {
      cwd: "D:/repo",
      sessionFile: "D:/repo/session.jsonl",
    });
    expect(slashResult).toBe(true);
    expect(executed).toEqual(["rewind-handled", "slash:deploy:--prod"]);
    expect(getClientPluginErrors()["bad-slash-plugin"]).toContain("slash interceptor rejected");
    clearClientRenderError("bad-slash-plugin", false);
  });

  it("passes real sessionFile to all 4 Composer plugin slots and isolates RegionErrorBoundary crashes", () => {
    const seenContexts: Array<{ slot: string; ctx: WorkbenchSlotContext }> = [];
    const disposes = [
      clientContributions.registerComposerBanner({
        id: "test-banner",
        render: (ctx) => {
          seenContexts.push({ slot: "banner", ctx });
          return createElement("div", null, `banner:${ctx.sessionFile}`);
        },
      }),
      clientContributions.registerComposerToolbar({
        id: "test-toolbar",
        render: (ctx) => {
          seenContexts.push({ slot: "toolbar", ctx });
          return createElement("span", null, `toolbar:${ctx.sessionFile}`);
        },
      }),
      clientContributions.registerComposerStatus({
        id: "test-status-before",
        position: "before-model",
        render: (ctx) => {
          seenContexts.push({ slot: "status-before", ctx });
          return createElement("span", null, `before:${ctx.sessionFile}`);
        },
      }),
      clientContributions.registerComposerStatus({
        id: "test-status-after",
        position: "after-model",
        render: (ctx) => {
          seenContexts.push({ slot: "status-after", ctx });
          return createElement("span", null, `after:${ctx.sessionFile}`);
        },
      }),
    ];

    try {
      const targetSessionFile = "D:/sessions/active-thread.jsonl";
      const html = renderToStaticMarkup(
        createElement(Composer, {
          isStreaming: false,
          attachments: [],
          commands: [],
          models: [],
          model: null,
          thinkingLevel: "off",
          thinkingLevels: ["off"],
          pendingCount: 0,
          workspace: "D:/workspace",
          sessionFile: targetSessionFile,
          variant: "follow-up",
          onSend: () => undefined,
          onStop: () => undefined,
          onPickAttachments: () => undefined,
          onRemoveAttachment: () => undefined,
          onModelChange: () => undefined,
          onThinkingChange: () => undefined,
        }),
      );

      expect(seenContexts.map((item) => item.slot)).toEqual([
        "banner",
        "toolbar",
        "status-before",
        "status-after",
      ]);
      for (const item of seenContexts) {
        expect(item.ctx).toEqual({
          cwd: "D:/workspace",
          sessionFile: targetSessionFile,
          variant: "follow-up",
        });
      }
      expect(html).toContain(`banner:${targetSessionFile}`);
      expect(html).toContain(`toolbar:${targetSessionFile}`);
      expect(html).toContain(`before:${targetSessionFile}`);
      expect(html).toContain(`after:${targetSessionFile}`);
    } finally {
      for (const dispose of disposes) dispose();
    }

    // Verify RegionErrorBoundary fallback and resetKey auto-recovery
    const regionBoundary = new RegionErrorBoundary({
      region: "右侧工作台",
      resetKey: "ws-1",
      children: createElement("div", null, "ok"),
    });
    regionBoundary.state = {
      ...regionBoundary.state,
      ...RegionErrorBoundary.getDerivedStateFromError(new Error("panel exploded")),
    };
    const fallbackHtml = renderToStaticMarkup(createElement("div", null, regionBoundary.render()));
    expect(fallbackHtml).toContain("右侧工作台 区域渲染异常：panel exploded");
    expect(fallbackHtml).toContain("重试渲染");

    const recoveredState = RegionErrorBoundary.getDerivedStateFromProps(
      { region: "右侧工作台", resetKey: "ws-2", children: createElement("div", null, "recovered") },
      regionBoundary.state,
    );
    expect(recoveredState?.error).toBeNull();
  });

  it("locks out sync and async activation crashes without reconcile loops and preserves v1 bundle styles on failed HMR reload", async () => {
    const headStyles: Array<{ attrs: Map<string, string>; textContent: string; isConnected: boolean; remove(): void }> = [];
    const mockDoc = {
      head: {
        appendChild(node: { isConnected: boolean }) {
          node.isConnected = true;
          if (!headStyles.includes(node as never)) headStyles.push(node as never);
          return node;
        },
      },
      createElement() {
        const attrs = new Map<string, string>();
        const node = {
          attrs,
          textContent: "",
          isConnected: false,
          setAttribute(k: string, v: string) {
            attrs.set(k, v);
          },
          remove() {
            node.isConnected = false;
            const idx = headStyles.indexOf(node);
            if (idx >= 0) headStyles.splice(idx, 1);
          },
        };
        return node;
      },
      querySelectorAll(sel: string) {
        const m = /^style\[data-qj-plugin-style="([^"]+)"\]$/.exec(sel);
        if (!m) return [];
        return headStyles.filter((item) => item.attrs.get("data-qj-plugin-style") === m[1]);
      },
    };
    const prevDocument = globalThis.document;
    (globalThis as Record<string, unknown>).document = mockDoc;

    try {
      const root = new Context();
      const targetGlobal: {
        __ModuleLoader__?: ModuleLoaderGlobal;
        __qianjiInjectPluginStyle?: (pluginId: string, css: string, styleKey?: string) => () => void;
      } = {};
      const changeListeners = new Set<(payload?: PluginChangedNotification) => void>();
      let syncLoadExecutions = 0;
      let asyncApplyExecutions = 0;

      let plugins: PluginInfo[] = [
        {
          id: "styled-hmr",
          name: "Styled HMR",
          version: "1.0.0",
          tier: "user",
          enabled: true,
          status: "active",
          overridesBuiltin: false,
          removable: true,
          watch: true,
          hasHost: false,
          hasClient: true,
          clientEtag: "v1-ok",
          config: {},
        },
        {
          id: "async-crasher",
          name: "Async Crasher",
          version: "1.0.0",
          tier: "user",
          enabled: true,
          status: "active",
          overridesBuiltin: false,
          removable: true,
          watch: true,
          hasHost: false,
          hasClient: true,
          clientEtag: "async-etag-1",
          config: {},
        },
      ];

      const bundles = new Map<string, string>([
        [
          "styled-hmr:v1-ok",
          `
            targetGlobal.__qianjiInjectPluginStyle("styled-hmr", ".v1 { color: green; }", "style.css");
            window.__ModuleLoader__.load({
              id: "styled-hmr",
              factory() {
                return { apply() {} };
              },
            });
          `,
        ],
        [
          "styled-hmr:v2-broken",
          `
            countSyncLoad();
            targetGlobal.__qianjiInjectPluginStyle("styled-hmr", ".v2-corrupt { color: red; }", "style.css");
            targetGlobal.__qianjiInjectPluginStyle("styled-hmr", ".v2-extra { color: orange; }", "extra.css");
            throw new Error("syntax/eval crash in v2");
          `,
        ],
        [
          "async-crasher:async-etag-1",
          `
            window.__ModuleLoader__.load({
              id: "async-crasher",
              factory() {
                return {
                  async apply() {
                    countAsyncApply();
                    await Promise.resolve();
                    throw new Error("async fiber rejection");
                  },
                };
              },
            });
          `,
        ],
        [
          "async-crasher:async-etag-2",
          `
            window.__ModuleLoader__.load({
              id: "async-crasher",
              factory() {
                return {
                  async apply() {
                    countAsyncApply();
                  },
                };
              },
            });
          `,
        ],
      ]);

      const runtime = createClientPluginRuntime(root, {
        targetGlobal,
        executeScript: async (code) => {
          const fn = new Function(
            "window",
            "targetGlobal",
            "countSyncLoad",
            "countAsyncApply",
            code,
          );
          fn(
            targetGlobal,
            targetGlobal,
            () => {
              syncLoadExecutions += 1;
            },
            () => {
              asyncApplyExecutions += 1;
            },
          );
        },
        modules: {},
        transport: {
          list: async () => plugins,
          clientBundle: async (params): Promise<PluginClientBundleResult> => {
            const target = plugins.find((p) => p.id === params.id);
            const etag = target?.clientEtag ?? "unknown";
            return {
              notModified: false,
              etag,
              code: bundles.get(`${params.id}:${etag}`) ?? "",
            };
          },
          onChanged: (listener) => {
            changeListeners.add(listener);
            return () => changeListeners.delete(listener);
          },
          onTrustChanged: () => () => undefined,
        },
      });

      await runtime.sync();
      await new Promise((r) => setTimeout(r, 20));
      expect(asyncApplyExecutions).toBe(1);
      expect(getClientPluginErrors()["async-crasher"]).toContain("async fiber rejection");

      // Repeated sync() calls MUST NOT re-mount or loop async-crasher on the same ETag!
      await runtime.sync();
      await runtime.sync();
      await new Promise((r) => setTimeout(r, 20));
      expect(asyncApplyExecutions).toBe(1);

      // Push broken v2 of styled-hmr: v1's style.css MUST remain intact and v2's extra.css MUST be rolled back!
      plugins = plugins.map((p) => (p.id === "styled-hmr" ? { ...p, clientEtag: "v2-broken" } : p));
      await runtime.sync();
      expect(syncLoadExecutions).toBe(1);
      expect(getClientPluginErrors()["styled-hmr"]).toContain("syntax/eval crash in v2");
      const styledTags = headStyles.filter((s) => s.attrs.get("data-qj-plugin-style") === "styled-hmr");
      expect(styledTags).toHaveLength(1);
      expect(styledTags[0]?.textContent).toContain(".v1 { color: green; }");
      expect(styledTags[0]?.textContent).not.toContain("v2-corrupt");

      // Repeated sync() calls MUST NOT re-execute broken v2 script!
      await runtime.sync();
      await runtime.sync();
      expect(syncLoadExecutions).toBe(1);

      // Manual reload notification bumps reloadEpoch so even the same ETag retries once when requested
      for (const listener of changeListeners) {
        listener({ reason: "reloaded", changedIds: ["styled-hmr"], plugins });
      }
      await runtime.sync();
      expect(syncLoadExecutions).toBe(2);

      // Advancing async-crasher to fixed ETag unlocks and clears error
      plugins = plugins.map((p) => (p.id === "async-crasher" ? { ...p, clientEtag: "async-etag-2" } : p));
      await runtime.sync();
      await new Promise((r) => setTimeout(r, 20));
      expect(asyncApplyExecutions).toBe(2);
      expect(getClientPluginErrors()["async-crasher"]).toBeUndefined();

      await runtime.dispose();
    } finally {
      if (prevDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        globalThis.document = prevDocument;
      }
    }
  });
});
