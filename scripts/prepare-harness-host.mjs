// Build the Harness Host (packages/host, ADR 0001) into one executable, the way
// prepare-pi-runtime.mjs builds pi.exe: esbuild bundles it, then Bun compiles
// the bundle. better-sidebar's host half (src/better-sidebar) is bundled in as
// one of the host's plugins, with the DSH host packages it imports mapped to
// packages/host/src/better-sidebar/shims, as dsh-aliases.ts maps them for vitest.
// `--bundle-only` stops after the bundle, which
// `node <bundle> --data-dir <dir> --port 47100 --page-origin http://localhost:1420`
// runs for browser-only development.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostDir = join(repoRoot, "packages", "host");
const shimDir = join(hostDir, "src", "better-sidebar", "shims");
const bundleDir = join(repoRoot, "node_modules", ".cache", "pidesktop-harness-host");
const bundleFile = join(bundleDir, "host.mjs");
const outputDir = join(repoRoot, "src-tauri", "resources", "harness");
const executable = join(outputDir, "pid-harness.exe");
const manifestFile = join(outputDir, "build-manifest.json");
const bunExecutable = join(repoRoot, "node_modules", "bun", "bin", "bun.exe");
const bundleOnly = process.argv.includes("--bundle-only");
const appVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

const shims = Object.fromEntries(
  readdirSync(shimDir)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => [`@deepseek-ai/${file.slice(0, -".ts".length)}`, join(shimDir, file)]),
);

await build({
  entryPoints: [join(hostDir, "src", "bin.ts")],
  outfile: bundleFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  tsconfig: join(hostDir, "tsconfig.build.json"),
  alias: {
    ...shims,
    "dsh-better-sidebar": join(repoRoot, "src", "better-sidebar"),
  },
  define: { PID_HOST_VERSION: JSON.stringify(appVersion) },
  // ws loads these optional accelerators inside try/catch.
  external: ["bufferutil", "utf-8-validate"],
  // CommonJS dependencies bundled into ESM still call require() for Node built-ins.
  banner: { js: "import { createRequire as __pidCreateRequire } from 'node:module'; const require = __pidCreateRequire(import.meta.url);" },
  legalComments: "eof",
  logLevel: "warning",
});
console.log(`Bundled Harness Host: ${bundleFile}`);
if (bundleOnly) process.exit(0);

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`Pi Desktop currently builds a Windows x64 Harness Host, not ${process.platform}/${process.arch}`);
}
if (!existsSync(bunExecutable)) throw new Error(`Bun compiler is missing: ${bunExecutable}`);

const bunVersion = JSON.parse(readFileSync(join(repoRoot, "node_modules", "bun", "package.json"), "utf8")).version;
const buildKey = createHash("sha256").update(readFileSync(bundleFile)).update(bunVersion).digest("hex");
if (existsSync(executable) && existsSync(manifestFile)) {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (manifest.buildKey === buildKey) {
    console.log("Harness Host is ready (cached).");
    process.exit(0);
  }
}

mkdirSync(outputDir, { recursive: true });
// Bun appends `.exe` to an outfile without it, so the staging name keeps the extension.
const staging = join(outputDir, "pid-harness.staging.exe");
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
console.log(`Prepared Harness Host: ${executable}`);
