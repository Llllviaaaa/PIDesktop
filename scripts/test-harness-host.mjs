// Smoke test of the compiled Harness Host (scripts/prepare-harness-host.mjs):
// start pid-harness.exe the way the desktop app does, read its port line, then
// check the RPC gateway (token, initialize, host.info) and a better-sidebar
// route, and that it exits once its stdin closes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";

const repoRoot = resolve(import.meta.dirname, "..");
const executable = join(repoRoot, "src-tauri", "resources", "harness", "pid-harness.exe");
const appVersion = (await import("../package.json", { with: { type: "json" } })).default.version;
const pageOrigin = "http://tauri.localhost";
const token = randomBytes(32).toString("base64url");
const dataDir = mkdtempSync(join(tmpdir(), "pidesktop-harness-test-"));

const child = spawn(executable, ["--data-dir", dataDir, "--port", "0", "--page-origin", pageOrigin, "--exit-with-stdin"], {
  env: { ...process.env, PID_HARNESS_TOKEN: token },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`no port line within 20s\n${stderr}`)), 20_000);
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolvePort(JSON.parse(buffered.slice(0, newline)).port);
    });
    child.once("exit", (code) => reject(new Error(`host exited with ${code} before listening\n${stderr}`)));
  });
  assert.ok(Number.isInteger(port) && port > 0, "host must report its port");

  const refused = new WebSocket(`ws://127.0.0.1:${port}/rpc`, ["pid.v1", `pid.token.${randomBytes(32).toString("base64url")}`]);
  const [, response] = await once(refused, "unexpected-response");
  assert.equal(response.statusCode, 401, "a wrong token must be refused");

  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, ["pid.v1", `pid.token.${token}`], { origin: pageOrigin });
  await once(socket, "open");
  const replies = new Map();
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    replies.get(message.id)?.(message);
  });
  const call = (id, method, params) => new Promise((done) => {
    replies.set(id, done);
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  const init = await call(1, "initialize", { protocolVersion: "1.0", client: { name: "smoke", version: "1" } });
  assert.equal(init.result?.host?.version, appVersion, "the bundle must carry the app version");
  const info = await call(2, "host.info", {});
  assert.equal(info.result?.protocolVersion, "1.0");
  socket.close();

  const sidebar = await fetch(`http://127.0.0.1:${port}/sidebar/api/settings.get`, {
    method: "POST",
    headers: { origin: pageOrigin, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(sidebar.status, 200, "better-sidebar must answer inside the host");

  const exited = once(child, "exit");
  child.stdin.end();
  const [code] = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("host did not exit after stdin closed")), 10_000))]);
  assert.equal(code, 0, `host must exit cleanly when stdin closes\n${stderr}`);
} finally {
  if (child.exitCode === null) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`harness-host: pid-harness ${appVersion} RPC, better-sidebar and stdin shutdown passed`);
