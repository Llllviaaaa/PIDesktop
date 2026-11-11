/**
 * Minimal pure-spine Core + isomorphic pluggable plugin catalog.
 *
 * `corePlugins()` contains ONLY the pure in-memory agent spine (credentials slot,
 * LLM slot, in-memory sessions, UI bus, tool bus, slash command bus, system
 * prompt builder, and the single agent loop). Every concrete model protocol,
 * pricing catalog, storage backend, full-text search index, filesystem/shell
 * tool, Git checkpointing, security policy, and HTTP/WebSocket RPC gateway is a
 * first-class `PluginManager`-managed plugin (`builtinPluginDefinitions`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { AgentLoop } from "@qianji/agent-loop";
import * as browser from "@qianji/browser";
import * as checkpoints from "@qianji/checkpoints";
import { Commands } from "@qianji/commands";
import * as computer from "@qianji/computer";
import * as hooks from "@qianji/hooks";
import * as intelligentUi from "@qianji/intelligent-ui";
import { Credentials, LlmService } from "@qianji/llm";
import * as llmAnthropic from "@qianji/llm-anthropic";
import * as llmGemini from "@qianji/llm-gemini";
import * as llmOpenaiCompat from "@qianji/llm-openai-compat";
import * as llmOpenaiResponses from "@qianji/llm-openai-responses";
import { Mcp, type McpServerConfig } from "@qianji/mcp";
import * as memory from "@qianji/memory";
import { Permissions, type PermissionMode } from "@qianji/permissions";
import * as plan from "@qianji/plan";
import { Pricing } from "@qianji/pricing";
import * as promptContext from "@qianji/prompt-context";
import { Schedule } from "@qianji/schedule";
import { Sessions } from "@qianji/session";
import * as sessionJsonl from "@qianji/session-jsonl";
import * as sessionSearchFts from "@qianji/session-search-fts";
import * as subagents from "@qianji/subagents";
import { SystemPrompt } from "@qianji/system-prompt";
import * as toolBash from "@qianji/tool-bash";
import * as toolFs from "@qianji/tool-fs";
import { Tools } from "@qianji/tools";
import { Ui } from "@qianji/ui";
import * as commandsRpc from "./commands-rpc.ts";
import { resolveDesktopBundledSkillRoots, resolveDesktopPluginTypesDir } from "./control.ts";
import * as diagnostics from "./diagnostics.ts";
import type { HarnessConfig } from "./harness-config.ts";
import type { PluginEntry } from "./host.ts";
import * as llmRpc from "./llm-rpc.ts";
import * as pluginDevTools from "./plugin-dev-tools.ts";
import type { PluginManager } from "./plugin-manager.ts";
import * as providerAdmin from "./provider-admin.ts";
import * as providers from "./providers.ts";
import type { ReloadableEntry } from "./reloadable.ts";
import { RpcGateway } from "./rpc.ts";
import { fileSecretResolver, readSecretFile, type McpServerSecrets, type SecretCodec } from "./secrets.ts";
import * as sessionsRpc from "./sessions-rpc.ts";
import * as uiRpc from "./ui-rpc.ts";
import { WebServer } from "./web-server.ts";
import * as workbenchRpc from "./workbench-rpc.ts";

export interface CoreOptions {
  /** DPAPI, when the host runs in Bun on Windows; `{ secret }` refs then resolve against secrets.dat. */
  codec?: SecretCodec;
}

/** Registers secrets.dat as the store for `{ secret }` refs. */
const secretStore = {
  name: "qianji-secret-store",
  inject: ["credentials"],
  apply(ctx: Context, config: { file: string; codec: SecretCodec }) {
    ctx.effect(() => ctx.credentials.registerStore(fileSecretResolver(config.file, config.codec)), "secret store: secrets.dat");
  },
};

