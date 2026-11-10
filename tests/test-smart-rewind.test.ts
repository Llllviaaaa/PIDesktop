import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedProvider, textReply, toolReply } from "@qianji/testkit";
import { ClientBundleRegistry } from "../packages/host/src/client-bundles.ts";
import { startE2eHost } from "../packages/host/test/e2e-host.ts";
import { connectHarness } from "../src/lib/harnessClient";
import { HarnessRuntimes } from "../src/lib/harnessRuntime";
import { messageImagesToAttachments, rewindController } from "../src/lib/rewindController";
import type { TranscriptEvent } from "../src/lib/transcript";
import { useAppStore } from "../src/store";
import type { AttachmentPayload, UiMessage } from "../src/types";

const SMART_REWIND_DIR = resolve(process.cwd(), "plugins", "smart-rewind");

function initGitRepo(cwd: string): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, windowsHide: true });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("commit", "-q", "-m", "init");
}

describe("smart-rewind plugin & rewindController", () => {
  it("compiles plugins/smart-rewind/client.tsx cleanly via ClientBundleRegistry", async () => {
    const registry = new ClientBundleRegistry();
    const compiled = await registry.compile("smart-rewind", SMART_REWIND_DIR, join(SMART_REWIND_DIR, "client.tsx"));
    expect(compiled.etag.length).toBeGreaterThan(4);
    expect(compiled.code).toContain('window.__ModuleLoader__.load({ id: "smart-rewind"');
    expect(compiled.code).toContain("smart-rewind:handler");
    expect(compiled.code).toContain("smart-rewind:composer-banner");
  });

  it("converts user message images back into Composer attachment payloads and refills draft with stash protection", async () => {
    let liveText = "未发送的半截草稿";
    let liveAttachments: AttachmentPayload[] = [];
    const offText = rewindController.bindTextBridge({
      getText: () => liveText,
      setText: (next) => {
        liveText = next;
      },
    });
    const offAttachments = rewindController.bindAttachmentBridge({
      getAttachments: () => liveAttachments,
      setAttachments: (next) => {
        liveAttachments = next;
      },
    });

    const originalRewindWithMode = useAppStore.getState().rewindMessageWithMode;
    useAppStore.setState({
      isStreaming: false,
      messages: [
        {
          id: "u-1",
          entryId: "1",
          role: "user",
          content: "帮我重构登录表单并保留校验逻辑",
          images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
          timestamp: Date.now(),
        },
      ],
      rewindMessageWithMode: async (entryId, mode = "both") => ({
        ok: true,
        mode,
        sessionId: "sess-1",
        toSeq: Number(entryId) - 1,
        rewindSeq: 4,
        restoredFiles: mode === "conversation" ? [] : ["src/Login.tsx"],
      }),
    });

    try {
      const targetMsg: UiMessage | undefined = useAppStore.getState().messages[0];
      expect(targetMsg).toBeDefined();
      if (!targetMsg) throw new Error("missing target message");
      const attachments = messageImagesToAttachments(targetMsg);
      expect(attachments).toHaveLength(1);
      expect(attachments[0]?.mimeType).toBe("image/png");

      const outcome = await rewindController.performRewind({
        message: targetMsg,
        entryId: "1",
        mode: "both",
        protectDraft: true,
      });

      expect(outcome).not.toBeNull();
      expect(liveText).toBe("帮我重构登录表单并保留校验逻辑");
      expect(liveAttachments).toHaveLength(1);
      expect(outcome?.stashedDraft?.text).toBe("未发送的半截草稿");
      expect(outcome?.restoredFiles).toEqual(["src/Login.tsx"]);
    } finally {
      offText();
      offAttachments();
      useAppStore.setState({ rewindMessageWithMode: originalRewindWithMode, messages: [] });
    }
  });

  it("supports conversation-only vs code-only vs full rewind modes and undoBranch RPC via smart-rewind host plugin", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pid-sr-data-"));
    const workspace = mkdtempSync(join(tmpdir(), "pid-sr-work-"));
    writeFileSync(join(workspace, "a.txt"), "initial\n");
    initGitRepo(workspace);

    const provider = new ScriptedProvider([
      toolReply([{ id: "w1", name: "write", args: { path: "created.txt", content: "v1" } }]),
      textReply("Created file."),
      textReply("Second reply."),
    ]);

    const token = Buffer.alloc(32, 7).toString("base64url");
    const e2eHost = await startE2eHost({
      dataDir,
      pageOrigin: "http://localhost:1420",
      token,
      provider,
    });

    const runtimes = new HarnessRuntimes(
      () => connectHarness({ baseUrl: e2eHost.baseUrl, token }, { name: "sr-test", version: "1" }),
      [20],
    );

    try {
      const installRes = await runtimes.call<{ plugin?: { id: string; status: string } }>("plugin.install", {
        channel: "local",
        spec: SMART_REWIND_DIR,
        link: false,
      });
      expect(installRes.plugin?.id).toBe("smart-rewind");
      expect(installRes.plugin?.status).toBe("active");

      const events: TranscriptEvent[] = [];
      const waiters: Array<() => void> = [];
      runtimes.subscribe((_id, event) => {
        events.push(event);
        for (const w of waiters.splice(0)) w();
      });
      const waitTurnEnd = async () => {
        for (;;) {
          if (events.some((ev) => ev.type === "turn-end")) {
            events.length = 0;
            return;
          }
          await new Promise<void>((res) => waiters.push(res));
        }
      };

      const { runtimeId } = await runtimes.start(workspace);
      await runtimes.setPermission(runtimeId, { permission: "full-access" });

      // Turn 1 writes `created.txt`.
      await runtimes.prompt(runtimeId, { message: "Create created.txt", images: [] });
      await waitTurnEnd();
      expect(readFileSync(join(workspace, "created.txt"), "utf8")).toBe("v1");

      // Turn 2 is pure conversation.
      await runtimes.prompt(runtimeId, { message: "Explain created.txt", images: [] });
      await waitTurnEnd();

      // Verify `/rewind` command registered by smart-rewind host plugin.
      const commands = await runtimes.commands(workspace);
      expect(commands.some((cmd) => cmd.name === "rewind")).toBe(true);
      const slashOut = await runtimes.runCommand(runtimeId, "rewind", "");
      expect(slashOut.handled).toBe(true);
      expect(slashOut.output).toContain("第 1 轮");
      expect(slashOut.output).toContain("第 2 轮");

      const points = await runtimes.forkPoints(runtimeId);
      expect(points).toHaveLength(2);
      const firstPoint = points[0];
      if (!firstPoint) throw new Error("missing first fork point");

      // 1) Inspect Turn 1: `created.txt` changed since before Turn 1.
      const inspectedTurn1 = await runtimes.inspectRewind(runtimeId, firstPoint.entryId);
      expect(inspectedTurn1.hasCheckpoint).toBe(true);
      expect(inspectedTurn1.changed).toBe(true);
      expect(inspectedTurn1.files).toContain("created.txt");

      const messagesBeforeRewind = await runtimes.messages(runtimeId);
      expect(messagesBeforeRewind.length).toBeGreaterThanOrEqual(4);

      // 2) `code`-only mode on Turn 1 restores `created.txt` (deletes it) while keeping all messages!
      const codeOnly = await runtimes.executeRewind(runtimeId, firstPoint.entryId, "code");
      expect(codeOnly.ok).toBe(true);
      expect(existsSync(join(workspace, "created.txt"))).toBe(false);
      expect(await runtimes.messages(runtimeId)).toHaveLength(messagesBeforeRewind.length);

      // Recreate `created.txt` manually and test `conversation`-only mode on Turn 1: keeps file, rewinds messages!
      writeFileSync(join(workspace, "created.txt"), "keep-my-code");
      const convOnly = await runtimes.executeRewind(runtimeId, firstPoint.entryId, "conversation");
      expect(convOnly.ok).toBe(true);
      expect(convOnly.rewindSeq).toBeTypeOf("number");
      expect(readFileSync(join(workspace, "created.txt"), "utf8")).toBe("keep-my-code");
      expect(await runtimes.messages(runtimeId)).toHaveLength(0);

      // 3) `smartRewind.undoBranch` restores the rewound conversation turns in-place!
      const undoRes = await runtimes.call<{ ok: boolean; restoredEvents: number }>("smartRewind.undoBranch", {
        sessionId: convOnly.sessionId,
        rewindSeq: convOnly.rewindSeq,
      });
      expect(undoRes.ok).toBe(true);
      expect(undoRes.restoredEvents).toBeGreaterThan(0);
      const restoredMessages = await runtimes.messages(runtimeId);
      expect(restoredMessages).toHaveLength(messagesBeforeRewind.length);
      expect(restoredMessages.map((m) => m.content)).toEqual(messagesBeforeRewind.map((m) => m.content));
    } finally {
      runtimes.close();
      await e2eHost.stop();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
