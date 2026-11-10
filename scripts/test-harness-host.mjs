// Smoke test of the compiled Harness Host (scripts/prepare-harness-host.mjs):
// start qianji-harness.exe the way the desktop app does, read its port line, then
// check the RPC gateway (token, initialize, host.info), a provider key it
// decrypts itself from a DPAPI-protected secrets.dat (Bun FFI), sessions on
// disk, settings sent as a `{"desktop": …}` stdin line taking effect without
// a restart, workbench.open RPC, that it exits once its stdin closes, and
// that a headless `run` without a model explains itself.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import WebSocket from "ws";

const repoRoot = resolve(import.meta.dirname, "..");
const executable = join(repoRoot, "src-tauri", "resources", "harness", "qianji-harness.exe");
const appVersion = (await import("../package.json", { with: { type: "json" } })).default.version;
const pageOrigin = "http://tauri.localhost";
const token = randomBytes(32).toString("base64url");
const dataDir = mkdtempSync(join(tmpdir(), "qianji-harness-test-"));

// A provider that records the key it is called with.
let seenAuthorization = "";
const provider = createServer((request, response) => {
  seenAuthorization = request.headers.authorization ?? "";
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ data: [{ id: "smoke-model" }] }));
});
await new Promise((resolveListen) => provider.listen(0, "127.0.0.1", resolveListen));
const providerPort = provider.address().port;
writeFileSync(join(dataDir, "providers.json"), JSON.stringify({
  providers: [{ api: "openai-compat", id: "smoke", baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: { secret: "provider/smoke" } }],
}));
// The key, encrypted for this user the way the desktop's Rust secret_store
// writes it (CryptProtectData, no entropy).
const protect = `Add-Type -AssemblyName System.Security; $bytes = [Text.Encoding]::UTF8.GetBytes('{"provider/smoke":"sk-smoke"}'); [IO.File]::WriteAllBytes('${join(dataDir, "secrets.dat")}', [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser'))`;
const protectedKey = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(protect, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true });
assert.equal(protectedKey.status, 0, `could not write the DPAPI fixture
${protectedKey.stderr}`);

