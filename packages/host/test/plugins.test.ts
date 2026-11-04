/**
 * Dynamic plugin kernel tests (ADR 0016):
 * - Host module bridge singleton identity for external `.ts` plugins
 * - Client `.tsx` / CJS / DSH pre-wrapped bundle serving with ETag + 304 + asset traversal defense
 * - Three-tier resolution (`workspace` > `user` > `builtin`), built-in override and fallback restoration
 * - Live `fs.watch` HMR and transactional rollback when a reload fails
 * - Multi-channel install/update (`local`, `archive` + Zip-Slip rejection, `git` clone & pull, `npm` via Bun)
 * - Workspace Trust gate (`workspace.trust.list` / `workspace.trust.set`)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode, type PluginChangedNotification, type WorkspaceTrustChangedNotification } from "@pid/protocol";
import { Sessions } from "@pid/session";
import { SystemPrompt } from "@pid/system-prompt";
import { Tools } from "@pid/tools";
import { Ui } from "@pid/ui";
import * as plan from "@pid/plan";
import { createHost, type Host } from "../src/host.ts";
import { validateArchiveEntries } from "../src/plugin-installer.ts";
import { PluginManager } from "../src/plugin-manager.ts";
import * as pluginsRpc from "../src/plugins-rpc.ts";
import { RpcError, RpcGateway } from "../src/rpc.ts";
import { WebServer } from "../src/web-server.ts";

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

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

interface TestHarness {
  dataDir: string;
  baseUrl: string;
  changedEvents: PluginChangedNotification[];
  trustEvents: WorkspaceTrustChangedNotification[];
  callRpc<T>(method: string, params?: unknown): Promise<T>;
}

async function setupPluginHost(): Promise<TestHarness> {
  tempRoot = mkdtempSync(join(tmpdir(), "pid-plugins-test-"));
  const dataDir = join(tempRoot, "data");
  mkdirSync(dataDir, { recursive: true });

  const changedEvents: PluginChangedNotification[] = [];
  const trustEvents: WorkspaceTrustChangedNotification[] = [];

  host = createHost({
    version: "0.3.0-test",
    dataDir,
    plugins: [
      [WebServer, { pageOrigins: [pageOrigin] }],
      [RpcGateway, { token: "a".repeat(32) }],
      [Sessions],
      [Ui],
      [Tools],
      [SystemPrompt],
    ],
  });
  await host.start();

  manager = new PluginManager(host.ctx, {
    dataDir,
    version: "0.3.0-test",
    builtins: () => [
      {
        id: "plan",
        name: "任务计划追踪 (plan)",
        description: "Built-in plan plugin",
        enabled: true,
        hasHost: true,
        hasClient: false,
        plugin: plan,
      },
    ],
    onChanged: (event) => changedEvents.push(event),
    onTrustChanged: (event) => trustEvents.push(event),
  });
  await host.ctx.plugin(pluginsRpc, { manager });
  await manager.sync();

  const port = await host.ctx.webServer.listen(0);
  const handlers = (host.ctx.rpc as unknown as { handlers: Map<string, (params: unknown, call: unknown) => unknown> }).handlers;

  return {
    dataDir,
    baseUrl: `http://127.0.0.1:${port}`,
    changedEvents,
    trustEvents,
    async callRpc<T>(method: string, params: unknown = {}): Promise<T> {
      const handler = handlers.get(method);
      if (handler === undefined) throw new Error(`Missing RPC method ${method}`);
      return (await handler(params, { signal: new AbortController().signal, notify: () => {} })) as T;
    },
  };
}

describe("dynamic plugin kernel (ADR 0016)", () => {
  it("shares host singletons with external .ts plugins and compiles .tsx client bundles with ETag + asset protection", async () => {
    const env = await setupPluginHost();
    const extDir = join(tempRoot, "my-fullstack-plugin");
    mkdirSync(join(extDir, "src"), { recursive: true });
    mkdirSync(join(extDir, "assets"), { recursive: true });

    writeFileSync(join(extDir, "package.json"), JSON.stringify({
      name: "@demo/fullstack",
      version: "1.2.0",
      description: "Full-stack TS/TSX plugin",
      pid: {
        id: "demo-fullstack",
        name: "全栈示例插件",
        host: "./src/index.ts",
        client: "./src/client.tsx",
        assets: "./assets",
        defaultConfig: { greeting: "hello" },
      },
    }, null, 2));

    writeFileSync(join(extDir, "src", "index.ts"), `
      import { Context } from "@deepseek-ai/cordis";
      import { textOutput } from "@pid/tools";

      export const name = "demo-fullstack";
      export const inject = ["tools"];

      export function apply(ctx: Context, config: { greeting?: string }) {
        const sameCordis = ctx instanceof Context;
        ctx.effect(() => ctx.tools.register({
          name: "demo_greet",
          description: "Greets from an external TS plugin",
          parameters: { type: "object", properties: { who: { type: "string" } } },
          execute: (args) => textOutput(\`\${config.greeting ?? "hi"}:\${(args as { who?: string }).who ?? "world"}:singleton=\${sameCordis}\`),
        }), "demo_greet");
      }
    `);

    writeFileSync(join(extDir, "src", "client.tsx"), `
      import { useState } from "react";
      export function DemoBadge() {
        const [count] = useState(7);
        return <span data-count={count}>Demo Plugin UI</span>;
      }
    `);
    writeFileSync(join(extDir, "assets", "icon.svg"), "<svg><circle r='4'/></svg>");

    const installed = await env.callRpc<{ plugin: { id: string; status: string; hasHost: boolean; hasClient: boolean; watch: boolean; clientEtag?: string } }>(
      "plugin.install",
      { channel: "local", spec: extDir, link: true },
    );
    expect(installed.plugin).toMatchObject({
      id: "demo-fullstack",
      status: "active",
      hasHost: true,
      hasClient: true,
      watch: true,
    });
    expect(installed.plugin.clientEtag).toMatch(/^"[0-9a-f]{12}"$/);

    const session = host?.ctx.sessions.create({ cwd: tempRoot });
    if (session === undefined) throw new Error("expected session");
    const runTool = () => host?.ctx.tools.execute(
      { id: "c1", name: "demo_greet", args: { who: "pi" } },
      { sessionId: session.id, cwd: tempRoot, signal: new AbortController().signal },
    );
    expect(await runTool()).toEqual({ content: [{ type: "text", text: "hello:pi:singleton=true" }] });

    // Live reconfiguration reloads the plugin with updated config.
    await env.callRpc("plugin.configure", { id: "demo-fullstack", config: { greeting: "ni-hao" } });
    expect(await runTool()).toEqual({ content: [{ type: "text", text: "ni-hao:pi:singleton=true" }] });

    // Client bundle HTTP route + ETag 304 + RPC clientBundle.
    const res200 = await fetch(`${env.baseUrl}/plugins/demo-fullstack/client.js`, { headers: { origin: pageOrigin } });
    expect(res200.status).toBe(200);
    const etag = res200.headers.get("etag") ?? "";
    const code = await res200.text();
    expect(code).toContain('window.__ModuleLoader__.load({ id: "demo-fullstack"');
    expect(code).toContain("Demo Plugin UI");

    const res304 = await fetch(`${env.baseUrl}/plugins/demo-fullstack/client.js`, {
      headers: { origin: pageOrigin, "if-none-match": etag },
    });
    expect(res304.status).toBe(304);

    const rpcBundle = await env.callRpc<{ notModified: boolean; etag: string; code?: string }>("plugin.clientBundle", { id: "demo-fullstack" });
    expect(rpcBundle.notModified).toBe(false);
    expect(rpcBundle.etag).toBe(etag);
    const rpcCached = await env.callRpc<{ notModified: boolean; etag: string; code?: string }>("plugin.clientBundle", { id: "demo-fullstack", ifNoneMatch: etag });
    expect(rpcCached).toEqual({ notModified: true, etag });

    // Static asset serving & path traversal rejection.
    const svgRes = await fetch(`${env.baseUrl}/plugins/demo-fullstack/assets/icon.svg`, { headers: { origin: pageOrigin } });
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get("content-type")).toBe("image/svg+xml");

    const traversalRes = await fetch(`${env.baseUrl}/plugins/demo-fullstack/assets/..%2Fpackage.json`, { headers: { origin: pageOrigin } });
    expect(traversalRes.status).toBe(404);

    // Removing a linked local plugin unmounts its tools without deleting the user's source directory.
    await env.callRpc("plugin.remove", { id: "demo-fullstack" });
    expect(host?.ctx.tools.schemas().some((s) => s.name === "demo_greet")).toBe(false);
    expect(existsSync(join(extDir, "src", "index.ts"))).toBe(true);
  });

  it("allows user plugins to override built-in plugins by id and restores the built-in on remove", async () => {
    const env = await setupPluginHost();
    expect(host?.ctx.tools.schemas().some((s) => s.name === "update_plan")).toBe(true);

    const overrideDir = join(tempRoot, "custom-plan");
    mkdirSync(overrideDir, { recursive: true });
    writeFileSync(join(overrideDir, "package.json"), JSON.stringify({
      name: "my-custom-plan",
      version: "2.0.0",
      pid: { id: "plan", name: "自定义计划插件", host: "./index.ts" },
    }));
    writeFileSync(join(overrideDir, "index.ts"), `
      import type { Context } from "@deepseek-ai/cordis";
      import { textOutput } from "@pid/tools";
      export const name = "custom-plan";
      export const inject = ["tools"];
      export function apply(ctx: Context) {
        ctx.effect(() => ctx.tools.register({
          name: "custom_plan_marker",
          description: "Custom plan replacement",
          parameters: { type: "object" },
          execute: () => textOutput("custom-plan-active"),
        }), "custom_plan_marker");
      }
    `);

    const installed = await env.callRpc<{ plugin: { id: string; tier: string; overridesBuiltin: boolean } }>(
      "plugin.install",
      { channel: "local", spec: overrideDir, link: false },
    );
    expect(installed.plugin).toMatchObject({ id: "plan", tier: "user", overridesBuiltin: true });
    expect(host?.ctx.tools.schemas().some((s) => s.name === "update_plan")).toBe(false);
    expect(host?.ctx.tools.schemas().some((s) => s.name === "custom_plan_marker")).toBe(true);

    // Removing the user override restores the built-in `plan` plugin automatically.
    const removed = await env.callRpc<{ plugin: { id: string; tier: string; overridesBuiltin: boolean; status: string } }>(
      "plugin.remove",
      { id: "plan" },
    );
    expect(removed.plugin).toMatchObject({ id: "plan", tier: "builtin", overridesBuiltin: false, status: "active" });
    expect(host?.ctx.tools.schemas().some((s) => s.name === "update_plan")).toBe(true);
    expect(host?.ctx.tools.schemas().some((s) => s.name === "custom_plan_marker")).toBe(false);
  });

  it("supports DSH community client-compat packages without executing DSH-private host entries", async () => {
    const env = await setupPluginHost();
    const dshDir = join(tempRoot, "dsh-office-viewer");
    mkdirSync(join(dshDir, "lib"), { recursive: true });
    writeFileSync(join(dshDir, "package.json"), JSON.stringify({
      name: "@dsh-external/dsh-office-viewer",
      version: "0.4.2",
      main: "./lib/index.js",
      exports: {
        ".": "./lib/index.js",
        "./client": "./lib/client.js",
      },
      dsh: { client: "./client" },
      peerDependencies: { "dsh-better-sidebar": "*" },
    }));
    // This host file would fail if executed because @deepseek-ai/dsh-client-modules does not exist in PI-Desktop.
    writeFileSync(join(dshDir, "lib", "index.js"), `import "@deepseek-ai/dsh-client-modules"; export function apply() {}`);
    const prewrapped = `window.__ModuleLoader__.load({ id: "@dsh-external/dsh-office-viewer", factory: (require) => ({ name: "office-viewer" }) });`;
    writeFileSync(join(dshDir, "lib", "client.js"), prewrapped);

    const installed = await env.callRpc<{ plugin: { id: string; status: string; hasHost: boolean; hasClient: boolean; clientPath?: string } }>(
      "plugin.install",
      { channel: "local", spec: dshDir, link: true },
    );
    expect(installed.plugin).toMatchObject({
      id: "@dsh-external/dsh-office-viewer",
      status: "active",
      hasHost: false,
      hasClient: true,
      clientPath: "/plugins/%40dsh-external%2Fdsh-office-viewer/client.js",
    });

    const res = await fetch(`${env.baseUrl}${installed.plugin.clientPath ?? ""}`, { headers: { origin: pageOrigin } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(prewrapped);
  });

  it("hot-reloads watched plugins on edit and rolls back to the previous fiber when an edit throws", async () => {
    const env = await setupPluginHost();
    const watchDir = join(tempRoot, "watched-plugin");
    mkdirSync(watchDir, { recursive: true });
    writeFileSync(join(watchDir, "package.json"), JSON.stringify({
      name: "watched-plugin",
      version: "0.1.0",
      pid: { id: "watched-plugin", host: "./index.ts" },
    }));
    const writePluginVersion = (body: string) => writeFileSync(join(watchDir, "index.ts"), body);

    writePluginVersion(`
      import type { Context } from "@deepseek-ai/cordis";
      import { textOutput } from "@pid/tools";
      export const name = "watched-plugin";
      export const inject = ["tools"];
      export function apply(ctx: Context) {
        ctx.effect(() => ctx.tools.register({
          name: "watched_tool",
          description: "v1",
          parameters: { type: "object" },
          execute: () => textOutput("v1"),
        }), "watched_tool");
      }
    `);

    await env.callRpc("plugin.install", { channel: "local", spec: watchDir, link: true, watch: true });
    const session = host?.ctx.sessions.create({ cwd: tempRoot });
    if (session === undefined) throw new Error("expected session");
    const execWatched = () => host?.ctx.tools.execute(
      { id: "w1", name: "watched_tool", args: {} },
      { sessionId: session.id, cwd: tempRoot, signal: new AbortController().signal },
    );
    expect(await execWatched()).toEqual({ content: [{ type: "text", text: "v1" }] });

    // Edit to v2 -> fs.watch triggers debounced HMR.
    writePluginVersion(`
      import type { Context } from "@deepseek-ai/cordis";
      import { textOutput } from "@pid/tools";
      export const name = "watched-plugin";
      export const inject = ["tools"];
      export function apply(ctx: Context) {
        ctx.effect(() => ctx.tools.register({
          name: "watched_tool",
          description: "v2",
          parameters: { type: "object" },
          execute: () => textOutput("v2"),
        }), "watched_tool");
      }
    `);
    await eventually(async () => {
      const out = await execWatched();
      return JSON.stringify(out).includes('"v2"');
    });
    expect(env.changedEvents.some((e) => e.reason === "hmr" && e.changedIds.includes("watched-plugin"))).toBe(true);

    // Edit to a broken apply() -> HMR catches error and rolls back to v2!
    writePluginVersion(`
      export function apply() {
        throw new Error("boom during apply");
      }
    `);
    const reloaded = await env.callRpc<{ plugin: { status: string; error?: string } }>("plugin.reload", { id: "watched-plugin" });
    expect(reloaded.plugin.status).toBe("active");
    expect(reloaded.plugin.error).toContain("rolled back");
    expect(reloaded.plugin.error).toContain("boom during apply");
    expect(await execWatched()).toEqual({ content: [{ type: "text", text: "v2" }] });
  });

  it("installs and updates plugins via archive (blocking Zip-Slip), git, and npm channels", async () => {
    const env = await setupPluginHost();

    // 1. Archive (.tgz) install + Zip-Slip rejection.
    expect(() => validateArchiveEntries("package/index.js\n../../outside.js\n")).toThrow(/Path traversal/);
    expect(() => validateArchiveEntries("C:/Windows/win.ini\n")).toThrow(/Unsafe archive entry/);
    expect(() => validateArchiveEntries("/etc/passwd\n")).toThrow(/Unsafe archive entry/);

    const pkgSrc = join(tempRoot, "archive-src", "package");
    mkdirSync(pkgSrc, { recursive: true });
    writeFileSync(join(pkgSrc, "package.json"), JSON.stringify({ name: "archived-plug", version: "1.0.0", main: "./index.js" }));
    writeFileSync(join(pkgSrc, "index.js"), `export function apply() {}`);
    const tgzFile = join(tempRoot, "archived-plug.tgz");
    expect(spawnSync("tar", ["-czf", tgzFile, "-C", join(tempRoot, "archive-src"), "package"], { windowsHide: true }).status).toBe(0);

    const fromArchive = await env.callRpc<{ plugin: { id: string; status: string; origin?: { channel: string } } }>(
      "plugin.install",
      { channel: "archive", spec: tgzFile },
    );
    expect(fromArchive.plugin).toMatchObject({ id: "archived-plug", status: "active", origin: { channel: "archive" } });

    // 2. Git clone + fast-forward update against a local git repository.
    const gitOrigin = join(tempRoot, "git-plugin-repo");
    mkdirSync(gitOrigin, { recursive: true });
    const git = (args: string[]) => {
      const res = spawnSync("git", args, { cwd: gitOrigin, encoding: "utf8", windowsHide: true });
      if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    };
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(join(gitOrigin, "package.json"), JSON.stringify({ name: "git-plug", version: "0.1.0", main: "./index.js" }));
    writeFileSync(join(gitOrigin, "index.js"), `export function apply() {}`);
    git(["add", "."]);
    git(["commit", "-m", "v0.1.0"]);

    const fromGit = await env.callRpc<{ plugin: { id: string; version: string } }>("plugin.install", {
      channel: "git",
      spec: gitOrigin,
    });
    expect(fromGit.plugin).toMatchObject({ id: "git-plug", version: "0.1.0" });

    writeFileSync(join(gitOrigin, "package.json"), JSON.stringify({ name: "git-plug", version: "0.2.0", main: "./index.js" }));
    git(["add", "."]);
    git(["commit", "-m", "v0.2.0"]);

    const updatedGit = await env.callRpc<{ plugin: { id: string; version: string } }>("plugin.update", { id: "git-plug" });
    expect(updatedGit.plugin).toMatchObject({ id: "git-plug", version: "0.2.0" });

    // 3. npm channel via Bun (`bun add --ignore-scripts <tarball>`).
    const npmSrc = join(tempRoot, "npm-src", "package");
    mkdirSync(npmSrc, { recursive: true });
    writeFileSync(join(npmSrc, "package.json"), JSON.stringify({ name: "npm-tarball-plug", version: "3.1.0", main: "./index.js" }));
    writeFileSync(join(npmSrc, "index.js"), `export function apply() {}`);
    const npmTgz = join(tempRoot, "npm-tarball-plug-3.1.0.tgz");
    expect(spawnSync("tar", ["-czf", npmTgz, "-C", join(tempRoot, "npm-src"), "package"], { windowsHide: true }).status).toBe(0);

    const fromNpm = await env.callRpc<{ plugin: { id: string; version: string; status: string; origin?: { channel: string } } }>(
      "plugin.install",
      { channel: "npm", spec: npmTgz },
    );
    expect(fromNpm.plugin).toMatchObject({ id: "npm-tarball-plug", version: "3.1.0", status: "active", origin: { channel: "npm" } });
  }, 30_000);

  it("gates workspace plugins behind Workspace Trust and unloads them immediately when revoked", async () => {
    const env = await setupPluginHost();
    const workspace = join(tempRoot, "team-repo");
    const wsPluginDir = join(workspace, ".pid", "plugins", "team-helper");
    mkdirSync(wsPluginDir, { recursive: true });
    writeFileSync(join(wsPluginDir, "package.json"), JSON.stringify({
      name: "team-helper",
      version: "0.1.0",
      pid: { id: "team-helper", name: "团队工作区插件", host: "./index.ts" },
    }));
    writeFileSync(join(wsPluginDir, "index.ts"), `
      import type { Context } from "@deepseek-ai/cordis";
      import { textOutput } from "@pid/tools";
      export const name = "team-helper";
      export const inject = ["tools"];
      export function apply(ctx: Context) {
        ctx.effect(() => ctx.tools.register({
          name: "team_helper_tool",
          description: "Workspace tool",
          parameters: { type: "object" },
          execute: () => textOutput("trusted"),
        }), "team_helper_tool");
      }
    `);

    const initialTrust = await env.callRpc<{ current?: { trusted: boolean; hasProjectPlugins: boolean; pluginIds: string[] } }>(
      "workspace.trust.list",
      { workspace },
    );
    expect(initialTrust.current).toMatchObject({
      trusted: false,
      hasProjectPlugins: true,
      pluginIds: ["team-helper"],
    });

    const untrustedList = await env.callRpc<{ plugins: Array<{ id: string; status: string }> }>("plugin.list", { workspace });
    expect(untrustedList.plugins.find((p) => p.id === "team-helper")).toMatchObject({ id: "team-helper", status: "untrusted" });
    expect(host?.ctx.tools.schemas().some((s) => s.name === "team_helper_tool")).toBe(false);

    // Enabling a workspace plugin before trusting the workspace is denied with PermissionDenied.
    await expect(env.callRpc("plugin.enable", { id: "team-helper", workspace })).rejects.toMatchObject({
      code: ErrorCode.PermissionDenied,
    } satisfies Partial<RpcError>);

    // Grant trust -> plugin mounts immediately.
    const granted = await env.callRpc<{ current?: { trusted: boolean } }>("workspace.trust.set", { workspace, trusted: true });
    expect(granted.current?.trusted).toBe(true);
    expect(host?.ctx.tools.schemas().some((s) => s.name === "team_helper_tool")).toBe(true);
    expect(env.trustEvents.at(-1)?.trusted).toBe(true);

    // Revoke trust -> plugin unmounts immediately.
    await env.callRpc("workspace.trust.set", { workspace, trusted: false });
    expect(host?.ctx.tools.schemas().some((s) => s.name === "team_helper_tool")).toBe(false);
    expect(env.trustEvents.at(-1)?.trusted).toBe(false);
  });
});
