// Build better-sidebar's host half (src/better-sidebar/index.ts) with PIDesktop's
// sidecar entry into one executable, the way prepare-pi-runtime.mjs builds pi.exe:
// esbuild bundles it (mapping the DSH runtime imports to sidecar/better-sidebar-host/shims),
// then Bun compiles the bundle. `--bundle-only` stops after the bundle, which
// `node <bundle> --data-dir <dir> --port <n> --page-origin http://localhost:1420`
// runs for browser-only development.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarDir = join(repoRoot, "sidecar", "better-sidebar-host");
const bundleDir = join(repoRoot, "node_modules", ".cache", "pidesktop-sidebar-host");
const bundleFile = join(bundleDir, "host.mjs");
const outputDir = join(repoRoot, "src-tauri", "resources", "sidebar-host");
const executable = join(outputDir, "better-sidebar-host.exe");
const manifestFile = join(outputDir, "build-manifest.json");
const bunExecutable = join(repoRoot, "node_modules", "bun", "bin", "bun.exe");
const bundleOnly = process.argv.includes("--bundle-only");

const shim = (name) => join(sidecarDir, "shims", `${name}.ts`);

await build({
  entryPoints: [join(sidecarDir, "main.ts")],
  outfile: bundleFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  tsconfig: join(sidecarDir, "tsconfig.build.json"),
  alias: {
    "@deepseek-ai/dsh-tools": shim("dsh-tools"),
    "@deepseek-ai/dsh-settings": shim("dsh-settings"),
    "@deepseek-ai/dsh-llm": shim("dsh-llm"),
    "@deepseek-ai/dsh-agent": shim("dsh-agent"),
    "@deepseek-ai/dsh-subagent": shim("dsh-subagent"),
  },
  // ws loads these optional accelerators inside try/catch.
  external: ["bufferutil", "utf-8-validate"],
  // CommonJS dependencies bundled into ESM still call require() for Node built-ins.
  banner: { js: "import { createRequire as __pidCreateRequire } from 'node:module'; const require = __pidCreateRequire(import.meta.url);" },
  legalComments: "eof",
  logLevel: "warning",
});
console.log(`Bundled better-sidebar host: ${bundleFile}`);
if (bundleOnly) process.exit(0);

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`Pi Desktop currently builds a Windows x64 sidebar host, not ${process.platform}/${process.arch}`);
}
if (!existsSync(bunExecutable)) throw new Error(`Bun compiler is missing: ${bunExecutable}`);

const bunVersion = JSON.parse(readFileSync(join(repoRoot, "node_modules", "bun", "package.json"), "utf8")).version;
const buildKey = createHash("sha256").update(readFileSync(bundleFile)).update(bunVersion).digest("hex");
if (existsSync(executable) && existsSync(manifestFile)) {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (manifest.buildKey === buildKey) {
    console.log("better-sidebar host is ready (cached).");
    process.exit(0);
  }
}

mkdirSync(outputDir, { recursive: true });
// Bun appends `.exe` to an outfile without it, so the staging name keeps the extension.
const staging = join(outputDir, "better-sidebar-host.staging.exe");
rmSync(staging, { force: true });
const result = spawnSync(bunExecutable, ["build", "--compile", bundleFile, "--outfile", staging], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`bun build --compile exited with ${result.status}`);
rmSync(executable, { force: true });
renameSync(staging, executable);
writeFileSync(manifestFile, `${JSON.stringify({ buildKey, compiler: "bun", compilerVersion: bunVersion }, null, 2)}\n`);
console.log(`Prepared better-sidebar host: ${executable}`);