const child = spawn(executable, ["--data-dir", dataDir, "--port", "0", "--page-origin", pageOrigin, "--exit-with-stdin"], {
  env: { ...process.env, QIANJI_HARNESS_TOKEN: token },
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

  const refused = new WebSocket(`ws://127.0.0.1:${port}/rpc`, ["qianji.v1", `qianji.token.${randomBytes(32).toString("base64url")}`]);
  const [, response] = await once(refused, "unexpected-response");
  assert.equal(response.statusCode, 401, "a wrong token must be refused");

  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`, ["qianji.v1", `qianji.token.${token}`], { origin: pageOrigin });
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
    ["smoke", "openai-compat", "secret store"],
  ], "the bundled LLM adapters must load the providers file");
  const models = await call(30, "model.list", { provider: "smoke" });
  assert.deepEqual(models.result?.models, [{ id: "smoke-model" }], `model.list must reach the provider
${JSON.stringify(models)}`);
  assert.equal(seenAuthorization, "Bearer sk-smoke", "the host must decrypt the DPAPI-protected key itself");
  const created = await call(4, "session.create", { cwd: dataDir, model: { provider: "smoke", model: "m" } });
  const sessionId = created.result?.session?.id;
  assert.equal(typeof sessionId, "string", `session.create must answer a session
${JSON.stringify(created)}`);
  const listed = await call(5, "session.list", {});
  assert.deepEqual(listed.result?.sessions?.map((session) => session.id), [sessionId], "session.list must find the new session");
  assert.ok(existsSync(join(dataDir, "sessions", created.result.session.createdAt.slice(0, 7), `${sessionId}.jsonl`)), "the session must be on disk");

  // Settings from the desktop, on stdin, apply without a restart.
  assert.equal((await call(6, "permission.get", { sessionId })).result?.permission, "ask");
  child.stdin.write(`${JSON.stringify({ desktop: { settings: { permissionMode: "read-only", mcpEnabled: false }, configDir: dataDir } })}
`);
  let permission = "";
  for (let attempt = 0; attempt < 50 && permission !== "read-only"; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    permission = (await call(100 + attempt, "permission.get", { sessionId })).result?.permission ?? "";
  }
  assert.equal(permission, "read-only", `desktop settings must reload the permissions plugin
${stderr}`);
  assert.ok(existsSync(join(dataDir, "harness.json")), "desktop settings must be written to harness.json");

  // Dynamic external full-stack (.ts + .tsx) plugin inside the compiled Bun binary (ADR 0016).
  const extPluginDir = join(dataDir, "smoke-ext-src");
  mkdirSync(extPluginDir, { recursive: true });
  writeFileSync(join(extPluginDir, "package.json"), JSON.stringify({
    name: "smoke-ext",
    version: "0.1.0",
    qianji: { id: "smoke-ext", name: "Smoke Ext", host: "./index.ts", client: "./client.tsx" },
  }));
  writeFileSync(join(extPluginDir, "index.ts"), `
    import { Context } from "@deepseek-ai/cordis";
    import { textOutput } from "@qianji/tools";
    export const name = "smoke-ext";
    export const inject = ["tools"];
    export function apply(ctx: Context) {
      if (!(ctx instanceof Context)) throw new Error("duplicate Cordis instance");
      ctx.effect(() => ctx.tools.register({
        name: "smoke_ext_tool",
        description: "Smoke dynamic tool",
        parameters: { type: "object" },
        execute: () => textOutput("ok"),
      }), "smoke_ext_tool");
    }
  `);
  writeFileSync(join(extPluginDir, "client.tsx"), `
    import { useState } from "react";
    export function SmokePanel() {
      const [ready] = useState(true);
      return <div>{ready ? "smoke-client-ready" : ""}</div>;
    }
  `);
  const installedExt = await call(8, "plugin.install", { channel: "local", spec: extPluginDir, link: true });
  assert.equal(installedExt.result?.plugin?.status, "active", `qianji-harness.exe must load external .ts plugins via Bun.plugin\n${JSON.stringify(installedExt)}\n${stderr}`);
  const clientRes = await fetch(`http://127.0.0.1:${port}/plugins/smoke-ext/client.js`, { headers: { origin: pageOrigin } });
  assert.equal(clientRes.status, 200, "qianji-harness.exe must serve compiled .tsx client bundles");
  const clientJs = await clientRes.text();
  assert.match(clientJs, /window\.__ModuleLoader__\.load/);
  assert.match(clientJs, /smoke-client-ready/);

  // Re-sending desktop settings must preserve user plugins in plugins.json.
  child.stdin.write(`${JSON.stringify({ desktop: { settings: { permissionMode: "read-only", mcpEnabled: false }, configDir: dataDir } })}\n`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  const listedPlugins = await call(9, "plugin.list", {});
  assert.equal(listedPlugins.result?.plugins?.find((p) => p.id === "smoke-ext")?.status, "active", "desktop settings sync must not overwrite user plugins");

  // The Host logs to <data-dir>/logs and bundles those logs for a report.
  const bundle = join(dataDir, "diagnostics.zip");
  const exported = await call(7, "diagnostics.export", { path: bundle, desktop: { version: "smoke" } });
  const files = exported.result?.files ?? [];
  assert.ok(files.includes("about.json") && files.some((file) => /^logs\/host-\d{4}-\d{2}-\d{2}\.log$/.test(file)), `diagnostics must bundle the Host's log: ${JSON.stringify(exported)}`);
  assert.equal(readFileSync(bundle).readUInt32LE(0), 0x04034b50, "the diagnostics bundle must be a zip");
  const openedWorkbench = await call(10, "workbench.open", { target: "summary", cwd: dataDir });
  assert.deepEqual(openedWorkbench.result, { ok: true }, "native workbench RPC must answer inside the host");
  socket.close();

  const exited = once(child, "exit");
  child.stdin.end();
  const [code] = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("host did not exit after stdin closed")), 10_000))]);
  assert.equal(code, 0, `host must exit cleanly when stdin closes\n${stderr}`);

  const headless = spawnSync(executable, ["run", "--data-dir", dataDir, "--cwd", dataDir, "hello"], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  assert.equal(headless.status, 2, `a headless run without a model must exit 2
${headless.stderr}`);
  assert.match(headless.stderr, /no model/);
} finally {
  provider.close();
  if (child.exitCode === null) child.kill();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`harness-host: qianji-harness ${appVersion} RPC, DPAPI secrets, providers, sessions, desktop settings reload, log file and diagnostics, workbench RPC, stdin shutdown and headless run passed`);
