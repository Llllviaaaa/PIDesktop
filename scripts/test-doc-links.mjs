import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const markdownFiles = execFileSync(
  "git",
  ["ls-files", "-co", "--exclude-standard", "--", "*.md"],
  { encoding: "utf8" },
)
  .split(/\r?\n/)
  .filter(Boolean);

const missing = [];
const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;

for (const file of markdownFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(linkPattern)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    if (!rawTarget || /^(?:[a-z]+:|#)/i.test(rawTarget)) continue;
    const pathPart = rawTarget.split("#", 1)[0];
    const localPath = resolve(dirname(file), decodeURIComponent(pathPart));
    if (!existsSync(localPath)) missing.push(`${file}: ${rawTarget}`);
  }
}

assert.deepEqual(missing, [], `missing local Markdown links:\n${missing.join("\n")}`);
console.log(`doc-links: ${markdownFiles.length} Markdown files checked`);
