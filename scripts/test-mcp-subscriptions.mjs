import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = process.cwd();
const extension = path.join(root, "src-tauri", "resources", "pidesktop-mcp.ts");
const server = path.join(root, "scripts", "fixtures", "fake-mcp-subscription-server.mjs");
const piCli = process.env.PIDESKTOP_PI_CLI
  || path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const config = [{
  id: "fixture",
  name: "Subscription fixture",
  enabled: true,
  transport: "stdio",
  command: process.execPath,
  args: [server],
  cwd: root,
  env: {},
  inheritEnvironment: false,
  url: "",
  headers: {},
  trustedReadOnly: true,
}];

const child = spawn(process.execPath, [piCli, "--offline", "--approve", "--mode", "rpc", "--no-extensions", "-e", extension, "--no-session"], {
  cwd: root,
  env: {
    ...process.env,
    PIDESKTOP_MCP_CONFIG_B64: Buffer.from(JSON.stringify(config)).toString("base64"),
    PIDESKTOP_MCP_CONFIRM: "0",
    PIDESKTOP_PERMISSION_MODE: "read-only",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
const events = [];
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
  while (true) {
    const newline = stdout.indexOf("\n");
    if (newline < 0) break;
    const line = stdout.slice(0, newline).trim();
    stdout = stdout.slice(newline + 1);
    if (line) events.push(JSON.parse(line));
  }
});

function waitFor(predicate, label, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const match = events.find(predicate);
      if (match) {
        clearInterval(timer);
        resolve(match);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${label}. stderr: ${stderr.slice(-2000)}`));
      }
    }, 25);
  });
}

function command(id, type, payload = {}) {
  child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
}

try {
  command("commands", "get_commands");
  const commandResponse = await waitFor((event) => event.type === "response" && event.id === "commands", "command list");
  const names = commandResponse.data.commands.map((item) => item.name);
  assert(names.includes("mcp-subscribe"));
  assert(names.includes("mcp-unsubscribe"));

  command("subscribe", "prompt", { message: "/mcp-subscribe fixture fixture://live-resource" });
  await waitFor((event) => event.type === "response" && event.id === "subscribe" && event.success, "subscribe response");
  const update = await waitFor(
    (event) => event.type === "message_start" && JSON.stringify(event).includes("fixture-version-2"),
    "resource update notification",
  );
  assert(JSON.stringify(update).includes("pidesktop-mcp-resource-update"));

  command("unsubscribe", "prompt", { message: "/mcp-unsubscribe fixture fixture://live-resource" });
  await waitFor((event) => event.type === "response" && event.id === "unsubscribe" && event.success, "unsubscribe response");
  console.log("mcp subscriptions: RPC end-to-end assertions passed");
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 500).unref();
}
