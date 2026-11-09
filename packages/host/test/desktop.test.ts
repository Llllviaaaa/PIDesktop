/**
 * P5a: the desktop's settings as harness configuration,
 * secrets at rest, the control channel, and plugins that reload
 * with their configuration.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Credentials, LlmService } from "@pid/llm";
import { Sessions } from "@pid/session";
import { SystemPrompt } from "@pid/system-prompt";
import { Tools, textOutput } from "@pid/tools";
import { Ui } from "@pid/ui";
import { featureEntries, withMcpSecrets } from "../src/agent-plugins.ts";
import { applyDesktopMessage, importDesktopTasks, parseControlLine } from "../src/control.ts";
import { effortFromThinking, harnessFromDesktop, personalInstructions } from "../src/desktop-settings.ts";
import { defaultHarnessConfig, readEffectiveHarnessConfig, readHarnessConfig } from "../src/harness-config.ts";
import { readPluginsStore, updatePluginsStore } from "../src/plugin-store.ts";
import { readDefaultModel } from "../src/providers.ts";
import { ReloadablePlugins } from "../src/reloadable.ts";
import { fileSecretResolver, readSecretFile, writeSecretFile, type SecretCodec } from "../src/secrets.ts";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Stands in for DPAPI: reversible, and plainly not the plaintext. */
const codec: SecretCodec = {
  protect: (data) => Buffer.from(data.map((byte) => byte ^ 0x5a)),
  unprotect: (data) => Buffer.from(data.map((byte) => byte ^ 0x5a)),
};

const desktopSettings = {
  provider: "deepseek",
  model: "deepseek-chat",
  thinkingLevel: "xhigh",
  permissionMode: "workspace-write",
  agentMode: "plan",
  alwaysConfirmShell: false,
  blockWriteOutsideWorkspace: true,
  allowForcePush: true,
  shellAllowPrefixes: "git status\n npm test ,",
  toolRules: [{ id: "r", enabled: true, toolPattern: "bash", action: "block", commandPrefix: "rm", pathPrefix: "" }],
  hooksEnabled: false,
  hooks: [{ id: "h" }],
  memoryEnabled: false,
  planTrackingEnabled: true,
  mcpEnabled: true,
  mcpConfirmTools: false,
  mcpServers: [{ id: "fs", name: "FS", enabled: true, transport: "stdio", command: "npx", args: [], cwd: "", env: {}, inheritEnvironment: false, url: "", headers: {}, trustedReadOnly: false }],
  subagentsEnabled: true,
  subagentMaxConcurrency: 9,
  browserEnabled: true,
  browserHeadless: false,
  browserProfileMode: "persistent",
  browserConfirmActions: true,
  browserExecutable: "",
  computerEnabled: false,
  computerConfirmActions: true,
  personality: "pragmatic",
  customInstructions: "  Answer in Chinese.  ",
};

