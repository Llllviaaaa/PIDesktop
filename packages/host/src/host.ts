import { Context, type Plugin } from "@deepseek-ai/cordis";
import { HostInfo, type HostInfoConfig } from "./host-info.ts";

/** A plugin and the config it starts with, in the order the host loads them. */
export type PluginEntry = readonly [plugin: Plugin, config?: unknown];

export interface HostOptions extends HostInfoConfig {
  plugins?: readonly PluginEntry[];
}

export interface Host {
  readonly ctx: Context;
  /** Load the built-in services, then each plugin in order. */
  start(): Promise<void>;
  /** Dispose the root fiber, which unwinds every plugin's effects. */
  stop(): Promise<void>;
}

export function createHost(options: HostOptions): Host {
  const ctx = new Context();
  let started = false;
  return {
    ctx,
    async start() {
      if (started) throw new Error("Harness host already started");
      started = true;
      await ctx.plugin(HostInfo, { version: options.version, dataDir: options.dataDir });
      for (const [plugin, config] of options.plugins ?? []) {
        await ctx.plugin(plugin, config);
      }
    },
    async stop() {
      await ctx.fiber.dispose();
    },
  };
}
