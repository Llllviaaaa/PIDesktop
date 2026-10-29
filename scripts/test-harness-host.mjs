// Smoke test of the compiled Harness Host (scripts/prepare-harness-host.mjs):
// start pid-harness.exe the way the desktop app does, read its port line, then
// check the RPC gateway (token, initialize, host.info), sessions on disk, a
// better-sidebar route, that it exits once its stdin closes, and that a
// headless `run` without a model explains itself.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
writeFileSync(join(dataDir, "providers.json"), JSON.stringify({
  providers: [{ api: "openai-compat", id: "smoke", baseUrl: "http://127.0.0.1:9/v1", apiKey: { env: "PID_SMOKE_KEY" } }],
}));

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
  const providers = await call(3, "provider.list", {});
  assert.deepEqual(providers.result?.providers?.map((provider) => [provider.id, provider.api, provider.keySource]), [
    ["smoke", "openai-compat", "environment variable PID_SMOKE_KEY"],
  ], "the bundled LLM adapters must load the providers file");
  const created = await call(4, "session.create", { cwd: dataDir, model: { provider: "smoke", model: "m" } });
  const sessionId = created.result?.session?.id;
  assert.equal(typeof sessionId, "string", `session.create must answer a session
${JSON.stringify(created)}`);
  const listed = await call(5, "session.list", {});
  assert.deepEqual(listed.result?.sessions?.map((session) => session.id), [sessionId], "session.list must find the new session");
  assert.ok(existsSync(join(dataDir, "sessions", created.result.session.createdAt.slice(0, 7), `${sessionId}.jsonl`)), "the session must be on disk");
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

  const headless = spawnSync(executable, ["run", "--data-dir", dataDir, "--cwd", dataDir, "hello"], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  assert.equal(headless.status, 2, `a headless run without a model must exit 2
${headless.stderr}`);
  assert.match(headless.stderr, /no model/);
} finally {
  if (child.exitCode === null) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`harness-host: pid-harness ${appVersion} RPC, providers, sessions, better-sidebar, stdin shutdown and headless run passed`);
