import assert from "node:assert/strict";
import { redactSensitiveText } from "../src/lib/redact";
import { test } from "vitest";

test("redaction", async () => {
  const providerKey = ["sk-proj", "abcdefghijklmnopqrstuvwxyz"].join("-");
  const output = redactSensitiveText(
    `Authorization: Bearer abcdefghijklmnop api_key=${providerKey}`,
  );

  assert.equal(output.includes("abcdefghijklmnop"), false);
  assert.equal(output.includes(providerKey), false);
  assert.match(output, /\[REDACTED\]/);
  assert.equal(redactSensitiveText("maxTokens=4096"), "maxTokens=4096");
});
