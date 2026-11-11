import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Commands } from "@qianji/commands";
import type { PluginListResult, WorkbenchOpenNotification } from "@qianji/protocol";
import { Sessions } from "@qianji/session";
import { SystemPrompt } from "@qianji/system-prompt";
import { Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import { ClientBundleRegistry } from "../src/client-bundles.ts";
import { cleanupLegacySeededPlugins } from "../src/control.ts";
import { installHostCrashGuards, type ProcessEventTarget } from "../src/crash-guard.ts";
import { createHost, type Host } from "../src/host.ts";
import { evictBunModuleSubtree } from "../src/plugin-bridge.ts";
import { PluginManager } from "../src/plugin-manager.ts";
import { readPluginsStore, updatePluginsStore } from "../src/plugin-store.ts";
import * as pluginsRpc from "../src/plugins-rpc.ts";
import { RpcGateway } from "../src/rpc.ts";
import { WebServer } from "../src/web-server.ts";
import * as workbenchRpc from "../src/workbench-rpc.ts";

const pageOrigin = "http://tauri.localhost";
let tempRoot = "";
let host: Host | undefined;
let manager: PluginManager | undefined;

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
  await host?.stop();
  host = undefined;
  if (tempRoot !== "") {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  }
});

function createFakeProcess(): ProcessEventTarget & {
  emitRejection(reason: unknown): void;
  emitException(error: Error): void;
} {
  const emitter = new EventEmitter();
  return {
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    emitRejection: (reason) => emitter.emit("unhandledRejection", reason, Promise.resolve()),
    emitException: (error) => emitter.emit("uncaughtException", error, "uncaughtException"),
  };
}

