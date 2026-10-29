/**
 * MCP servers as tools (ADR 0010). The `mcp` service connects the enabled
 * servers in the background when the host starts and registers each remote
 * tool as `mcp__<server>__<tool>`, plus `mcp_list_resources`,
 * `mcp_read_resource`, `mcp_(un)subscribe_resource`, `mcp_list_prompts` and
 * `mcp_get_prompt` when a connected server supports them.
 *
 * The rules are the Pi extension's: under a read-only session only servers
 * marked `trustedReadOnly` may be read (the permissions plugin blocks `mcp__`
 * tools there outright), and every call asks through `ui` first unless the
 * session has full access or `confirmTools` is off. Server notifications
 * (resource updates, list changes) are shown with `ui.notify`.
 */
import { Context, Service } from "@deepseek-ai/cordis";
import type { Session } from "@pid/session";
import { textOutput, type ToolDefinition, type ToolEnv, type ToolOutput } from "@pid/tools";
import "@pid/ui";
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
  type McpServerConfig,
  type ServerStatus,
} from "./client.ts";

export * from "./client.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    mcp: Mcp;
  }
}

export interface Config {
  servers?: McpServerConfig[];
  /** Ask before each MCP call unless the session has full access. Default true. */
  confirmTools?: boolean;
}

const CHANGE_NOTICES: Record<string, string> = {
  "notifications/resources/list_changed": "资源列表已变化，可重新调用 mcp_list_resources。",
  "notifications/prompts/list_changed": "提示词列表已变化，可重新调用 mcp_list_prompts。",
  "notifications/tools/list_changed": "工具列表已变化；重启 Host 后会重新发现并注册工具。",
};

export class Mcp extends Service {
  static inject = ["sessions", "tools", "ui"];

  /** Settles once every configured server has connected or failed. */
  readonly ready: Promise<void>;
  private readonly statusList: ServerStatus[] = [];
  private readonly connected: ConnectedServer[] = [];
  private readonly subscriptions = new Map<string, Set<string>>();
  private readonly disposers: Array<() => void> = [];
  private closed = false;

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, "mcp");
    ctx.effect(() => () => {
      this.closed = true;
      for (const dispose of this.disposers.splice(0)) dispose();
      for (const server of this.connected) server.client.close();
    }, "mcp: servers");
    this.ready = this.connectAll((config.servers ?? []).filter((server) => server.enabled));
  }

  statuses(): ServerStatus[] {
    return this.statusList.map((status) => ({ ...status }));
  }

  private async connectAll(configured: McpServerConfig[]): Promise<void> {
    const attempts = await Promise.all(configured.map((config) => this.connect(config)));
    if (this.closed) {
      for (const server of attempts) server?.client.close();
      return;
    }
    const used = new Set<string>();
    for (const server of attempts) {
      if (server === null) continue;
      this.connected.push(server);
      this.statusList.push({
        config: server.config,
        connected: true,
        toolCount: server.tools.length,
        protocolVersion: server.protocolVersion,
        hasResources: Boolean(server.capabilities.resources),
        hasPrompts: Boolean(server.capabilities.prompts),
      });
      for (const remote of server.tools) this.register(this.remoteTool(server, remote, toolName(server.config.id, remote.name, used)));
    }
    this.registerResourceAndPromptTools();
  }

  private async connect(config: McpServerConfig): Promise<ConnectedServer | null> {
    const client = createClient(config);
    const label = config.name || config.id;
    client.setNotificationHandler(async (message) => {
      if (message.method === "notifications/resources/updated") {
        const uri = typeof message.params?.uri === "string" ? message.params.uri : "";
        if (uri !== "" && this.subscriptions.get(config.id)?.has(uri)) this.ctx.ui.notify(undefined, `MCP 资源已更新 · ${label}\n${uri}`, "info");
        return;
      }
      const notice = message.method === undefined ? undefined : CHANGE_NOTICES[message.method];
      if (notice !== undefined) this.ctx.ui.notify(undefined, `MCP 通知 · ${label}\n${notice}`, "info");
    });
    try {
      const connection = await client.connect();
      const declared = Object.keys(connection.capabilities).length > 0;
      const tools = connection.capabilities.tools || !declared ? await client.listTools() : [];
      return { config, client, tools, ...connection };
    } catch (error) {
      client.close();
      this.statusList.push({ config, connected: false, toolCount: 0, error: errorText(error) });
      this.ctx.logger("mcp").warn("%s did not connect: %s", label, errorText(error));
      return null;
    }
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
    const resourceServers = this.connected.filter((server) => Boolean(server.capabilities.resources));
    const subscribable = resourceServers.filter((server) => server.capabilities.resources?.subscribe === true);
    const promptServers = this.connected.filter((server) => Boolean(server.capabilities.prompts));
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
}
