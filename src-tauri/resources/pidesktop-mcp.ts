import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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

interface McpCapabilities {
  tools?: Record<string, unknown>;
  resources?: { subscribe?: boolean; listChanged?: boolean; [key: string]: unknown };
  prompts?: { listChanged?: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

interface McpConnectResult {
  protocolVersion: string;
  capabilities: McpCapabilities;
}

interface McpResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface McpPromptResult {
  description?: string;
  messages?: Array<{ role?: string; content?: Record<string, unknown> }>;
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
  capabilities: McpCapabilities;
}

type McpNotificationHandler = (message: JsonRpcMessage) => void | Promise<void>;

interface ServerStatus {
  config: McpServerConfig;
  connected: boolean;
  toolCount: number;
  protocolVersion?: string;
  hasResources?: boolean;
  hasPrompts?: boolean;
  error?: string;
}

interface McpClient {
  connect(): Promise<McpConnectResult>;
  setNotificationHandler(handler: McpNotificationHandler): void;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult>;
  listResources(): Promise<McpResource[]>;
  readResource(uri: string): Promise<{ contents?: McpResourceContents[] }>;
  subscribeResource(uri: string): Promise<void>;
  unsubscribeResource(uri: string): Promise<void>;
  listPrompts(): Promise<McpPrompt[]>;
  getPrompt(name: string, args: Record<string, string>): Promise<McpPromptResult>;
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
  delete inherited.PIDESKTOP_MCP_CONFIG;
  delete inherited.PIDESKTOP_MCP_CONFIG_B64;
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
  private notificationHandler: McpNotificationHandler | undefined;

  constructor(private config: McpServerConfig) {}

  async connect(): Promise<McpConnectResult> {
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
      clientInfo: { name: "Pi Desktop", version: "0.2.27" },
    }) as { protocolVersion?: string; capabilities?: McpCapabilities };
    const negotiated = result.protocolVersion || PROTOCOL_VERSION;
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(negotiated)) {
      throw new Error(`MCP server selected unsupported protocol version ${negotiated}`);
    }
    this.notify("notifications/initialized");
    return { protocolVersion: negotiated, capabilities: result.capabilities || {} };
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

  setNotificationHandler(handler: McpNotificationHandler): void {
    this.notificationHandler = handler;
  }

  async listResources(): Promise<McpResource[]> {
    return this.listPaginated<McpResource>("resources/list", "resources");
  }

  async readResource(uri: string): Promise<{ contents?: McpResourceContents[] }> {
    return this.request("resources/read", { uri }) as Promise<{ contents?: McpResourceContents[] }>;
  }

  async subscribeResource(uri: string): Promise<void> {
    await this.request("resources/subscribe", { uri });
  }

  async unsubscribeResource(uri: string): Promise<void> {
    await this.request("resources/unsubscribe", { uri });
  }

