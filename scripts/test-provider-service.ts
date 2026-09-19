import assert from "node:assert/strict";
import {
  collectProviderIds,
  decodeProviderMessage,
  encodeProviderMessage,
  parseProviderRequest,
  PROVIDER_SERVICE_PREFIX,
  shouldAutoAnswerSecret,
  summarizeAuthEvent,
  summarizeModel,
  summarizeProvider,
} from "../src-tauri/resources/pidesktop-providers-core";

assert.deepEqual(parseProviderRequest('{"id":"1","op":"list"}'), { id: "1", op: "list" });
assert.deepEqual(parseProviderRequest('{"id":"2","op":"refresh","network":true}'), { id: "2", op: "refresh", network: true });
assert.deepEqual(parseProviderRequest('{"id":"3","op":"refresh"}'), { id: "3", op: "refresh", network: false });
assert.deepEqual(
  parseProviderRequest('{"id":"4","op":"login","providerId":" openai ","method":"api_key","apiKey":" sk-1 "}'),
  { id: "4", op: "login", providerId: "openai", method: "api_key", apiKey: "sk-1" },
);
assert.equal(parseProviderRequest('{"id":"5","op":"login","providerId":"a","method":"oauth","apiKey":"  "}').op, "login");
assert.equal((parseProviderRequest('{"id":"5","op":"login","providerId":"a","method":"oauth","apiKey":"  "}') as { apiKey?: string }).apiKey, undefined);
assert.deepEqual(parseProviderRequest('{"id":"6","op":"check","providerId":"a","modelId":"m"}'), { id: "6", op: "check", providerId: "a", modelId: "m" });
assert.throws(() => parseProviderRequest("nope"), /must be JSON/);
assert.throws(() => parseProviderRequest("[]"), /must be an object/);
assert.throws(() => parseProviderRequest('{"op":"list"}'), /id is required/);
assert.throws(() => parseProviderRequest('{"id":"1","op":"drop"}'), /Unknown provider service operation/);
assert.throws(() => parseProviderRequest('{"id":"1","op":"login","providerId":"a","method":"password"}'), /Unknown login method/);
assert.throws(() => parseProviderRequest('{"id":"1","op":"logout"}'), /providerId is required/);

const encoded = encodeProviderMessage({ id: "7", type: "result", result: { ok: true } });
assert.ok(encoded.startsWith(PROVIDER_SERVICE_PREFIX));
assert.deepEqual(decodeProviderMessage(encoded), { id: "7", type: "result", result: { ok: true } });
assert.equal(decodeProviderMessage("Plain notification"), null);
assert.equal(decodeProviderMessage(`${PROVIDER_SERVICE_PREFIX}{broken`), null);

assert.deepEqual([...collectProviderIds([{ id: "a" }, "b"])].sort(), ["a", "b"]);
assert.deepEqual([...collectProviderIds(new Map([["c", { id: "c" }]]))], ["c"]);
assert.deepEqual([...collectProviderIds(undefined)], []);

assert.deepEqual(summarizeModel({ id: "m", input: ["text", "image"], contextWindow: 0, maxTokens: 8192, cost: { input: 3 } }), {
  id: "m",
  name: "m",
  reasoning: false,
  input: ["text", "image"],
  contextWindow: null,
  maxTokens: 8192,
  cost: { input: 3, output: 0 },
});

const builtin = summarizeProvider(
  { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com", auth: { oauth: { name: "Claude Pro/Max" }, apiKey: { name: "API key" } } },
  { configured: true, source: "stored", label: "auth.json" },
  true,
  [{ id: "claude", name: "Claude", reasoning: true, input: ["text"] }],
  new Set(["anthropic"]),
);
assert.equal(builtin.builtin, true);
assert.equal(builtin.authType, "oauth");
assert.equal(builtin.source, "stored");
assert.equal(builtin.oauthMethod, "Claude Pro/Max");
assert.equal(builtin.models.length, 1);

const unconfigured = summarizeProvider({ id: "grok" }, { configured: false, source: "environment" }, false, [], new Set());
assert.equal(unconfigured.name, "grok");
assert.equal(unconfigured.builtin, false);
assert.equal(unconfigured.authType, null);
assert.equal(unconfigured.source, null, "an unconfigured provider has no active credential source");
assert.equal(summarizeProvider({ id: "x" }, { configured: true, source: "mystery" }, false, [], new Set()).source, null);

// Mirrors quoted_secret_pattern in src-tauri/src/pi/rpc.rs: string values under these keys are masked
// before events reach the UI, so provider summaries must not use them for display labels.
const redactedKey = /["'](?:api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|credential|cookie|password|private[-_]?key|secret|token)["']\s*:\s*["']/i;
const listMessage = encodeProviderMessage({ id: "list", type: "result", result: { providers: [builtin, unconfigured] } });
assert.equal(redactedKey.test(listMessage), false, "provider list labels must survive the desktop secret redactor");

assert.deepEqual(summarizeAuthEvent({ type: "auth_url", url: "https://example.com", instructions: "" }), { type: "auth_url", url: "https://example.com", instructions: undefined });
assert.deepEqual(summarizeAuthEvent({ type: "device_code", userCode: "ABCD", verificationUri: "https://github.com/login/device" }), { type: "device_code", userCode: "ABCD", verificationUri: "https://github.com/login/device" });
assert.equal(summarizeAuthEvent({ type: "unknown" }), null);

assert.equal(shouldAutoAnswerSecret("secret", "sk", false), true);
assert.equal(shouldAutoAnswerSecret("secret", "sk", true), false, "the supplied key answers only one prompt");
assert.equal(shouldAutoAnswerSecret("text", "sk", false), false);
assert.equal(shouldAutoAnswerSecret("secret", undefined, false), false);

console.log("provider service tests passed");
