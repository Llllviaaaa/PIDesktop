/**
 * The plugins that make up the agent. The core (models, sessions on disk,
 * tools, the system prompt, the loop) is loaded once; the feature plugins
 * configured by `<dataDir>/harness.json` and providers.json are keyed
 * entries the RPC host keeps in line with those files (`ReloadablePlugins`,
 * ADR 0013). Headless runs load both once (`agentPlugins`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { AgentLoop } from "@pid/agent-loop";
import * as browser from "@pid/browser";
import * as checkpoints from "@pid/checkpoints";
import * as computer from "@pid/computer";
import * as hooks from "@pid/hooks";
import { Credentials, LlmService } from "@pid/llm";
import { Mcp, type McpServerConfig } from "@pid/mcp";
import * as memory from "@pid/memory";
import { Permissions, type PermissionMode } from "@pid/permissions";
import * as plan from "@pid/plan";
import * as promptContext from "@pid/prompt-context";
import { Schedule } from "@pid/schedule";
import { Sessions } from "@pid/session";
import * as sessionJsonl from "@pid/session-jsonl";
import * as subagents from "@pid/subagents";
import { SystemPrompt } from "@pid/system-prompt";
import * as toolBash from "@pid/tool-bash";
import * as toolFs from "@pid/tool-fs";
import { Tools } from "@pid/tools";
import { Ui } from "@pid/ui";
import type { HarnessConfig } from "./harness-config.ts";
import type { PluginEntry } from "./host.ts";
import * as providers from "./providers.ts";
import type { ReloadableEntry } from "./reloadable.ts";
import { fileSecretResolver, readSecretFile, type McpServerSecrets, type SecretCodec } from "./secrets.ts";

export interface CoreOptions {
  /** DPAPI, when the host runs in Bun on Windows; `{ secret }` refs then resolve against secrets.dat. */
  codec?: SecretCodec;
}

/** Registers secrets.dat as the store for `{ secret }` refs. */
const secretStore = {
  name: "pid-secret-store",
  inject: ["credentials"],
  apply(ctx: Context, config: { file: string; codec: SecretCodec }) {
    ctx.effect(() => ctx.credentials.registerStore(fileSecretResolver(config.file, config.codec)), "secret store: secrets.dat");
  },
};

export function corePlugins(dataDir: string, options: CoreOptions = {}): PluginEntry[] {
  return [
    [Credentials],
    ...(options.codec === undefined ? [] : [[secretStore, { file: join(dataDir, "secrets.dat"), codec: options.codec }] as PluginEntry]),
    [LlmService],
    [Sessions],
    [sessionJsonl, { dir: join(dataDir, "sessions") }],
    [Ui],
    [Tools],
    [SystemPrompt],
    [toolFs],
    [toolBash],
    [AgentLoop],
    [checkpoints],
  ];
}

export interface FeatureOptions {
  /** Overrides the configured default permission mode (headless `--permission`). */
  permission?: PermissionMode;
  /** Run scheduled tasks: only the long-running host does, never a headless run. */
  scheduler?: { defaultModel: () => { provider: string; model: string } | undefined };
  /** Where the computer helper is when harness.json does not say (`PID_COMPUTER_HELPER`). */
  computerHelper?: string;
  /** Decrypts the desktop's MCP secrets file, when one is configured. */
  codec?: SecretCodec;
}

/** MCP servers with their env and headers from the desktop's encrypted secrets, in memory only. */
export function withMcpSecrets(servers: readonly McpServerConfig[], secrets: Record<string, McpServerSecrets>): McpServerConfig[] {
  return servers.map((server) => {
    const stored = secrets[server.id];
    if (stored === undefined) return server;
    return { ...server, env: { ...server.env, ...stored.env }, headers: { ...server.headers, ...stored.headers } };
  });
}

function fileRevision(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** The configured feature plugins, keyed so a reload only touches what changed. */
export function featureEntries(dataDir: string, config: HarnessConfig, options: FeatureOptions = {}): ReloadableEntry[] {
  const providersFile = join(dataDir, "providers.json");
  const permissions = options.permission === undefined ? config.permissions : { ...config.permissions, defaultPermission: options.permission };
  const { secretsFile, ...mcpConfig } = config.mcp;
  const mcpSecrets = secretsFile !== undefined && options.codec !== undefined
    ? readSecretFile<Record<string, McpServerSecrets>>(secretsFile, options.codec)
    : {};
  const entries: Array<ReloadableEntry | false> = [
    // The file's text is part of the config so an edited providers.json reloads the adapters.
    { key: "providers", plugin: providers, config: { file: providersFile, revision: fileRevision(providersFile) } },
    { key: "permissions", plugin: Permissions, config: permissions },
    {
      key: "prompt-context",
      plugin: promptContext,
      config: { dataDir, contextFiles: config.contextFiles.enabled, instructions: config.prompt.instructions },
    },
    config.plan.enabled && { key: "plan", plugin: plan },
    config.memory.enabled && { key: "memory", plugin: memory, config: { file: config.memory.file ?? join(dataDir, "memory.md") } },
    config.subagents.enabled && { key: "subagents", plugin: subagents, config: config.subagents },
    { key: "mcp", plugin: Mcp, config: { ...mcpConfig, servers: withMcpSecrets(mcpConfig.servers ?? [], mcpSecrets) } },
    config.computer.enabled && {
      key: "computer",
      plugin: computer,
      config: { ...config.computer, helper: config.computer.helper ?? options.computerHelper },
    },
    config.browser.enabled && { key: "browser", plugin: browser, config: config.browser },
    { key: "hooks", plugin: hooks, config: config.hooks },
    options.scheduler !== undefined && config.schedule.enabled && {
      key: "schedule",
      plugin: Schedule,
      config: {
        tasksFile: join(dataDir, "schedules.json"),
        runsFile: join(dataDir, "schedule-runs.jsonl"),
        defaultModel: options.scheduler.defaultModel,
      },
    },
  ];
  return entries.filter((entry): entry is ReloadableEntry => entry !== false);
}

/** Core and features at once, for a run that never reloads (headless, tests). */
export function agentPlugins(dataDir: string, options: CoreOptions & FeatureOptions & { config: HarnessConfig }): PluginEntry[] {
  return [
    ...corePlugins(dataDir, options),
    ...featureEntries(dataDir, options.config, options).map((entry): PluginEntry => [entry.plugin, entry.config]),
  ];
}
