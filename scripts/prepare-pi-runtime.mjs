import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const tauriResources = join(repoRoot, "src-tauri", "resources");
const outputDir = join(tauriResources, "pi-runtime");
const piPackageDir = join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const bunPackageDir = join(repoRoot, "node_modules", "bun");
const bunBinaryPackageDir = join(repoRoot, "node_modules", "@oven", "bun-windows-x64");
const bunExecutable = join(bunPackageDir, "bin", "bun.exe");
const noticesPath = join(repoRoot, "THIRD_PARTY_NOTICES.md");
const buildFormatVersion = 1;

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`Pi Desktop currently prepares a Windows x64 Pi runtime, not ${process.platform}/${process.arch}`);
}

function assertInside(parent, target, label) {
  const pathFromParent = relative(parent, target);
  if (!pathFromParent || pathFromParent.startsWith("..") || isAbsolute(pathFromParent)) {
    throw new Error(`${label} must be a child of ${parent}: ${target}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function requireFile(path, label) {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${label} is missing: ${path}`);
  }
  return path;
}

function requireDirectory(path, label) {
  if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${label} is missing: ${path}`);
  }
  return path;
}

function hashFiles(paths) {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${basename(executable)} ${args.join(" ")} exited with ${result.status}\n${result.stdout || ""}${result.stderr || ""}`,
    );
  }
  return result;
}