/** Exposes `config.reload` when an RPC gateway is attached. */
const configRpcPlugin = {
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
const bashSandboxPlugin = {
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

/**
 * Minimal pure in-memory Core spine. Contains zero business/vendor logic,
 * zero disk formats, zero pricing tables, zero concrete tools, and zero network gateways.
 */
export function corePlugins(_dataDir?: string, _options?: CoreOptions): PluginEntry[] {
  return [
    [Credentials],
    [LlmService],
    [Sessions],
    [Ui],
    [Tools],
    [Commands],
    [SystemPrompt],
    [AgentLoop],
  ];
}

export interface GatewayOptions {
  pageOrigins: readonly string[];
  token: string;
  defaultModel?: () => { provider: string; model: string } | undefined;
  manager?: () => PluginManager | undefined;
  reload?: () => Promise<string[]>;
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
  /** Optional workspace trust checker for project-scoped memory. */
  isWorkspaceTrusted?: (cwd: string) => boolean;
  /** When false, `providers` relies strictly on mounted `llm-*` protocol plugins. */
  autoRegisterBuiltinProtocols?: boolean;
  /** Optional bundled read-only skill roots (`skills/` in dev or `bundled-skills/` in release). */
  bundledSkillsDirs?: readonly string[] | (() => readonly string[]);
  /** Optional live `PluginManager` getter for `qianji_inspect` and `plugin_manager`. */
  pluginManager?: () => PluginManager | undefined;
  /** Optional path to generated offline `plugin-types/` declarations for `scaffold`. */
  pluginTypesDir?: string | (() => string | undefined);
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
  /** False when disabling this built-in would sever the active HTTP/RPC control plane. */
  canDisable?: boolean;
  hasHost: boolean;
  hasClient: boolean;
  plugin: Plugin;
  config?: unknown;
  inject?: readonly string[];
  provides?: readonly string[];
}

/** Built-in capability & policy plugins configured via `harness.json` and `providers.json`. */
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
      description: "加载 providers.json 并按已启用协议插件动态实例化模型适配器与密钥解析",
      // The file's text is part of the config so an edited providers.json reloads the adapters.
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: providers,
      inject: ["llm", "credentials"],
      config: {
        file: providersFile,
        revision: fileRevision(providersFile),
        ...(options.autoRegisterBuiltinProtocols === undefined
          ? {}
          : { autoRegisterBuiltinProtocols: options.autoRegisterBuiltinProtocols }),
      },
    },
    {
      id: "permissions",
      name: "工具权限策略 (permissions)",
      description: "执行会话读写、命令白名单与自定义工具审批门禁",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: Permissions,
      inject: ["sessions", "tools", "ui", "systemPrompt"],
      provides: ["permissions"],
      config: permissions,
    },
    {
      id: "prompt-context",
      name: "上下文与技能管理 (prompt-context)",
      description: "注入工作区上下文文件（AGENTS.md / CLAUDE.md）、技能目录与自定义指令",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: promptContext,
      inject: ["systemPrompt"],
      config: {
        dataDir,
        contextFiles: config.contextFiles.enabled,
        instructions: config.prompt.instructions,
        bundledSkillsDirs: options.bundledSkillsDirs ?? (() => resolveDesktopBundledSkillRoots()),
      },
    },
    {
      id: "plugin-dev-tools",
      name: "Agent 插件自省与开发工具 (plugin-dev-tools)",
      description: "提供免审运行时自省工具 qianji_inspect 与按需加载的插件生命周期管理工具 plugin_manager",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: pluginDevTools,
      inject: ["tools", "sessions", "ui"],
      config: {
        manager: options.pluginManager ?? (() => undefined),
        pluginTypesDir: options.pluginTypesDir ?? (() => resolveDesktopPluginTypesDir()),
      },
    },
    {
      id: "plan",
      name: "任务计划追踪 (plan)",
      description: "提供 update_plan 工具并在对话提示词中维护分步计划状态",
      enabled: config.plan.enabled,
      hasHost: true,
      hasClient: false,
      plugin: plan,
      inject: ["sessions", "tools"],
    },
    {
      id: "intelligent-ui",
      name: "Intelligent UI 交互式界面 (intelligent-ui)",
      description: "支持在对话流内生成可交互计算器、动态图表、参数表单与安全沙箱微应用，支持多版本切换与右侧画布展开",
      enabled: config.intelligentUi.enabled,
      hasHost: true,
      hasClient: true,
      plugin: intelligentUi,
      inject: ["sessions", "tools", "systemPrompt"],
    },
    {
      id: "memory",
      name: "本地长期记忆 (memory)",
      description: "维护并向系统提示词注入持久化的全局与项目记忆文件",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: memory,
      inject: ["tools", "systemPrompt"],
      config: {
        file: config.memory.file ?? join(dataDir, "memory.md"),
        userEnabled: config.memory.enabled,
        projectEnabled: config.memory.projectEnabled ?? config.memory.enabled,
        ...(options.isWorkspaceTrusted === undefined ? {} : { isTrusted: options.isWorkspaceTrusted }),
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
      inject: ["sessions", "agents", "tools"],
      config: config.subagents,
    },
    {
      id: "mcp",
      name: "MCP 服务器桥接 (mcp)",
      description: "连接 STDIO 与 HTTP MCP 服务器并将其工具暴露给模型",
      enabled: config.mcp.enabled !== false,
      hasHost: true,
      hasClient: false,
      plugin: Mcp,
      inject: ["sessions", "tools", "ui"],
      provides: ["mcp"],
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
      inject: ["tools", "ui", "sessions"],
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
      inject: ["tools", "ui", "sessions"],
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
      inject: ["tools", "sessions"],
    },
    options.scheduler !== undefined && {
      id: "schedule",
      name: "本地定时任务 (schedule)",
      description: "按周期调度后台无人值守会话并记录运行历史",
      enabled: config.schedule.enabled,
      hasHost: true,
      hasClient: false,
      plugin: Schedule,
      inject: ["sessions", "agents", "ui"],
      provides: ["schedule"],
      config: {
        tasksFile: join(dataDir, "schedules.json"),
        runsFile: join(dataDir, "schedule-runs.jsonl"),
        defaultModel: options.scheduler.defaultModel,
      },
    },
  ];
  return definitions.filter((entry): entry is BuiltinPluginDefinition => entry !== false);
}

