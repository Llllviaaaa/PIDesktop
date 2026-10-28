import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import modelGuard, { PIDESKTOP_RICH_CONTENT_INSTRUCTIONS } from "../src-tauri/resources/pidesktop-guard.ts";
import { afterAll, beforeAll, test } from "vitest";

// before_agent_start checkpoints the workspace the guard was created in, which
// defaults to process.cwd(): this repository. Point it at an empty directory so
// the test leaves no refs/pidesktop/checkpoints/* snapshots behind.
let workspace = "";
let previousWorkspace: string | undefined;
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), "pidesktop-model-selection-"));
  previousWorkspace = process.env.PIDESKTOP_WORKSPACE_ROOT;
  process.env.PIDESKTOP_WORKSPACE_ROOT = workspace;
});
afterAll(() => {
  if (previousWorkspace === undefined) delete process.env.PIDESKTOP_WORKSPACE_ROOT;
  else process.env.PIDESKTOP_WORKSPACE_ROOT = previousWorkspace;
  rmSync(workspace, { recursive: true, force: true });
});

test("model selection extension", async () => {
  type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;

  const handlers = new Map<string, Handler>();
  const messages: Array<{
    customType: string;
    content: string;
    display: boolean;
    details?: unknown;
  }> = [];

  modelGuard({
    registerCommand() {},
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    sendMessage(message: (typeof messages)[number]) {
      messages.push(message);
    },
  } as never);

  const modelSelect = handlers.get("model_select");
  assert.ok(modelSelect, "model_select handler should be registered");
  const beforeAgentStart = handlers.get("before_agent_start");
  assert.ok(beforeAgentStart, "before_agent_start handler should be registered");

  const interactivePrompt = await beforeAgentStart({ systemPrompt: "base prompt" }, { hasUI: true }) as {
    systemPrompt?: string;
  };
  assert.match(interactivePrompt.systemPrompt ?? "", /pidesktop-rich/);
  assert.ok(
    interactivePrompt.systemPrompt?.includes(PIDESKTOP_RICH_CONTENT_INSTRUCTIONS),
    "interactive desktop turns should receive the rich-content capability",
  );

  const headlessPrompt = await beforeAgentStart({ systemPrompt: "base prompt" }, { hasUI: false }) as {
    systemPrompt?: string;
  };
  assert.equal(headlessPrompt.systemPrompt, undefined, "headless runs should not receive UI-only instructions");

  const quickChatHandlers = new Map<string, Handler>();
  const previousQuickChat = process.env.PIDESKTOP_QUICK_CHAT;
  process.env.PIDESKTOP_QUICK_CHAT = "1";
  modelGuard({
    registerCommand() {},
    on(event: string, handler: Handler) {
      quickChatHandlers.set(event, handler);
    },
    sendMessage() {},
  } as never);
  if (previousQuickChat === undefined) delete process.env.PIDESKTOP_QUICK_CHAT;
  else process.env.PIDESKTOP_QUICK_CHAT = previousQuickChat;
  const quickChatBeforeStart = quickChatHandlers.get("before_agent_start");
  assert.ok(quickChatBeforeStart, "quick-chat guard should register before_agent_start");
  const quickChatPrompt = await quickChatBeforeStart({ systemPrompt: "base prompt" }, { hasUI: true }) as {
    systemPrompt?: string;
  };
  assert.match(quickChatPrompt.systemPrompt ?? "", /pidesktop-rich/, "all interactive chat surfaces should share the capability");

  await modelSelect({
    source: "restore",
    model: { provider: "example", id: "old-model", name: "Old Model" },
  }, {});
  assert.equal(messages.length, 0, "restoring a session must not add model metadata");

  await modelSelect({
    source: "set",
    model: { provider: "google", id: "gemini-test", name: "Gemini Test" },
  }, {});

  assert.equal(messages.length, 1);
  assert.equal(messages[0].customType, "pidesktop-model-selection");
  assert.equal(messages[0].display, false, "runtime metadata must stay hidden in the transcript");
  assert.match(messages[0].content, /google/);
  assert.match(messages[0].content, /gemini-test/);
});
