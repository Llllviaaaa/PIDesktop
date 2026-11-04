/**
 * The plugins that make up the agent. The core (models, sessions on disk,
 * tools, the system prompt, the loop) is loaded once; the feature plugins
 * configured by `<dataDir>/harness.json` and providers.json are keyed
 * entries the RPC host keeps in line with those files (`ReloadablePlugins`,
 * ADR 0013). Headless runs load both once (`agentPlugins`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { AgentLoop } from "@pid/agent-loop";
import * as browser from "@pid/browser";
import * as checkpoints from "@pid/checkpoints";
import { Commands } from "@pid/commands";
import * as computer from "@pid/computer";
import * as hooks from "@pid/hooks";
import { Credentials, LlmService } from "@pid/llm";
import { Mcp, type McpServerConfig } from "@pid/mcp";
import * as memory from "@pid/memory";
import { Permissions, type PermissionMode } from "@pid/permissions";
import * as plan from "@pid/plan";
import { Pricing } from "@pid/pricing";
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

/** Reloadable lightweight sandbox policy for `bash` (M4.3). */
const bashSandboxPlugin = {
  name: "pid-bash-sandbox",
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

export function corePlugins(dataDir: string, options: CoreOptions = {}): PluginEntry[] {
  return [
    [Credentials],
    ...(options.codec === undefined ? [] : [[secretStore, { file: join(dataDir, "secrets.dat"), codec: options.codec }] as PluginEntry]),
    [LlmService],
    [Pricing],
    [Sessions],
    [sessionJsonl, { dir: join(dataDir, "sessions"), indexFile: join(dataDir, "index.sqlite") }],
    [Ui],
    [Tools],
    [Commands],
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

export interface BuiltinPluginDefinition {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  hasHost: boolean;
  hasClient: boolean;
  plugin: Plugin;
  config?: unknown;
}

/** Full catalog of built-in reloadable feature plugins, enabled and disabled alike (ADR 0016). */
export function builtinFeatureDefinitions(dataDir: string, config: HarnessConfig, options: FeatureOptions = {}): BuiltinPluginDefinition[] {
  const providersFile = join(dataDir, "providers.json");
  const permissions = options.permission === undefined ? config.permissions : { ...config.permissions, defaultPermission: options.permission };
  const { secretsFile, ...mcpConfig } = config.mcp;
  const mcpSecrets = secretsFile !== undefined && options.codec !== undefined
    ? readSecretFile<Record<string, McpServerSecrets>>(secretsFile, options.codec)
    : {};

  const definitions: Array<BuiltinPluginDefinition | false> = [
    {
      id: "providers",
      name: "模型服务商路由 (providers)",
      description: "加载 providers.json 并管理模型适配器与密钥解析",
      // The file's text is part of the config so an edited providers.json reloads the adapters.
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: providers,
      config: { file: providersFile, revision: fileRevision(providersFile) },
    },
    {
      id: "permissions",
      name: "工具权限策略 (permissions)",
      description: "执行会话读写、命令白名单与自定义工具审批门禁",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: Permissions,
      config: permissions,
    },
    {
      id: "prompt-context",
      name: "上下文与提示词组装 (prompt-context)",
      description: "注入工作区上下文文件（AGENTS.md / CLAUDE.md）、技能目录与自定义指令",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: promptContext,
      config: { dataDir, contextFiles: config.contextFiles.enabled, instructions: config.prompt.instructions },
    },
    {
      id: "plan",
      name: "任务计划追踪 (plan)",
      description: "提供 update_plan 工具并在对话提示词中维护分步计划状态",
      enabled: config.plan.enabled,
      hasHost: true,
      hasClient: false,
      plugin: plan,
    },
    {
      id: "memory",
      name: "本地长期记忆 (memory)",
      description: "维护并向系统提示词注入持久化的全局与项目记忆文件",
      enabled: config.memory.enabled || (config.memory.projectEnabled ?? config.memory.enabled),
      hasHost: true,
      hasClient: false,
      plugin: memory,
      config: {
        file: config.memory.file ?? join(dataDir, "memory.md"),
        userEnabled: config.memory.enabled,
        projectEnabled: config.memory.projectEnabled ?? config.memory.enabled,
      },
    },
    {
      id: "subagents",
      name: "并行子代理 (subagents)",
      description: "支持派发受并发控制的子会话代理执行独立探索或编码子任务",
      enabled: config.subagents.enabled,
      hasHost: true,
      hasClient: false,
      plugin: subagents,
      config: config.subagents,
    },
    {
      id: "mcp",
      name: "MCP 服务器桥接 (mcp)",
      description: "连接 STDIO 与 HTTP MCP 服务器并将其工具暴露给模型",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: Mcp,
      config: { ...mcpConfig, servers: withMcpSecrets(mcpConfig.servers ?? [], mcpSecrets) },
    },
    {
      id: "computer",
      name: "本机桌面控制 (computer)",
      description: "提供桌面截图、窗口焦点与键鼠自动化工具",
      enabled: config.computer.enabled,
      hasHost: true,
      hasClient: false,
      plugin: computer,
      config: { ...config.computer, helper: config.computer.helper ?? options.computerHelper },
    },
    {
      id: "browser",
      name: "内置自动化浏览器 (browser)",
      description: "基于本机 Edge/Chrome CDP 提供网页浏览与交互工具",
      enabled: config.browser.enabled,
      hasHost: true,
      hasClient: false,
      plugin: browser,
      config: config.browser,
    },
    {
      id: "hooks",
      name: "生命周期命令钩子 (hooks)",
      description: "在会话轮次与工具执行前后触发用户自定义脚本",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: hooks,
      config: config.hooks,
    },
    {
      id: "sandbox",
      name: "Windows 轻量沙箱 (sandbox)",
      description: "为 bash 工具启用环境变量脱敏、Job Object 进程数限制与高危系统命令拦截",
      enabled: config.sandbox.enabled,
      hasHost: true,
      hasClient: false,
      plugin: bashSandboxPlugin,
    },
    options.scheduler !== undefined && {
      id: "schedule",
      name: "本地定时任务 (schedule)",
      description: "按周期调度后台无人值守会话并记录运行历史",
      enabled: config.schedule.enabled,
      hasHost: true,
      hasClient: false,
      plugin: Schedule,
      config: {
        tasksFile: join(dataDir, "schedules.json"),
        runsFile: join(dataDir, "schedule-runs.jsonl"),
        defaultModel: options.scheduler.defaultModel,
      },
    },
  ];
  return definitions.filter((entry): entry is BuiltinPluginDefinition => entry !== false);
}

/** The configured feature plugins, keyed so a reload only touches what changed. */
export function featureEntries(dataDir: string, config: HarnessConfig, options: FeatureOptions = {}): ReloadableEntry[] {
  return builtinFeatureDefinitions(dataDir, config, options)
    .filter((entry) => entry.enabled)
    .map((entry) => ({ key: entry.id, plugin: entry.plugin, ...(entry.config === undefined ? {} : { config: entry.config }) }));
}

/** Core and features at once, for a run that never reloads (headless, tests). */
export function agentPlugins(dataDir: string, options: CoreOptions & FeatureOptions & { config: HarnessConfig }): PluginEntry[] {
  return [
    ...corePlugins(dataDir, options),
    ...featureEntries(dataDir, options.config, options).map((entry): PluginEntry => [entry.plugin, entry.config]),
  ];
}
