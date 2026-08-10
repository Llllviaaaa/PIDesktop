import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);

interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  inheritEnvironment: boolean;
  url: string;
  headers: Record<string, string>;
  trustedReadOnly: boolean;
}

interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [key: string]: unknown };
}

interface McpToolResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ConnectedServer {
  config: McpServerConfig;
  client: McpClient;
  tools: McpTool[];
  protocolVersion: string;
}

interface ServerStatus {
  config: McpServerConfig;
  connected: boolean;
  toolCount: number;
  protocolVersion?: string;
  error?: string;
}

interface McpClient {
  connect(): Promise<string>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult>;
  close(): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeEnvironment(config: McpServerConfig): NodeJS.ProcessEnv {
  const sensitive = /(api.?key|token|secret|password|credential|authorization|cookie)/i;
  const inherited = config.inheritEnvironment
    ? { ...process.env }
    : Object.fromEntries(Object.entries(process.env).filter(([key]) => !sensitive.test(key)));
  return { ...inherited, ...config.env };
}

function commandForWindows(command: string, args: string[]): { command: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") return { command, args, shell: false };
  const needsShell = /\.(cmd|bat)$/i.test(command) || !/[\\/]/.test(command);
  return { command, args, shell: needsShell };
}

class StdioMcpClient implements McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private closing = false;
  private stderrTail = "";

  constructor(private config: McpServerConfig) {}

  async connect(): Promise<string> {
    const launch = commandForWindows(this.config.command, this.config.args || []);
    this.child = spawn(launch.command, launch.args, {
      cwd: this.config.cwd || undefined,
      env: safeEnvironment(this.config),
      shell: launch.shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.consume(this.decoder.write(chunk)));
    this.child.stdout.on("end", () => this.consume(this.decoder.end()));
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("close", (code) => {
      if (!this.closing) this.failAll(new Error(this.stderrTail.trim() || `MCP server exited with code ${code}`));
    });
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Pi Desktop", version: "0.2.0" },
    }) as { protocolVersion?: string };
    const negotiated = result.protocolVersion || PROTOCOL_VERSION;
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(negotiated)) {
      throw new Error(`MCP server selected unsupported protocol version ${negotiated}`);
    }
    this.notify("notifications/initialized");
    return negotiated;
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request("tools/list", cursor ? { cursor } : {}) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(result.tools || []));
      cursor = result.nextCursor;
      if (!cursor) return tools;
    }
    throw new Error("MCP tools/list exceeded 50 pages");
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    return this.request("tools/call", { name, arguments: args }, 120_000, signal) as Promise<McpToolResult>;
  }

  close(): void {
    this.closing = true;
    this.failAll(new Error("MCP connection closed"));
    const child = this.child;
    child?.stdin.end();
    setTimeout(() => child?.kill(), 1000);
    this.child = null;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 20_000, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      const abort = () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        try {
          this.notify("notifications/cancelled", { requestId: id, reason: "Pi Desktop tool call cancelled" });
        } catch {
          // The connection may already be closing.
        }
        clearTimeout(entry.timeout);
        this.pending.delete(id);
        reject(new Error(`MCP request cancelled: ${method}`));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        timeout,
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        signal?.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  private send(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) throw new Error("MCP stdio connection is not writable");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.failAll(new Error(`MCP server wrote invalid JSON to stdout: ${line.slice(0, 300)}`));
        continue;
      }
      if (message.id !== undefined && message.id !== null && (message.result !== undefined || message.error)) {
        const id = Number(message.id);
        const pending = this.pending.get(id);
        if (!pending) continue;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        if (message.error) pending.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result);
        continue;
      }
      if (message.id !== undefined && message.method) {
        this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Pi Desktop does not support this MCP client request" } });
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class HttpMcpClient implements McpClient {
  private nextId = 1;
  private sessionId: string | undefined;
  private negotiatedVersion: string | undefined;

  constructor(private config: McpServerConfig) {}

  async connect(): Promise<string> {
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Pi Desktop", version: "0.2.0" },
    }) as { protocolVersion?: string };
    this.negotiatedVersion = result.protocolVersion || PROTOCOL_VERSION;
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(this.negotiatedVersion)) {
      throw new Error(`MCP server selected unsupported protocol version ${this.negotiatedVersion}`);
    }
    await this.notification("notifications/initialized");
    return this.negotiatedVersion;
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request("tools/list", cursor ? { cursor } : {}) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(result.tools || []));
      cursor = result.nextCursor;
      if (!cursor) return tools;
    }
    throw new Error("MCP tools/list exceeded 50 pages");
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    return this.request("tools/call", { name, arguments: args }, signal, 120_000) as Promise<McpToolResult>;
  }

  close(): void {
    if (!this.sessionId) return;
    const headers: Record<string, string> = { ...this.config.headers, "mcp-session-id": this.sessionId };
    if (this.negotiatedVersion) headers["mcp-protocol-version"] = this.negotiatedVersion;
    void fetch(this.config.url, { method: "DELETE", headers }).catch(() => undefined);
    this.sessionId = undefined;
  }

  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 20_000): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    const response = await this.post(message, signal, timeoutMs);
    const matched = response.find((entry) => entry.id === id);
    if (!matched) throw new Error(`MCP HTTP response did not include request ${id}`);
    if (matched.error) throw new Error(`MCP ${matched.error.code}: ${matched.error.message}`);
    return matched.result;
  }

  private async notification(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, undefined, 20_000);
  }

  private async post(message: JsonRpcMessage, signal?: AbortSignal, timeoutMs = 20_000): Promise<JsonRpcMessage[]> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
    const abort = () => timeoutController.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...this.config.headers,
      };
      if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
      if (this.negotiatedVersion) headers["mcp-protocol-version"] = this.negotiatedVersion;
      const response = await fetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: timeoutController.signal,
      });
      const nextSessionId = response.headers.get("mcp-session-id");
      if (nextSessionId) this.sessionId = nextSessionId;
      if (response.status === 202) return [];
      const body = await response.text();
      if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${body.slice(0, 500)}`);
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) return parseSse(body);
      const parsed = JSON.parse(body) as JsonRpcMessage | JsonRpcMessage[];
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      if (timeoutController.signal.aborted) throw new Error("MCP HTTP request timed out or was cancelled");
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function parseSse(body: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    messages.push(JSON.parse(data) as JsonRpcMessage);
  }
  return messages;
}

function createClient(config: McpServerConfig): McpClient {
  return config.transport === "http" ? new HttpMcpClient(config) : new StdioMcpClient(config);
}

function toolName(serverId: string, remoteName: string, used: Set<string>): string {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const base = `mcp__${clean(serverId) || "server"}__${clean(remoteName) || "tool"}`.slice(0, 120);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base.slice(0, 115)}_${suffix++}`;
  used.add(candidate);
  return candidate;
}

