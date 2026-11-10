/**
 * Process entry of the Harness Host (ADR 0001).
 *
 * Usage: qianji-harness --data-dir <dir> [--port <n>] [--page-origin <origin>]... [--exit-with-stdin]
 *        qianji-harness run [options] <prompt>   (headless, see headless.ts)
 *
 * The RPC token comes from QIANJI_HARNESS_TOKEN, never the command line, so it
 * does not show in process listings. Without it (a host started by hand for
 * browser-only development) a token is generated and written to stderr.
 * Once listening, the host prints one JSON line `{"port": n}` on stdout and
 * nothing else there; logs go to stderr.
 */
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Logger, type Exporter } from "@deepseek-ai/cordis";
import { builtinPluginDefinitions, corePlugins } from "./agent-plugins.ts";
import { applyDesktopMessage, parseControlLine } from "./control.ts";
import { readEffectiveHarnessConfig } from "./harness-config.ts";
import { runHeadless } from "./headless.ts";
import { createHost } from "./host.ts";
import { logFileExporter } from "./log-file.ts";
import { PluginManager } from "./plugin-manager.ts";
import * as pluginsRpc from "./plugins-rpc.ts";
import { readDefaultModel } from "./providers.ts";
import { dpapiCodec } from "./secrets.ts";

declare const QIANJI_HOST_VERSION: string | undefined;

export const HOST_VERSION = typeof QIANJI_HOST_VERSION === "string" ? QIANJI_HOST_VERSION : "0.0.0-dev";

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
  let token = process.env.QIANJI_HARNESS_TOKEN || process.env.PID_HARNESS_TOKEN;
  if (token === undefined || token === "") {
    token = randomBytes(32).toString("base64url");
    process.stderr.write(`[harness] QIANJI_HARNESS_TOKEN not set; generated ${token}\n`);
  }

  const { dataDir } = options;
  const providersFile = join(dataDir, "providers.json");
  const defaultModel = () => readDefaultModel(providersFile);
  const codec = await dpapiCodec();
  let reload: () => Promise<string[]> = async () => [];
  const managerRef: { current?: PluginManager } = {};
  const host = createHost({
    version: HOST_VERSION,
    dataDir,
    plugins: corePlugins(),
  });
  host.ctx.logger.exporter(stderrExporter);
  // ~/.qianji/logs: the desktop writes its own log beside this one. Its level follows
  // Settings → 日志等级, which every desktop message (the first arrives at start) carries.
  const fileLog = logFileExporter(join(dataDir, "logs"));
  host.ctx.logger.exporter(fileLog);
  await host.start();

  // Built-in plugins + dynamic user/workspace plugins managed uniformly by PluginManager.
  const logger = host.ctx.logger("harness");
  const computerHelper = process.env.QIANJI_COMPUTER_HELPER || process.env.PID_COMPUTER_HELPER;
  const pluginManager = new PluginManager(host.ctx, {
    dataDir,
    version: HOST_VERSION,
    builtins: (trustedWorkspace) => {
      const { config, problems } = readEffectiveHarnessConfig(dataDir, trustedWorkspace);
      for (const problem of problems) logger.warn("%s", problem);
      return builtinPluginDefinitions(dataDir, config, {
        scheduler: { defaultModel },
        ...(computerHelper ? { computerHelper } : {}),
        ...(codec === undefined ? {} : { codec }),
        gateway: {
          pageOrigins: options.pageOrigins,
          token,
          defaultModel,
          manager: () => managerRef.current,
          reload: () => reload(),
        },
      });
    },
    onChanged: (payload) => host.ctx.get("rpc")?.broadcast("plugin/changed", payload),
    onTrustChanged: (payload) => host.ctx.get("rpc")?.broadcast("workspace/trustChanged", payload),
  });
  managerRef.current = pluginManager;
  await host.ctx.plugin(pluginsRpc, { manager: pluginManager });

  reload = async () => {
    const changed = await pluginManager.sync({ reason: "reloaded" });
    if (changed.length > 0) logger.info("loaded %s", changed.join(", "));
    return changed;
  };
  const initialChanged = await pluginManager.sync();
  if (initialChanged.length > 0) logger.info("loaded %s", initialChanged.join(", "));

  const webServer = host.ctx.get("webServer");
  if (webServer === undefined) {
    throw new Error("web-server plugin must remain enabled when starting the HTTP/RPC host");
  }
  const port = await webServer.listen(options.port);
  process.stdout.write(`${JSON.stringify({ port })}\n`);

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void pluginManager.dispose().then(() => host.stop()).finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  if (options.exitWithStdin) {
    // The desktop app holds our stdin; when it exits, however it exits, the pipe
    // closes. Until then it sends control commands there, one JSON per line.
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let pending = Promise.resolve();
    lines.on("line", (line) => {
      pending = pending.then(async () => {
        const command = parseControlLine(line);
        if (command === undefined) return;
        if ("desktop" in command) {
          const level = command.desktop.settings.logLevel;
          fileLog.setLevel(typeof level === "string" ? level : undefined);
          for (const note of applyDesktopMessage(dataDir, command.desktop)) logger.info("%s", note);
        }
        await reload();
      }).catch((error: unknown) => logger.error("control command failed: %s", error));
    });
    lines.on("close", shutdown);
    process.stdin.on("end", shutdown);
  }
}
