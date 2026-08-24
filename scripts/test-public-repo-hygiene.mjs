import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const csp = tauriConfig?.app?.security?.csp;

const packageManifest = JSON.parse(readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const cargoManifest = readFileSync("src-tauri/Cargo.toml", "utf8");
const cargoLock = readFileSync("src-tauri/Cargo.lock", "utf8");
const mcpExtension = readFileSync("src-tauri/resources/pidesktop-mcp.ts", "utf8");
const license = readFileSync("LICENSE", "utf8");
const thirdPartyNotices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");

assert.equal(packageManifest.license, "Apache-2.0", "package metadata must declare the repository license");
assert.match(license, /Apache License\s+Version 2\.0, January 2004/, "LICENSE must contain the Apache 2.0 text");
assert.equal(packageLock.version, packageManifest.version, "package-lock version must match package.json");
assert.equal(packageLock.packages?.[""]?.version, packageManifest.version, "package-lock root package version must match package.json");
assert.match(cargoManifest, new RegExp(`^version = "${packageManifest.version.replaceAll(".", "\\.")}"$`, "m"), "Cargo package version must match package.json");
assert.match(cargoManifest, /^license = "Apache-2\.0"$/m, "Cargo metadata must declare the repository license");
assert.match(cargoLock, new RegExp(`name = "pid-desktop"\\r?\\nversion = "${packageManifest.version.replaceAll(".", "\\.")}"`), "Cargo.lock package version must match package.json");
assert.equal(tauriConfig.version, packageManifest.version, "Tauri bundle version must match package.json");
assert.equal(packageManifest.devDependencies?.bun, "1.4.0", "the Pi sidecar compiler must be pinned exactly");
assert.equal(
  tauriConfig.bundle?.resources?.["resources/pi-runtime/"],
  "pi-runtime/",
  "the generated Pi runtime must be included in desktop bundles",
);
assert.match(thirdPartyNotices, /@earendil-works\/pi-coding-agent/, "bundled Pi must have redistribution notices");
assert.match(thirdPartyNotices, /Bun runtime/, "bundled Bun runtime must have redistribution notices");
const mcpVersions = [...mcpExtension.matchAll(/clientInfo: \{ name: "Pi Desktop", version: "([^"]+)" \}/g)].map((match) => match[1]);
assert.ok(mcpVersions.length > 0, "bundled MCP clients must declare a version");
assert.ok(mcpVersions.every((version) => version === packageManifest.version), "bundled MCP client versions must match package.json");

assert.equal(typeof csp, "string", "the main WebView must define a CSP");
assert.match(csp, /default-src 'self'/, "CSP must default to same-origin resources");
assert.match(csp, /connect-src[^;]*\bipc:/, "CSP must retain the Tauri IPC transport");
assert.match(csp, /object-src 'none'/, "CSP must block embedded objects");
assert.match(csp, /base-uri 'self'/, "CSP must prevent external base URL injection");
assert.match(csp, /form-action 'none'/, "CSP must block form submissions from the app shell");
assert.doesNotMatch(csp, /(?:^|\s)\*(?:\s|;|$)/, "CSP must not allow wildcard sources");

const fixtureSource = readFileSync("src/main.tsx", "utf8");
assert.doesNotMatch(fixtureSource, /[A-Z]:\\(?:Users\\[^\\]+|02_Lab)\\/i, "development fixtures must not contain personal machine paths");

const referenceDir = join("docs", "codex-ui-refs");
if (existsSync(referenceDir)) {
  const redistributedImages = readdirSync(referenceDir)
    .filter((name) => [".gif", ".jpeg", ".jpg", ".png", ".webp"].includes(extname(name).toLowerCase()));
  assert.deepEqual(redistributedImages, [], "third-party UI reference images must not be redistributed");
}

console.log("public-repo-hygiene: release metadata, security, and redistribution checks passed");
