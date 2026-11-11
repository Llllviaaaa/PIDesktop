import type { Context } from "@deepseek-ai/cordis";
import { textOutput } from "@qianji/tools";

export const name = "demo-panel-host";
export const inject = ["tools", "rpc"];

export function apply(ctx: Context): void {
  ctx.rpc.method("demo_panel.summary", async (params) => {
    const raw = (params ?? {}) as { cwd?: string };
    return {
      cwd: raw.cwd ?? "",
      timestamp: new Date().toISOString(),
    };
  });

  ctx.tools.register({
    name: "demo_panel_ping",
    description: "Read-only diagnostic ping exposed by demo-panel.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_args, env) {
      return textOutput(JSON.stringify({ ok: true, cwd: env.cwd }));
    },
  });
}