  async listPrompts(): Promise<McpPrompt[]> {
    return this.listPaginated<McpPrompt>("prompts/list", "prompts");
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<McpPromptResult> {
    return this.request("prompts/get", { name, arguments: args }) as Promise<McpPromptResult>;
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

  private async listPaginated<T>(method: string, field: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request(method, cursor ? { cursor } : {}) as Record<string, unknown> & { nextCursor?: string };
      const pageItems = result[field];
      if (Array.isArray(pageItems)) items.push(...pageItems as T[]);
      cursor = result.nextCursor;
      if (!cursor) return items;
    }
    throw new Error(`${method} exceeded 50 pages`);
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
        continue;
      }
      if (message.method && message.id === undefined) {
        void Promise.resolve(this.notificationHandler?.(message)).catch((error) => {
          console.error(`MCP notification handler failed: ${errorText(error)}`);
        });
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
  private notificationHandler: McpNotificationHandler | undefined;
  private eventStreamAbort: AbortController | undefined;
  private eventStreamTask: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectWake: (() => void) | undefined;
  private closing = false;

  constructor(private config: McpServerConfig) {}

  async connect(): Promise<McpConnectResult> {
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "Pi Desktop", version: "0.2.27" },
    }) as { protocolVersion?: string; capabilities?: McpCapabilities };
    this.negotiatedVersion = result.protocolVersion || PROTOCOL_VERSION;
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(this.negotiatedVersion)) {
      throw new Error(`MCP server selected unsupported protocol version ${this.negotiatedVersion}`);
    }
    await this.notification("notifications/initialized");
    this.startEventStream();
    return { protocolVersion: this.negotiatedVersion, capabilities: result.capabilities || {} };
  }

  setNotificationHandler(handler: McpNotificationHandler): void {
    this.notificationHandler = handler;
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

  async listResources(): Promise<McpResource[]> {
    return this.listPaginated<McpResource>("resources/list", "resources");
  }

  async readResource(uri: string): Promise<{ contents?: McpResourceContents[] }> {
    return this.request("resources/read", { uri }) as Promise<{ contents?: McpResourceContents[] }>;
  }

  async subscribeResource(uri: string): Promise<void> {
    await this.request("resources/subscribe", { uri });
  }

  async unsubscribeResource(uri: string): Promise<void> {
    await this.request("resources/unsubscribe", { uri });
  }

  async listPrompts(): Promise<McpPrompt[]> {
    return this.listPaginated<McpPrompt>("prompts/list", "prompts");
  }

  async getPrompt(name: string, args: Record<string, string>): Promise<McpPromptResult> {
    return this.request("prompts/get", { name, arguments: args }) as Promise<McpPromptResult>;
  }

  close(): void {
    this.closing = true;
    this.eventStreamAbort?.abort();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectWake?.();
    this.reconnectTimer = undefined;
    this.reconnectWake = undefined;
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
    for (const entry of response) {
      if (entry.method && entry.id === undefined) this.dispatchNotification(entry);
    }
    const matched = response.find((entry) => entry.id === id);
    if (!matched) throw new Error(`MCP HTTP response did not include request ${id}`);
    if (matched.error) throw new Error(`MCP ${matched.error.code}: ${matched.error.message}`);
    return matched.result;
  }

  private async listPaginated<T>(method: string, field: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request(method, cursor ? { cursor } : {}) as Record<string, unknown> & { nextCursor?: string };
      const pageItems = result[field];
      if (Array.isArray(pageItems)) items.push(...pageItems as T[]);
      cursor = result.nextCursor;
      if (!cursor) return items;
    }
    throw new Error(`${method} exceeded 50 pages`);
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

  private dispatchNotification(message: JsonRpcMessage): void {
    void Promise.resolve(this.notificationHandler?.(message)).catch((error) => {
      console.error(`MCP notification handler failed: ${errorText(error)}`);
    });
  }

  private startEventStream(): void {
    if (!this.sessionId || this.eventStreamTask || this.closing) return;
    this.eventStreamTask = this.consumeEventStream().finally(() => {
      this.eventStreamTask = undefined;
    });
  }

  private async consumeEventStream(): Promise<void> {
    let retryMs = 750;
    while (!this.closing && this.sessionId) {
      const controller = new AbortController();
      this.eventStreamAbort = controller;
      try {
        const headers: Record<string, string> = {
          accept: "text/event-stream",
          ...this.config.headers,
          "mcp-session-id": this.sessionId,
        };
        if (this.negotiatedVersion) headers["mcp-protocol-version"] = this.negotiatedVersion;
        const response = await fetch(this.config.url, { method: "GET", headers, signal: controller.signal });
        if (response.status === 404 || response.status === 405) return;
        if (!response.ok) throw new Error(`MCP HTTP event stream returned ${response.status}`);
        if (!(response.headers.get("content-type") || "").includes("text/event-stream") || !response.body) return;
        retryMs = 750;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!this.closing) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          while (true) {
            const boundary = buffer.search(/\r?\n\r?\n/);
            if (boundary < 0) break;
            const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] || "\n\n";
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + separator.length);
            for (const message of parseSse(`${event}\n\n`)) this.dispatchNotification(message);
          }
        }
        buffer += decoder.decode();
        for (const message of parseSse(buffer)) this.dispatchNotification(message);
      } catch (error) {
        if (this.closing || controller.signal.aborted) return;
        console.error(`MCP HTTP event stream disconnected: ${errorText(error)}`);
      } finally {
        if (this.eventStreamAbort === controller) this.eventStreamAbort = undefined;
      }
      await this.waitForReconnect(retryMs);
      retryMs = Math.min(retryMs * 2, 10_000);
    }
  }

  private waitForReconnect(delayMs: number): Promise<void> {
    if (this.closing) return Promise.resolve();
    return new Promise((resolve) => {
      this.reconnectWake = resolve;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        this.reconnectWake = undefined;
        resolve();
      }, delayMs);
    });
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

