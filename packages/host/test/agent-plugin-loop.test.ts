/**
 * Phase 3 End-to-End Agent Plugin Development Loop Verification:
 * 1. Built-in `skills/qianji-plugin-development` discovery (`scope: "builtin", readOnly: true`),
 *    `< 5 KB` SKILL.md constraint, read-only guard against overwrite/delete, toggle state,
 *    and user/project skill override precedence.
 * 2. `readOnly: true` tool exemption in `Plan` / `Ask` (`read-only`) mode (`qianji_inspect`,
 *    `plugin_manager(list)`, `plugin_manager(verify)` execute with zero confirmation prompts;
 *    mutating actions are blocked in `read-only` mode).
 * 3. Full 5-ring Agent workflow in an isolated external workspace:
 *    read `SKILL.md` -> `qianji_inspect` -> `activate_tools("plugin_dev")` ->
 *    `plugin_manager(scaffold)` -> deliberate compile error caught by `plugin_manager(verify)` ->
 *    fix & `plugin_manager(install_local)` -> simulated frontend `clientError` inspected via
 *    `qianji_inspect(plugins)` -> live edit + `reload` clears `clientError` and updates `clientEtag`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ErrorCode,
  type SkillListResult,
  type UiPendingResult,
} from "@qianji/protocol";
import { builtinPluginDefinitions, corePlugins } from "../src/agent-plugins.ts";
import { readEffectiveHarnessConfig } from "../src/harness-config.ts";
import { createHost, type Host } from "../src/host.ts";
import { PluginManager } from "../src/plugin-manager.ts";
import * as pluginsRpc from "../src/plugins-rpc.ts";
import { generatePluginTypes } from "../../../scripts/generate-plugin-types.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const repoSkillsDir = join(repoRoot, "skills");

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

async function callRpc<T>(target: Host, method: string, params?: unknown): Promise<T> {
  const handler = (
    target.ctx.rpc as unknown as {
      handlers: Map<string, (p: unknown, c: { signal: AbortSignal }) => unknown>;
    }
  ).handlers.get(method);
  if (handler === undefined) throw new Error(`RPC method not found: ${method}`);
  return (await handler(params, { signal: new AbortController().signal })) as T;
}

describe("Phase 3: Agent plugin development closed loop", () => {
  it("discovers builtin qianji-plugin-development skill (< 5 KB), guards readOnly mutations, and supports toggle + override", async () => {
    const skillMdPath = join(repoSkillsDir, "qianji-plugin-development", "SKILL.md");
    expect(existsSync(skillMdPath)).toBe(true);
    expect(statSync(skillMdPath).size).toBeLessThan(5 * 1024);

    tempRoot = mkdtempSync(join(tmpdir(), "qj-agent-skill-"));
    const dataDir = join(tempRoot, "data");
    const workspace = join(tempRoot, "workspace");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });

    const managerRef: { current: PluginManager | undefined } = { current: undefined };
    host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: corePlugins(),
    });
    await host.start();

    manager = new PluginManager(host.ctx, {
      dataDir,
      version: "0.3.0-test",
      builtins: (ws) =>
        builtinPluginDefinitions(dataDir, readEffectiveHarnessConfig(dataDir, ws).config, {
          bundledSkillsDirs: [repoSkillsDir],
          gateway: {
            pageOrigins: [],
            token: Buffer.alloc(32, 7).toString("base64url"),
            manager: () => managerRef.current,
          },
        }),
    });
    managerRef.current = manager;
    await host.ctx.plugin(pluginsRpc, { manager });
    await manager.sync();

    const listed = await callRpc<SkillListResult>(host, "skill.list", { cwd: workspace });
    const builtinSkill = listed.skills.find((item) => item.name === "qianji-plugin-development");
    expect(builtinSkill).toBeDefined();
    expect(builtinSkill).toMatchObject({
      name: "qianji-plugin-development",
      scope: "builtin",
      enabled: true,
      trusted: true,
      readOnly: true,
    });

    // Built-in skill appears in system prompt <skills> summary
    const promptText = await host.ctx.systemPrompt.build({
      sessionId: "s-skill",
      cwd: workspace,
      model: { provider: "mock", model: "mock" },
      tools: [{ name: "read", description: "read", parameters: {} }],
    });
    expect(promptText).toContain("<skills>");
    expect(promptText).toContain("qianji-plugin-development");

    // Read-only guard rejects overwrite and delete on builtin SKILL.md
    await expect(
      callRpc(host, "skill.save", {
        path: builtinSkill?.path,
        cwd: workspace,
        content: "---\nname: qianji-plugin-development\ndescription: hacked\n---\n",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });

    await expect(
      callRpc(host, "skill.delete", {
        path: builtinSkill?.path,
        cwd: workspace,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });

    // Toggling builtin skill off hides it from system prompt; toggling back restores it
    await callRpc(host, "skill.toggle", {
      path: builtinSkill?.path,
      cwd: workspace,
      enabled: false,
    });
    const promptDisabled = await host.ctx.systemPrompt.build({
      sessionId: "s-skill",
      cwd: workspace,
      model: { provider: "mock", model: "mock" },
      tools: [{ name: "read", description: "read", parameters: {} }],
    });
    expect(promptDisabled).not.toContain("qianji-plugin-development");

    await callRpc(host, "skill.toggle", {
      path: builtinSkill?.path,
      cwd: workspace,
      enabled: true,
    });

    // User/project skill with the same name coexists in Settings list while overriding builtin in systemPrompt
    const overrideCreated = await callRpc<{ skill: { scope: string; readOnly?: boolean } }>(
      host,
      "skill.create",
      {
        scope: "project",
        cwd: workspace,
        name: "qianji-plugin-development",
        description: "Workspace-customized Qianji plugin workflow",
      },
    );
    expect(overrideCreated.skill.scope).toBe("project");
    const afterOverride = await callRpc<SkillListResult>(host, "skill.list", { cwd: workspace });
    const matchingEntries = afterOverride.skills.filter((item) => item.name === "qianji-plugin-development");
    expect(matchingEntries.some((item) => item.scope === "builtin" && item.readOnly === true)).toBe(true);
    expect(matchingEntries.some((item) => item.scope === "project" && item.readOnly !== true)).toBe(true);

    const promptOverridden = await host.ctx.systemPrompt.build({
      sessionId: "s-skill",
      cwd: workspace,
      model: { provider: "mock", model: "mock" },
      tools: [{ name: "read", description: "read", parameters: {} }],
    });
    expect(promptOverridden).toContain("Workspace-customized Qianji plugin workflow");
  });

  it("executes the full 5-ring Agent workflow (read SKILL -> inspect -> scaffold -> verify -> install_local -> fix clientError)", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "qj-agent-loop-"));
    const dataDir = join(tempRoot, "data");
    const workspace = join(tempRoot, "workspace");
    const pluginTypesDir = join(tempRoot, "plugin-types");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    generatePluginTypes({ repoRoot, targetDir: pluginTypesDir });

    const managerRef: { current: PluginManager | undefined } = { current: undefined };
    host = createHost({
      version: "0.3.0-test",
      dataDir,
      plugins: corePlugins(),
    });
    await host.start();

    manager = new PluginManager(host.ctx, {
      dataDir,
      version: "0.3.0-test",
      builtins: (ws) =>
        builtinPluginDefinitions(dataDir, readEffectiveHarnessConfig(dataDir, ws).config, {
          bundledSkillsDirs: [repoSkillsDir],
          pluginTypesDir,
          gateway: {
            pageOrigins: [],
            token: Buffer.alloc(32, 9).toString("base64url"),
            manager: () => managerRef.current,
          },
        }),
    });
    managerRef.current = manager;
    await host.ctx.plugin(pluginsRpc, { manager });
    await manager.sync();

    // Auto-approve UI confirmation requests while recording every prompt title
    const approvalTitles: string[] = [];
    const pollApprovals = setInterval(() => {
      void callRpc<UiPendingResult>(host as Host, "ui.pending")
        .then(({ requests }) => {
          for (const req of requests) {
            if (req.kind === "confirm" && req.requestId !== undefined) {
              approvalTitles.push(req.title);
              void callRpc(host as Host, "ui.respond", {
                requestId: req.requestId,
                value: true,
              });
            }
          }
        })
        .catch(() => undefined);
    }, 15);

    try {
      // 1. Start in `plan` (`read-only`) mode!
      const session = await host.ctx.sessions.create({ cwd: workspace });
      host.ctx.permissions.set(session, { agentMode: "plan", permission: "ask" });
      const env = {
        sessionId: session.id,
        cwd: workspace,
        signal: new AbortController().signal,
      };

      // `qianji_inspect` MUST be visible in active tool schemas BEFORE `activate_tools(["plugin_dev"])`,
      // whereas `plugin_manager` stays deferred until `plugin_dev` is activated.
      const initialSchemaNames = host.ctx.tools.schemas(session.id).map((t) => t.name);
      expect(initialSchemaNames).toContain("qianji_inspect");
      expect(initialSchemaNames).not.toContain("plugin_manager");

      // Agent reads SKILL.md via `read` tool in read-only mode (0 prompts)
      const skillMdPath = join(repoSkillsDir, "qianji-plugin-development", "SKILL.md");
      const readSkillRes = await host.ctx.tools.execute(
        { id: "call-read-skill", name: "read", args: { path: skillMdPath } },
        env,
      );
      expect(readSkillRes.isError).not.toBe(true);
      expect(JSON.stringify(readSkillRes.content)).toContain("qianji_inspect");
      expect(approvalTitles).toEqual([]);

      // Ring 1: Agent calls `qianji_inspect` in `plan` (`read-only`) mode -> allowed with 0 prompts!
      const inspectRes = await host.ctx.tools.execute(
        { id: "call-inspect-1", name: "qianji_inspect", args: { topic: "all" } },
        env,
      );
      expect(inspectRes.isError).not.toBe(true);
      const inspectJson = JSON.parse(
        (inspectRes.content[0] as { type: "text"; text: string }).text,
      ) as {
        clientSlots: { slots: Array<{ slot: string }> };
        themeTokens: { tokens: { backgrounds: string[] } };
        sharedModules: { client: string[] };
      };
      expect(inspectJson.clientSlots.slots.some((s) => s.slot === "message.toolRenderer")).toBe(true);
      expect(inspectJson.clientSlots.slots.some((s) => s.slot === "file.viewer")).toBe(true);
      expect(inspectJson.themeTokens.tokens.backgrounds).toContain("--qj-bg-surface");
      expect(inspectJson.sharedModules.client).toContain("@qianji/client");
      expect(approvalTitles).toEqual([]);

      // Agent activates `plugin_dev` group and calls `plugin_manager(list)` in `read-only` mode -> 0 prompts!
      const activateRes = await host.ctx.tools.execute(
        { id: "call-activate", name: "activate_tools", args: { names: ["plugin_dev"] } },
        env,
      );
      expect(activateRes.isError).not.toBe(true);
      expect(host.ctx.tools.isActivated(session.id, "plugin_manager")).toBe(true);

      const listInPlanRes = await host.ctx.tools.execute(
        { id: "call-pm-list", name: "plugin_manager", args: { action: "list" } },
        env,
      );
      expect(listInPlanRes.isError).not.toBe(true);
      expect(approvalTitles).toEqual([]);

      // Attempting `scaffold` while still in `plan` (`read-only`) mode MUST be blocked!
      const blockedScaffold = await host.ctx.tools.execute(
        {
          id: "call-pm-blocked",
          name: "plugin_manager",
          args: { action: "scaffold", id: "loop-demo", template: "fullstack-panel" },
        },
        env,
      );
      expect(blockedScaffold.isError).toBe(true);
      expect(approvalTitles).toEqual([]);

      // Switch session to `agent` + `ask` mode to build & install the plugin
      host.ctx.permissions.set(session, { agentMode: "agent", permission: "ask" });

      // Ring 2: `plugin_manager(scaffold)` -> prompts once via UI, creates files in workspace
      const scaffoldDir = join(workspace, "plugins", "loop-demo");
      const scaffoldRes = await host.ctx.tools.execute(
        {
          id: "call-pm-scaffold",
          name: "plugin_manager",
          args: {
            action: "scaffold",
            id: "loop-demo",
            template: "fullstack-panel",
            dir: scaffoldDir,
          },
        },
        env,
      );
      expect(scaffoldRes.isError).not.toBe(true);
      expect(approvalTitles).toHaveLength(1);
      expect(existsSync(join(scaffoldDir, "package.json"))).toBe(true);
      expect(existsSync(join(scaffoldDir, "index.ts"))).toBe(true);
      expect(existsSync(join(scaffoldDir, "client.tsx"))).toBe(true);
      expect(existsSync(join(scaffoldDir, "tsconfig.json"))).toBe(true);

      // Ring 3: Deliberately inject a broken import/syntax error into `client.tsx` and run `verify`
      const goodClientCode = readFileSync(join(scaffoldDir, "client.tsx"), "utf8");
      writeFileSync(
        join(scaffoldDir, "client.tsx"),
        `${goodClientCode}\nconst broken = <UnclosedTag ;\n`,
        "utf8",
      );

      const badVerifyRes = await host.ctx.tools.execute(
        {
          id: "call-pm-verify-bad",
          name: "plugin_manager",
          args: { action: "verify", dir: scaffoldDir },
        },
        env,
      );
      expect(badVerifyRes.isError).toBe(true);
      const badVerifyJson = JSON.parse(
        (badVerifyRes.content[0] as { type: "text"; text: string }).text,
      ) as { ok: boolean; errors: string[] };
      expect(badVerifyJson.ok).toBe(false);
      expect(badVerifyJson.errors.some((e) => e.includes("Client bundle compilation failed"))).toBe(true);
      // Verify MUST NOT trigger any approval popup!
      expect(approvalTitles).toHaveLength(1);

      // Restore valid `client.tsx` and re-run `verify` -> `ok: true`
      writeFileSync(join(scaffoldDir, "client.tsx"), goodClientCode, "utf8");
      const goodVerifyRes = await host.ctx.tools.execute(
        {
          id: "call-pm-verify-good",
          name: "plugin_manager",
          args: { action: "verify", dir: scaffoldDir },
        },
        env,
      );
      expect(goodVerifyRes.isError).not.toBe(true);
      const goodVerifyJson = JSON.parse(
        (goodVerifyRes.content[0] as { type: "text"; text: string }).text,
      ) as { ok: boolean; clientCompiled?: { bytes: number; etag: string } };
      expect(goodVerifyJson.ok).toBe(true);
      expect((goodVerifyJson.clientCompiled?.bytes ?? 0) > 100).toBe(true);
      expect(approvalTitles).toHaveLength(1);

      // Ring 4: `plugin_manager(install_local)` -> mounts Host + Client plugin live
      const installRes = await host.ctx.tools.execute(
        {
          id: "call-pm-install",
          name: "plugin_manager",
          args: { action: "install_local", dir: scaffoldDir, link: true, watch: true },
        },
        env,
      );
      expect(installRes.isError).not.toBe(true);
      expect(approvalTitles).toHaveLength(2);

      // Verify custom Host RPC and readOnly tool registered by `loop-demo` work immediately!
      const summaryRpc = await callRpc<{ pluginId: string; cwd: string }>(
        host,
        "loop_demo.summary",
        { cwd: workspace },
      );
      expect(summaryRpc.pluginId).toBe("loop-demo");
      expect(summaryRpc.cwd).toBe(workspace);

      // Switch to `plan` (`read-only`) mode temporarily to prove plugin's `readOnly: true` tool works without prompts!
      host.ctx.permissions.set(session, { agentMode: "plan", permission: "ask" });
      const customToolRes = await host.ctx.tools.execute(
        { id: "call-custom-inspect", name: "loop_demo_inspect", args: {} },
        env,
      );
      expect(customToolRes.isError).not.toBe(true);
      expect(approvalTitles).toHaveLength(2); // readOnly: true -> 0 extra prompts even in Plan mode!
      host.ctx.permissions.set(session, { agentMode: "agent", permission: "ask" });

      // Ring 5: Simulate frontend React render ErrorBoundary reporting `clientError`
      await callRpc(host, "plugin.reportClientError", {
        id: "loop-demo",
        phase: "render",
        message: "ReferenceError: undefinedWidgetVar is not defined",
        stack: "at FullstackPanel (client.tsx:24:11)",
      });

      const inspectErrRes = await host.ctx.tools.execute(
        {
          id: "call-inspect-err",
          name: "qianji_inspect",
          args: { topic: "plugins", pluginId: "loop-demo" },
        },
        env,
      );
      const inspectErrJson = JSON.parse(
        (inspectErrRes.content[0] as { type: "text"; text: string }).text,
      ) as {
        plugins: {
          items: Array<{
            id: string;
            status: string;
            clientEtag?: string;
            clientError?: { phase: string; message: string; stack?: string };
          }>;
        };
      };
      expect(inspectErrJson.plugins.items).toHaveLength(1);
      const beforeFixEtag = inspectErrJson.plugins.items[0]?.clientEtag;
      expect(inspectErrJson.plugins.items[0]?.clientError).toMatchObject({
        phase: "render",
        message: "ReferenceError: undefinedWidgetVar is not defined",
      });

      // Agent fixes `client.tsx` and calls `plugin_manager(reload)` -> `clientEtag` updates & `clientError` clears!
      writeFileSync(
        join(scaffoldDir, "client.tsx"),
        goodClientCode.replace("已刷新插件状态", "热修复完成"),
        "utf8",
      );
      const reloadRes = await host.ctx.tools.execute(
        {
          id: "call-pm-reload",
          name: "plugin_manager",
          args: { action: "reload", id: "loop-demo" },
        },
        env,
      );
      expect(reloadRes.isError).not.toBe(true);

      const inspectCleanRes = await host.ctx.tools.execute(
        {
          id: "call-inspect-clean",
          name: "qianji_inspect",
          args: { topic: "plugins", pluginId: "loop-demo" },
        },
        env,
      );
      const inspectCleanJson = JSON.parse(
        (inspectCleanRes.content[0] as { type: "text"; text: string }).text,
      ) as {
        plugins: {
          items: Array<{
            id: string;
            status: string;
            clientEtag?: string;
            clientError?: unknown;
          }>;
        };
      };
      expect(inspectCleanJson.plugins.items[0]?.status).toBe("active");
      expect(inspectCleanJson.plugins.items[0]?.clientError).toBeUndefined();
      expect(inspectCleanJson.plugins.items[0]?.clientEtag).not.toBe(beforeFixEtag);
    } finally {
      clearInterval(pollApprovals);
    }
  });
});