describe("desktop settings", () => {
  it("map onto every harness.json section the way launch.rs maps them onto Pi", () => {
    const { config, defaultModel } = harnessFromDesktop({ settings: desktopSettings, configDir: "C:/cfg", executable: "C:/app/Pi Desktop.exe" });
    expect(defaultModel).toEqual({ provider: "deepseek", model: "deepseek-chat" });
    expect(config.permissions).toEqual({
      defaultPermission: "workspace-write",
      defaultAgentMode: "plan",
      alwaysConfirmShell: false,
      blockWriteOutsideWorkspace: true,
      allowForcePush: true,
      shellAllowPrefixes: ["git status", "npm test"],
      toolRules: desktopSettings.toolRules,
    });
    expect(config.hooks).toEqual({ hooks: [], inheritEnvironment: false });
    expect(config.memory).toEqual({ enabled: false, file: join("C:/cfg", "memory.md") });
    expect(config.contextFiles).toEqual({ enabled: false });
    expect(config.mcp).toMatchObject({ confirmTools: false, secretsFile: join("C:/cfg", "mcp-secrets.dat"), servers: [{ id: "fs" }] });
    expect(config.subagents).toEqual({ enabled: true, concurrency: 4, model: defaultModel, effort: "xhigh" });
    expect(config.browser).toEqual({ enabled: true, headless: false, confirmActions: true, profileDir: join("C:/cfg", "browser-profile") });
    expect(config.computer).toEqual({ enabled: false, confirmActions: true, helper: "C:/app/Pi Desktop.exe" });
    expect(config.sandbox).toEqual({ enabled: false });
    expect(harnessFromDesktop({ settings: { sandboxEnabled: true }, configDir: "C:/cfg" }).config.sandbox).toEqual({ enabled: true });
    expect(config.prompt.instructions).toBe("Communication style: be direct, implementation-focused, and concise. Lead with concrete outcomes.\n\nAnswer in Chinese.");
  });

  it("fall back to the defaults for missing settings", () => {
    const { config, defaultModel } = harnessFromDesktop({ settings: {}, configDir: "/c" });
    expect(defaultModel).toBeUndefined();
    expect(config.permissions).toMatchObject({ defaultPermission: "ask", defaultAgentMode: "agent", alwaysConfirmShell: true });
    expect(config.mcp.servers).toEqual([]);
    expect(personalInstructions({ personality: "unknown" })).toBe("");
    expect([effortFromThinking("off"), effortFromThinking("minimal"), effortFromThinking("medium"), effortFromThinking("ultra"), effortFromThinking("")]).toEqual(["off", "minimal", "medium", "ultra", undefined]);
  });
});

describe("secrets at rest", () => {
  it("round-trip through the codec and never sit in the file as plaintext", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-secrets-"));
    const file = join(dir, "secrets.dat");
    writeSecretFile(file, { "provider/a": "sk-secret" }, codec);
    expect(readFileSync(file).toString("utf8")).not.toContain("sk-secret");
    expect(readSecretFile(file, codec)).toEqual({ "provider/a": "sk-secret" });
    expect(await fileSecretResolver(file, codec)("provider/a")).toBe("sk-secret");
    expect(await fileSecretResolver(file, codec)("missing")).toBeUndefined();
    expect(readSecretFile(join(dir, "none.dat"), codec)).toEqual({});
  });

  it("merge MCP env and headers into server configs in memory", () => {
    const server = desktopSettings.mcpServers[0] as never;
    expect(withMcpSecrets([server], { fs: { env: { TOKEN: "t" }, headers: { Authorization: "Bearer x" } } })).toMatchObject([{ env: { TOKEN: "t" }, headers: { Authorization: "Bearer x" } }]);
    expect(withMcpSecrets([server], {})).toEqual([server]);
  });
});

