import readline from "node:readline";

const uri = "fixture://live-resource";
let version = 1;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "notifications/initialized") return;
  if (message.id === undefined) return;

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { resources: { subscribe: true, listChanged: true } },
        serverInfo: { name: "Pi Desktop subscription fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "resources/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { resources: [{ uri, name: "Live fixture" }] } });
    return;
  }
  if (message.method === "resources/read") {
    send({ jsonrpc: "2.0", id: message.id, result: { contents: [{ uri, mimeType: "text/plain", text: `fixture-version-${version}` }] } });
    return;
  }
  if (message.method === "resources/subscribe") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setTimeout(() => {
      version += 1;
      send({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } });
    }, 120);
    return;
  }
  if (message.method === "resources/unsubscribe") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported method: ${message.method}` } });
});
