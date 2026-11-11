import type { Context } from "@deepseek-ai/cordis";
import { textOutput } from "@qianji/tools";

export interface DemoToolConfig {
  prefix?: string;
}

export const name = "demo-tool-host";
export const inject = ["tools"];

export function apply(ctx: Context, config: DemoToolConfig = {}): void {
  ctx.tools.register({
    name: "demo_tool_echo",
    description: "Read-only echo diagnostic tool registered by demo-tool.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to echo" },
      },
    },
    async execute(args, env) {
      const prefix = config.prefix ?? "[demo-tool]";
      const msg = typeof args.message === "string" && args.message.trim() !== ""
        ? args.message.trim()
        : "ok";
      return textOutput(`${prefix} ${msg} (cwd: ${env.cwd})`);
    },
  });
}
