/**
 * The Harness Host the browser E2E suite talks to (docs/REFACTOR_V2_P7.md,
 * 3.4): the plugins `main.ts` loads, on a temporary data directory, with one
 * extra model, `scripted/m`, whose replies the test lines up. Production code
 * has no switch for this; only the suite (e2e/) imports it.
 */
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { ScriptedProvider, useScriptedProvider } from "@pid/testkit";
import { corePlugins, featureEntries } from "../src/agent-plugins.ts";
import * as betterSidebar from "../src/better-sidebar/index.ts";
import * as diagnostics from "../src/diagnostics.ts";
import * as featuresRpc from "../src/features-rpc.ts";
import { defaultHarnessConfig } from "../src/harness-config.ts";
import { createHost, type Host } from "../src/host.ts";
import * as llmRpc from "../src/llm-rpc.ts";
import * as providerAdmin from "../src/provider-admin.ts";
import { ReloadablePlugins } from "../src/reloadable.ts";
import { RpcGateway } from "../src/rpc.ts";
import * as scheduleRpc from "../src/schedule-rpc.ts";
import * as sessionsRpc from "../src/sessions-rpc.ts";
import * as uiRpc from "../src/ui-rpc.ts";
import { WebServer } from "../src/web-server.ts";

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
  const host = createHost({
    version: "0.0.0-e2e",
    dataDir,
    plugins: [
      [WebServer, { pageOrigins: [options.pageOrigin] }],
      [RpcGateway, { token: options.token }],
      ...corePlugins(dataDir),
      [sessionsRpc, { defaultModel }],
      [uiRpc],
      [featuresRpc],
      [diagnostics],
      [scheduleRpc],
      [llmRpc, { defaultModel }],
      [{
        name: "pid-config-rpc",
        inject: ["rpc"],
        apply: (ctx: Context) => ctx.effect(() => ctx.rpc.method("config.reload", async () => ({ reloaded: await reload() })), "config.reload"),
      }],
      [providerAdmin, { file: join(dataDir, "providers.json"), secretsFile: join(dataDir, "secrets.dat"), reload: () => reload() }],
      [betterSidebar, { dataDir }],
      [{ name: "e2e-scripted-model", inject: ["llm"], apply: (ctx: never) => useScriptedProvider(ctx, provider) }],
    ],
  });
  await host.start();
  const features = new ReloadablePlugins(host.ctx);
  reload = () => features.apply(featureEntries(dataDir, defaultHarnessConfig(), { scheduler: { defaultModel } }));
  await reload();
  const port = await host.ctx.webServer.listen(options.port ?? 0);
  return {
    host,
    port,
    baseUrl: `http://127.0.0.1:${port}/`,
    async stop() {
      await features.dispose();
      await host.stop();
    },
  };
}