function findInstalledPackage(packageName, fromPackageDir) {
  let cursor = fromPackageDir;
  while (true) {
    const candidate = join(cursor, "node_modules", ...packageName.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function collectRuntimeLicenses(rootPackages) {
  const queue = [...rootPackages];
  const seen = new Set();
  const packages = [];
  while (queue.length > 0) {
    const packageDir = queue.shift();
    const manifestPath = join(packageDir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    const key = `${manifest.name}@${manifest.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const licenseFiles = readdirSync(packageDir)
      .filter((name) => /^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(name))
      .filter((name) => statSync(join(packageDir, name)).isFile());
    packages.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license || "UNKNOWN",
      licenseFiles,
    });
    const dependencies = {
      ...(manifest.dependencies || {}),
      ...(manifest.optionalDependencies || {}),
    };
    for (const dependency of Object.keys(dependencies)) {
      const installed = findInstalledPackage(dependency, packageDir);
      if (installed) queue.push(installed);
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function copyRuntimeLicenses(packages, stagingDir) {
  const licensesDir = join(stagingDir, "licenses");
  mkdirSync(licensesDir, { recursive: true });
  for (const entry of packages) {
    if (entry.licenseFiles.length === 0) continue;
    const safeName = `${entry.name}@${entry.version}`.replaceAll(/[\\/:*?"<>|]/g, "_");
    const destination = join(licensesDir, safeName);
    mkdirSync(destination, { recursive: true });
    const packageDir = findPackageDirectory(entry.name, entry.version);
    if (!packageDir) continue;
    for (const licenseFile of entry.licenseFiles) {
      copyFileSync(join(packageDir, licenseFile), join(destination, licenseFile));
    }
  }
  writeFileSync(join(stagingDir, "runtime-licenses.json"), `${JSON.stringify(packages, null, 2)}\n`);
}

function findPackageDirectory(name, version) {
  const queue = [piPackageDir, bunPackageDir, bunBinaryPackageDir];
  const visited = new Set();
  while (queue.length > 0) {
    const packageDir = queue.shift();
    if (visited.has(packageDir) || !existsSync(join(packageDir, "package.json"))) continue;
    visited.add(packageDir);
    const manifest = readJson(join(packageDir, "package.json"));
    if (manifest.name === name && manifest.version === version) return packageDir;
    const dependencies = { ...(manifest.dependencies || {}), ...(manifest.optionalDependencies || {}) };
    for (const dependency of Object.keys(dependencies)) {
      const installed = findInstalledPackage(dependency, packageDir);
      if (installed) queue.push(installed);
    }
  }
  return null;
}

function copyRuntimeAssets(stagingDir) {
  for (const file of ["package.json", "README.md", "CHANGELOG.md"]) {
    copyFileSync(requireFile(join(piPackageDir, file), `Pi ${file}`), join(stagingDir, file));
  }
  cpSync(
    requireDirectory(join(piPackageDir, "dist", "modes", "interactive", "theme"), "Pi themes"),
    join(stagingDir, "theme"),
    { recursive: true },
  );
  cpSync(
    requireDirectory(join(piPackageDir, "dist", "modes", "interactive", "assets"), "Pi interactive assets"),
    join(stagingDir, "assets"),
    { recursive: true },
  );
  const exportDir = join(stagingDir, "export-html");
  mkdirSync(exportDir, { recursive: true });
  copyFileSync(
    requireFile(join(piPackageDir, "dist", "core", "export-html", "template.html"), "Pi HTML export template"),
    join(exportDir, "template.html"),
  );
  cpSync(
    requireDirectory(join(piPackageDir, "dist", "core", "export-html", "vendor"), "Pi HTML export vendor files"),
    join(exportDir, "vendor"),
    { recursive: true },
  );
  cpSync(requireDirectory(join(piPackageDir, "docs"), "Pi docs"), join(stagingDir, "docs"), { recursive: true });
  cpSync(requireDirectory(join(piPackageDir, "examples"), "Pi examples"), join(stagingDir, "examples"), { recursive: true });
  copyFileSync(
    requireFile(
      join(piPackageDir, "node_modules", "@silvia-odwyer", "photon-node", "photon_rs_bg.wasm"),
      "Photon image runtime",
    ),
    join(stagingDir, "photon_rs_bg.wasm"),
  );
  copyFileSync(requireFile(noticesPath, "third-party notices"), join(stagingDir, "THIRD_PARTY_NOTICES.md"));
}

function validateRuntime(runtimeDir, expectedVersion) {
  const executable = requireFile(join(runtimeDir, "pi.exe"), "bundled Pi executable");
  const version = run(executable, ["--version"]).stdout.trim();
  if (version !== expectedVersion) {
    throw new Error(`bundled Pi version mismatch: expected ${expectedVersion}, received ${version}`);
  }
  const validationAgentDir = mkdtempSync(join(tmpdir(), "pidesktop-pi-validation-"));
  try {
    const rpc = run(executable, ["--mode", "rpc", "--no-session"], {
      input: '{"id":"runtime-probe","type":"get_state"}\n',
      env: { ...process.env, PI_CODING_AGENT_DIR: validationAgentDir },
    });
    const response = rpc.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((message) => message.id === "runtime-probe");
    if (!response?.success) throw new Error("bundled Pi RPC validation did not return a successful response");
  } finally {
    rmSync(validationAgentDir, { recursive: true, force: true });
  }
}

function directorySize(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? directorySize(child) : statSync(child).size;
  }
  return total;
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function promoteRuntime(stagingDir, destinationDir) {
  rmSync(destinationDir, { recursive: true, force: true });
  for (const delay of [0, 250, 750, 1500]) {
    if (delay > 0) wait(delay);
    try {
      renameSync(stagingDir, destinationDir);
      return "renamed";
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    }
  }
  cpSync(stagingDir, destinationDir, { recursive: true });
  return "copied";
}

requireDirectory(piPackageDir, "Pi npm package");
requireDirectory(bunPackageDir, "Bun npm package");
requireDirectory(bunBinaryPackageDir, "Bun Windows binary package");
requireFile(bunExecutable, "Bun compiler");

const piManifest = readJson(join(piPackageDir, "package.json"));
const bunManifest = readJson(join(bunPackageDir, "package.json"));
const buildKey = hashFiles([
  scriptPath,
  noticesPath,
  join(piPackageDir, "package.json"),
  join(piPackageDir, "npm-shrinkwrap.json"),
  join(bunPackageDir, "package.json"),
]);
const existingManifestPath = join(outputDir, "runtime-manifest.json");
if (existsSync(existingManifestPath)) {
  const existingManifest = readJson(existingManifestPath);
  if (existingManifest.buildKey === buildKey) {
    validateRuntime(outputDir, piManifest.version);
    console.log(`Pi runtime ${piManifest.version} is ready (${(directorySize(outputDir) / 1024 / 1024).toFixed(1)} MiB, cached).`);
    process.exit(0);
  }
}

mkdirSync(tauriResources, { recursive: true });
const stagingDir = mkdtempSync(join(tauriResources, ".pi-runtime-staging-"));
assertInside(tauriResources, stagingDir, "Pi runtime staging directory");
assertInside(tauriResources, outputDir, "Pi runtime output directory");
let promoted = false;
try {
  const piExecutable = join(stagingDir, "pi.exe");
  run(
    bunExecutable,
    [
      "build",
      "--compile",
      join(piPackageDir, "dist", "bun", "cli.js"),
      join(piPackageDir, "dist", "utils", "image-resize-worker.js"),
      "--outfile",
      piExecutable,
    ],
    { stdio: "inherit", encoding: undefined },
  );
  copyRuntimeAssets(stagingDir);
  const runtimeLicenses = collectRuntimeLicenses([piPackageDir, bunPackageDir, bunBinaryPackageDir]);
  copyRuntimeLicenses(runtimeLicenses, stagingDir);
  writeFileSync(
    join(stagingDir, "runtime-manifest.json"),
    `${JSON.stringify({
      buildFormatVersion,
      buildKey,
      piPackage: piManifest.name,
      piVersion: piManifest.version,
      compiler: "bun",
      compilerVersion: bunManifest.version,
      platform: process.platform,
      arch: process.arch,
    }, null, 2)}\n`,
  );
  validateRuntime(stagingDir, piManifest.version);
  const promotion = promoteRuntime(stagingDir, outputDir);
  validateRuntime(outputDir, piManifest.version);
  promoted = promotion === "renamed";
  console.log(`Prepared Pi runtime ${piManifest.version} (${(directorySize(outputDir) / 1024 / 1024).toFixed(1)} MiB).`);
} finally {
  if (!promoted) rmSync(stagingDir, { recursive: true, force: true });
}
