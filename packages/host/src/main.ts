/**
 * Process entry of the Harness Host (ADR 0001).
 *
 * Usage: pid-harness --data-dir <dir> [--port <n>] [--page-origin <origin>]... [--exit-with-stdin]
 *        pid-harness run [options] <prompt>   (headless, see headless.ts)
 *
 * The RPC token comes from PID_HARNESS_TOKEN, never the command line, so it
 * does not show in process listings. Without it (a host started by hand for
 * browser-only development) a token is generated and written to stderr.
 * Once listening, the host prints one JSON line `{"port": n}` on stdout and
 * nothing else there; logs go to stderr.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Logger, type Exporter } from "@deepseek-ai/cordis";
import { agentPlugins } from "./agent-plugins.ts";
import * as betterSidebar from "./better-sidebar/index.ts";
import { runHeadless } from "./headless.ts";
import { createHost } from "./host.ts";
import { readDefaultModel } from "./providers.ts";
import * as featuresRpc from "./features-rpc.ts";
import { readHarnessConfig } from "./harness-config.ts";
import { RpcGateway } from "./rpc.ts";
import * as scheduleRpc from "./schedule-rpc.ts";
import * as sessionsRpc from "./sessions-rpc.ts";
import * as uiRpc from "./ui-rpc.ts";
import { WebServer } from "./web-server.ts";

declare const PID_HOST_VERSION: string | undefined;

export const HOST_VERSION = typeof PID_HOST_VERSION === "string" ? PID_HOST_VERSION : "0.0.0-dev";

export interface MainOptions {
  dataDir: string;
  port: number;
  pageOrigins: string[];
  exitWithStdin: boolean;
}

export function parseOptions(argv: readonly string[]): MainOptions {
  const options: MainOptions = { dataDir: "", port: 0, pageOrigins: [], exitWithStdin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === "--port") options.port = Number(value());
    else if (flag === "--data-dir") options.dataDir = value();
    else if (flag === "--page-origin") options.pageOrigins.push(value());
    else if (flag === "--exit-with-stdin") options.exitWithStdin = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("--port must be a port number");
  if (options.dataDir === "") throw new Error("--data-dir is required");
  return options;
}

export const stderrExporter: Exporter = {
  colors: false,
  export(message) {
    process.stderr.write(`[harness] ${Logger.format(stderrExporter, message)}\n`);
  },
};

export async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === "run") {
    process.exitCode = await runHeadless(argv.slice(1));
    return;
  }
  const options = parseOptions(argv);
  let token = process.env.PID_HARNESS_TOKEN;
  if (token === undefined || token === "") {
    token = randomBytes(32).toString("base64url");
    process.stderr.write(`[harness] PID_HARNESS_TOKEN not set; generated ${token}\n`);
  }

  const providersFile = join(options.dataDir, "providers.json");
  const defaultModel = readDefaultModel(providersFile);
  const { config, problems } = readHarnessConfig(join(options.dataDir, "harness.json"));
  const host = createHost({
    version: HOST_VERSION,
    dataDir: options.dataDir,
    plugins: [
      [WebServer, { pageOrigins: options.pageOrigins }],
      [RpcGateway, { token }],
      ...agentPlugins(options.dataDir, {
        config,
        scheduler: defaultModel === undefined ? {} : { defaultModel },
        ...(process.env.PID_COMPUTER_HELPER ? { computerHelper: process.env.PID_COMPUTER_HELPER } : {}),
      }),
      [sessionsRpc, defaultModel === undefined ? {} : { defaultModel }],
      [uiRpc],
      [featuresRpc],
      [scheduleRpc],
      [betterSidebar, { dataDir: options.dataDir }],
    ],
  });
  host.ctx.logger.exporter(stderrExporter);
  for (const problem of problems) host.ctx.logger("harness").warn("%s", problem);
  await host.start();
  const port = await host.ctx.webServer.listen(options.port);
  process.stdout.write(`${JSON.stringify({ port })}\n`);

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void host.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  if (options.exitWithStdin) {
    // The desktop app holds our stdin; when it exits, however it exits, the pipe closes.
    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
    process.stdin.resume();
  }
}