describe("control channel", () => {
  it("parses commands and rejects unknown ones", () => {
    expect(parseControlLine("")).toBeUndefined();
    expect(parseControlLine('{"reload":true}')).toEqual({ reload: true });
    expect(parseControlLine('{"desktop":{"settings":{},"configDir":"/c"}}')).toEqual({ desktop: { settings: {}, configDir: "/c" } });
    expect(() => parseControlLine('{"shutdown":true}')).toThrow("unknown control command");
  });

  it("writes harness.json and follows the desktop's model", () => {
    dir = mkdtempSync(join(tmpdir(), "pid-control-"));
    const dataDir = join(dir, "data");
    const message = { settings: desktopSettings, configDir: join(dir, "cfg") };

    expect(applyDesktopMessage(dataDir, message)).toEqual([]);
    expect(readHarnessConfig(join(dataDir, "harness.json")).config.permissions.defaultPermission).toBe("workspace-write");
    expect(readDefaultModel(join(dataDir, "providers.json"))).toEqual({ provider: "deepseek", model: "deepseek-chat" });

    // Later messages leave the providers alone and only move the default model.
    const file = JSON.parse(readFileSync(join(dataDir, "providers.json"), "utf8"));
    writeFileSync(join(dataDir, "providers.json"), JSON.stringify({ ...file, providers: [{ api: "openai-compat", id: "deepseek", baseUrl: "https://api.deepseek.com/v1" }] }));
    expect(applyDesktopMessage(dataDir, { ...message, settings: { ...desktopSettings, model: "deepseek-reasoner" } })).toEqual([]);
    const providers = JSON.parse(readFileSync(join(dataDir, "providers.json"), "utf8"));
    expect(providers.providers.map((entry: { id: string }) => entry.id)).toEqual(["deepseek"]);
    expect(providers.defaultModel).toEqual({ provider: "deepseek", model: "deepseek-reasoner" });
  });

  it("reconciles DesktopMessage toggle flips with plugins.json without clobbering untouched plugin toggles, and overlays trusted .pid/harness.json", () => {
    dir = mkdtempSync(join(tmpdir(), "pid-control-reconcile-"));
    const dataDir = join(dir, "data");
    const cfgDir = join(dir, "cfg");

    // 1. Initial desktop sync writes harness.json (plan = true).
    applyDesktopMessage(dataDir, { settings: { ...desktopSettings, planTrackingEnabled: true }, configDir: cfgDir });
    // 2. User disables `plan` and `mcp` in PluginsSettingsPanel -> stored in plugins.json.
    updatePluginsStore(dataDir, (store) => {
      store.plugins.plan = { enabled: false, config: { custom: 1 } };
      store.plugins.mcp = { enabled: false };
    });

    // 3. Unrelated desktop change (model switch) does NOT clobber plugins.json overrides!
    applyDesktopMessage(dataDir, { settings: { ...desktopSettings, planTrackingEnabled: true, model: "deepseek-reasoner" }, configDir: cfgDir });
    expect(readPluginsStore(dataDir).plugins.plan).toEqual({ enabled: false, config: { custom: 1 } });
    expect(readPluginsStore(dataDir).plugins.mcp).toEqual({ enabled: false });

    // 4. Explicit flip of `planTrackingEnabled` and `mcpEnabled` in Desktop Settings clears the stale enabled override while keeping `config`!
    applyDesktopMessage(dataDir, {
      settings: { ...desktopSettings, planTrackingEnabled: false, mcpEnabled: false },
      configDir: cfgDir,
    });
    expect(readPluginsStore(dataDir).plugins.plan).toEqual({ config: { custom: 1 } });
    expect(readPluginsStore(dataDir).plugins.mcp).toBeUndefined();

    // 5. Workspace `.pid/harness.json` overlays only explicitly provided sections when trustedWorkspace is supplied.
    const workspace = join(dir, "trusted-proj");
    mkdirSync(join(workspace, ".pid"), { recursive: true });
    writeFileSync(join(workspace, ".pid", "harness.json"), JSON.stringify({
      permissions: { defaultPermission: "read-only" },
      plan: { enabled: true },
    }));
    expect(readEffectiveHarnessConfig(dataDir).config.plan.enabled).toBe(false);
    const merged = readEffectiveHarnessConfig(dataDir, workspace).config;
    expect(merged.plan.enabled).toBe(true);
    expect(merged.permissions.defaultPermission).toBe("read-only");
    expect(merged.permissions.alwaysConfirmShell).toBe(false);
  });
});

