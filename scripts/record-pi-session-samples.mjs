// Records the Pi session samples the Pi session importer is tested against
// (packages/host/test/fixtures/pi-sessions). Pi's own SessionManager writes
// them, so they are real Pi files; no model is called. Run it while Pi is
// still a dependency (P6b); the committed samples outlive it.
//
//   node scripts/record-pi-session-samples.mjs
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "host", "test", "fixtures", "pi-sessions");
const cwd = "C:\\work\\demo";
const usage = (input, output) => ({ input, output, cacheRead: 3, cacheWrite: 0, totalTokens: input + output + 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
let clock = Date.parse("2026-05-01T08:00:00.000Z");
const at = () => (clock += 1000);

const user = (content) => ({ role: "user", content, timestamp: at() });
const assistant = (content, stopReason = "stop", extra = {}) => ({
  role: "assistant", content, api: "openai-completions", provider: "deepseek", model: "deepseek-chat",
  usage: usage(100, 20), stopReason, timestamp: at(), ...extra,
});
const toolResult = (toolCallId, toolName, text, isError = false) => ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: at() });

function record(name, build) {
  const dir = join(out, `.tmp-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const session = SessionManager.create(cwd, dir, { id: `00000000-0000-4000-8000-00000000000${name.length}` });
  build(session);
  const [file] = readdirSync(dir).filter((entry) => entry.endsWith(".jsonl"));
  if (file === undefined) throw new Error(`${name}: Pi wrote no session file`);
  renameSync(join(dir, file), join(out, `${name}.jsonl`));
  rmSync(dir, { recursive: true, force: true });
}

mkdirSync(out, { recursive: true });

// Tools, thinking, a model and a thinking level, a name and a bookmark.
record("tools", (session) => {
  session.appendModelChange("deepseek", "deepseek-chat");
  session.appendThinkingLevelChange("high");
  session.appendMessage(user("List the files"));
  session.appendMessage(assistant([
    { type: "thinking", thinking: "I should run ls.", thinkingSignature: "sig-1" },
    { type: "text", text: "Looking." },
    { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
  ], "toolUse"));
  session.appendMessage(toolResult("call_1", "bash", "a.txt\nb.txt"));
  const answer = session.appendMessage(assistant([{ type: "text", text: "Two files: a.txt and b.txt." }]));
  session.appendSessionInfo("List files");
  session.appendLabelChange(answer, "done");
});

// A rewound turn: only the branch the session ended on is imported.
record("branched", (session) => {
  session.appendMessage(user([{ type: "text", text: "First question" }]));
  const first = session.appendMessage(assistant([{ type: "text", text: "First answer" }]));
  session.appendMessage(user("Abandoned question"));
  session.appendMessage(assistant([{ type: "text", text: "Abandoned answer" }]));
  session.branch(first);
  session.appendMessage(user("Second question"));
  session.appendMessage(assistant([{ type: "text", text: "Second answer" }], "error", { errorMessage: "rate limited" }));
});

// A compaction, an image, a `!` command and an extension's message.
record("compacted", (session) => {
  session.appendMessage(user("Old question"));
  session.appendMessage(assistant([{ type: "text", text: "Old answer" }]));
  const kept = session.appendMessage(user([{ type: "text", text: "Look at this" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }]));
  session.appendMessage(assistant([{ type: "text", text: "A greeting." }]));
  session.appendCompaction("The user asked an old question.", kept, 5000);
  session.appendMessage({ role: "bashExecution", command: "git status", output: "clean", exitCode: 0, cancelled: false, truncated: false, timestamp: at() });
  session.appendCustomMessageEntry("pidesktop-plan", "Plan: step 1", false);
  session.appendMessage(user("Next"));
  session.appendMessage(assistant([{ type: "text", text: "Done." }], "length"));
});

console.log(`recorded ${readdirSync(out).filter((entry) => entry.endsWith(".jsonl")).length} samples in ${out}`);
