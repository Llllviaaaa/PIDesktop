/**
 * MCP servers as tools (ADR 0010). The `mcp` service connects the enabled
 * servers in the background when the host starts and registers each remote
 * tool as `mcp__<server>__<tool>`, plus `mcp_list_resources`,
 * `mcp_read_resource`, `mcp_(un)subscribe_resource`, `mcp_list_prompts` and
 * `mcp_get_prompt` when a connected server supports them.
 *
 * `notifications/tools/list_changed` refreshes that server's tools live
 * without restarting the Host; unexpected STDIO server exits trigger bounded
 * exponential-backoff reconnection, and `reconnect()` lets the UI or slash
 * commands reconnect on demand.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import "@qianji/commands";
import {
  ErrorCode,
  type McpGetPromptResult,
  type McpPromptsResult,
  type McpReadResourceResult,
  type McpResourcesResult,
  type McpServerStatus,
  type McpStatusResult,
} from "@qianji/protocol";
import { RpcError } from "@qianji/rpc";
import type { Session } from "@qianji/session";
import { textOutput, type ToolDefinition, type ToolEnv, type ToolOutput } from "@qianji/tools";
import "@qianji/ui";
import {
  createClient,
  errorText,
  promptListMarkdown,
  promptResultMarkdown,
  resourceContent,
  resourceListMarkdown,
  resultContent,
  toolName,
  type ConnectedServer,
  type McpPrompt,
  type McpResource,
  type McpServerConfig,
  type ServerStatus,
} from "./client.ts";

export * from "./client.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    mcp: Mcp;
  }

  interface Events {
    "mcp/changed"(): void;
  }
}

export interface Config {
  servers?: McpServerConfig[];
  /** Ask before each MCP call unless the session has full access. Default true. */
  confirmTools?: boolean;
  /** Backoff schedule in ms when a connected STDIO server exits unexpectedly. */
  reconnectDelaysMs?: readonly number[];
}

export interface ListedMcpResource extends McpResource {
  serverId: string;
  serverName: string;
}

export interface ListedMcpPrompt extends McpPrompt {
  serverId: string;
  serverName: string;
}

const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

const CHANGE_NOTICES: Record<string, string> = {
  "notifications/resources/list_changed": "资源列表已变化，可重新调用 mcp_list_resources。",
  "notifications/prompts/list_changed": "提示词列表已变化，可重新调用 mcp_list_prompts。",
};

export class Mcp extends Service {
  static inject = ["sessions", "tools", "ui"];
  static provide = "mcp";

