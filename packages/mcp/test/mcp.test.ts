import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it } from "vitest";
import { Sessions } from "@pid/session";
import { Tools, type ToolOutput } from "@pid/tools";
import { Ui } from "@pid/ui";
import { Mcp, type Config, type McpServerConfig } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fake-server.mjs", import.meta.url));
let ctx: Context | undefined;

afterEach(async () => {
  await ctx?.fiber.dispose();
  ctx = undefined;
});

const server = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: "fixture", name: "Fixture", enabled: true, transport: "stdio", command: process.execPath, args: [fixture],
  cwd: "", env: {}, inheritEnvironment: false, url: "", headers: {}, trustedReadOnly: false, ...overrides,
});

async function setup(config: Config, options: { answer?: boolean; mode?: string } = {}) {
  ctx = new Context();
  await ctx.plugin(Sessions);
  await ctx.plugin(Ui);
  await ctx.plugin(Tools);
  const mode = options.mode;
  if (mode !== undefined) ctx.provide("permissions", { modes: () => ({ effective: mode }) });
  const asked: string[] = [];
  const notes: string[] = [];
  const answer = options.answer;
  const local = ctx;
  if (answer !== undefined) {
    local.ui.attach({
      request: ({ requestId, request }) => {
        asked.push(request.kind === "confirm" ? request.title : request.kind);
        queueMicrotask(() => local.ui.respond(requestId, answer));
      },
      cancel: () => {},
      notify: (_session, message) => void notes.push(message),
    });
  }
  await local.plugin(Mcp, config);
  await local.mcp.ready;
  const session = local.sessions.create({ cwd: "." });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolOutput> =>
    local.tools.execute({ id: "1", name, args }, { sessionId: session.id, cwd: ".", signal: new AbortController().signal });
  const text = (output: ToolOutput) => output.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  return { ctx: local, call, text, asked, notes };
}

describe("MCP plugin", () => {
  it("registers remote tools and calls them after confirmation", async () => {
    const { ctx: c, call, text, asked } = await setup({ servers: [server()] }, { answer: true });
    expect(c.tools.schemas().map((schema) => schema.name)).toEqual([
      "mcp__fixture__echo", "mcp__fixture__fail", "mcp_get_prompt", "mcp_list_prompts", "mcp_list_resources",
      "mcp_read_resource", "mcp_subscribe_resource", "mcp_unsubscribe_resource",
    ]);
    expect(text(await call("mcp__fixture__echo", { text: "hi" }))).toBe("echo: hi");
    expect(asked).toEqual(["允许 MCP 工具？Fixture"]);
    const failed = await call("mcp__fixture__fail");
    expect([failed.isError, text(failed)]).toEqual([true, "it broke"]);
    expect(c.mcp.statuses()).toMatchObject([{ connected: true, toolCount: 2, protocolVersion: "2025-11-25", hasResources: true, hasPrompts: true }]);
  });

  it("refuses when the user says no or nobody can answer", async () => {
    const declined = await setup({ servers: [server()] }, { answer: false });
    expect(declined.text(await declined.call("mcp__fixture__echo", { text: "hi" }))).toBe("用户拒绝了 MCP 工具调用");
    await ctx?.fiber.dispose();
    const headless = await setup({ servers: [server()] });
    expect(headless.text(await headless.call("mcp_list_resources"))).toBe("用户拒绝了 MCP 资源读取");
  });

  it("reads resources and prompts, and reports subscribed updates", async () => {
    const { call, text, notes } = await setup({ servers: [server()], confirmTools: false }, { answer: true });
    expect(text(await call("mcp_list_resources"))).toContain("URI: `fixture://note`");
    expect(text(await call("mcp_read_resource", { uri: "fixture://note" }))).toBe("资源：fixture://note\n\nnote v1");
    expect(text(await call("mcp_get_prompt", { name: "review", arguments: { path: "a.ts" } }))).toContain("Review a.ts");
    await call("mcp_subscribe_resource", { uri: "fixture://note" });
    await expect.poll(() => notes).toEqual(["MCP 资源已更新 · Fixture\nfixture://note"]);
    expect(text(await call("mcp_unsubscribe_resource", { uri: "fixture://note" }))).toContain("已取消订阅");
  });

  it("keeps read-only sessions to trusted servers", async () => {
    const untrusted = await setup({ servers: [server()] }, { answer: true, mode: "read-only" });
    expect(untrusted.text(await untrusted.call("mcp_list_resources"))).toBe("只读模式只允许访问已标记为受信任只读的 MCP 服务器");
    await ctx?.fiber.dispose();
    const trusted = await setup({ servers: [server({ trustedReadOnly: true })] }, { answer: true, mode: "read-only" });
    expect(trusted.text(await trusted.call("mcp_list_resources"))).toContain("fixture://note");
    expect(trusted.asked).toEqual([]);
  });

  it("records servers that fail to start", async () => {
    const { ctx: c } = await setup({ servers: [server({ id: "broken", command: process.execPath, args: ["-e", "process.exit(3)"] }), server({ id: "off", enabled: false })] });
    expect(c.mcp.statuses()).toMatchObject([{ config: { id: "broken" }, connected: false }]);
    expect(c.tools.schemas()).toEqual([]);
  });
});
