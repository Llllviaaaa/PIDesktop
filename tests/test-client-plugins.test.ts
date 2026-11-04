import { describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import type { PluginClientBundleParams, PluginClientBundleResult, PluginInfo } from "@pid/protocol";
import {
  createClientPluginRuntime,
  getClientPluginErrors,
  normalizeSharedModule,
  type ModuleLoaderGlobal,
} from "../src/lib/clientPluginRuntime.ts";

describe("clientPluginRuntime", () => {
  it("normalizes ES module namespaces for both CJS require() and esbuild __toESM", () => {
    const normalizedReact = normalizeSharedModule(React) as Record<string, unknown>;
    expect(normalizedReact.__esModule).toBe(true);
    expect(typeof normalizedReact.createElement).toBe("function");
    expect(typeof normalizedReact.useState).toBe("function");
    expect(normalizedReact.default).toBeDefined();

    const namedOnly = normalizeSharedModule({ alpha: 1, beta: "two" }) as Record<string, unknown>;
    expect(namedOnly.__esModule).toBe(true);
    expect(namedOnly.alpha).toBe(1);
    expect(namedOnly.default).toBe(namedOnly);
  });

  it("mounts external client plugins, hot-swaps Fibers on ETag/config changes, and rolls back broken updates", async () => {
    const root = new Context();
    const events: string[] = [];
    const targetGlobal: { __ModuleLoader__?: ModuleLoaderGlobal } = {};
    const requestedBundles: PluginClientBundleParams[] = [];

    let plugins: PluginInfo[] = [
      {
        id: "demo-ui",
        name: "Demo UI",
        version: "1.0.0",
        tier: "user",
        enabled: true,
        status: "active",
        overridesBuiltin: false,
        removable: true,
        watch: true,
        hasHost: false,
        hasClient: true,
        clientEtag: "etag-v1",
        config: { label: "initial" },
      },
      {
        id: "dsh-compat-ui",
        name: "DSH Compat UI",
        version: "0.2.0",
        tier: "user",
        enabled: true,
        status: "active",
        overridesBuiltin: false,
        removable: true,
        watch: false,
        hasHost: false,
        hasClient: true,
        clientEtag: "etag-dsh-1",
        config: {},
      },
    ];

    const bundles = new Map<string, { etag: string; code: string }>([
      [
        "demo-ui",
        {
          etag: "etag-v1",
          code: `
            window.__ModuleLoader__.load({
              id: "demo-ui",
              factory(require) {
                const { Context: SharedContext } = require("@deepseek-ai/cordis");
                const jsx = require("react/jsx-runtime");
                return {
                  default: {
                    name: "demo-ui-v1",
                    apply(ctx, config) {
                      if (!(ctx instanceof SharedContext)) {
                        throw new Error("Context singleton mismatch");
                      }
                      const node = jsx.jsx("span", { children: config.label });
                      ctx.effect(() => {
                        events.push("mount:v1:" + node.props.children);
                        return () => events.push("dispose:v1:" + node.props.children);
                      });
                    }
                  }
                };
              }
            });
          `,
        },
      ],
      [
        "dsh-compat-ui",
        {
          etag: "etag-dsh-1",
          // Simulates a prebuilt community DSH plugin whose embedded loader ID differs from package name.
          code: `
            window.__ModuleLoader__.load({
              id: "@community/internal-entry/client",
              factory() {
                return function applyCompat(ctx) {
                  ctx.effect(() => {
                    events.push("mount:dsh-compat");
                    return () => events.push("dispose:dsh-compat");
                  });
                };
              }
            });
          `,
        },
      ],
    ]);

    const changeListeners = new Set<() => void>();
    const executeScript = async (code: string): Promise<void> => {
      const fn = new Function("window", "events", code);
      fn(targetGlobal, events);
    };

    const runtime = createClientPluginRuntime(root, {
      targetGlobal,
      executeScript,
      modules: {
        "react": async () => React,
        "react/jsx-runtime": async () => jsxRuntime,
        "@deepseek-ai/cordis": async () => ({ Context }),
      },
      transport: {
        list: async () => plugins,
        clientBundle: async (params): Promise<PluginClientBundleResult> => {
          requestedBundles.push(params);
          const entry = bundles.get(params.id);
          if (entry === undefined) throw new Error(`missing bundle ${params.id}`);
          if (params.ifNoneMatch === entry.etag) {
            return { notModified: true, etag: entry.etag };
          }
          return { notModified: false, etag: entry.etag, code: entry.code };
        },
        onChanged: (listener) => {
          changeListeners.add(listener);
          return () => changeListeners.delete(listener);
        },
        onTrustChanged: () => () => undefined,
      },
    });

    await runtime.sync();
    expect(events).toEqual(["mount:v1:initial", "mount:dsh-compat"]);
    expect(getClientPluginErrors()["demo-ui"]).toBeUndefined();

    // Hot-swap demo-ui to v2 without touching dsh-compat-ui.
    bundles.set("demo-ui", {
      etag: "etag-v2",
      code: `
        window.__ModuleLoader__.load({
          id: "demo-ui",
          factory() {
            return {
              apply(ctx, config) {
                ctx.effect(() => {
                  events.push("mount:v2:" + config.label);
                  return () => events.push("dispose:v2:" + config.label);
                });
              }
            };
          }
        });
      `,
    });
    plugins = plugins.map((item) => (
      item.id === "demo-ui" ? { ...item, clientEtag: "etag-v2", config: { label: "reloaded" } } : item
    ));
    for (const listener of changeListeners) listener();
    await runtime.sync();

    expect(events).toEqual([
      "mount:v1:initial",
      "mount:dsh-compat",
      "dispose:v1:initial",
      "mount:v2:reloaded",
    ]);
    expect(requestedBundles.at(-1)?.ifNoneMatch).toBe("etag-v1");

    // Push a broken v3 that throws inside apply(ctx): v2 should roll back and error should be recorded.
    bundles.set("demo-ui", {
      etag: "etag-v3-broken",
      code: `
        window.__ModuleLoader__.load({
          id: "demo-ui",
          factory() {
            return {
              apply() {
                throw new Error("broken render hook");
              }
            };
          }
        });
      `,
    });
    plugins = plugins.map((item) => (
      item.id === "demo-ui" ? { ...item, clientEtag: "etag-v3-broken" } : item
    ));
    await runtime.sync();

    expect(getClientPluginErrors()["demo-ui"]).toContain("broken render hook");
    expect(events.slice(-2)).toEqual(["dispose:v2:reloaded", "mount:v2:reloaded"]);

    // Disable demo-ui and dispose runtime.
    plugins = plugins.map((item) => (
      item.id === "demo-ui" ? { ...item, enabled: false, status: "disabled" } : item
    ));
    await runtime.sync();
    expect(getClientPluginErrors()["demo-ui"]).toBeUndefined();
    expect(events.at(-1)).toBe("dispose:v2:reloaded");

    await runtime.dispose();
    expect(events.at(-1)).toBe("dispose:dsh-compat");
    expect(targetGlobal.__ModuleLoader__).toBeUndefined();
  });
});