function resourceContent(result: { contents?: McpResourceContents[] }): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const resource of result.contents || []) {
    if (typeof resource.text === "string") {
      const limit = 200_000;
      const suffix = resource.text.length > limit ? `\n\n[内容已截断：原始长度 ${resource.text.length.toLocaleString()} 字符]` : "";
      content.push({ type: "text", text: `资源：${resource.uri}\n\n${resource.text.slice(0, limit)}${suffix}` });
    } else if (typeof resource.blob === "string" && resource.mimeType?.startsWith("image/")) {
      content.push({ type: "image", data: resource.blob, mimeType: resource.mimeType });
    } else if (typeof resource.blob === "string") {
      content.push({ type: "text", text: `资源：${resource.uri}\n二进制内容 · ${resource.mimeType || "application/octet-stream"} · ${resource.blob.length} 个 Base64 字符` });
    }
  }
  return content.length ? content : [{ type: "text", text: "MCP 服务器返回了空资源。" }];
}

function resourceListMarkdown(server: ConnectedServer, resources: McpResource[]): string {
  const title = server.config.name || server.config.id;
  if (!resources.length) return `### MCP 资源 · ${title}\n\n该服务器没有返回资源。`;
  return `### MCP 资源 · ${title}\n\n${resources.map((resource) => {
    const label = resource.title || resource.name || resource.uri;
    const metadata = [resource.mimeType, resource.description].filter(Boolean).join(" · ");
    return `- **${label}**\n  - URI: \`${resource.uri}\`${metadata ? `\n  - ${metadata}` : ""}`;
  }).join("\n")}`;
}

function promptListMarkdown(server: ConnectedServer, prompts: McpPrompt[]): string {
  const title = server.config.name || server.config.id;
  if (!prompts.length) return `### MCP 提示词 · ${title}\n\n该服务器没有返回提示词。`;
  return `### MCP 提示词 · ${title}\n\n${prompts.map((prompt) => {
    const args = (prompt.arguments || []).map((arg) => `${arg.name}${arg.required ? "*" : ""}`).join(", ");
    return `- **${prompt.title || prompt.name}**${prompt.description ? `：${prompt.description}` : ""}${args ? `\n  - 参数：${args}` : ""}`;
  }).join("\n")}`;
}

function promptResultMarkdown(server: ConnectedServer, name: string, result: McpPromptResult): string {
  const messages = (result.messages || []).map((message) => {
    const raw = message.content || {};
    const body = typeof raw.text === "string" ? raw.text : JSON.stringify(raw, null, 2);
    return `#### ${message.role || "message"}\n\n${body}`;
  }).join("\n\n");
  return `### MCP 提示词 · ${server.config.name || server.config.id} / ${name}${result.description ? `\n\n${result.description}` : ""}${messages ? `\n\n${messages}` : "\n\n服务器返回了空提示词。"}`;
}

async function loadConfig(): Promise<McpServerConfig[]> {
  const encoded = process.env.PIDESKTOP_MCP_CONFIG_B64;
  delete process.env.PIDESKTOP_MCP_CONFIG_B64;
  delete process.env.PIDESKTOP_MCP_CONFIG;
  if (!encoded) return [];
  const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as McpServerConfig[];
  return parsed.filter((server) => server.enabled);
}

