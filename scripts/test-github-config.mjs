import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";

function yamlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/i.test(entry.name) ? [path] : [];
  });
}

const files = yamlFiles(".github");
assert(files.length > 0, "GitHub configuration files are required");

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const document = parseDocument(source);
  assert.deepEqual(document.errors, [], `${file} contains invalid YAML`);
  const value = document.toJS();
  assert(value && typeof value === "object", `${file} must contain a YAML object`);

  if (file.includes(`${join(".github", "workflows")}\\`) || file.includes(".github/workflows/")) {
    assert(value.on, `${file} must declare workflow triggers`);
    assert(value.jobs && typeof value.jobs === "object", `${file} must declare jobs`);
    for (const match of source.matchAll(/\buses:\s*([^\s#]+)/g)) {
      const action = match[1];
      if (action.startsWith("./")) continue;
      assert.match(action, /@[0-9a-f]{40}$/i, `${file} must pin ${action} to a full commit SHA`);
    }
  }
}

console.log(`github-config: ${files.length} YAML files parsed`);
