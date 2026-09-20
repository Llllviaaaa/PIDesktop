import assert from "node:assert/strict";
import { nextMemoryContent } from "../src-tauri/resources/pidesktop-memory-core";
import { test } from "vitest";

test("memory tool", async () => {
  assert.equal(nextMemoryContent("", "append", "Use pnpm"), "Use pnpm\n");
  assert.equal(nextMemoryContent("Use pnpm\n", "append", "Prefer concise answers"), "Use pnpm\n\nPrefer concise answers\n");
  assert.equal(nextMemoryContent("old", "replace", "new"), "new\n");
  assert.equal(nextMemoryContent("old", "clear"), "");
  assert.throws(() => nextMemoryContent("", "append", "  "), /content is required/);
});