function resultContent(result: McpToolResult): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const item of result.content || []) {
    if (item.type === "text" && typeof item.text === "string") content.push({ type: "text", text: item.text });
    else if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      content.push({ type: "image", data: item.data, mimeType: item.mimeType });
    } else if (item.type === "resource" && item.resource && typeof item.resource === "object") {
      const resource = item.resource as Record<string, unknown>;
      content.push({ type: "text", text: typeof resource.text === "string" ? resource.text : `[MCP 资源] ${String(resource.uri || "")}` });
    } else if (item.type === "resource_link") {
      content.push({ type: "text", text: `[MCP 资源链接] ${String(item.title || item.name || "")} ${String(item.uri || "")}`.trim() });
    } else {
      content.push({ type: "text", text: JSON.stringify(item) });
    }
  }
  if (!content.length && result.structuredContent) content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
  if (!content.length) content.push({ type: "text", text: "MCP 工具执行完成。" });
  return content;
}

async function loadConfig(): Promise<McpServerConfig[]> {
  const path = process.env.PIDESKTOP_MCP_CONFIG;
  if (!path) return [];
  const parsed = JSON.parse(await readFile(path, "utf8")) as McpServerConfig[];
  return parsed.filter((server) => server.enabled);
}

export default async function (pi: ExtensionAPI) {
  const permissionMode = process.env.PIDESKTOP_PERMISSION_MODE || "ask";
  const confirmTools = process.env.PIDESKTOP_MCP_CONFIRM !== "0";
  const statuses: ServerStatus[] = [];
  const connected: ConnectedServer[] = [];
  const usedNames = new Set<string>();
  let configured: McpServerConfig[] = [];

  try {
    configured = await loadConfig();
  } catch (error) {
    statuses.push({
      config: { id: "config", name: "MCP 配置", enabled: true, transport: "stdio", command: "", args: [], cwd: "", env: {}, inheritEnvironment: false, url: "", headers: {}, trustedReadOnly: false },
      connected: false,
      toolCount: 0,
      error: errorText(error),
    });
  }

  const attempts = await Promise.all(configured.map(async (config) => {
    const client = createClient(config);
    try {
      const protocolVersion = await client.connect();
      const tools = await client.listTools();
      return { config, client, tools, protocolVersion } satisfies ConnectedServer;
    } catch (error) {
      client.close();
      statuses.push({ config, connected: false, toolCount: 0, error: errorText(error) });
      return null;
    }
  }));

  for (const server of attempts) {
    if (!server) continue;
    connected.push(server);
    statuses.push({ config: server.config, connected: true, toolCount: server.tools.length, protocolVersion: server.protocolVersion });
    for (const remoteTool of server.tools) {
      const name = toolName(server.config.id, remoteTool.name, usedNames);
      const parameters = Type.Unsafe<Record<string, unknown>>(
        remoteTool.inputSchema && remoteTool.inputSchema.type === "object"
          ? remoteTool.inputSchema
          : { type: "object", properties: {}, additionalProperties: true },
      );
      pi.registerTool({
        name,
        label: remoteTool.title || remoteTool.name,
        description: `[MCP: ${server.config.name || server.config.id}] ${remoteTool.description || remoteTool.name}`,
        promptSnippet: `Call ${remoteTool.name} on the ${server.config.name || server.config.id} MCP server`,
        parameters,
        async execute(_toolCallId, args, signal, onUpdate, ctx) {
          const trustedReadOnly = server.config.trustedReadOnly && remoteTool.annotations?.destructiveHint !== true;
          if (permissionMode === "read-only" && !trustedReadOnly) {
            throw new Error("只读模式阻止了未标记为受信任只读的 MCP 工具");
          }
          if (confirmTools) {
            const preview = JSON.stringify(args, null, 2).slice(0, 1800);
            const allowed = await ctx.ui.confirm(
              `允许 MCP 工具？${server.config.name || server.config.id}`,
              `${remoteTool.name}\n${preview}`,
            );
            if (!allowed) throw new Error("用户拒绝了 MCP 工具调用");
          }
          onUpdate?.({
            content: [{ type: "text", text: `MCP ${server.config.name || server.config.id}：${remoteTool.name}…` }],
            details: { serverId: server.config.id, serverName: server.config.name, toolName: remoteTool.name },
          });
          const result = await server.client.callTool(remoteTool.name, args, signal);
          const content = resultContent(result);
          if (result.isError) {
            throw new Error(content.map((item) => item.type === "text" ? item.text : "[image]").join("\n"));
          }
          return {
            content,
            details: {
              serverId: server.config.id,
              serverName: server.config.name,
              toolName: remoteTool.name,
              structuredContent: result.structuredContent,
            },
          };
        },
      });
    }
  }

  const summary = () => {
    const healthy = statuses.filter((status) => status.connected).length;
    const tools = statuses.reduce((total, status) => total + status.toolCount, 0);
    const failed = statuses.length - healthy;
    return configured.length ? `MCP ${healthy}/${configured.length} · ${tools} 工具${failed ? ` · ${failed} 失败` : ""}` : "MCP 未配置";
  };

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("pidesktop-mcp", summary());
  });
  pi.on("session_shutdown", async () => {
    for (const server of connected) server.client.close();
  });

  pi.registerCommand("mcp-diagnose", {
    description: "显示 MCP 服务器、协议版本和已发现工具",
    handler: async (_args, ctx) => {
      if (!statuses.length) {
        ctx.ui.notify("尚未配置启用的 MCP 服务器。请在设置中添加服务器并新建任务。", "warning");
        return;
      }
      const lines = statuses.map((status) => status.connected
        ? `✓ ${status.config.name || status.config.id} · ${status.config.transport} · ${status.protocolVersion} · ${status.toolCount} 个工具`
        : `✗ ${status.config.name || status.config.id} · ${status.error}`);
      ctx.ui.notify(lines.join("\n"), statuses.some((status) => !status.connected) ? "warning" : "info");
    },
  });
}