describe("Harness Host plugin resilience & microkernel isolation (Phase 1)", () => {
  it("auto-disposes Tools, Commands, SystemPrompt, RpcGateway, and WebServer registrations even when plugin omits ctx.effect()", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pid-resilience-auto-dispose-"));
    const dataDir = join(tempRoot, "data");
    mkdirSync(dataDir, { recursive: true });

    host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: [
        [WebServer, { pageOrigins: [pageOrigin] }],
        [RpcGateway, { token: "a".repeat(32) }],
        [Sessions],
        [Ui],
        [Tools],
        [Commands],
        [SystemPrompt],
      ],
    });
    await host.start();
    const port = await host.ctx.webServer.listen(0);

    manager = new PluginManager(host.ctx, {
      dataDir,
      version: "0.3.0-test",
    });
    await host.ctx.plugin(pluginsRpc, { manager });
    await manager.sync();

    const pluginDir = join(tempRoot, "sloppy-plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({
        name: "sloppy-plugin",
        version: "1.0.0",
        pid: {
          id: "sloppy-plugin",
          name: "Sloppy Plugin Without ctx.effect",
          host: "./index.ts",
        },
      }),
    );
    writeFileSync(
      join(pluginDir, "index.ts"),
      `
        import { textOutput } from "@qianji/tools";
        export const inject = ["tools", "commands", "systemPrompt", "rpc", "webServer"];
        export function apply(ctx) {
          // Deliberately NOT wrapping any registration in ctx.effect(...)!
          ctx.tools.register({
            name: "sloppy_tool",
            description: "Tool without ctx.effect",
            parameters: { type: "object", properties: {} },
            execute: () => textOutput("v1"),
          });
          ctx.commands.register({
            name: "sloppy-cmd",
            description: "Command without ctx.effect",
            execute: () => ({ output: "cmd-v1" }),
          });
          ctx.systemPrompt.section("sloppy-section", () => "Sloppy prompt v1", { order: 500 });
          ctx.rpc.method("sloppy.ping", () => ({ pong: "v1" }));
          ctx.webServer.register({
            kind: "exact",
            path: "/sloppy",
            handler: (_req, res) => {
              res.writeHead(200);
              res.end("v1");
            },
          });
        }
      `,
    );

    const installed = await manager.install({ channel: "local", spec: pluginDir, link: true });
    expect(installed.plugin?.status).toBe("active");
    expect(host.ctx.tools.schemas().some((t) => t.name === "sloppy_tool")).toBe(true);
    expect(host.ctx.rpc.methods()).toContain("sloppy.ping");

    const promptV1 = await host.ctx.systemPrompt.build({
      sessionId: "s-check",
      cwd: tempRoot,
      model: { provider: "mock", model: "mock" },
      tools: [],
    });
    expect(promptV1).toContain("Sloppy prompt v1");

    const httpV1 = await fetch(`http://127.0.0.1:${port}/sloppy`);
    expect(httpV1.status).toBe(200);
    expect(await httpV1.text()).toBe("v1");

    // Update source to v2 and reload — would throw "already registered" or leak v1 without auto-disposal!
    writeFileSync(
      join(pluginDir, "index.ts"),
      `
        import { textOutput } from "@qianji/tools";
        export const inject = ["tools", "commands", "systemPrompt", "rpc", "webServer"];
        export function apply(ctx) {
          ctx.tools.register({
            name: "sloppy_tool",
            description: "Tool without ctx.effect v2",
            parameters: { type: "object", properties: {} },
            execute: () => textOutput("v2"),
          });
          ctx.commands.register({
            name: "sloppy-cmd",
            description: "Command without ctx.effect v2",
            execute: () => ({ output: "cmd-v2" }),
          });
          ctx.systemPrompt.section("sloppy-section", () => "Sloppy prompt v2", { order: 500 });
          ctx.rpc.method("sloppy.ping", () => ({ pong: "v2" }));
          ctx.webServer.register({
            kind: "exact",
            path: "/sloppy",
            handler: (_req, res) => {
              res.writeHead(200);
              res.end("v2");
            },
          });
        }
      `,
    );

    const reloaded = await manager.reload("sloppy-plugin");
    expect(reloaded.plugin?.status).toBe("active");
    expect(reloaded.plugin?.error).toBeUndefined();

    const session = host.ctx.sessions.create({ cwd: tempRoot });
    const toolRes = await host.ctx.tools.execute(
      { id: "t1", name: "sloppy_tool", args: {} },
      { sessionId: session.id, cwd: tempRoot, signal: new AbortController().signal },
    );
    expect(toolRes).toEqual({ content: [{ type: "text", text: "v2" }] });

    const promptV2 = await host.ctx.systemPrompt.build({
      sessionId: session.id,
      cwd: tempRoot,
      model: { provider: "mock", model: "mock" },
      tools: [],
    });
    expect(promptV2).toContain("Sloppy prompt v2");
    expect(promptV2).not.toContain("Sloppy prompt v1");

    const httpV2 = await fetch(`http://127.0.0.1:${port}/sloppy`);
    expect(httpV2.status).toBe(200);
    expect(await httpV2.text()).toBe("v2");

    await manager.setEnabled("sloppy-plugin", false);
    expect(host.ctx.tools.schemas().some((t) => t.name === "sloppy_tool")).toBe(false);
    expect((await host.ctx.commands.list()).some((c) => c.name === "sloppy-cmd")).toBe(false);
    expect(host.ctx.rpc.methods()).not.toContain("sloppy.ping");

    const promptDisabled = await host.ctx.systemPrompt.build({
      sessionId: session.id,
      cwd: tempRoot,
      model: { provider: "mock", model: "mock" },
      tools: [],
    });
    expect(promptDisabled).not.toContain("Sloppy prompt");

    const httpDisabled = await fetch(`http://127.0.0.1:${port}/sloppy`);
    expect(httpDisabled.status).toBe(404);
  });

  it("tracks multi-file .tsx + .css inputs in ClientBundleRegistry, injects scoped CSS, and supports dsh-better-sidebar externals", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pid-bundle-multifile-"));
    mkdirSync(join(tempRoot, "sub"), { recursive: true });

    const entryPath = join(tempRoot, "client.tsx");
    const childTsxPath = join(tempRoot, "sub", "Badge.tsx");
    const childCssPath = join(tempRoot, "sub", "badge.css");

    writeFileSync(childCssPath, ".badge { color: rgb(10, 20, 30); }");
    writeFileSync(
      childTsxPath,
      `
        import "./badge.css";
        export function Badge() {
          return <span className="badge">v1-child</span>;
        }
      `,
    );
    writeFileSync(
      entryPath,
      `
        import { useSidebar } from "dsh-better-sidebar/client";
        import { Badge } from "./sub/Badge";
        export default function apply() {
          return { Badge, useSidebar };
        }
      `,
    );

    const registry = new ClientBundleRegistry();
    const first = await registry.compile("multi-ui", tempRoot, entryPath);
    expect(first.code).toContain("__qianjiInjectPluginStyle");
    expect(first.code).toContain(".badge { color: rgb(10, 20, 30); }");
    expect(first.code).toContain("dsh-better-sidebar/client");
    expect(first.code).toContain("v1-child");

    // Recompile with unchanged files hits cache (exact same ETag)
    const cached = await registry.compile("multi-ui", tempRoot, entryPath);
    expect(cached.etag).toBe(first.etag);

    // Modify ONLY child Badge.tsx (without touching entry client.tsx) and advance mtime
    const futureTime = new Date(Date.now() + 5_000);
    writeFileSync(
      childTsxPath,
      `
        import "./badge.css";
        export function Badge() {
          return <span className="badge">v2-updated-child</span>;
        }
      `,
    );
    utimesSync(childTsxPath, futureTime, futureTime);

    const second = await registry.compile("multi-ui", tempRoot, entryPath);
    expect(second.etag).not.toBe(first.etag);
    expect(second.code).toContain("v2-updated-child");

    // Modify ONLY child badge.css (without touching entry client.tsx or Badge.tsx)
    const futureTime2 = new Date(Date.now() + 10_000);
    writeFileSync(childCssPath, ".badge { color: rgb(99, 88, 77); font-weight: 700; }");
    utimesSync(childCssPath, futureTime2, futureTime2);

    const third = await registry.compile("multi-ui", tempRoot, entryPath);
    expect(third.etag).not.toBe(second.etag);
    expect(third.code).toContain("rgb(99, 88, 77)");

    // Rejects `..` relative imports attempting to escape pluginDir
    const parentSecret = join(tempRoot, "outside-secret.json");
    const nestedPluginDir = join(tempRoot, "nested-plugin");
    mkdirSync(nestedPluginDir, { recursive: true });
    writeFileSync(parentSecret, JSON.stringify({ secret: "forbidden" }));
    const badEntryPath = join(nestedPluginDir, "client.tsx");
    writeFileSync(
      badEntryPath,
      `
        import secret from "../outside-secret.json";
        export default function apply() { return secret; }
      `,
    );
    await expect(registry.compile("escape-ui", nestedPluginDir, badEntryPath)).rejects.toThrow(
      /escapes plugin directory/,
    );
  });

  it("evicts all modules inside plugin subtree across both filesystem paths and file:// URLs", () => {
    const fakePluginDir = join(tmpdir(), "qj-evict-test-dir");
    const subFile = join(fakePluginDir, "helpers", "math.ts");
    const subFileUrl = `${pathToFileURL(subFile).href}?rev=1`;
    const unrelatedKey = join(tmpdir(), "other-plugin", "index.ts");

    const nodeCache = createRequire(import.meta.url).cache;
    const fakeBunRegistry = new Map<string, unknown>([
      [subFile, {}],
      [subFileUrl, {}],
      [unrelatedKey, {}],
    ]);
    const g = globalThis as { Loader?: { registry?: Map<string, unknown> } };
    const prevLoader = g.Loader;
    g.Loader = { registry: fakeBunRegistry };
    if (nodeCache) {
      nodeCache[subFile] = { id: subFile } as NodeModule;
      nodeCache[unrelatedKey] = { id: unrelatedKey } as NodeModule;
    }

    try {
      evictBunModuleSubtree(fakePluginDir);
      expect(fakeBunRegistry.has(subFile)).toBe(false);
      expect(fakeBunRegistry.has(subFileUrl)).toBe(false);
      expect(fakeBunRegistry.has(unrelatedKey)).toBe(true);
      if (nodeCache) {
        expect(nodeCache[subFile]).toBeUndefined();
        expect(nodeCache[unrelatedKey]).toBeDefined();
      }
    } finally {
      g.Loader = prevLoader;
      if (nodeCache) {
        delete nodeCache[subFile];
        delete nodeCache[unrelatedKey];
      }
    }
  });

  it("loads bundledPluginsDirs directly as read-only builtin tier and cleans unmodified legacy .seeded-*-v1 copies while preserving user customizations", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pid-bundled-tier-"));
    const dataDir = join(tempRoot, "data");
    const bundledDir = join(tempRoot, "bundled-plugins");
    const managedRoot = join(dataDir, "plugins");
    mkdirSync(bundledDir, { recursive: true });
    mkdirSync(managedRoot, { recursive: true });

    // Create two official bundled plugins: alpha (unmodified legacy seed) and beta (user-modified legacy seed)
    for (const id of ["official-alpha", "official-beta"]) {
      const pDir = join(bundledDir, id);
      mkdirSync(pDir, { recursive: true });
      writeFileSync(
        join(pDir, "package.json"),
        JSON.stringify({
          name: id,
          version: "2.0.0",
          pid: {
            id,
            name: `Official ${id}`,
            host: "./index.ts",
            client: "./client.tsx",
          },
        }),
      );
      writeFileSync(
        join(pDir, "index.ts"),
        `
          import { textOutput } from "@qianji/tools";
          export const inject = ["tools"];
          export function apply(ctx) {
            ctx.tools.register({
              name: "${id.replace(/-/g, "_")}_tool",
              description: "Official tool",
              parameters: { type: "object", properties: {} },
              execute: () => textOutput("bundled-v2"),
            });
          }
        `,
      );
      writeFileSync(
        join(pDir, "client.tsx"),
        `export default function apply() { return "${id}-client-v2"; }`,
      );
    }

    // Seed legacy copy of official-alpha (unmodified relative to install timestamp, but user configured custom config)
    const alphaSeedDir = join(managedRoot, "official-alpha");
    mkdirSync(alphaSeedDir, { recursive: true });
    const seedTimeMs = Date.now() - 60_000;
    const seedDate = new Date(seedTimeMs);
    writeFileSync(join(alphaSeedDir, "package.json"), JSON.stringify({ name: "official-alpha", version: "1.0.0" }));
    utimesSync(join(alphaSeedDir, "package.json"), seedDate, seedDate);
    writeFileSync(join(managedRoot, ".seeded-official-alpha-v1"), new Date(seedTimeMs).toISOString());

    // Seed legacy copy of official-beta where user manually edited index.ts 30s AFTER installation!
    const betaSeedDir = join(managedRoot, "official-beta");
    mkdirSync(betaSeedDir, { recursive: true });
    writeFileSync(
      join(betaSeedDir, "package.json"),
      JSON.stringify({
        name: "official-beta",
        version: "1.5.0-custom",
        pid: { id: "official-beta", name: "User Customized Beta", host: "./index.ts" },
      }),
    );
    writeFileSync(
      join(betaSeedDir, "index.ts"),
      `
        import { textOutput } from "@qianji/tools";
        export const inject = ["tools"];
        export function apply(ctx) {
          ctx.tools.register({
            name: "official_beta_tool",
            description: "User forked beta tool",
            parameters: { type: "object", properties: {} },
            execute: () => textOutput("user-modified-v1.5"),
          });
        }
      `,
    );
    const modifiedDate = new Date(seedTimeMs + 30_000);
    utimesSync(join(betaSeedDir, "index.ts"), modifiedDate, modifiedDate);
    writeFileSync(join(managedRoot, ".seeded-official-beta-v1"), new Date(seedTimeMs).toISOString());

    updatePluginsStore(dataDir, (draft) => {
      draft.plugins["official-alpha"] = {
        enabled: true,
        config: { customLimit: 99 },
        origin: {
          channel: "local",
          spec: join(bundledDir, "official-alpha"),
          installedAt: new Date(seedTimeMs).toISOString(),
        },
      };
      draft.plugins["official-beta"] = {
        enabled: true,
        origin: {
          channel: "local",
          spec: join(bundledDir, "official-beta"),
          installedAt: new Date(seedTimeMs).toISOString(),
        },
      };
    });

    cleanupLegacySeededPlugins(dataDir, [bundledDir]);

    // Unmodified alpha copy + seed marker removed, while custom config is preserved!
    expect(existsSync(alphaSeedDir)).toBe(false);
    expect(existsSync(join(managedRoot, ".seeded-official-alpha-v1"))).toBe(false);
    const savedStore = readPluginsStore(dataDir);
    expect(savedStore.plugins["official-alpha"]).toEqual({
      config: { customLimit: 99 },
    });

    // User-modified beta copy is kept intact!
    expect(existsSync(betaSeedDir)).toBe(true);

    // Boot Host + PluginManager with bundledPluginsDirs: [bundledDir]
    host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: [
        [WebServer, { pageOrigins: [pageOrigin] }],
        [RpcGateway, { token: "a".repeat(32) }],
        [Sessions],
        [Ui],
        [Tools],
      ],
    });
    await host.start();

    manager = new PluginManager(host.ctx, {
      dataDir,
      version: "0.3.0-test",
      bundledPluginsDirs: [bundledDir],
    });
    await host.ctx.plugin(pluginsRpc, { manager });
    await manager.sync();

    const list = await manager.list();
    const alphaInfo = list.find((p) => p.id === "official-alpha");
    const betaInfo = list.find((p) => p.id === "official-beta");

    expect(alphaInfo).toMatchObject({
      id: "official-alpha",
      version: "2.0.0",
      tier: "builtin",
      status: "active",
      removable: true, // has preserved user config patch that can be reset via remove()
      hasHost: true,
      hasClient: true,
      clientPath: "/plugins/official-alpha/client.js",
      config: { customLimit: 99 },
    });
    expect(betaInfo).toMatchObject({
      id: "official-beta",
      version: "1.5.0-custom",
      tier: "user",
      overridesBuiltin: true,
      status: "active",
    });

    // Resetting official-alpha via remove() clears user config override without deleting bundled-plugins files!
    const resetAlpha = await manager.remove("official-alpha");
    expect(resetAlpha.plugin).toMatchObject({
      id: "official-alpha",
      tier: "builtin",
      removable: false,
      config: {},
    });
    expect(existsSync(join(bundledDir, "official-alpha", "package.json"))).toBe(true);
  });

  it("attributes async plugin exceptions, circuit-breaks rogue plugin storms without killing Host, and syncs clientError + custom workbench tabs", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pid-plugin-storm-"));
    const dataDir = join(tempRoot, "data");
    const logsDir = join(dataDir, "logs");
    mkdirSync(logsDir, { recursive: true });

    host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: [
        [WebServer, { pageOrigins: [pageOrigin] }],
        [RpcGateway, { token: "a".repeat(32) }],
        [Sessions],
        [Ui],
        [Tools],
      ],
    });
    await host.start();

    manager = new PluginManager(host.ctx, {
      dataDir,
      version: "0.3.0-test",
    });
    await host.ctx.plugin(pluginsRpc, { manager });
    await host.ctx.plugin(workbenchRpc);
    await manager.sync();

    const rogueDir = join(tempRoot, "rogue-async");
    mkdirSync(rogueDir, { recursive: true });
    writeFileSync(
      join(rogueDir, "package.json"),
      JSON.stringify({
        name: "rogue-async",
        version: "1.0.0",
        pid: { id: "rogue-async", name: "Rogue Async", host: "./index.ts" },
      }),
    );
    writeFileSync(join(rogueDir, "index.ts"), `export function apply() {}`);
    await manager.install({ channel: "local", spec: rogueDir, link: true });

    const proc = createFakeProcess();
    const exitCodes: number[] = [];
    let clockMs = Date.now();
    const circuitBreaks: string[] = [];

    const guard = installHostCrashGuards({
      getLogsDir: () => logsDir,
      isStarted: () => true,
      proc,
      stderr: { write: () => true },
      exit: (code) => exitCodes.push(code),
      now: () => new Date(clockMs),
      stormLimit: 3,
      stormWindowMs: 5_000,
      onPluginError: (err) => manager?.attributeExternalPluginError(err),
      onPluginStorm: (pluginId, err) => {
        circuitBreaks.push(pluginId);
        manager?.circuitBreakPlugin(pluginId, err);
      },
    });

    try {
      const rogueFile = join(rogueDir, "index.ts");
      const makeRogueError = (n: number): Error => {
        const err = new Error(`async timer failure #${n}`);
        err.stack = `Error: async timer failure #${n}\n    at Timeout._onTimeout (${rogueFile}:12:9)`;
        return err;
      };

      proc.emitException(makeRogueError(1));
      expect((await manager.list()).find((p) => p.id === "rogue-async")?.status).toBe("errored");
      expect(exitCodes).toEqual([]);

      clockMs += 100;
      proc.emitException(makeRogueError(2));
      clockMs += 100;
      proc.emitException(makeRogueError(3));

      // Rogue plugin storm trips circuit-breaker on rogue-async ONLY — Host process does NOT exit!
      expect(exitCodes).toEqual([]);
      expect(circuitBreaks).toEqual(["rogue-async"]);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect((await manager.list()).find((p) => p.id === "rogue-async")?.enabled).toBe(false);
    } finally {
      guard.dispose();
    }

    // Verify plugin.reportClientError / plugin.clearClientError and custom workbench.open tab IDs
    const handlers = (host.ctx.rpc as unknown as {
      handlers: Map<string, (params: unknown, call: unknown) => unknown>;
    }).handlers;
    const callRpc = async <T>(method: string, params: unknown = {}): Promise<T> => {
      const fn = handlers.get(method);
      if (!fn) throw new Error(`Missing RPC ${method}`);
      return (await fn(params, { signal: new AbortController().signal, notify: () => undefined })) as T;
    };

    await manager.setEnabled("rogue-async", true);
    await callRpc("plugin.reportClientError", {
      id: "rogue-async",
      phase: "render",
      message: "Slot render exploded",
      stack: "at RogueSlot",
      etag: "\"abc123\"",
    });

    const listWithErr = await callRpc<PluginListResult>("plugin.list", {});
    expect(listWithErr.plugins.find((p) => p.id === "rogue-async")?.clientError).toEqual({
      phase: "render",
      message: "Slot render exploded",
      stack: "at RogueSlot",
      etag: "\"abc123\"",
    });

    await callRpc("plugin.clearClientError", { id: "rogue-async" });
    const listCleared = await callRpc<PluginListResult>("plugin.list", {});
    expect(listCleared.plugins.find((p) => p.id === "rogue-async")?.clientError).toBeUndefined();

    // Verify custom plugin workbench tab IDs work via workbench.open and sidebar_open
    const workbenchEvents: WorkbenchOpenNotification[] = [];
    const origBroadcast = host.ctx.rpc.broadcast.bind(host.ctx.rpc);
    host.ctx.rpc.broadcast = ((method: string, params: unknown) => {
      if (method === "workbench/open") {
        workbenchEvents.push(params as WorkbenchOpenNotification);
      }
      origBroadcast(method, params);
    }) as typeof host.ctx.rpc.broadcast;

    await callRpc("workbench.open", { target: "my-plugin:sqlite-viewer" });
    expect(workbenchEvents.at(-1)).toMatchObject({
      target: "my-plugin:sqlite-viewer",
    });

    const session = host.ctx.sessions.create({ cwd: tempRoot });
    const toolOpenRes = await host.ctx.tools.execute(
      { id: "open1", name: "sidebar_open", args: { target: "my-plugin:metrics" } },
      { sessionId: session.id, cwd: tempRoot, signal: new AbortController().signal },
    );
    expect(toolOpenRes.isError).toBeUndefined();
    expect(workbenchEvents.at(-1)?.target).toBe("my-plugin:metrics");

    const badToolOpenRes = await host.ctx.tools.execute(
      { id: "open2", name: "sidebar_open", args: { target: "../bad target" } },
      { sessionId: session.id, cwd: tempRoot, signal: new AbortController().signal },
    );
    expect(badToolOpenRes.isError).toBe(true);

    // Regression: alias/junction/8.3 short-path directories where resolve(dir) !== realpathSync.native(dir)
    const realTargetDir = join(tempRoot, "real-plugin-dir");
    const aliasDir = join(tempRoot, "RUNNER~1-alias");
    mkdirSync(join(realTargetDir, "sub"), { recursive: true });
    writeFileSync(join(realTargetDir, "sub", "Part.tsx"), `export const Part = () => <span>alias-ok</span>;`);
    writeFileSync(
      join(realTargetDir, "client.tsx"),
      `import { Part } from "./sub/Part";\nexport default function apply() { return Part; }`,
    );
    writeFileSync(
      join(realTargetDir, "package.json"),
      JSON.stringify({
        name: "alias-plugin",
        version: "1.0.0",
        pid: { id: "alias-plugin", name: "Alias Plugin", host: "./index.ts", client: "./client.tsx" },
      }),
    );
    writeFileSync(join(realTargetDir, "index.ts"), `export function apply() {}`);
    symlinkSync(realTargetDir, aliasDir, process.platform === "win32" ? "junction" : "dir");

    const aliasRegistry = new ClientBundleRegistry();
    const aliasCompiled = await aliasRegistry.compile("alias-plugin", aliasDir, join(aliasDir, "client.tsx"));
    expect(aliasCompiled.code).toContain("alias-ok");

    await manager.install({ channel: "local", spec: realTargetDir, link: true });
    const aliasStackErr = new Error("alias frame failure");
    aliasStackErr.stack = `Error: alias frame failure\n    at Timeout._onTimeout (${join(aliasDir, "index.ts")}:9:3)`;
    const attributed = manager.attributeExternalPluginError(aliasStackErr);
    expect(attributed).toEqual({ pluginId: "alias-plugin", alreadyCircuitBroken: false });
  });
});
