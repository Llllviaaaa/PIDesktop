/**
 * The Harness Host the browser E2E suite talks to (docs/archive/REFACTOR_V2_P7.md,
 * 3.4): the plugins `main.ts` loads, on a temporary data directory, with one
 * extra model, `scripted/m`, whose replies the test lines up. Production code
 * has no switch for this; only the suite (e2e/) imports it.
 */
import { ScriptedProvider, useScriptedProvider } from "@pid/testkit";
import { builtinPluginDefinitions, corePlugins } from "../src/agent-plugins.ts";
import { readEffectiveHarnessConfig } from "../src/harness-config.ts";
import { createHost, type Host } from "../src/host.ts";
import { PluginManager } from "../src/plugin-manager.ts";
import * as pluginsRpc from "../src/plugins-rpc.ts";

export const E2E_MODEL = { provider: "scripted", model: "m" };

export interface E2eHostOptions {
  dataDir: string;
  /** The page's origin, which the RPC gateway admits. */
  pageOrigin: string;
  token: string;
  provider: ScriptedProvider;
  /** Listen here; a free port when left out. A restarted Host takes the same one. */
  port?: number;
}

export interface E2eHost {
  readonly host: Host;
  readonly port: number;
  readonly baseUrl: string;
  stop(): Promise<void>;
}

export async function startE2eHost(options: E2eHostOptions): Promise<E2eHost> {
  const { dataDir, provider } = options;
  const defaultModel = () => E2E_MODEL;
  let reload: () => Promise<string[]> = async () => [];
  const managerRef: { current?: PluginManager } = {};
  const host = createHost({
    version: "0.0.0-e2e",
    dataDir,
    plugins: [
      ...corePlugins(),
      [{ name: "e2e-scripted-model", inject: ["llm"], apply: (ctx: never) => useScriptedProvider(ctx, provider) }],
    ],
  });
  await host.start();
  const pluginManager = new PluginManager(host.ctx, {
    dataDir,
    version: "0.0.0-e2e",
    builtins: (trustedWorkspace) => builtinPluginDefinitions(
      dataDir,
      readEffectiveHarnessConfig(dataDir, trustedWorkspace).config,
      {
        scheduler: { defaultModel },
        gateway: {
          pageOrigins: [options.pageOrigin],
          token: options.token,
          defaultModel,
          manager: () => managerRef.current,
          reload: () => reload(),
        },
      },
    ),
    onChanged: (payload) => host.ctx.get("rpc")?.broadcast("plugin/changed", payload),
    onTrustChanged: (payload) => host.ctx.get("rpc")?.broadcast("workspace/trustChanged", payload),
  });
  managerRef.current = pluginManager;
  await host.ctx.plugin(pluginsRpc, { manager: pluginManager });
  reload = () => pluginManager.sync({ reason: "reloaded" });
  await pluginManager.sync();
  const port = await host.ctx.webServer.listen(options.port ?? 0);
  return {
    host,
    port,
    baseUrl: `http://127.0.0.1:${port}/`,
    async stop() {
      await pluginManager.dispose();
      await host.stop();
    },
  };
}
