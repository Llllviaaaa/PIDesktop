// A stdio MCP server for the plugin tests: one tool (echo), one resource that
// changes after a subscription, and one prompt.
import process from "node:process";
import readline from "node:readline";
import { setTimeout } from "node:timers";

const uri = "fixture://note";
let version = 1;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      return reply(message.id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {}, resources: { subscribe: true }, prompts: {} },
        serverInfo: { name: "fixture", version: "1.0.0" },
      });
    case "tools/list":
      return reply(message.id, {
        tools: [
          { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
          { name: "fail", description: "Always fails", inputSchema: { type: "object" } },
        ],
      });
    case "tools/call":
      if (message.params.name === "fail") return reply(message.id, { content: [{ type: "text", text: "it broke" }], isError: true });
      return reply(message.id, { content: [{ type: "text", text: `echo: ${message.params.arguments.text}` }] });
    case "resources/list":
      return reply(message.id, { resources: [{ uri, name: "Note", mimeType: "text/plain" }] });
    case "resources/read":
      return reply(message.id, { contents: [{ uri, mimeType: "text/plain", text: `note v${version}` }] });
    case "resources/subscribe":
      reply(message.id, {});
      setTimeout(() => {
        version += 1;
        send({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } });
      }, 50);
      return;
    case "resources/unsubscribe":
      return reply(message.id, {});
    case "prompts/list":
      return reply(message.id, { prompts: [{ name: "review", description: "Review code", arguments: [{ name: "path", required: true }] }] });
    case "prompts/get":
      return reply(message.id, { messages: [{ role: "user", content: { type: "text", text: `Review ${message.params.arguments.path}` } }] });
    default:
      return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported: ${message.method}` } });
  }
});
