import { Context, Service } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import {
  WorkspacePluginScope,
  extractPluginDependencyMeta,
  inspectCordisFiber,
  onCordisFiberStatusChange,
  reverseTopologicalOrder,
  topologicalSortPlugins,
} from "../src/index.ts";

describe("@qianji/kernel", () => {
  it("extracts inject and provide metadata from classes, objects, and default exports", () => {
    class DbService extends Service {
      static inject = ["logger"];
      static provide = "db";
      constructor(ctx: Context) {
        super(ctx, "db");
      }
    }

    const consumerMod = {
      default: {
        name: "consumer",
        inject: { required: ["db", "rpc"], optional: ["ui"] },
        provide: ["search"],
        apply() {},
      },
    };

    expect(extractPluginDependencyMeta(DbService)).toEqual({
      inject: ["logger"],
      provides: ["db"],
    });
    expect(extractPluginDependencyMeta(consumerMod)).toEqual({
      inject: ["db", "rpc"],
      provides: ["search"],
    });
  });

  it("topologically sorts providers before consumers while preserving declaration order and handling cycles", () => {
    const sorted = topologicalSortPlugins([
      { id: "search", inject: ["storage", "rpc"], provides: ["search"] },
      { id: "ui-widget", inject: ["search"], provides: [] },
      { id: "storage", inject: [], provides: ["storage"] },
      { id: "rpc-gateway", inject: ["webServer"], provides: ["rpc"] },
      { id: "web-server", inject: [], provides: ["webServer"] },
    ]);

    expect(sorted.cycles).toEqual([]);
    expect(sorted.ordered.map((item) => item.id)).toEqual([
      "storage",
      "web-server",
      "rpc-gateway",
      "search",
      "ui-widget",
    ]);

    expect(reverseTopologicalOrder(sorted.ordered).map((item) => item.id)).toEqual([
      "ui-widget",
      "search",
      "rpc-gateway",
      "web-server",
      "storage",
    ]);

    // Cyclic plugins do not throw or drop any node.
    const cyclic = topologicalSortPlugins([
      { id: "alpha", inject: ["betaSvc"], provides: ["alphaSvc"] },
      { id: "beta", inject: ["alphaSvc"], provides: ["betaSvc"] },
      { id: "independent", inject: [], provides: ["ind"] },
    ]);
    expect(cyclic.ordered.map((item) => item.id)).toEqual(["independent", "alpha", "beta"]);
    expect(cyclic.cycles).toEqual([["alpha", "beta"]]);
  });

  it("distinguishes pending (unmet inject) from genuinely active Cordis fibers and tracks live transitions", async () => {
    const ctx = new Context();
    const transitions: number[] = [];
    const off = onCordisFiberStatusChange(ctx, (_fiber, prev) => transitions.push(prev));

    let consumerRan = 0;
    const consumerPlugin = {
      name: "needs-alpha",
      inject: ["alphaService"],
      apply(inner: Context) {
        consumerRan += 1;
        inner.effect(() => () => {
          consumerRan -= 1;
        });
      },
    };

    const consumerFiber = ctx.plugin(consumerPlugin);
    await consumerFiber;

    // Missing `alphaService` -> Cordis resolves `await fiber` immediately, but fiber is PENDING, NOT ACTIVE!
    expect(consumerRan).toBe(0);
    expect(inspectCordisFiber(ctx, consumerFiber)).toEqual({
      status: "pending",
      missingInject: ["alphaService"],
    });

    class AlphaService extends Service {
      constructor(inner: Context) {
        super(inner, "alphaService");
      }
    }

    const providerFiber = ctx.plugin(AlphaService);
    await providerFiber;
    // Wait a microtask turn for Cordis to activate waiting fibers.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(consumerRan).toBe(1);
    expect(inspectCordisFiber(ctx, consumerFiber)).toEqual({
      status: "active",
      missingInject: [],
    });
    expect(transitions.length).toBeGreaterThan(0);

    // Unmounting the provider returns the consumer to `pending` automatically.
    await providerFiber.dispose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(consumerRan).toBe(0);
    expect(inspectCordisFiber(ctx, consumerFiber)).toEqual({
      status: "pending",
      missingInject: ["alphaService"],
    });

    off();
    await ctx.fiber.dispose();
  });

  it("isolates workspace child scopes and tears down all effects when switching workspaces", async () => {
    const root = new Context();
    const scope = new WorkspacePluginScope(root);
    const activeMarkers = new Set<string>();

    const wsACtx = await scope.ensure("ws-a", "/projects/a");
    await wsACtx.plugin({
      name: "ws-a-plugin",
      apply(ctx: Context) {
        activeMarkers.add("ws-a");
        ctx.effect(() => () => {
          activeMarkers.delete("ws-a");
        });
      },
    });
    expect([...activeMarkers]).toEqual(["ws-a"]);

    // Switching to ws-b disposes ws-a's entire child fiber before mounting ws-b.
    const wsBCtx = await scope.ensure("ws-b", "/projects/b");
    expect([...activeMarkers]).toEqual([]);
    await wsBCtx.plugin({
      name: "ws-b-plugin",
      apply(ctx: Context) {
        activeMarkers.add("ws-b");
        ctx.effect(() => () => {
          activeMarkers.delete("ws-b");
        });
      },
    });
    expect([...activeMarkers]).toEqual(["ws-b"]);

    await scope.dispose();
    expect([...activeMarkers]).toEqual([]);
    await root.fiber.dispose();
  });
});
