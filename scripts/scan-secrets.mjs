import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const rules = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/i],
  ["openai-like", /sk-(?:proj-|svcacct-)?[a-z0-9_-]{16,}/i],
  ["anthropic", /sk-ant-[a-z0-9_-]{16,}/i],
  ["openrouter", /sk-or-v1-[a-z0-9]{16,}/i],
  ["groq", /gsk_[a-z0-9]{16,}/i],
  ["github", /(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{30,})/i],
  ["google", /AIza[0-9a-z_-]{30,}/i],
  ["aws", /(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ["stripe-live", /(?:sk|rk)_live_[a-z0-9]{16,}/i],
  ["slack", /xox[baprs]-[a-z0-9-]{10,}/i],
  ["huggingface", /hf_[a-z0-9]{20,}/i],
  ["npm", /npm_[a-z0-9]{20,}/i],
  ["pypi", /pypi-[a-z0-9_-]{20,}/i],
  ["sendgrid", /SG\.[a-z0-9_-]{10,}\.[a-z0-9_-]{20,}/i],
  ["credential-assignment", /(?:api[-_]?key|access[-_]?token|authorization|client[-_]?secret|credential|cookie|password|private[-_]?key|secret|token)\s*[:=]\s*["'](?!\$|!|\[?redacted|example|placeholder|your[-_])[^"'\r\n]{16,}["']/i],
];

function git(args, encoding = "utf8") {
  return execFileSync("git", args, { encoding, maxBuffer: 128 * 1024 * 1024 });
}

const findings = new Map();

function scan(content, location) {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : content;
  for (const [name, pattern] of rules) {
    if (pattern.test(text)) findings.set(`${name}:${location}`, { name, location });
  }
}

const files = git(["ls-files", "-co", "--exclude-standard", "-z"], "buffer")
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
for (const path of files) {
  try {
    scan(readFileSync(path), path);
  } catch {
    // A concurrently removed build file is not a repository leak.
  }
}

const objectPaths = new Map();
for (const line of git(["rev-list", "--objects", "--all"]).split(/\r?\n/)) {
  if (!line) continue;
  const separator = line.indexOf(" ");
  const object = separator < 0 ? line : line.slice(0, separator);
  const path = separator < 0 ? "<unknown>" : line.slice(separator + 1);
  if (!objectPaths.has(object)) objectPaths.set(object, path);
}
for (const [object, path] of objectPaths) {
  if (git(["cat-file", "-t", object]).trim() !== "blob") continue;
  scan(git(["cat-file", "blob", object], "buffer"), `git:${object.slice(0, 12)}:${path}`);
}

if (findings.size) {
  console.error("Potential credentials detected (values intentionally hidden):");
  for (const { name, location } of findings.values()) {
    console.error(`- ${name}: ${location}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed: ${files.length} files and ${objectPaths.size} Git objects checked.`);
}