export default async function (pi: ExtensionAPI) {
  const permissionMode = process.env.PIDESKTOP_PERMISSION_MODE || "ask";
  const confirmTools = process.env.PIDESKTOP_MCP_CONFIRM !== "0";
  const statuses: ServerStatus[] = [];
  const connected: ConnectedServer[] = [];
  const usedNames = new Set<string>();
  const subscribedResources = new Map<string, Set<string>>();
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
    client.setNotificationHandler(async (message) => {
      const label = config.name || config.id;
      if (message.method === "notifications/resources/updated") {
        const uri = typeof message.params?.uri === "string" ? message.params.uri : "";
        if (!uri || !subscribedResources.get(config.id)?.has(uri)) return;
        try {
          const result = await client.readResource(uri);
          pi.sendMessage({
            customType: "pidesktop-mcp-resource-update",
            content: resourceContent(result),
            display: true,
            details: { serverId: config.id, uri, notification: message.method },
          }, { triggerTurn: false });
        } catch (error) {
          pi.sendMessage({
            customType: "pidesktop-mcp-notification",
            content: `MCP 资源更新读取失败 · ${label}\n\n\`${uri}\`\n\n${errorText(error)}`,
            display: true,
          }, { triggerTurn: false });
        }
        return;
      }
      const changeLabels: Record<string, string> = {
        "notifications/resources/list_changed": "资源列表已变化，可重新调用 mcp_list_resources。",
        "notifications/prompts/list_changed": "提示词列表已变化，可重新调用 mcp_list_prompts。",
        "notifications/tools/list_changed": "工具列表已变化；请新建任务以重新发现并注册工具。",
      };
      const notice = message.method ? changeLabels[message.method] : undefined;
      if (notice) {
        pi.sendMessage({
          customType: "pidesktop-mcp-notification",
          content: `MCP 通知 · ${label}\n\n${notice}`,
          display: true,
          details: { serverId: config.id, notification: message.method },
        }, { triggerTurn: false });
      }
    });
    try {
      const connection = await client.connect();
      const capabilitiesDeclared = Object.keys(connection.capabilities).length > 0;
      const tools = connection.capabilities.tools || !capabilitiesDeclared ? await client.listTools() : [];
      return { config, client, tools, ...connection } satisfies ConnectedServer;
    } catch (error) {
      client.close();
      statuses.push({ config, connected: false, toolCount: 0, error: errorText(error) });
      return null;
    }
  }));

  for (const server of attempts) {
    if (!server) continue;
    connected.push(server);
    statuses.push({
      config: server.config,
      connected: true,
      toolCount: server.tools.length,
      protocolVersion: server.protocolVersion,
      hasResources: Boolean(server.capabilities.resources),
      hasPrompts: Boolean(server.capabilities.prompts),
    });
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

  const resourceServers = connected.filter((server) => Boolean(server.capabilities.resources));
  const subscribableResourceServers = resourceServers.filter((server) => server.capabilities.resources?.subscribe === true);
  const promptServers = connected.filter((server) => Boolean(server.capabilities.prompts));
  const resolveServer = (requestedId: string | undefined, candidates: ConnectedServer[], capability: string): ConnectedServer => {
    const requested = requestedId?.trim();
    if (requested) {
      const match = candidates.find((server) => server.config.id === requested || server.config.name === requested);
      if (match) return match;
      throw new Error(`没有找到支持${capability}的 MCP 服务器“${requested}”。可用：${candidates.map((server) => server.config.id).join(", ") || "无"}`);
    }
    if (candidates.length === 1) return candidates[0];
    if (!candidates.length) throw new Error(`没有已连接且支持${capability}的 MCP 服务器`);
    throw new Error(`请指定 serverId。可用：${candidates.map((server) => server.config.id).join(", ")}`);
  };

  if (resourceServers.length) {
    pi.registerTool({
      name: "mcp_list_resources",
      label: "MCP 资源列表",
      description: "List read-only resources advertised by a connected MCP server.",
      promptSnippet: "List resources exposed by a configured MCP server before reading one",
      parameters: Type.Object({
        serverId: Type.Optional(Type.String({ description: "MCP server ID; optional when exactly one server supports resources" })),
      }),
      async execute(_toolCallId, params, _signal, onUpdate, ctx) {
        const server = resolveServer(params.serverId, resourceServers, "资源");
        if (permissionMode === "read-only" && !server.config.trustedReadOnly) {
          throw new Error("只读模式只允许读取已标记为受信任只读的 MCP 服务器");
        }
        if (confirmTools && !server.config.trustedReadOnly) {
          const allowed = await ctx.ui.confirm("允许读取 MCP 资源列表？", server.config.name || server.config.id);
          if (!allowed) throw new Error("用户拒绝了 MCP 资源读取");
        }
        onUpdate?.({ content: [{ type: "text", text: `正在读取 ${server.config.name || server.config.id} 的资源列表…` }] });
        const resources = await server.client.listResources();
        return { content: [{ type: "text", text: resourceListMarkdown(server, resources) }], details: { serverId: server.config.id, resources } };
      },
    });

    pi.registerTool({
      name: "mcp_read_resource",
      label: "读取 MCP 资源",
      description: "Read a resource URI from a connected MCP server.",
      promptSnippet: "Read a specific resource exposed by a configured MCP server",
      parameters: Type.Object({
        serverId: Type.Optional(Type.String({ description: "MCP server ID; optional when exactly one server supports resources" })),
        uri: Type.String({ description: "Exact URI returned by mcp_list_resources" }),
      }),
      async execute(_toolCallId, params, _signal, onUpdate, ctx) {
        const server = resolveServer(params.serverId, resourceServers, "资源");
        if (permissionMode === "read-only" && !server.config.trustedReadOnly) {
          throw new Error("只读模式只允许读取已标记为受信任只读的 MCP 服务器");
        }
        if (confirmTools && !server.config.trustedReadOnly) {
          const allowed = await ctx.ui.confirm("允许读取 MCP 资源？", `${server.config.name || server.config.id}\n${params.uri}`);
          if (!allowed) throw new Error("用户拒绝了 MCP 资源读取");
        }
        onUpdate?.({ content: [{ type: "text", text: `正在读取 MCP 资源 ${params.uri}…` }] });
        const result = await server.client.readResource(params.uri);
        return { content: resourceContent(result), details: { serverId: server.config.id, uri: params.uri } };
      },
    });

    if (subscribableResourceServers.length) {
      pi.registerTool({
        name: "mcp_subscribe_resource",
        label: "订阅 MCP 资源",
        description: "Subscribe to updates for a resource URI on an MCP server that advertises subscription support.",
        promptSnippet: "Subscribe to a live MCP resource only when ongoing updates are useful",
        parameters: Type.Object({
          serverId: Type.Optional(Type.String({ description: "MCP server ID; optional when exactly one server supports subscriptions" })),
          uri: Type.String({ description: "Exact resource URI to subscribe to" }),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const server = resolveServer(params.serverId, subscribableResourceServers, "资源订阅");
          if (permissionMode === "read-only" && !server.config.trustedReadOnly) {
            throw new Error("只读模式只允许订阅已标记为受信任只读的 MCP 服务器");
          }
          if (confirmTools && !server.config.trustedReadOnly) {
            const allowed = await ctx.ui.confirm("允许订阅 MCP 资源？", `${server.config.name || server.config.id}\n${params.uri}`);
            if (!allowed) throw new Error("用户拒绝了 MCP 资源订阅");
          }
          await server.client.subscribeResource(params.uri);
          const subscriptions = subscribedResources.get(server.config.id) || new Set<string>();
          subscriptions.add(params.uri);
          subscribedResources.set(server.config.id, subscriptions);
          return {
            content: [{ type: "text", text: `已订阅 MCP 资源：${server.config.name || server.config.id}\n${params.uri}` }],
            details: { serverId: server.config.id, uri: params.uri, subscribed: true },
          };
        },
      });

      pi.registerTool({
        name: "mcp_unsubscribe_resource",
        label: "取消订阅 MCP 资源",
        description: "Stop live updates for a previously subscribed MCP resource URI.",
        promptSnippet: "Unsubscribe from an MCP resource when live updates are no longer needed",
        parameters: Type.Object({
          serverId: Type.Optional(Type.String({ description: "MCP server ID; optional when exactly one server supports subscriptions" })),
          uri: Type.String({ description: "Exact subscribed resource URI" }),
        }),
        async execute(_toolCallId, params) {
          const server = resolveServer(params.serverId, subscribableResourceServers, "资源订阅");
          const subscriptions = subscribedResources.get(server.config.id);
          if (!subscriptions?.has(params.uri)) {
            return { content: [{ type: "text", text: `该资源当前未订阅：${params.uri}` }], details: { serverId: server.config.id, uri: params.uri, subscribed: false } };
          }
          await server.client.unsubscribeResource(params.uri);
          subscriptions.delete(params.uri);
          if (!subscriptions.size) subscribedResources.delete(server.config.id);
          return {
            content: [{ type: "text", text: `已取消订阅 MCP 资源：${server.config.name || server.config.id}\n${params.uri}` }],
            details: { serverId: server.config.id, uri: params.uri, subscribed: false },
          };
        },
      });
    }
  }

  if (promptServers.length) {
    pi.registerTool({
      name: "mcp_list_prompts",
      label: "MCP 提示词列表",
      description: "List prompt templates advertised by a connected MCP server.",
      promptSnippet: "List reusable prompt templates exposed by a configured MCP server",
      parameters: Type.Object({
        serverId: Type.Optional(Type.String({ description: "MCP server ID; optional when exactly one server supports prompts" })),
      }),
      async execute(_toolCallId, params, _signal, onUpdate, ctx) {
        const server = resolveServer(params.serverId, promptServers, "提示词");
        if (permissionMode === "read-only" && !server.config.trustedReadOnly) {
          throw new Error("只读模式只允许访问已标记为受信任只读的 MCP 服务器");
        }
        if (confirmTools && !server.config.trustedReadOnly) {
          const allowed = await ctx.ui.confirm("允许读取 MCP 提示词列表？", server.config.name || server.config.id);
          if (!allowed) throw new Error("用户拒绝了 MCP 提示词读取");
        }
        onUpdate?.({ content: [{ type: "text", text: `正在读取 ${server.config.name || server.config.id} 的提示词…` }] });
        const prompts = await server.client.listPrompts();
        return { content: [{ type: "text", text: promptListMarkdown(server, prompts) }], details: { serverId: server.config.id, prompts } };
      },
    });

    pi.registerTool({
      name: "mcp_get_prompt",
      label: "读取 MCP 提示词",
      description: "Resolve a prompt template from a connected MCP server with string arguments.",
      promptSnippet: "Resolve a reusable MCP prompt template before following it",
      parameters: Type.Object({
        serverId: Type.Optional(Type.String({ description: "MCP server ID; optional when exactly one server supports prompts" })),
        name: Type.String({ description: "Prompt name returned by mcp_list_prompts" }),
        arguments: Type.Optional(Type.Record(Type.String(), Type.String())),
      }),
      async execute(_toolCallId, params, _signal, onUpdate, ctx) {
        const server = resolveServer(params.serverId, promptServers, "提示词");
        if (permissionMode === "read-only" && !server.config.trustedReadOnly) {
          throw new Error("只读模式只允许访问已标记为受信任只读的 MCP 服务器");
        }
        if (confirmTools && !server.config.trustedReadOnly) {
          const allowed = await ctx.ui.confirm("允许读取 MCP 提示词？", `${server.config.name || server.config.id}\n${params.name}`);
          if (!allowed) throw new Error("用户拒绝了 MCP 提示词读取");
        }
        onUpdate?.({ content: [{ type: "text", text: `正在读取 MCP 提示词 ${params.name}…` }] });
        const result = await server.client.getPrompt(params.name, params.arguments || {});
        return { content: [{ type: "text", text: promptResultMarkdown(server, params.name, result) }], details: { serverId: server.config.id, name: params.name } };
      },
    });
  }

  const summary = () => {
    const healthy = statuses.filter((status) => status.connected).length;
    const tools = statuses.reduce((total, status) => total + status.toolCount, 0);
    const resources = statuses.filter((status) => status.hasResources).length;
    const prompts = statuses.filter((status) => status.hasPrompts).length;
    const failed = statuses.length - healthy;
    const extras = [resources ? `${resources} 资源服务` : "", prompts ? `${prompts} 提示词服务` : ""].filter(Boolean).join(" · ");
    if (!configured.length && statuses.length) return `MCP 配置错误 · ${statuses[0].error || "无法读取服务器配置"}`;
    return configured.length ? `MCP ${healthy}/${configured.length} · ${tools} 工具${extras ? ` · ${extras}` : ""}${failed ? ` · ${failed} 失败` : ""}` : "MCP 未配置";
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
        ? `✓ ${status.config.name || status.config.id} · ${status.config.transport} · ${status.protocolVersion} · ${status.toolCount} 个工具${status.hasResources ? " · resources" : ""}${status.hasPrompts ? " · prompts" : ""}`
        : `✗ ${status.config.name || status.config.id} · ${status.error}`);
      ctx.ui.notify(lines.join("\n"), statuses.some((status) => !status.connected) ? "warning" : "info");
    },
  });

  pi.registerCommand("mcp-resources", {
    description: "列出 MCP 服务器公开的只读资源，可选参数为 serverId",
    handler: async (args, ctx) => {
      try {
        const server = resolveServer(args.trim() || undefined, resourceServers, "资源");
        const resources = await server.client.listResources();
        pi.sendMessage({
          customType: "pidesktop-mcp-resources",
          content: resourceListMarkdown(server, resources),
          display: true,
          details: { serverId: server.config.id, resources },
        }, { triggerTurn: false });
      } catch (error) {
        ctx.ui.notify(`MCP 资源读取失败：${errorText(error)}`, "error");
      }
    },
  });

  pi.registerCommand("mcp-read", {
    description: "读取 MCP 资源：/mcp-read <serverId> <uri>",
    handler: async (args, ctx) => {
      const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
      if (!match) {
        ctx.ui.notify("用法：/mcp-read <serverId> <uri>", "warning");
        return;
      }
      try {
        const server = resolveServer(match[1], resourceServers, "资源");
        const result = await server.client.readResource(match[2].trim());
        pi.sendMessage({
          customType: "pidesktop-mcp-resource",
          content: resourceContent(result),
          display: true,
          details: { serverId: server.config.id, uri: match[2].trim() },
        }, { triggerTurn: false });
      } catch (error) {
        ctx.ui.notify(`MCP 资源读取失败：${errorText(error)}`, "error");
      }
    },
  });

  pi.registerCommand("mcp-subscribe", {
    description: "订阅 MCP 资源更新：/mcp-subscribe <serverId> <uri>",
    handler: async (args, ctx) => {
      const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
      if (!match) {
        ctx.ui.notify("用法：/mcp-subscribe <serverId> <uri>", "warning");
        return;
      }
      try {
        const server = resolveServer(match[1], subscribableResourceServers, "资源订阅");
        const uri = match[2].trim();
        await server.client.subscribeResource(uri);
        const subscriptions = subscribedResources.get(server.config.id) || new Set<string>();
        subscriptions.add(uri);
        subscribedResources.set(server.config.id, subscriptions);
        ctx.ui.notify(`已订阅 MCP 资源：${server.config.name || server.config.id}\n${uri}`, "info");
      } catch (error) {
        ctx.ui.notify(`MCP 资源订阅失败：${errorText(error)}`, "error");
      }
    },
  });

  pi.registerCommand("mcp-unsubscribe", {
    description: "取消 MCP 资源订阅：/mcp-unsubscribe <serverId> <uri>",
    handler: async (args, ctx) => {
      const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
      if (!match) {
        ctx.ui.notify("用法：/mcp-unsubscribe <serverId> <uri>", "warning");
        return;
      }
      try {
        const server = resolveServer(match[1], subscribableResourceServers, "资源订阅");
        const uri = match[2].trim();
        if (subscribedResources.get(server.config.id)?.has(uri)) {
          await server.client.unsubscribeResource(uri);
          subscribedResources.get(server.config.id)?.delete(uri);
        }
        ctx.ui.notify(`已取消 MCP 资源订阅：${server.config.name || server.config.id}\n${uri}`, "info");
      } catch (error) {
        ctx.ui.notify(`取消 MCP 资源订阅失败：${errorText(error)}`, "error");
      }
    },
  });

  pi.registerCommand("mcp-prompts", {
    description: "列出 MCP 服务器公开的提示词模板，可选参数为 serverId",
    handler: async (args, ctx) => {
      try {
        const server = resolveServer(args.trim() || undefined, promptServers, "提示词");
        const prompts = await server.client.listPrompts();
        pi.sendMessage({
          customType: "pidesktop-mcp-prompts",
          content: promptListMarkdown(server, prompts),
          display: true,
          details: { serverId: server.config.id, prompts },
        }, { triggerTurn: false });
      } catch (error) {
        ctx.ui.notify(`MCP 提示词读取失败：${errorText(error)}`, "error");
      }
    },
  });
}
