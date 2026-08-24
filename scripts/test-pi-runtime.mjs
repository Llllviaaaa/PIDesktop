import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const runtimeDir = join(repoRoot, "src-tauri", "resources", "pi-runtime");
const executable = join(runtimeDir, "pi.exe");
const manifest = JSON.parse(readFileSync(join(runtimeDir, "runtime-manifest.json"), "utf8"));
const piPackage = JSON.parse(readFileSync(join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"));

assert.equal(manifest.piVersion, piPackage.version, "bundled Pi version must match the locked npm package");
assert.equal(manifest.platform, "win32", "bundled Pi runtime must target Windows");
assert.equal(manifest.arch, "x64", "bundled Pi runtime must target x64");
for (const relativePath of [
  "pi.exe",
  "package.json",
  "theme/dark.json",
  "theme/light.json",
  "export-html/template.html",
  "photon_rs_bg.wasm",
  "THIRD_PARTY_NOTICES.md",
  "runtime-licenses.json",
]) {
  assert.ok(existsSync(join(runtimeDir, relativePath)), `bundled Pi runtime is missing ${relativePath}`);
}

const version = spawnSync(executable, ["--version"], { encoding: "utf8" });
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), manifest.piVersion);

const agentDir = mkdtempSync(join(tmpdir(), "pidesktop-pi-runtime-test-"));
try {
  const extension = join(repoRoot, "src-tauri", "resources", "pidesktop-guard.ts");
  const rpc = spawnSync(executable, ["--mode", "rpc", "--no-session", "--extension", extension], {
    cwd: repoRoot,
    encoding: "utf8",
    input: '{"id":"extension-probe","type":"get_state"}\n',
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(rpc.status, 0, rpc.stderr);
  const response = rpc.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((message) => message.id === "extension-probe");
  assert.equal(response?.success, true, "bundled Pi must start RPC and load Pi Desktop extensions");
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}

console.log(`pi-runtime: Pi ${manifest.piVersion} RPC and extension loading passed`);
