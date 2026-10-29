import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { Sessions } from "@pid/session";
import { Tools, type ToolOutput } from "@pid/tools";
import { Ui } from "@pid/ui";
import { computerTools, helperRunner, type HelperRunner, type ScreenshotResult } from "../src/index.ts";

const shot: ScreenshotResult = {
  data: "AAAA", mimeType: "image/png", width: 1920, height: 1080, left: 0, top: 0,
  imageWidth: 1920, imageHeight: 1080, scaleX: 1, scaleY: 1, captureBackend: "test", frameId: "f1",
};

async function setup(options: { answer?: boolean; mode?: string } = {}) {
  const ctx = new Context();
  await ctx.plugin(Sessions);
  await ctx.plugin(Ui);
  await ctx.plugin(Tools);
  const mode = options.mode;
  if (mode !== undefined) ctx.provide("permissions", { modes: () => ({ effective: mode }) });
  const answer = options.answer;
  if (answer !== undefined) {
    ctx.ui.attach({ request: ({ requestId }) => queueMicrotask(() => ctx.ui.respond(requestId, answer)), cancel: () => {}, notify: () => {} });
  }
  const actions: Array<Record<string, unknown>> = [];
  const run: HelperRunner = async <T>(payload: Record<string, unknown>) => {
    actions.push(payload);
    if (payload.action === "screenshot") return shot as T;
    if (payload.action === "list_windows") return { windows: [{ title: "Notepad", handle: "42", x: 10, y: 10, width: 800, height: 600 }] } as T;
    if (payload.action === "observe") return { elements: [], windowTitle: "Notepad", windowHandle: "42" } as T;
    return { ok: true } as T;
  };
  for (const definition of computerTools(ctx, {}, run)) ctx.tools.register(definition);
  const sessions = [ctx.sessions.create({ cwd: "." }), ctx.sessions.create({ cwd: "." })];
  const call = async (name: string, args: Record<string, unknown> = {}, session = 0): Promise<{ text: string; isError: boolean; output: ToolOutput }> => {
    const output = await ctx.tools.execute({ id: "1", name, args }, { sessionId: sessions[session]?.id ?? "", cwd: ".", signal: new AbortController().signal });
    return { text: output.content.map((block) => (block.type === "text" ? block.text : `[${block.mimeType}]`)).join("\n"), isError: output.isError === true, output };
  };
  return { ctx, call, actions, sessions };
}

describe("computer tools", () => {
  it("observe, then control after approval, one session per agent session", async () => {
    const { call, actions, ctx, sessions } = await setup({ answer: true });
    const live: unknown[] = [];
    ctx.on("session/delta", (_session, _seq, delta) => void live.push(delta));

    expect((await call("computer_screenshot")).text).toBe("computer_screenshot failed: Start a computer session with computer_start before this action");
    expect((await call("computer_sources")).text).toBe("screen:primary [screen] Primary desktop (0,0) 1920×1080\nwindow:42 [window] Notepad (10,10) 800×600");
    expect((await call("computer_start", { sourceId: "window:42", mode: "control" })).text).toMatch(/only supports screen sources/);
    expect((await call("computer_start", { sourceId: "screen:primary", mode: "control" })).text).toBe("Computer session started: control screen:primary");
    expect(live.at(-1)).toEqual({ type: "computer", mode: "control", sourceId: "screen:primary", sourceKind: "screen", windowTitle: undefined });

    expect((await call("computer_click", { x: 10.4, y: 20.6 })).text).toBe("Clicked (10.4, 20.6)\n[image/png]");
    expect(actions).toContainEqual({ action: "click", x: 10, y: 21, button: "left", count: 1 });
    expect((await call("computer_key", { key: "S", modifiers: ["ctrl", "win"] })).text).toBe("Pressed CTRL+WIN+S");

    // Another agent session has its own, idle computer session.
    expect((await call("computer_type", { text: "hi" }, 1)).text).toMatch(/Start a computer session/);
    expect(sessions).toHaveLength(2);

    await call("computer_stop");
    expect((await call("computer_move", { x: 1, y: 1 })).isError).toBe(true);
  });

  it("refuses control when denied, unattended or read-only", async () => {
    const denied = await setup({ answer: false });
    expect((await denied.call("computer_start", { sourceId: "screen:primary", mode: "control" })).text).toBe("User denied computer control");
    expect((await denied.call("computer_start", { sourceId: "screen:primary", mode: "observe" })).text).toBe("Computer session started: observe screen:primary");
    expect((await denied.call("computer_click", { x: 1, y: 1 })).text).toMatch(/requires an approved computer_start control session/);

    const readOnly = await setup({ answer: true, mode: "read-only" });
    expect((await readOnly.call("computer_start", { sourceId: "screen:primary", mode: "control" })).text).toBe("Interactive computer control is disabled in read-only mode");

    const full = await setup({ mode: "full-access" });
    expect((await full.call("computer_start", { sourceId: "screen:primary", mode: "control" })).text).toBe("Computer session started: control screen:primary");
  });

  it("explains when the helper is unavailable", async () => {
    await expect(helperRunner(undefined, "win32")({ action: "screenshot" })).rejects.toThrow("did not provide its computer helper path");
    await expect(helperRunner("x.exe", "linux")({ action: "screenshot" })).rejects.toThrow("supports Windows only");
  });
});