  /** Settles once every configured server has connected or failed. */
  readonly ready: Promise<void>;
  private readonly enabledConfigs: McpServerConfig[];
  private readonly statusMap = new Map<string, ServerStatus>();
  private readonly connected = new Map<string, ConnectedServer>();
  private readonly subscriptions = new Map<string, Set<string>>();
  private readonly disposers: Array<() => void> = [];
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly refreshLocks = new Map<string, Promise<void>>();
  private closed = false;

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, "mcp");
    this.enabledConfigs = (config.servers ?? []).filter((server) => server.enabled);
    ctx.effect(() => () => {
      this.closed = true;
      for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
      this.reconnectTimers.clear();
      for (const dispose of this.disposers.splice(0)) dispose();
      for (const server of this.connected.values()) server.client.close();
      this.connected.clear();
    }, "mcp: servers");
    this.registerSlashCommands(ctx);
    this.ready = this.connectAll(this.enabledConfigs);
    this.registerRpcMethods(ctx);
  }

  statuses(): ServerStatus[] {
    const ordered: ServerStatus[] = [];
    for (const cfg of this.enabledConfigs) {
      const status = this.statusMap.get(cfg.id);
      if (status !== undefined) ordered.push({ ...status });
    }
    for (const [id, status] of this.statusMap) {
      if (!this.enabledConfigs.some((cfg) => cfg.id === id)) {
        ordered.push({ ...status });
      }
    }
    return ordered;
  }

  /** Reconnect one configured server by `id` (or all enabled servers when omitted). */
  async reconnect(serverId?: string): Promise<ServerStatus[]> {
    await this.ready;
    if (this.closed) return this.statuses();
    const targets = serverId !== undefined && serverId.trim() !== ""
      ? this.enabledConfigs.filter((cfg) => cfg.id === serverId.trim() || cfg.name === serverId.trim())
      : [...this.enabledConfigs];
    if (serverId !== undefined && serverId.trim() !== "" && targets.length === 0) {
      throw new Error(`未找到已启用的 MCP 服务器“${serverId}”`);
    }
    for (const cfg of targets) {
      this.clearReconnectTimer(cfg.id);
      const existing = this.connected.get(cfg.id);
      if (existing !== undefined) {
        this.connected.delete(cfg.id);
        existing.client.close();
      }
    }
    const attempts = await Promise.all(targets.map((cfg) => this.connect(cfg)));
    if (this.closed) {
      for (const server of attempts) server?.client.close();
      return this.statuses();
    }
    for (const server of attempts) {
      if (server === null) continue;
      this.connected.set(server.config.id, server);
      this.recordConnectedStatus(server);
      await this.resubscribe(server);
    }
    this.rebuildToolRegistrations();
    this.ctx.emit("mcp/changed");
    return this.statuses();
  }

  async listAllResources(serverId?: string): Promise<ListedMcpResource[]> {
    await this.ready;
    const resourceServers = [...this.connected.values()].filter((server) => Boolean(server.capabilities.resources));
    const targets = serverId && serverId.trim() !== ""
      ? [this.resolve(serverId, resourceServers, "资源")]
      : resourceServers;
    const lists = await Promise.all(targets.map(async (server) => {
      const items = await server.client.listResources();
      return items.map((item): ListedMcpResource => ({
        ...item,
        serverId: server.config.id,
        serverName: server.config.name || server.config.id,
      }));
    }));
    return lists.flat();
  }

  async readServerResource(serverId: string | undefined, uri: string): Promise<{ serverId: string; uri: string; text: string }> {
    await this.ready;
    const resourceServers = [...this.connected.values()].filter((server) => Boolean(server.capabilities.resources));
    const server = this.resolve(serverId, resourceServers, "资源");
    const blocks = resourceContent(await server.client.readResource(uri));
    const text = blocks.map((block) => (block.type === "text" ? block.text : `[图片资源 ${block.mimeType}]`)).join("\n\n");
    return { serverId: server.config.id, uri, text };
  }

  async listAllPrompts(serverId?: string): Promise<ListedMcpPrompt[]> {
    await this.ready;
    const promptServers = [...this.connected.values()].filter((server) => Boolean(server.capabilities.prompts));
    const targets = serverId && serverId.trim() !== ""
      ? [this.resolve(serverId, promptServers, "提示词")]
      : promptServers;
    const lists = await Promise.all(targets.map(async (server) => {
      const items = await server.client.listPrompts();
      return items.map((item): ListedMcpPrompt => ({
        ...item,
        serverId: server.config.id,
        serverName: server.config.name || server.config.id,
      }));
    }));
    return lists.flat();
  }

  async getServerPrompt(serverId: string | undefined, name: string, args: Record<string, string> = {}): Promise<{ serverId: string; name: string; markdown: string }> {
    await this.ready;
    const promptServers = [...this.connected.values()].filter((server) => Boolean(server.capabilities.prompts));
    const server = this.resolve(serverId, promptServers, "提示词");
    const resolved = await server.client.getPrompt(name, args);
    return {
      serverId: server.config.id,
      name,
      markdown: promptResultMarkdown(server, name, resolved),
    };
  }

  private clearReconnectTimer(serverId: string): void {
    const timer = this.reconnectTimers.get(serverId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.reconnectTimers.delete(serverId);
    }
  }

  private recordConnectedStatus(server: ConnectedServer): void {
    this.statusMap.set(server.config.id, {
      config: server.config,
      connected: true,
      toolCount: server.tools.length,
      protocolVersion: server.protocolVersion,
      hasResources: Boolean(server.capabilities.resources),
      hasPrompts: Boolean(server.capabilities.prompts),
    });
  }

  private async resubscribe(server: ConnectedServer): Promise<void> {
    if (server.capabilities.resources?.subscribe !== true) return;
    const uris = this.subscriptions.get(server.config.id);
    if (!uris || uris.size === 0) return;
    for (const uri of uris) {
      await server.client.subscribeResource(uri).catch(() => undefined);
    }
  }

  private async connectAll(configured: McpServerConfig[]): Promise<void> {
    const attempts = await Promise.all(configured.map((config) => this.connect(config)));
    if (this.closed) {
      for (const server of attempts) server?.client.close();
      return;
    }
    for (const server of attempts) {
      if (server === null) continue;
      this.connected.set(server.config.id, server);
      this.recordConnectedStatus(server);
    }
    this.rebuildToolRegistrations();
  }

  private async refreshServerTools(serverId: string): Promise<void> {
    const previous = this.refreshLocks.get(serverId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      if (this.closed) return;
      const server = this.connected.get(serverId);
      if (server === undefined) return;
      const label = server.config.name || server.config.id;
      try {
        const tools = await server.client.listTools();
        if (this.closed || this.connected.get(serverId) !== server) return;
        server.tools = tools;
        this.recordConnectedStatus(server);
        this.rebuildToolRegistrations();
        this.ctx.ui.notify(undefined, `MCP 通知 · ${label}\n工具列表已动态刷新（当前 ${tools.length} 个工具）。`, "info");
        this.ctx.emit("mcp/changed");
      } catch (error) {
        this.ctx.logger("mcp").warn("failed to refresh tools for %s: %s", label, errorText(error));
      }
    });
    this.refreshLocks.set(serverId, next);
    await next;
  }

  private handleUnexpectedDisconnect(config: McpServerConfig, closedClient: ConnectedServer["client"], error: Error): void {
    if (this.closed) return;
    const current = this.connected.get(config.id);
    if (current === undefined || current.client !== closedClient) return;
    this.connected.delete(config.id);
    this.statusMap.set(config.id, {
      config,
      connected: false,
      toolCount: 0,
      error: errorText(error),
    });
    this.rebuildToolRegistrations();
    this.ctx.emit("mcp/changed");
    this.scheduleBackoffReconnect(config, 0);
  }

  private scheduleBackoffReconnect(config: McpServerConfig, attempt: number): void {
    const delays = this.config.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    if (this.closed || attempt >= delays.length) return;
    this.clearReconnectTimer(config.id);
    const delay = delays[attempt] ?? 1_000;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(config.id);
      if (this.closed || this.connected.has(config.id)) return;
      void this.connect(config).then(async (reconnected) => {
        if (this.closed) {
          reconnected?.client.close();
          return;
        }
        if (reconnected === null) {
          this.scheduleBackoffReconnect(config, attempt + 1);
          return;
        }
        this.connected.set(config.id, reconnected);
        this.recordConnectedStatus(reconnected);
        await this.resubscribe(reconnected);
        this.rebuildToolRegistrations();
        this.ctx.emit("mcp/changed");
      });
    }, delay);
    timer.unref?.();
    this.reconnectTimers.set(config.id, timer);
  }

  private async connect(config: McpServerConfig): Promise<ConnectedServer | null> {
    const client = createClient(config);
    const label = config.name || config.id;
    client.setNotificationHandler(async (message) => {
      if (message.method === "notifications/resources/updated") {
        const uri = typeof message.params?.uri === "string" ? message.params.uri : "";
        if (uri !== "" && this.subscriptions.get(config.id)?.has(uri)) {
          this.ctx.ui.notify(undefined, `MCP 资源已更新 · ${label}\n${uri}`, "info");
        }
        return;
      }
      if (message.method === "notifications/tools/list_changed") {
        await this.refreshServerTools(config.id);
        return;
      }
      const notice = message.method === undefined ? undefined : CHANGE_NOTICES[message.method];
      if (notice !== undefined) this.ctx.ui.notify(undefined, `MCP 通知 · ${label}\n${notice}`, "info");
    });
    client.setDisconnectHandler?.((error) => this.handleUnexpectedDisconnect(config, client, error));
    try {
      const connection = await client.connect();
      const declared = Object.keys(connection.capabilities).length > 0;
      const tools = connection.capabilities.tools || !declared ? await client.listTools() : [];
      return { config, client, tools, ...connection };
    } catch (error) {
      client.close();
      this.statusMap.set(config.id, { config, connected: false, toolCount: 0, error: errorText(error) });
      this.ctx.logger("mcp").warn("%s did not connect: %s", label, errorText(error));
      return null;
    }
  }

  private rebuildToolRegistrations(): void {
    if (this.closed) return;
    for (const dispose of this.disposers.splice(0)) dispose();
    const used = new Set<string>();
    for (const server of this.connected.values()) {
      for (const remote of server.tools) {
        this.register(this.remoteTool(server, remote, toolName(server.config.id, remote.name, used)));
      }
    }
    this.registerResourceAndPromptTools();
  }

  private register<A extends Record<string, unknown>>(definition: ToolDefinition<A>): void {
    if (this.closed) return;
    this.disposers.push(this.ctx.tools.register(definition));
  }

  /** The session's effective permission mode, or `ask` without the permissions plugin. */
  private async mode(env: ToolEnv): Promise<string> {
    const permissions = this.ctx.get("permissions") as { modes(session: Session): { effective: string } } | undefined;
    const session = await this.ctx.sessions.get(env.sessionId);
    return session === undefined || permissions === undefined ? "ask" : permissions.modes(session).effective;
  }

  /**
   * Apply the read-only and confirmation rules; an error output when the call
   * may not go ahead.
   */
  private async gate(env: ToolEnv, trusted: boolean, title: string, message: string, refusal: string): Promise<ToolOutput | undefined> {
    const mode = await this.mode(env);
    if (mode === "read-only" && !trusted) return textOutput("只读模式只允许访问已标记为受信任只读的 MCP 服务器", true);
    if (trusted || this.config.confirmTools === false || mode === "full-access") return undefined;
    const allowed = await this.ctx.ui.confirm(env.sessionId, title, message, env.signal);
    return allowed ? undefined : textOutput(refusal, true);
  }

  private remoteTool(server: ConnectedServer, remote: ConnectedServer["tools"][number], name: string): ToolDefinition {
    const label = server.config.name || server.config.id;
    const parameters = remote.inputSchema?.type === "object"
      ? (remote.inputSchema as ToolDefinition["parameters"])
      : { type: "object" as const, properties: {}, additionalProperties: true };
    return {
      name,
      description: `[MCP: ${label}] ${remote.description || remote.name}`,
      parameters,
      execute: async (args: Record<string, unknown>, env: ToolEnv) => {
        const trusted = server.config.trustedReadOnly && remote.annotations?.destructiveHint !== true;
        const mode = await this.mode(env);
        if (mode === "read-only" && !trusted) return textOutput("只读模式阻止了未标记为受信任只读的 MCP 工具", true);
        if (this.config.confirmTools !== false && mode !== "full-access") {
          const preview = JSON.stringify(args, null, 2).slice(0, 1800);
          if (!(await this.ctx.ui.confirm(env.sessionId, `允许 MCP 工具？${label}`, `${remote.name}\n${preview}`, env.signal))) {
            return textOutput("用户拒绝了 MCP 工具调用", true);
          }
        }
        const result = await server.client.callTool(remote.name, args, env.signal);
        const content = resultContent(result);
        return {
          content,
          ...(result.isError ? { isError: true } : {}),
          details: { serverId: server.config.id, toolName: remote.name, structuredContent: result.structuredContent },
        };
      },
    };
  }

  private resolve(requestedId: string | undefined, candidates: ConnectedServer[], capability: string): ConnectedServer {
    const requested = requestedId?.trim();
    if (requested) {
      const match = candidates.find((server) => server.config.id === requested || server.config.name === requested);
      if (match) return match;
      throw new Error(`没有找到支持${capability}的 MCP 服务器“${requested}”。可用：${candidates.map((server) => server.config.id).join(", ") || "无"}`);
    }
    if (candidates.length === 1 && candidates[0] !== undefined) return candidates[0];
    if (candidates.length === 0) throw new Error(`没有已连接且支持${capability}的 MCP 服务器`);
    throw new Error(`请指定 serverId。可用：${candidates.map((server) => server.config.id).join(", ")}`);
  }

  private registerResourceAndPromptTools(): void {
    const connectedList = [...this.connected.values()];
    const resourceServers = connectedList.filter((server) => Boolean(server.capabilities.resources));
    const subscribable = resourceServers.filter((server) => server.capabilities.resources?.subscribe === true);
    const promptServers = connectedList.filter((server) => Boolean(server.capabilities.prompts));
    const serverId = { type: "string", description: "MCP server ID; optional when exactly one server supports this" };
    const labelOf = (server: ConnectedServer) => server.config.name || server.config.id;

    if (resourceServers.length > 0) {
      this.register({
        name: "mcp_list_resources",
        description: "List read-only resources advertised by a connected MCP server.",
        parameters: { type: "object", properties: { serverId } },
        execute: async ({ serverId: requested }: { serverId?: string }, env: ToolEnv) => {
          const server = this.resolve(requested, resourceServers, "资源");
          const refused = await this.gate(env, server.config.trustedReadOnly, "允许读取 MCP 资源列表？", labelOf(server), "用户拒绝了 MCP 资源读取");
          if (refused) return refused;
          const resources = await server.client.listResources();
          return { content: [{ type: "text", text: resourceListMarkdown(server, resources) }], details: { serverId: server.config.id, resources } };
        },
      });

      this.register({
        name: "mcp_read_resource",
        description: "Read a resource URI from a connected MCP server.",
        parameters: { type: "object", properties: { serverId, uri: { type: "string", description: "Exact URI returned by mcp_list_resources" } }, required: ["uri"] },
        execute: async ({ serverId: requested, uri }: { serverId?: string; uri: string }, env: ToolEnv) => {
          const server = this.resolve(requested, resourceServers, "资源");
          const refused = await this.gate(env, server.config.trustedReadOnly, "允许读取 MCP 资源？", `${labelOf(server)}\n${uri}`, "用户拒绝了 MCP 资源读取");
          if (refused) return refused;
          return { content: resourceContent(await server.client.readResource(uri)), details: { serverId: server.config.id, uri } };
        },
      });
    }

    if (subscribable.length > 0) {
      this.register({
        name: "mcp_subscribe_resource",
        description: "Subscribe to updates for a resource URI on an MCP server that advertises subscription support.",
        parameters: { type: "object", properties: { serverId, uri: { type: "string", description: "Exact resource URI to subscribe to" } }, required: ["uri"] },
        execute: async ({ serverId: requested, uri }: { serverId?: string; uri: string }, env: ToolEnv) => {
          const server = this.resolve(requested, subscribable, "资源订阅");
          const refused = await this.gate(env, server.config.trustedReadOnly, "允许订阅 MCP 资源？", `${labelOf(server)}\n${uri}`, "用户拒绝了 MCP 资源订阅");
          if (refused) return refused;
          await server.client.subscribeResource(uri);
          const set = this.subscriptions.get(server.config.id) ?? new Set<string>();
          set.add(uri);
          this.subscriptions.set(server.config.id, set);
          return { content: [{ type: "text", text: `已订阅 MCP 资源：${labelOf(server)}\n${uri}` }], details: { serverId: server.config.id, uri, subscribed: true } };
        },
      });

      this.register({
        name: "mcp_unsubscribe_resource",
        description: "Stop live updates for a previously subscribed MCP resource URI.",
        parameters: { type: "object", properties: { serverId, uri: { type: "string", description: "Exact subscribed resource URI" } }, required: ["uri"] },
        execute: async ({ serverId: requested, uri }: { serverId?: string; uri: string }) => {
          const server = this.resolve(requested, subscribable, "资源订阅");
          const set = this.subscriptions.get(server.config.id);
          if (!set?.has(uri)) return { content: [{ type: "text", text: `该资源当前未订阅：${uri}` }], details: { serverId: server.config.id, uri, subscribed: false } };
          await server.client.unsubscribeResource(uri);
          set.delete(uri);
          if (set.size === 0) this.subscriptions.delete(server.config.id);
          return { content: [{ type: "text", text: `已取消订阅 MCP 资源：${labelOf(server)}\n${uri}` }], details: { serverId: server.config.id, uri, subscribed: false } };
        },
      });
    }

    if (promptServers.length > 0) {
      this.register({
        name: "mcp_list_prompts",
        description: "List prompt templates advertised by a connected MCP server.",
        parameters: { type: "object", properties: { serverId } },
        execute: async ({ serverId: requested }: { serverId?: string }, env: ToolEnv) => {
          const server = this.resolve(requested, promptServers, "提示词");
          const refused = await this.gate(env, server.config.trustedReadOnly, "允许读取 MCP 提示词列表？", labelOf(server), "用户拒绝了 MCP 提示词读取");
          if (refused) return refused;
          const prompts = await server.client.listPrompts();
          return { content: [{ type: "text", text: promptListMarkdown(server, prompts) }], details: { serverId: server.config.id, prompts } };
        },
      });

      this.register({
        name: "mcp_get_prompt",
        description: "Resolve a prompt template from a connected MCP server with string arguments.",
        parameters: {
          type: "object",
          properties: { serverId, name: { type: "string", description: "Prompt name returned by mcp_list_prompts" }, arguments: { type: "object", additionalProperties: { type: "string" } } },
          required: ["name"],
        },
        execute: async ({ serverId: requested, name, arguments: args }: { serverId?: string; name: string; arguments?: Record<string, string> }, env: ToolEnv) => {
          const server = this.resolve(requested, promptServers, "提示词");
          const refused = await this.gate(env, server.config.trustedReadOnly, "允许读取 MCP 提示词？", `${labelOf(server)}\n${name}`, "用户拒绝了 MCP 提示词读取");
          if (refused) return refused;
          const result = await server.client.getPrompt(name, args ?? {});
          return { content: [{ type: "text", text: promptResultMarkdown(server, name, result) }], details: { serverId: server.config.id, name } };
        },
      });
    }
  }

  private registerSlashCommands(ctx: Context): void {
    const formatStatuses = (): string => {
      const list = this.statuses();
      if (list.length === 0) return "### MCP 服务器状态\n\n尚未启用任何 MCP 服务器。";
      const rows = list.map((status) => {
        const label = status.config.name || status.config.id;
        const state = status.connected ? `已连接（${status.toolCount} 个工具）` : `未连接（${status.error || "连接失败"}）`;
        const caps = [
          status.hasResources ? "资源" : null,
          status.hasPrompts ? "提示词" : null,
          status.protocolVersion ? `协议 ${status.protocolVersion}` : null,
        ].filter(Boolean).join(" · ");
        return `- **${label}** (\`${status.config.id}\`, ${status.config.transport.toUpperCase()})：${state}${caps ? ` — ${caps}` : ""}`;
      });
      return `### MCP 服务器状态\n\n${rows.join("\n")}`;
    };

    ctx.inject(["commands"], (inner) => {
      const disposers = [
        inner.commands.register({
          name: "mcp-status",
          description: "查看 MCP 服务器连接状态、协议版本与工具数量",
          source: "mcp",
          async execute() {
            await inner.mcp.ready;
            return { output: formatStatuses() };
          },
        }),
        inner.commands.register({
          name: "mcp-diagnose",
          description: "诊断已启用的 MCP 服务器连接状态（等同 /mcp-status）",
          source: "mcp",
          async execute() {
            await inner.mcp.ready;
            return { output: formatStatuses() };
          },
        }),
        inner.commands.register({
          name: "mcp-resources",
          description: "列出已连接 MCP 服务器提供的只读资源",
          argsHint: "[serverId]",
          source: "mcp",
          async execute(rawArgs) {
            await inner.mcp.ready;
            const serverId = rawArgs.trim() || undefined;
            const resources = await inner.mcp.listAllResources(serverId);
            if (resources.length === 0) return { output: "### MCP 资源\n\n没有发现可用资源。" };
            const lines = resources.map((item) => {
              const title = item.title || item.name || item.uri;
              const meta = [item.serverName, item.mimeType, item.description].filter(Boolean).join(" · ");
              return `- **${title}** — \`${item.uri}\`${meta ? `（${meta}）` : ""}`;
            });
            return { output: `### MCP 资源列表\n\n${lines.join("\n")}` };
          },
        }),
        inner.commands.register({
          name: "mcp-read",
          description: "读取指定 MCP 资源 URI 的内容",
          argsHint: "[serverId] <uri>",
          source: "mcp",
          async execute(rawArgs) {
            const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
            if (parts.length === 0) return { output: "用法：`/mcp-read [serverId] <uri>`", isError: true };
            const [first, second] = parts;
            const uri = second !== undefined ? second : (first ?? "");
            const serverId = second !== undefined ? first : undefined;
            const read = await inner.mcp.readServerResource(serverId, uri);
            return { output: read.text };
          },
        }),
        inner.commands.register({
          name: "mcp-prompts",
          description: "列出或解析 MCP 服务器的提示词模板",
          argsHint: "[serverId] [promptName]",
          source: "mcp",
          async execute(rawArgs) {
            const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
            if (parts.length <= 1) {
              const prompts = await inner.mcp.listAllPrompts(parts[0]);
              if (prompts.length === 0) return { output: "### MCP 提示词\n\n没有发现可用提示词模板。" };
              const lines = prompts.map((item) => {
                const args = (item.arguments ?? []).map((arg) => `${arg.name}${arg.required ? "*" : ""}`).join(", ");
                return `- **${item.title || item.name}** (\`${item.serverId}\`)${item.description ? `：${item.description}` : ""}${args ? ` — 参数：\`${args}\`` : ""}`;
              });
              return { output: `### MCP 提示词模板\n\n${lines.join("\n")}` };
            }
            const [serverId, promptName] = parts;
            const resolved = await inner.mcp.getServerPrompt(serverId, promptName ?? "");
            return { output: resolved.markdown };
          },
        }),
      ];
      inner.effect(() => () => {
        for (const dispose of disposers) dispose();
      }, "mcp: slash commands");
    });
  }

  private registerRpcMethods(ctx: Context): void {
    ctx.inject(["rpc"], (rpcCtx) => {
      let rpcActive = true;
      rpcCtx.effect(() => () => {
        rpcActive = false;
      }, "mcp: rpc scope");

      const recordOf = (params: unknown): Record<string, unknown> => {
        if (params === undefined || params === null) return {};
        if (typeof params !== "object" || Array.isArray(params)) {
          throw new RpcError(ErrorCode.InvalidParams, "params must be an object");
        }
        return params as Record<string, unknown>;
      };
      const optionalStr = (p: Record<string, unknown>, key: string): string | undefined => {
        const raw = p[key];
        if (raw === undefined) return undefined;
        if (typeof raw !== "string") throw new RpcError(ErrorCode.InvalidParams, `${key} must be a string`);
        const trimmed = raw.trim();
        return trimmed === "" ? undefined : trimmed;
      };
      const requiredStr = (p: Record<string, unknown>, key: string): string => {
        const value = optionalStr(p, key);
        if (value === undefined) throw new RpcError(ErrorCode.InvalidParams, `${key} must be a non-empty string`);
        return value;
      };
      const formatMcpStatuses = (): McpServerStatus[] =>
        this.statuses().map(({ config, connected, toolCount, protocolVersion, hasResources, hasPrompts, error }) => ({
          id: config.id,
          name: config.name || config.id,
          transport: config.transport,
          connected,
          toolCount,
          ...(protocolVersion === undefined ? {} : { protocolVersion }),
          resources: hasResources === true,
          prompts: hasPrompts === true,
          ...(error === undefined ? {} : { error }),
        }));

      rpcCtx.on("mcp/changed", () => {
        if (rpcActive && !this.closed) {
          rpcCtx.rpc.broadcast("mcp/changed", { servers: formatMcpStatuses() });
        }
      });
      void this.ready.then(() => {
        if (rpcActive && !this.closed) {
          rpcCtx.rpc.broadcast("mcp/changed", { servers: formatMcpStatuses() });
        }
      });

      const methods: Record<string, (params: unknown) => unknown> = {
        "mcp.status": async (): Promise<McpStatusResult> => {
          await this.ready;
          return { servers: formatMcpStatuses() };
        },

        "mcp.reconnect": async (params): Promise<McpStatusResult> => {
          const p = recordOf(params);
          const serverId = optionalStr(p, "serverId");
          try {
            await this.reconnect(serverId);
          } catch (error) {
            throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
          }
          return { servers: formatMcpStatuses() };
        },

        "mcp.resources": async (params): Promise<McpResourcesResult> => {
          const p = recordOf(params);
          const serverId = optionalStr(p, "serverId");
          try {
            const resources = await this.listAllResources(serverId);
            return { resources };
          } catch (error) {
            throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
          }
        },

        "mcp.readResource": async (params): Promise<McpReadResourceResult> => {
          const p = recordOf(params);
          const serverId = optionalStr(p, "serverId");
          const uri = requiredStr(p, "uri");
          try {
            return await this.readServerResource(serverId, uri);
          } catch (error) {
            throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
          }
        },

        "mcp.prompts": async (params): Promise<McpPromptsResult> => {
          const p = recordOf(params);
          const serverId = optionalStr(p, "serverId");
          try {
            const prompts = await this.listAllPrompts(serverId);
            return { prompts };
          } catch (error) {
            throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
          }
        },

        "mcp.getPrompt": async (params): Promise<McpGetPromptResult> => {
          const p = recordOf(params);
          const serverId = optionalStr(p, "serverId");
          const name = requiredStr(p, "name");
          const rawArgs = p.arguments;
          const args: Record<string, string> = {};
          if (rawArgs !== undefined) {
            if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
              throw new RpcError(ErrorCode.InvalidParams, "arguments must be a string map");
            }
            for (const [key, value] of Object.entries(rawArgs as Record<string, unknown>)) {
              if (typeof value === "string") args[key] = value;
            }
          }
          try {
            return await this.getServerPrompt(serverId, name, args);
          } catch (error) {
            throw new RpcError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
          }
        },
      };

      for (const [method, handler] of Object.entries(methods)) {
        rpcCtx.effect(() => rpcCtx.rpc.method(method, handler), `mcp: ${method}`);
      }
    });
  }
}
