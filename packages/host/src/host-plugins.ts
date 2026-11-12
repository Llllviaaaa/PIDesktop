/**
 * Small plugins that only the Host mounts, with no package of their own;
 * `builtinPluginDefinitions` (agent-plugins.ts) wires them in.
 */
import type { Context } from "@deepseek-ai/cordis";
import "@qianji/permissions";
import "@qianji/session";
import * as toolBash from "@qianji/tool-bash";
import "@qianji/tools";
import { fileSecretResolver, type SecretCodec } from "./secrets.ts";

/** Registers secrets.dat as the store for `{ secret }` refs. */
export const secretStore = {
  name: "qianji-secret-store",
  inject: ["credentials"],
  apply(ctx: Context, config: { file: string; codec: SecretCodec }) {
    ctx.effect(() => ctx.credentials.registerStore(fileSecretResolver(config.file, config.codec)), "secret store: secrets.dat");
  },
};

/** Exposes `config.reload` when an RPC gateway is attached. */
export const configRpcPlugin = {
  name: "qianji-config-rpc",
  inject: ["rpc"],
  apply(ctx: Context, config: { reload: () => Promise<string[]> }) {
    ctx.effect(
      () => ctx.rpc.method("config.reload", async () => ({ reloaded: await config.reload() })),
      "config.reload",
    );
  },
};

/** Reloadable lightweight sandbox policy for `bash` (M4.3). */
export const bashSandboxPlugin = {
  name: "qianji-bash-sandbox",
  inject: ["tools", "sessions"],
  apply(ctx: Context) {
    ctx.plugin(toolBash.BashSandbox, { enabled: true });
    ctx.on("tools/pre-execute", async (call, env) => {
      if (call.name !== "bash") return undefined;
      const permissions = ctx.get("permissions");
      if (permissions !== undefined) {
        const session = await ctx.sessions.get(env.sessionId);
        const effective = session === undefined ? permissions.defaultModes().effective : permissions.modes(session).effective;
        if (effective === "full-access") return undefined;
      }
      const command = typeof call.args.command === "string" ? call.args.command : "";
      const violation = toolBash.inspectSandboxedCommand(command);
      return violation === undefined ? undefined : { deny: true, reason: violation };
    });
  },
};