/**
 * Complete isomorphic catalog of ALL built-in plugins managed by `PluginManager`
 * (resource protocols, pricing, storage, async FTS search, tools, checkpoints,
 * capability/security features, and optional HTTP/WebSocket RPC gateway).
 */
export function builtinPluginDefinitions(
  dataDir: string,
  config: HarnessConfig,
  options: CoreOptions & FeatureOptions & { gateway?: GatewayOptions } = {},
): BuiltinPluginDefinition[] {
  const providersFile = join(dataDir, "providers.json");
  const gateway = options.gateway;
  const baseDefinitions: Array<BuiltinPluginDefinition | false> = [
    gateway !== undefined && {
      id: "web-server",
      name: "本地 HTTP 静态与升级网关 (web-server)",
      description: "提供受来源门禁保护的本地回环 HTTP 路由与 WebSocket 升级入口",
      enabled: true,
      canDisable: false,
      hasHost: true,
      hasClient: false,
      plugin: WebServer,
      provides: ["webServer"],
      config: { pageOrigins: gateway.pageOrigins },
    },
    gateway !== undefined && {
      id: "rpc-gateway",
      name: "JSON-RPC 通信网关 (rpc-gateway)",
      description: "通过令牌鉴权 WebSocket 向客户端与外部工具暴露标准 JSON-RPC 总线",
      enabled: true,
      canDisable: false,
      hasHost: true,
      hasClient: false,
      plugin: RpcGateway,
      inject: ["webServer", "hostInfo"],
      provides: ["rpc"],
      config: { token: gateway.token },
    },
    options.codec !== undefined && {
      id: "secret-store",
      name: "系统加密凭据库 (secret-store)",
      description: "解析 secrets.dat 中受系统 DPAPI 加密保护的模型与服务密钥引用",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: secretStore,
      inject: ["credentials"],
      config: { file: join(dataDir, "secrets.dat"), codec: options.codec },
    },
    {
      id: "llm-openai-compat",
      name: "OpenAI Chat Completions 协议 (llm-openai-compat)",
      description: "为 OpenAI 兼容接口（DeepSeek / Qwen / Ollama / vLLM 等）提供流式适配器",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: llmOpenaiCompat,
      inject: ["llm", "credentials"],
    },
    {
      id: "llm-openai-responses",
      name: "OpenAI Responses 协议 (llm-openai-responses)",
      description: "为 OpenAI Responses API（GPT-5 / o-series 等）提供流式推理适配器",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: llmOpenaiResponses,
      inject: ["llm", "credentials"],
    },
    {
      id: "llm-anthropic",
      name: "Anthropic Messages 协议 (llm-anthropic)",
      description: "为 Claude 系列模型提供原生 Messages 流式与缓存适配器",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: llmAnthropic,
      inject: ["llm", "credentials"],
    },
    {
      id: "llm-gemini",
      name: "Google Gemini 协议 (llm-gemini)",
      description: "为 Gemini 系列模型提供原生 GenerateContent 流式适配器",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: llmGemini,
      inject: ["llm", "credentials"],
    },
    {
      id: "pricing",
      name: "离线模型计费估算 (pricing)",
      description: "监听模型调用用量并结合内置或自定义费率表估算会话成本",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: Pricing,
      provides: ["pricing"],
    },
    {
      id: "session-jsonl",
      name: "JSONL 会话持久化 (session-jsonl)",
      description: "将会话事件以纯顺序追加 JSONL 方式写入本地磁盘，零主线程阻塞",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: sessionJsonl,
      inject: ["sessions"],
      config: { dir: join(dataDir, "sessions") },
    },
    {
      id: "session-search-fts",
      name: "异步全文检索索引 (session-search-fts)",
      description: "在后台防抖增量构建 SQLite FTS5 中英双语全文检索索引，随时可独立停用",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: sessionSearchFts,
      inject: ["sessions"],
      provides: ["sessionSearch"],
      config: { sessionsDir: join(dataDir, "sessions"), indexFile: join(dataDir, "index.sqlite") },
    },
    {
      id: "tool-fs",
      name: "本地文件读写工具集 (tool-fs)",
      description: "提供 read、write、edit、ls、find 与 grep 本地工作区文件工具",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: toolFs,
      inject: ["tools"],
    },
    {
      id: "tool-bash",
      name: "本地命令执行工具 (tool-bash)",
      description: "提供 bash 命令行执行工具与沙箱配置文件生成接口",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: toolBash,
      inject: ["tools"],
    },
    {
      id: "checkpoints",
      name: "Git 代码快照回退 (checkpoints)",
      description: "在每轮可写任务前自动创建无侵入 Git 快照，支持按消息一键查看差异与回滚",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: checkpoints,
      inject: ["sessions", "agents"],
    },
    ...builtinFeatureDefinitions(dataDir, config, {
      ...options,
      ...(options.pluginManager === undefined && gateway?.manager !== undefined
        ? { pluginManager: gateway.manager }
        : {}),
      autoRegisterBuiltinProtocols: false,
    }),
    gateway !== undefined && {
      id: "sessions-rpc",
      name: "会话与用量 RPC 服务 (sessions-rpc)",
      description: "暴露 session.*、model.* 与 usage.summary 会话控制接口",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: sessionsRpc,
      inject: ["rpc", "sessions", "agents", "llm"],
      config: gateway.defaultModel === undefined ? {} : { defaultModel: gateway.defaultModel },
    },
    gateway !== undefined && {
      id: "commands-rpc",
      name: "斜杠命令 RPC 服务 (commands-rpc)",
      description: "暴露 command.list 与 command.execute 斜杠命令接口",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: commandsRpc,
      inject: ["rpc", "commands"],
      config: gateway.manager === undefined ? {} : { manager: gateway.manager },
    },
    gateway !== undefined && {
      id: "ui-rpc",
      name: "交互审批 RPC 服务 (ui-rpc)",
      description: "暴露 ui.pending 与 ui.respond 工具审批及询问回传接口",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: uiRpc,
      inject: ["rpc", "ui"],
    },
    gateway !== undefined && {
      id: "diagnostics",
      name: "宿主诊断与日志服务 (diagnostics)",
      description: "暴露 diagnostics.logs 与 diagnostics.export 宿主运行诊断接口",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: diagnostics,
      inject: ["rpc", "hostInfo"],
    },
    gateway !== undefined && {
      id: "llm-rpc",
      name: "直连模型补全 RPC 服务 (llm-rpc)",
      description: "暴露 llm.complete 轻量单轮补全接口（如会话自动命名与提交摘要）",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: llmRpc,
      inject: ["rpc", "llm"],
      config: gateway.defaultModel === undefined ? {} : { defaultModel: gateway.defaultModel },
    },
    gateway !== undefined && {
      id: "provider-admin",
      name: "模型服务商管理接口 (provider-admin)",
      description: "暴露 provider.save、provider.delete 与在线连接测试管理接口",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: providerAdmin,
      inject: ["rpc", "credentials"],
      config: {
        file: providersFile,
        secretsFile: join(dataDir, "secrets.dat"),
        ...(options.codec === undefined ? {} : { codec: options.codec }),
        reload: gateway.reload ?? (async () => []),
      },
    },
    gateway?.reload !== undefined && {
      id: "config-rpc",
      name: "配置热重载接口 (config-rpc)",
      description: "暴露 config.reload 触发插件与配置同步",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: configRpcPlugin,
      inject: ["rpc"],
      config: { reload: gateway.reload },
    },
    gateway !== undefined && {
      id: "workbench",
      name: "原生工作台联动 (workbench)",
      description: "提供 sidebar_open 工具与 workbench/open 工作台面板联动通知",
      enabled: true,
      hasHost: true,
      hasClient: false,
      plugin: workbenchRpc,
      inject: ["rpc", "tools", "sessions"],
    },
  ];
  return baseDefinitions.filter((entry): entry is BuiltinPluginDefinition => entry !== false);
}

/** The configured feature plugins, keyed so a reload only touches what changed. */
export function featureEntries(dataDir: string, config: HarnessConfig, options: FeatureOptions = {}): ReloadableEntry[] {
  return builtinFeatureDefinitions(dataDir, config, options)
    .filter((entry) => entry.enabled)
    .map((entry) => ({ key: entry.id, plugin: entry.plugin, ...(entry.config === undefined ? {} : { config: entry.config }) }));
}

/** Core spine and full built-in plugin set at once, for direct programmatic hosts/tests. */
export function agentPlugins(dataDir: string, options: CoreOptions & FeatureOptions & { config: HarnessConfig }): PluginEntry[] {
  return [
    ...corePlugins(),
    ...builtinPluginDefinitions(dataDir, options.config, options)
      .filter((entry) => entry.enabled)
      .map((entry): PluginEntry => [entry.plugin, entry.config]),
  ];
}