describe("reloadable plugins", () => {
  it("reload only what changed and drop what is no longer wanted", async () => {
    const ctx = new Context();
    const events: string[] = [];
    const plugin = (name: string) => ({
      name,
      apply(inner: Context, config: { value?: number }) {
        events.push(`start ${name} ${config?.value ?? ""}`.trim());
        inner.effect(() => () => void events.push(`stop ${name}`), name);
      },
    });
    const a = plugin("a");
    const b = plugin("b");
    const reloadable = new ReloadablePlugins(ctx);
    expect(await reloadable.apply([{ key: "a", plugin: a, config: { value: 1 } }, { key: "b", plugin: b }])).toEqual(["a", "b"]);
    expect(await reloadable.apply([{ key: "a", plugin: a, config: { value: 1 } }, { key: "b", plugin: b }])).toEqual([]);
    expect(await reloadable.apply([{ key: "a", plugin: a, config: { value: 2 } }])).toEqual(["b", "a"]);
    expect(events).toEqual(["start a 1", "start b", "stop b", "stop a", "start a 2"]);
    await reloadable.dispose();
    expect(events.at(-1)).toBe("stop a");
  });

  it("apply a changed harness.json to running services", async () => {
    dir = mkdtempSync(join(tmpdir(), "pid-reload-"));
    const ctx = new Context();
    for (const service of [Credentials, LlmService, Sessions, Ui, Tools, SystemPrompt]) await ctx.plugin(service);
    ctx.tools.register({ name: "bash", description: "", parameters: { type: "object" }, execute: () => textOutput("ran") });
    const reloadable = new ReloadablePlugins(ctx);
    const session = ctx.sessions.create({ cwd: dir });
    const config = defaultHarnessConfig();
    const run = () => ctx.tools.execute({ id: "1", name: "bash", args: { command: "ls" } }, { sessionId: session.id, cwd: dir, signal: new AbortController().signal });

    await reloadable.apply(featureEntries(dir, { ...config, permissions: { defaultPermission: "read-only" } }));
    expect(await run()).toEqual(textOutput("Denied: Pi Desktop is in read-only mode", true));
    const changed = await reloadable.apply(featureEntries(dir, { ...config, permissions: { defaultPermission: "full-access" } }));
    expect(changed).toEqual(["permissions"]);
    expect(await run()).toEqual(textOutput("ran"));
    await ctx.fiber.dispose();
  });
});

describe("scheduled tasks on the harness", () => {
  it("always run on the host", () => {
    expect(harnessFromDesktop({ settings: {}, configDir: "/c" }).config.schedule).toEqual({ enabled: true });
  });

  it("import the desktop's tasks, letting the host compute the next run", () => {
    expect(importDesktopTasks([
      { id: "t", name: "Nightly", prompt: "report", cwd: "/w", frequency: "daily", hour: 2, minute: 0, weekday: 1, permissionMode: "ask", timeoutMinutes: null, enabled: true, lastRunAt: 5, nextRunAt: 9, lastStatus: "running", lastMessage: "" },
      { id: "broken" },
    ])).toEqual([
      { id: "t", name: "Nightly", prompt: "report", cwd: "/w", frequency: "daily", hour: 2, minute: 0, weekday: 1, permissionMode: "ask", enabled: true, lastRunAt: 5, lastStatus: "interrupted", lastMessage: "" },
    ]);
    expect(importDesktopTasks(undefined)).toEqual([]);
  });

  it("move the desktop's tasks over once", () => {
    dir = mkdtempSync(join(tmpdir(), "pid-control-"));
    const configDir = join(dir, "cfg");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "scheduled-tasks.json"), JSON.stringify([{ id: "t", name: "N", prompt: "p", cwd: dir, frequency: "hourly", hour: 0, minute: 5, weekday: 1, permissionMode: "read-only", enabled: true, lastStatus: "", lastMessage: "" }]));
    const dataDir = join(dir, "data");
    const notes = applyDesktopMessage(dataDir, { settings: {}, configDir });
    expect(notes).toEqual([`imported 1 scheduled task(s) from ${join(configDir, "scheduled-tasks.json")}`]);
    expect(JSON.parse(readFileSync(join(dataDir, "schedules.json"), "utf8"))).toMatchObject([{ id: "t", permissionMode: "read-only" }]);
    writeFileSync(join(configDir, "scheduled-tasks.json"), "[]");
    expect(applyDesktopMessage(dataDir, { settings: {}, configDir })).toEqual([]);
    expect(JSON.parse(readFileSync(join(dataDir, "schedules.json"), "utf8"))).toHaveLength(1);
  });
});
